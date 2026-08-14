import {
  makeWASocket,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  DisconnectReason,
  type WAMessage,
  type Contact,
  type proto,
  isJidGroup,
  isJidUser,
  isLidUser,
  jidNormalizedUser,
} from "@whiskeysockets/baileys";
import type { P } from "pino";
import { existsSync } from "node:fs";
import path from "node:path";

import {
  storeMessage,
  storeChat,
  storeContact,
  storeJidMapping,
  type Message as DbMessage,
} from "./db/queries.ts";

export type WhatsAppSocket = ReturnType<typeof makeWASocket>;

export type ConnectionHooks = {
  onQr?: (qr: string) => void;
  onOpen?: (phoneJid: string | null) => void;
  onClose?: (loggedOut: boolean) => void;
};

function phoneFromJid(jid: string | undefined): string | null {
  if (!jid || !isJidUser(jid)) return null;
  return jid.split("@")[0] ?? null;
}

function contactToStore(
  sessionId: string,
  contact: Partial<Contact> & { id: string },
) {
  const jid = jidNormalizedUser(contact.id);
  const lid = contact.lid ? jidNormalizedUser(contact.lid) : null;
  const phoneJid = (contact as Contact & { phoneNumber?: string }).phoneNumber
    ? jidNormalizedUser(
        (contact as Contact & { phoneNumber?: string }).phoneNumber!,
      )
    : isJidUser(jid)
      ? jid
      : null;

  if (phoneJid && lid) {
    maybeStoreJidMapping(sessionId, phoneJid, lid);
  } else if (phoneJid && isLidUser(jid)) {
    maybeStoreJidMapping(sessionId, phoneJid, jid);
  } else if (isJidUser(jid) && lid) {
    maybeStoreJidMapping(sessionId, jid, lid);
  }

  return {
    jid,
    name: contact.name ?? null,
    notify: contact.notify ?? null,
    phoneNumber:
      phoneFromJid(phoneJid ?? undefined) ?? phoneFromJid(jid) ?? null,
  };
}

function maybeStoreJidMapping(
  sessionId: string,
  phoneJid: string | null,
  lid: string | null,
) {
  if (phoneJid && lid && isJidUser(phoneJid) && isLidUser(lid)) {
    storeJidMapping(
      sessionId,
      jidNormalizedUser(phoneJid),
      jidNormalizedUser(lid),
    );
  }
}

function storeChatWithLidMapping(
  sessionId: string,
  chat: {
    id?: string | null;
    lidJid?: string | null;
    name?: string | null;
    conversationTimestamp?: number | null;
  },
) {
  if (!chat.id) return;

  const jid = jidNormalizedUser(chat.id);
  storeChat(sessionId, {
    jid,
    name: chat.name ?? undefined,
    last_message_time: chat.conversationTimestamp
      ? new Date(Number(chat.conversationTimestamp) * 1000)
      : undefined,
  });

  if (chat.lidJid) {
    const lid = jidNormalizedUser(chat.lidJid);
    if (isJidUser(jid)) {
      maybeStoreJidMapping(sessionId, jid, lid);
    } else if (isLidUser(jid)) {
      maybeStoreJidMapping(sessionId, lid, jid);
    }
  }
}

function storeContactFromMessage(sessionId: string, msg: WAMessage): void {
  if (!msg.key?.remoteJid || isJidGroup(msg.key.remoteJid)) {
    return;
  }

  const jid = jidNormalizedUser(msg.key.remoteJid);
  const notify = msg.pushName?.trim() || null;

  storeContact(sessionId, {
    jid,
    notify,
    phoneNumber: phoneFromJid(jid),
  });

  if (notify) {
    storeChat(sessionId, { jid, name: notify });
  }
}

