import { randomUUID } from "node:crypto";
import { existsSync, rmSync } from "node:fs";
import path from "node:path";
import type { P } from "pino";

import {
  createSessionRow,
  deleteSessionRow,
  getSessionRow,
  getSessionRowByName,
  listSessionRows,
  updateSessionRow,
} from "./db/queries.ts";
import type { SessionStatus } from "./db/schema.ts";
import {
  disconnectWhatsAppSession,
  hasAuthCreds,
  sendWhatsAppMessage,
  startWhatsAppConnection,
  type WhatsAppSocket,
} from "./whatsapp.ts";

const AUTH_ROOT = path.join(import.meta.dirname, "..", "auth_info");

export type SessionInfo = {
  id: string;
  name: string;
  status: SessionStatus;
  phoneJid: string | null;
  qrUrl: string | null;
  createdAt?: string;
  updatedAt?: string;
};

type RuntimeSession = {
  id: string;
  name: string;
  status: SessionStatus;
  phoneJid: string | null;
  qrUrl: string | null;
  socket: WhatsAppSocket | null;
  stop: (() => void) | null;
};

const runtimes = new Map<string, RuntimeSession>();
let waLogger: P.Logger | null = null;

function authDirFor(sessionId: string): string {
  return path.join(AUTH_ROOT, sessionId);
}

function qrUrlFromData(qr: string): string {
  return `https://quickchart.io/qr?text=${encodeURIComponent(qr)}`;
}

function toInfo(runtime: RuntimeSession, row?: {
  createdAt?: string;
  updatedAt?: string;
}): SessionInfo {
  return {
    id: runtime.id,
    name: runtime.name,
    status: runtime.status,
    phoneJid: runtime.phoneJid,
    qrUrl: runtime.qrUrl,
    createdAt: row?.createdAt,
    updatedAt: row?.updatedAt,
  };
}

function ensureLogger(): P.Logger {
  if (!waLogger) {
    throw new Error("Session manager not initialized. Call initSessionManager first.");
  }
  return waLogger;
}

function setRuntimeStatus(
  sessionId: string,
  status: SessionStatus,
  extras?: { phoneJid?: string | null; qrUrl?: string | null },
): void {
  const runtime = runtimes.get(sessionId);
  if (!runtime) return;

  runtime.status = status;
  if (extras?.phoneJid !== undefined) runtime.phoneJid = extras.phoneJid;
  if (extras?.qrUrl !== undefined) runtime.qrUrl = extras.qrUrl;

  updateSessionRow(sessionId, {
    status,
    ...(extras?.phoneJid !== undefined ? { phoneJid: extras.phoneJid } : {}),
  });
}

async function startRuntimeConnection(runtime: RuntimeSession): Promise<void> {
  const logger = ensureLogger().child({ sessionId: runtime.id, sessionName: runtime.name });
  const authDir = authDirFor(runtime.id);

  setRuntimeStatus(runtime.id, "connecting", { qrUrl: null });

  const { socket, stop } = await startWhatsAppConnection({
    sessionId: runtime.id,
    authDir,
    logger,
    waitForOpen: false,
    hooks: {
      onQr: (qr) => {
        const url = qrUrlFromData(qr);
        setRuntimeStatus(runtime.id, "pending_qr", { qrUrl: url });
        void import("open").then(({ default: open }) => open(url)).catch(() => {});
      },
      onOpen: (phoneJid) => {
        setRuntimeStatus(runtime.id, "connected", {
          phoneJid: phoneJid ?? runtime.phoneJid,
          qrUrl: null,
        });
      },
      onClose: (loggedOut) => {
        if (loggedOut) {
          setRuntimeStatus(runtime.id, "logged_out", { qrUrl: null });
          runtime.socket = null;
        } else if (runtime.status !== "logged_out") {
          setRuntimeStatus(runtime.id, "connecting", { qrUrl: null });
        }
      },
    },
  });

  runtime.socket = socket;
  runtime.stop = stop;
}

export function initSessionManager(logger: P.Logger): void {
  waLogger = logger;
}

