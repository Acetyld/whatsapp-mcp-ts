import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import path from "node:path";

const LOCK_FILENAME = ".wa_session.lock";

export type SessionLock = {
  release: () => void;
};

type LockPayload = {
  pid: number;
  startedAt: string;
};

function lockPathFor(authDir: string): string {
  return path.join(authDir, LOCK_FILENAME);
}

function readLock(lockPath: string): LockPayload | null {
  try {
    const raw = readFileSync(lockPath, "utf8");
    const parsed = JSON.parse(raw) as Partial<LockPayload>;
    if (typeof parsed.pid !== "number" || !Number.isInteger(parsed.pid)) {
      return null;
    }
    return {
      pid: parsed.pid,
      startedAt:
        typeof parsed.startedAt === "string"
          ? parsed.startedAt
          : new Date(0).toISOString(),
    };
  } catch {
    return null;
  }
}

function isProcessAlive(pid: number): boolean {
  if (pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: any) {
    // EPERM means the process exists but we can't signal it.
    return error?.code === "EPERM";
  }
}

function tryCreateExclusive(lockPath: string): number {
  return openSync(lockPath, "wx");
}

/**
 * Acquire an exclusive lock for one WhatsApp auth directory.
 * A second live process must fail instead of taking over the Baileys socket.
 * Stale locks (dead PID) are replaced.
 */
export function acquireSessionLock(authDir: string): SessionLock {
  mkdirSync(authDir, { recursive: true });
  const lockPath = lockPathFor(authDir);

  let fd: number | null = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      fd = tryCreateExclusive(lockPath);
      break;
    } catch (error: any) {
      if (error?.code !== "EEXIST") throw error;

      const existing = readLock(lockPath);
      if (existing && isProcessAlive(existing.pid)) {
        throw new Error(
          `Session auth directory is already in use by pid ${existing.pid} ` +
            `(lock: ${lockPath}). Refusing to start a second WhatsApp socket for this session.`,
        );
      }

      // Stale lock from a crashed/killed process — remove and retry.
      try {
        unlinkSync(lockPath);
      } catch {
        // Another process may have claimed it; retry the exclusive create.
      }
    }
  }

  if (fd == null) {
    throw new Error(
      `Failed to acquire session lock at ${lockPath}. Another process may hold it.`,
    );
  }

  const payload: LockPayload = {
    pid: process.pid,
    startedAt: new Date().toISOString(),
  };
  writeSync(fd, `${JSON.stringify(payload)}\n`);

  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    try {
      closeSync(fd!);
    } catch {
      // ignore
    }
    try {
      if (!existsSync(lockPath)) return;
      const current = readLock(lockPath);
      if (current?.pid === process.pid) {
        unlinkSync(lockPath);
      }
    } catch {
      // ignore
    }
  };

  return { release };
}