function parseMessageForDb(msg: WAMessage): DbMessage | null {
  if (!msg.message || !msg.key || !msg.key.remoteJid) {
    return null;
  }

  let content: string | null = null;

  if (msg.message.conversation) {
    content = msg.message.conversation;
  } else if (msg.message.extendedTextMessage?.text) {
    content = msg.message.extendedTextMessage.text;
  } else if (msg.message.imageMessage?.caption) {
    content = `[Image] ${msg.message.imageMessage.caption}`;
  } else if (msg.message.videoMessage?.caption) {
    content = `[Video] ${msg.message.videoMessage.caption}`;
  } else if (msg.message.documentMessage?.caption) {
    content = `[Document] ${
      msg.message.documentMessage.caption ||
      msg.message.documentMessage.fileName ||
      ""
    }`;
  } else if (msg.message.audioMessage) {
    content = `[Audio]`;
  } else if (msg.message.stickerMessage) {
    content = `[Sticker]`;
  } else if (msg.message.locationMessage?.address) {
    content = `[Location] ${msg.message.locationMessage.address}`;
  } else if (msg.message.contactMessage?.displayName) {
    content = `[Contact] ${msg.message.contactMessage.displayName}`;
  } else if (msg.message.pollCreationMessage?.name) {
    content = `[Poll] ${msg.message.pollCreationMessage.name}`;
  }

  if (!content) {
    return null;
  }

  let timestampSeconds: number;
  if (msg.messageTimestamp != null) {
    timestampSeconds = Number(msg.messageTimestamp);
  } else {
    timestampSeconds = Date.now() / 1000;
  }

  const timestamp = new Date(timestampSeconds * 1000);

  let senderJid: string | null | undefined = msg.key.participant;
  if (!msg.key.fromMe && !senderJid && !isJidGroup(msg.key.remoteJid)) {
    senderJid = msg.key.remoteJid;
  }
  if (msg.key.fromMe && !isJidGroup(msg.key.remoteJid)) {
    senderJid = null;
  }

  return {
    id: msg.key.id!,
    chat_jid: msg.key.remoteJid,
    sender: senderJid ? jidNormalizedUser(senderJid) : null,
    content: content,
    timestamp: timestamp,
    is_from_me: msg.key.fromMe ?? false,
  };
}

function bindSocketEvents(
  sessionId: string,
  sock: WhatsAppSocket,
  logger: P.Logger,
  saveCreds: () => Promise<void>,
  onOpen: () => void,
  onLoggedOut: () => void,
  scheduleReconnect: (dead: WhatsAppSocket) => void,
  onQr?: (qr: string) => void,
): () => void {
  return sock.ev.process(async (events) => {
    if (events["connection.update"]) {
      const update = events["connection.update"];
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        logger.info(
          { qrCodeData: qr },
          "QR Code Received. Scan with WhatsApp or open the qr_url from get_session.",
        );
        onQr?.(qr);
      }

      if (connection === "close") {
        const statusCode = (lastDisconnect?.error as any)?.output?.statusCode;
        logger.warn(
          `Connection closed. Reason: ${
            DisconnectReason[statusCode as number] || "Unknown"
          }`,
          lastDisconnect?.error,
        );
        if (statusCode !== DisconnectReason.loggedOut) {
          scheduleReconnect(sock);
        } else {
          onLoggedOut();
        }
      } else if (connection === "open") {
        logger.info(`Connection opened. WA user: ${sock.user?.name}`);
        onOpen();
      }
    }

    if (events["creds.update"]) {
      await saveCreds();
      logger.info("Credentials saved.");
    }

    if (events["messaging-history.set"]) {
      const { chats, contacts, messages } = events["messaging-history.set"];
      if (contacts.length > 0) {
        logger.info(`Storing ${contacts.length} contacts from history sync.`);
        contacts.forEach((c) => {
          storeContact(sessionId, contactToStore(sessionId, c));
        });
      }

      logger.info(`Storing ${chats.length} chats from history sync.`);
      chats.forEach((chat) => storeChatWithLidMapping(sessionId, chat));

      let storedCount = 0;
      messages.forEach((msg) => {
        const parsed = parseMessageForDb(msg);
        if (parsed) {
          storeMessage(sessionId, parsed);
          storedCount++;
        }
      });
      logger.info(`Stored ${storedCount} messages from history sync.`);
    }

    if (events["messages.upsert"]) {
      const { messages, type } = events["messages.upsert"];
      logger.info(
        { type, count: messages.length },
        "Received messages.upsert event",
      );

      if (type === "notify") {
        for (const msg of messages) {
          storeContactFromMessage(sessionId, msg);

          const parsed = parseMessageForDb(msg);
          if (parsed) {
            logger.info(
              {
                msgId: parsed.id,
                chatId: parsed.chat_jid,
                fromMe: parsed.is_from_me,
                sender: parsed.sender,
              },
              `Storing message: ${parsed.content.substring(0, 50)}...`,
            );
            storeMessage(sessionId, parsed);
          } else {
            logger.warn(
              { msgId: msg.key?.id, chatId: msg.key?.remoteJid },
              "Skipped storing message (parsing failed or unsupported type)",
            );
          }
        }
      }
    }

    if (events["chats.upsert"]) {
      logger.info(
        { count: events["chats.upsert"].length },
        "Received chats.upsert event",
      );
      for (const chat of events["chats.upsert"]) {
        storeChatWithLidMapping(sessionId, chat);
      }
    }

    if (events["chats.update"]) {
      logger.info(
        { count: events["chats.update"].length },
        "Received chats.update event",
      );
      for (const chatUpdate of events["chats.update"]) {
        storeChatWithLidMapping(sessionId, chatUpdate);
      }
    }

    if (events["chats.phoneNumberShare"]) {
      const { lid, jid } = events["chats.phoneNumberShare"];
      logger.info({ lid, jid }, "Received chats.phoneNumberShare event");
      const phoneJid = jidNormalizedUser(jid);
      const lidJid = jidNormalizedUser(lid);
      maybeStoreJidMapping(sessionId, phoneJid, lidJid);
      storeContact(sessionId, {
        jid: lidJid,
        phoneNumber: phoneFromJid(phoneJid),
      });
      storeContact(sessionId, {
        jid: phoneJid,
        phoneNumber: phoneFromJid(phoneJid),
      });
    }

    if (events["contacts.upsert"]) {
      logger.info(
        { count: events["contacts.upsert"].length },
        "Received contacts.upsert event",
      );
      for (const contact of events["contacts.upsert"]) {
        storeContact(sessionId, contactToStore(sessionId, contact));
      }
    }

    if (events["contacts.update"]) {
      logger.info(
        { count: events["contacts.update"].length },
        "Received contacts.update event",
      );
      for (const contact of events["contacts.update"]) {
        if (!contact.id?.includes("@")) continue;
        storeContact(
          sessionId,
          contactToStore(sessionId, contact as Contact),
        );
      }
    }
  });
}