export async function createSession(name: string): Promise<SessionInfo> {
  const trimmed = name.trim();
  if (!trimmed) {
    throw new Error("Session name is required");
  }

  const existing = getSessionRowByName(trimmed);
  if (existing) {
    throw new Error(`A session named "${trimmed}" already exists (id: ${existing.id})`);
  }

  const id = randomUUID();
  createSessionRow(id, trimmed);

  const runtime: RuntimeSession = {
    id,
    name: trimmed,
    status: "connecting",
    phoneJid: null,
    qrUrl: null,
    socket: null,
    stop: null,
  };
  runtimes.set(id, runtime);

  // Start connection in background; QR / connected status update via hooks.
  void startRuntimeConnection(runtime).catch((error) => {
    ensureLogger().error({ err: error, sessionId: id }, "Failed to start session connection");
    setRuntimeStatus(id, "disconnected", { qrUrl: null });
  });

  // Brief wait so QR may be available on first create response.
  await new Promise((r) => setTimeout(r, 1500));

  const row = getSessionRow(id);
  return toInfo(runtime, row ?? undefined);
}

export function listSessions(): SessionInfo[] {
  const rows = listSessionRows();
  return rows.map((row) => {
    const runtime = runtimes.get(row.id);
    return {
      id: row.id,
      name: row.name,
      status: (runtime?.status ?? row.status) as SessionStatus,
      phoneJid: runtime?.phoneJid ?? row.phoneJid,
      qrUrl: runtime?.qrUrl ?? null,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  });
}

export function getSession(sessionId: string): SessionInfo | null {
  const row = getSessionRow(sessionId);
  if (!row) return null;

  const runtime = runtimes.get(sessionId);
  return {
    id: row.id,
    name: row.name,
    status: (runtime?.status ?? row.status) as SessionStatus,
    phoneJid: runtime?.phoneJid ?? row.phoneJid,
    qrUrl: runtime?.qrUrl ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function requireSession(sessionId: string): SessionInfo {
  const session = getSession(sessionId);
  if (!session) {
    throw new Error(`Session not found: ${sessionId}`);
  }
  return session;
}

export function getSocket(sessionId: string): WhatsAppSocket | null {
  return runtimes.get(sessionId)?.socket ?? null;
}

export async function deleteSession(sessionId: string): Promise<void> {
  const row = getSessionRow(sessionId);
  if (!row) {
    throw new Error(`Session not found: ${sessionId}`);
  }

  const runtime = runtimes.get(sessionId);
  if (runtime) {
    runtime.stop?.();
    await disconnectWhatsAppSession(runtime.socket);
    runtimes.delete(sessionId);
  }

  deleteSessionRow(sessionId);

  const authDir = authDirFor(sessionId);
  if (existsSync(authDir)) {
    rmSync(authDir, { recursive: true, force: true });
  }
}

export async function restoreSessions(): Promise<void> {
  const logger = ensureLogger();
  const rows = listSessionRows();

  for (const row of rows) {
    const runtime: RuntimeSession = {
      id: row.id,
      name: row.name,
      status: "disconnected",
      phoneJid: row.phoneJid,
      qrUrl: null,
      socket: null,
      stop: null,
    };
    runtimes.set(row.id, runtime);

    const authDir = authDirFor(row.id);
    if (!hasAuthCreds(authDir)) {
      setRuntimeStatus(row.id, "disconnected");
      logger.info(
        { sessionId: row.id, name: row.name },
        "Skipping restore: no saved auth credentials",
      );
      continue;
    }

    logger.info({ sessionId: row.id, name: row.name }, "Restoring WhatsApp session");
    void startRuntimeConnection(runtime).catch((error) => {
      logger.error({ err: error, sessionId: row.id }, "Failed to restore session");
      setRuntimeStatus(row.id, "disconnected");
    });
  }
}

export async function sendSessionMessage(
  sessionId: string,
  recipientJid: string,
  text: string,
) {
  const session = requireSession(sessionId);
  const socket = getSocket(sessionId);
  if (!socket || session.status !== "connected") {
    throw new Error(
      `Session "${session.name}" is not connected (status: ${session.status}).`,
    );
  }

  return sendWhatsAppMessage(ensureLogger(), sessionId, socket, recipientJid, text);
}