export function hasAuthCreds(authDir: string): boolean {
  return existsSync(path.join(authDir, "creds.json"));
}

/**
 * Open a self-healing WhatsApp connection for one session.
 * Returns a stable Proxy that always delegates to the live socket,
 * plus a stop() to tear down reconnect loops.
 */
export async function startWhatsAppConnection(options: {
  sessionId: string;
  authDir: string;
  logger: P.Logger;
  hooks?: ConnectionHooks;
  /** When true, waits until connection opens (or times out). Default false for multi-session. */
  waitForOpen?: boolean;
}): Promise<{ socket: WhatsAppSocket; stop: () => void }> {
  const { sessionId, authDir, logger, hooks, waitForOpen = false } = options;

  const { state, saveCreds } = await useMultiFileAuthState(authDir);
  const { version, isLatest } = await fetchLatestBaileysVersion();
  logger.info(`Using WA v${version.join(".")}, isLatest: ${isLatest}`);

  let currentSock: WhatsAppSocket | null = null;
  let detach: (() => void) | null = null;
  let reconnecting = false;
  let stopped = false;
  let attempts = 0;
  const BASE_DELAY_MS = 1_000;
  const MAX_DELAY_MS = 30_000;

  let resolveInitialConnection: (() => void) | null = null;
  let rejectInitialConnection: ((err: Error) => void) | null = null;
  let initialConnectionResolved = false;

  const initialConnectionReady = waitForOpen
    ? new Promise<void>((resolve, reject) => {
        resolveInitialConnection = resolve;
        rejectInitialConnection = reject;
      })
    : Promise.resolve();

  const alreadyRegistered = Boolean(state.creds?.me?.id);
  let connectionTimeout: ReturnType<typeof setTimeout> | null = null;

  if (waitForOpen) {
    connectionTimeout = setTimeout(() => {
      if (!initialConnectionResolved) {
        rejectInitialConnection?.(
          new Error(
            alreadyRegistered
              ? "WA connection timeout after 30s"
              : "WA connection timeout after 120s (QR not scanned?)",
          ),
        );
        rejectInitialConnection = null;
        resolveInitialConnection = null;
      }
    }, alreadyRegistered ? 30_000 : 120_000);
  }

  const onOpen = () => {
    if (!initialConnectionResolved) {
      initialConnectionResolved = true;
      if (connectionTimeout) clearTimeout(connectionTimeout);
      resolveInitialConnection?.();
      resolveInitialConnection = null;
    }
    attempts = 0;
    const phoneJid = state.creds?.me?.id
      ? jidNormalizedUser(state.creds.me.id)
      : currentSock?.user?.id
        ? jidNormalizedUser(currentSock.user.id)
        : null;
    hooks?.onOpen?.(phoneJid);
  };

  const onLoggedOut = () => {
    if (connectionTimeout) clearTimeout(connectionTimeout);
    rejectInitialConnection?.(new Error("Logged out"));
    rejectInitialConnection = null;
    resolveInitialConnection = null;
    logger.error(
      "Connection closed: Logged Out. Delete the session or create a new one to re-authenticate.",
    );
    hooks?.onClose?.(true);
  };

  const teardown = (dead: WhatsAppSocket) => {
    if (currentSock === dead) {
      currentSock = null;
    }
    try {
      detach?.();
    } catch {}
    detach = null;
    try {
      dead.end(undefined);
    } catch {}
  };

  const scheduleReconnect = (dead: WhatsAppSocket) => {
    if (stopped || reconnecting) return;
    reconnecting = true;
    teardown(dead);
    hooks?.onClose?.(false);
    const delay = Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** attempts);
    attempts++;
    logger.info(`Reconnecting in ${delay}ms (attempt ${attempts})`);
    setTimeout(() => {
      reconnecting = false;
      if (!stopped) connect();
    }, delay);
  };

  const connect = () => {
    if (stopped) return;
    const sock = makeWASocket({
      version,
      logger,
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, logger),
      },
      syncFullHistory: false,
      shouldSyncHistoryMessage: () => false,
      generateHighQualityLinkPreview: true,
      shouldIgnoreJid: (jid) => isJidGroup(jid),
    });
    currentSock = sock;

    detach = bindSocketEvents(
      sessionId,
      sock,
      logger,
      saveCreds,
      onOpen,
      onLoggedOut,
      scheduleReconnect,
      hooks?.onQr,
    );
  };

  connect();

  if (waitForOpen) {
    await initialConnectionReady;
  }

  const socket = new Proxy({} as WhatsAppSocket, {
    get(_target, prop) {
      if (!currentSock) return undefined;
      const value = (currentSock as any)[prop];
      return typeof value === "function" ? value.bind(currentSock) : value;
    },
    set(_target, prop, value) {
      if (!currentSock) return true;
      (currentSock as any)[prop] = value;
      return true;
    },
  });

  const stop = () => {
    stopped = true;
    if (connectionTimeout) clearTimeout(connectionTimeout);
    if (currentSock) teardown(currentSock);
  };

  return { socket, stop };
}

export async function disconnectWhatsAppSession(
  sock: WhatsAppSocket | null,
): Promise<void> {
  if (!sock) return;
  try {
    sock.end(undefined);
  } catch {
    // ignore
  }
}

export async function sendWhatsAppMessage(
  logger: P.Logger,
  sessionId: string,
  sock: WhatsAppSocket | null,
  recipientJid: string,
  text: string,
): Promise<proto.WebMessageInfo | void> {
  if (!sock || !sock.user) {
    logger.error(
      "Cannot send message: WhatsApp socket not connected or initialized.",
    );
    return;
  }
  if (!recipientJid) {
    logger.error("Cannot send message: Recipient JID is missing.");
    return;
  }
  if (!text) {
    logger.error("Cannot send message: Message text is empty.");
    return;
  }

  try {
    logger.info(
      `Sending message to ${recipientJid}: ${text.substring(0, 50)}...`,
    );
    const normalizedJid = jidNormalizedUser(recipientJid);
    const result = await sock.sendMessage(normalizedJid, { text: text });
    storeContact(sessionId, {
      jid: normalizedJid,
      phoneNumber: phoneFromJid(normalizedJid),
    });
    logger.info({ msgId: result?.key.id }, "Message sent successfully");
    return result;
  } catch (error) {
    logger.error({ err: error, recipientJid }, "Failed to send message");
    return;
  }
}
