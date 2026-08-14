import { and, asc, desc, eq, lt, gt, or, sql } from "drizzle-orm";

import { getDb, getSqlite } from "./index.ts";
import {
  chats,
  contacts,
  jidMapping,
  messages,
  sessions,
  type SessionStatus,
} from "./schema.ts";

export interface Chat {
  jid: string;
  name?: string | null;
  last_message_time?: Date | null;
  last_message?: string | null;
  last_sender?: string | null;
  last_is_from_me?: boolean | null;
}

export type Message = {
  id: string;
  chat_jid: string;
  sender?: string | null;
  content: string;
  timestamp: Date;
  is_from_me: boolean;
  chat_name?: string | null;
};

function normalizeChatTimestamp(
  value: Date | string | null | undefined,
): string | null {
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (
    value == null ||
    String(value) === "undefined" ||
    String(value) === "null"
  ) {
    return null;
  }
  return String(value);
}

function parseDateSafe(dateString: string | null | undefined): Date | null {
  if (!dateString) return null;
  try {
    const date = new Date(dateString);
    return isNaN(date.getTime()) ? null : date;
  } catch {
    return null;
  }
}

function rowToMessage(row: {
  id: string;
  chatJid: string;
  sender: string | null;
  content: string;
  timestamp: string;
  isFromMe: boolean;
  chatName?: string | null;
}): Message {
  return {
    id: row.id,
    chat_jid: row.chatJid,
    sender: row.sender,
    content: row.content,
    timestamp: parseDateSafe(row.timestamp)!,
    is_from_me: Boolean(row.isFromMe),
    chat_name: row.chatName ?? null,
  };
}

function rowToChat(row: {
  jid: string;
  name: string | null;
  lastMessageTime: string | null;
  lastMessage?: string | null;
  lastSender?: string | null;
  lastIsFromMe?: boolean | number | null;
}): Chat {
  return {
    jid: row.jid,
    name: row.name,
    last_message_time: parseDateSafe(row.lastMessageTime),
    last_message: row.lastMessage ?? null,
    last_sender: row.lastSender ?? null,
    last_is_from_me:
      row.lastIsFromMe !== null && row.lastIsFromMe !== undefined
        ? Boolean(row.lastIsFromMe)
        : null,
  };
}

export function createSessionRow(id: string, name: string): void {
  const db = getDb();
  db.insert(sessions)
    .values({
      id,
      name,
      status: "connecting",
    })
    .run();
}

export function listSessionRows() {
  const db = getDb();
  return db.select().from(sessions).orderBy(asc(sessions.createdAt)).all();
}

export function getSessionRow(id: string) {
  const db = getDb();
  return db.select().from(sessions).where(eq(sessions.id, id)).get();
}

export function getSessionRowByName(name: string) {
  const db = getDb();
  return db.select().from(sessions).where(eq(sessions.name, name)).get();
}

export function updateSessionRow(
  id: string,
  patch: {
    status?: SessionStatus;
    phoneJid?: string | null;
    name?: string;
  },
): void {
  const db = getDb();
  db.update(sessions)
    .set({
      ...patch,
      updatedAt: sql`(datetime('now'))`,
    })
    .where(eq(sessions.id, id))
    .run();
}

export function deleteSessionRow(id: string): void {
  const db = getDb();
  db.delete(sessions).where(eq(sessions.id, id)).run();
}

export function chatExists(sessionId: string, jid: string): boolean {
  const db = getDb();
  const row = db
    .select({ jid: chats.jid })
    .from(chats)
    .where(and(eq(chats.sessionId, sessionId), eq(chats.jid, jid)))
    .get();
  return row != null;
}

export function storeJidMapping(
  sessionId: string,
  phoneJid: string,
  lid: string,
): void {
  const db = getDb();
  try {
    db.insert(jidMapping)
      .values({ sessionId, phoneJid, lid })
      .onConflictDoNothing()
      .run();
  } catch (error) {
    console.error("Error storing jid mapping:", error);
  }
}

function lookupMappedJid(sessionId: string, jid: string): string | null {
  const db = getDb();
  const asPhone = db
    .select({ lid: jidMapping.lid })
    .from(jidMapping)
    .where(
      and(eq(jidMapping.sessionId, sessionId), eq(jidMapping.phoneJid, jid)),
    )
    .get();
  if (asPhone?.lid) return asPhone.lid;

  const asLid = db
    .select({ phoneJid: jidMapping.phoneJid })
    .from(jidMapping)
    .where(and(eq(jidMapping.sessionId, sessionId), eq(jidMapping.lid, jid)))
    .get();
  return asLid?.phoneJid ?? null;
}

function chatHasMessages(sessionId: string, jid: string): boolean {
  const db = getDb();
  const row = db
    .select({ id: messages.id })
    .from(messages)
    .where(and(eq(messages.sessionId, sessionId), eq(messages.chatJid, jid)))
    .limit(1)
    .get();
  return row != null;
}

/** Resolve phone JID, LID, or bare number to the chat JID stored in the DB. */
export function resolveChatJid(sessionId: string, input: string): string {
  let jid = input.trim();
  if (!jid.includes("@")) {
    const digits = jid.replace(/\D/g, "");
    jid = digits ? `${digits}@s.whatsapp.net` : jid;
  }

  const mapped = lookupMappedJid(sessionId, jid);
  const candidates = [jid, mapped].filter(
    (value, index, arr): value is string =>
      Boolean(value) && arr.indexOf(value) === index,
  );

  for (const candidate of candidates) {
    if (chatHasMessages(sessionId, candidate)) return candidate;
  }

  for (const candidate of candidates) {
    if (chatExists(sessionId, candidate)) return candidate;
  }

  const db = getDb();
  const phonePart = jid.split("@")[0];
  const contactRow = db
    .select({ jid: contacts.jid })
    .from(contacts)
    .where(
      and(
        eq(contacts.sessionId, sessionId),
        or(
          eq(contacts.phoneNumber, phonePart),
          eq(contacts.jid, jid),
          like(contacts.phoneNumber, `%${phonePart}%`),
        ),
      ),
    )
    .limit(1)
    .get();

  if (contactRow?.jid) {
    if (chatHasMessages(sessionId, contactRow.jid)) return contactRow.jid;
    if (chatExists(sessionId, contactRow.jid)) return contactRow.jid;
    const contactMapped = lookupMappedJid(sessionId, contactRow.jid);
    if (contactMapped && chatHasMessages(sessionId, contactMapped)) {
      return contactMapped;
    }
    if (contactMapped && chatExists(sessionId, contactMapped)) {
      return contactMapped;
    }
  }

  return mapped ?? jid;
}

export function storeChat(
  sessionId: string,
  chat: Partial<Chat> & { jid: string },
): void {
  const db = getDb();
  try {
    const lastMessageTime = normalizeChatTimestamp(chat.last_message_time);
    db.insert(chats)
      .values({
        sessionId,
        jid: chat.jid,
        name: chat.name ?? null,
        lastMessageTime,
      })
      .onConflictDoUpdate({
        target: [chats.sessionId, chats.jid],
        set: {
          name: sql`COALESCE(excluded.name, ${chats.name})`,
          lastMessageTime: sql`COALESCE(excluded.last_message_time, ${chats.lastMessageTime})`,
        },
      })
      .run();
  } catch (error) {
    console.error("Error storing chat:", error);
  }
}

export function storeMessage(sessionId: string, message: Message): void {
  const db = getDb();
  try {
    storeChat(sessionId, {
      jid: message.chat_jid,
      last_message_time: message.timestamp,
    });

    db.insert(messages)
      .values({
        sessionId,
        id: message.id,
        chatJid: message.chat_jid,
        sender: message.sender ?? null,
        content: message.content,
        timestamp: message.timestamp.toISOString(),
        isFromMe: message.is_from_me,
      })
      .onConflictDoUpdate({
        target: [messages.sessionId, messages.id, messages.chatJid],
        set: {
          sender: message.sender ?? null,
          content: message.content,
          timestamp: message.timestamp.toISOString(),
          isFromMe: message.is_from_me,
        },
      })
      .run();

    const ts = message.timestamp.toISOString();
    db.update(chats)
      .set({
        lastMessageTime: sql`MAX(COALESCE(${chats.lastMessageTime}, '1970-01-01T00:00:00.000Z'), ${ts})`,
      })
      .where(
        and(eq(chats.sessionId, sessionId), eq(chats.jid, message.chat_jid)),
      )
      .run();
  } catch (error) {
    console.error("Error storing message:", error);
  }
}

export function getMessages(
  sessionId: string,
  chatJid: string,
  limit: number = 20,
  page: number = 0,
): Message[] {
  const db = getDb();
  const resolvedJid = resolveChatJid(sessionId, chatJid);
  try {
    const offset = page * limit;
    const rows = db
      .select({
        id: messages.id,
        chatJid: messages.chatJid,
        sender: messages.sender,
        content: messages.content,
        timestamp: messages.timestamp,
        isFromMe: messages.isFromMe,
        chatName: chats.name,
      })
      .from(messages)
      .innerJoin(
        chats,
        and(
          eq(messages.sessionId, chats.sessionId),
          eq(messages.chatJid, chats.jid),
        ),
      )
      .where(
        and(
          eq(messages.sessionId, sessionId),
          eq(messages.chatJid, resolvedJid),
        ),
      )
      .orderBy(desc(messages.timestamp))
      .limit(limit)
      .offset(offset)
      .all();

    return rows.map(rowToMessage);
  } catch (error) {
    console.error("Error getting messages:", error);
    return [];
  }
}

export function getChats(
  sessionId: string,
  limit: number = 20,
  page: number = 0,
  sortBy: "last_active" | "name" = "last_active",
  query?: string | null,
  includeLastMessage: boolean = true,
): Chat[] {
  try {
    const offset = page * limit;
    const sqlite = getSqlite();

    let sqlQuery = `
      SELECT
        c.jid,
        COALESCE(c.name, ct.name, ct.notify, ct.phone_number) as name,
        c.last_message_time as lastMessageTime
        ${
          includeLastMessage
            ? `,
        (SELECT m.content FROM messages m WHERE m.session_id = c.session_id AND m.chat_jid = c.jid ORDER BY m.timestamp DESC LIMIT 1) as lastMessage,
        (SELECT m.sender FROM messages m WHERE m.session_id = c.session_id AND m.chat_jid = c.jid ORDER BY m.timestamp DESC LIMIT 1) as lastSender,
        (SELECT m.is_from_me FROM messages m WHERE m.session_id = c.session_id AND m.chat_jid = c.jid ORDER BY m.timestamp DESC LIMIT 1) as lastIsFromMe
        `
            : ""
        }
      FROM chats c
      LEFT JOIN contacts ct ON c.session_id = ct.session_id AND c.jid = ct.jid
      WHERE c.session_id = ?
    `;

    const params: (string | number)[] = [sessionId];

    if (query) {
      sqlQuery += ` AND (LOWER(COALESCE(c.name, ct.name, ct.notify, ct.phone_number)) LIKE LOWER(?) OR c.jid LIKE ?)`;
      params.push(`%${query}%`, `%${query}%`);
    }

    const orderByClause =
      sortBy === "last_active"
        ? "c.last_message_time DESC NULLS LAST"
        : "COALESCE(c.name, ct.name, ct.notify, ct.phone_number) ASC";
    sqlQuery += ` ORDER BY ${orderByClause}, c.jid ASC`;
    sqlQuery += ` LIMIT ? OFFSET ?`;
    params.push(limit, offset);

    const rows = sqlite.prepare(sqlQuery).all(...params) as Array<{
      jid: string;
      name: string | null;
      lastMessageTime: string | null;
      lastMessage?: string | null;
      lastSender?: string | null;
      lastIsFromMe?: number | null;
    }>;

    return rows.map(rowToChat);
  } catch (error) {
    console.error("Error getting chats:", error);
    return [];
  }
}

export function getChat(
  sessionId: string,
  jid: string,
  includeLastMessage: boolean = true,
): Chat | null {
  const resolvedJid = resolveChatJid(sessionId, jid);
  try {
    const sqlite = getSqlite();
    const sqlQuery = `
      SELECT
        c.jid,
        COALESCE(c.name, ct.name, ct.notify, ct.phone_number) as name,
        c.last_message_time as lastMessageTime
        ${
          includeLastMessage
            ? `,
        (SELECT m.content FROM messages m WHERE m.session_id = c.session_id AND m.chat_jid = c.jid ORDER BY m.timestamp DESC LIMIT 1) as lastMessage,
        (SELECT m.sender FROM messages m WHERE m.session_id = c.session_id AND m.chat_jid = c.jid ORDER BY m.timestamp DESC LIMIT 1) as lastSender,
        (SELECT m.is_from_me FROM messages m WHERE m.session_id = c.session_id AND m.chat_jid = c.jid ORDER BY m.timestamp DESC LIMIT 1) as lastIsFromMe
        `
            : ""
        }
      FROM chats c
      LEFT JOIN contacts ct ON c.session_id = ct.session_id AND c.jid = ct.jid
      WHERE c.session_id = ? AND c.jid = ?
    `;

    const row = sqlite.prepare(sqlQuery).get(sessionId, resolvedJid) as
      | {
          jid: string;
          name: string | null;
          lastMessageTime: string | null;
          lastMessage?: string | null;
          lastSender?: string | null;
          lastIsFromMe?: number | null;
        }
      | undefined;

    return row ? rowToChat(row) : null;
  } catch (error) {
    console.error("Error getting chat:", error);
    return null;
  }
}

export function getMessagesAround(
  sessionId: string,
  messageId: string,
  before: number = 5,
  after: number = 5,
): { before: Message[]; target: Message | null; after: Message[] } {
  const db = getDb();
  const result: {
    before: Message[];
    target: Message | null;
    after: Message[];
  } = { before: [], target: null, after: [] };

  try {
    const targetRow = db
      .select({
        id: messages.id,
        chatJid: messages.chatJid,
        sender: messages.sender,
        content: messages.content,
        timestamp: messages.timestamp,
        isFromMe: messages.isFromMe,
        chatName: chats.name,
      })
      .from(messages)
      .innerJoin(
        chats,
        and(
          eq(messages.sessionId, chats.sessionId),
          eq(messages.chatJid, chats.jid),
        ),
      )
      .where(
        and(eq(messages.sessionId, sessionId), eq(messages.id, messageId)),
      )
      .get();

    if (!targetRow) {
      return result;
    }
    result.target = rowToMessage(targetRow);
    const targetTimestamp = result.target.timestamp.toISOString();
    const chatJid = result.target.chat_jid;

    const beforeRows = db
      .select({
        id: messages.id,
        chatJid: messages.chatJid,
        sender: messages.sender,
        content: messages.content,
        timestamp: messages.timestamp,
        isFromMe: messages.isFromMe,
        chatName: chats.name,
      })
      .from(messages)
      .innerJoin(
        chats,
        and(
          eq(messages.sessionId, chats.sessionId),
          eq(messages.chatJid, chats.jid),
        ),
      )
      .where(
        and(
          eq(messages.sessionId, sessionId),
          eq(messages.chatJid, chatJid),
          lt(messages.timestamp, targetTimestamp),
        ),
      )
      .orderBy(desc(messages.timestamp))
      .limit(before)
      .all();
    result.before = beforeRows.map(rowToMessage).reverse();

    const afterRows = db
      .select({
        id: messages.id,
        chatJid: messages.chatJid,
        sender: messages.sender,
        content: messages.content,
        timestamp: messages.timestamp,
        isFromMe: messages.isFromMe,
        chatName: chats.name,
      })
      .from(messages)
      .innerJoin(
        chats,
        and(
          eq(messages.sessionId, chats.sessionId),
          eq(messages.chatJid, chats.jid),
        ),
      )
      .where(
        and(
          eq(messages.sessionId, sessionId),
          eq(messages.chatJid, chatJid),
          gt(messages.timestamp, targetTimestamp),
        ),
      )
      .orderBy(asc(messages.timestamp))
      .limit(after)
      .all();
    result.after = afterRows.map(rowToMessage);

    return result;
  } catch (error) {
    console.error("Error getting messages around:", error);
    return result;
  }
}

export function searchDbForContacts(
  sessionId: string,
  query: string,
  limit: number = 20,
): { jid: string; name: string | null }[] {
  try {
    const pattern = `%${query}%`;
    const sqlite = getSqlite();

    const rows = sqlite
      .prepare(
        `
      SELECT jid, display_name FROM (
        SELECT
          jid,
          COALESCE(name, notify, phone_number, jid) AS display_name
        FROM contacts
        WHERE session_id = ?
          AND LOWER(COALESCE(name, notify, phone_number, jid)) LIKE LOWER(?)

        UNION

        SELECT
          c.jid,
          COALESCE(c.name, ct.name, ct.notify, ct.phone_number, c.jid) AS display_name
        FROM chats c
        LEFT JOIN contacts ct ON c.session_id = ct.session_id AND c.jid = ct.jid
        WHERE c.session_id = ?
          AND LOWER(COALESCE(c.name, ct.name, ct.notify, ct.phone_number, c.jid)) LIKE LOWER(?)
          AND c.jid NOT IN (SELECT jid FROM contacts WHERE session_id = ?)
      )
      LIMIT ?
    `,
      )
      .all(sessionId, pattern, sessionId, pattern, sessionId, limit) as Array<{
      jid: string;
      display_name: string | null;
    }>;

    return rows.map((r) => ({
      jid: r.jid,
      name: r.display_name,
    }));
  } catch (error) {
    console.error("Error searching contacts:", error);
    return [];
  }
}

export function searchMessages(
  sessionId: string,
  searchQuery: string,
  chatJid?: string | null,
  limit: number = 10,
  page: number = 0,
): Message[] {
  try {
    const offset = page * limit;
    const searchPattern = `%${searchQuery}%`;
    const sqlite = getSqlite();
    let sqlQuery = `
      SELECT m.id, m.chat_jid as chatJid, m.sender, m.content, m.timestamp,
             m.is_from_me as isFromMe,
             COALESCE(c.name, ct.name, ct.notify, ct.phone_number) as chatName
      FROM messages m
      JOIN chats c ON m.session_id = c.session_id AND m.chat_jid = c.jid
      LEFT JOIN contacts ct ON c.session_id = ct.session_id AND c.jid = ct.jid
      WHERE m.session_id = ? AND LOWER(m.content) LIKE LOWER(?)
    `;
    const params: (string | number)[] = [sessionId, searchPattern];

    if (chatJid) {
      sqlQuery += ` AND m.chat_jid = ?`;
      params.push(resolveChatJid(sessionId, chatJid));
    }

    sqlQuery += ` ORDER BY m.timestamp DESC LIMIT ? OFFSET ?`;
    params.push(limit, offset);

    const rows = sqlite.prepare(sqlQuery).all(...params) as Array<{
      id: string;
      chatJid: string;
      sender: string | null;
      content: string;
      timestamp: string;
      isFromMe: number;
      chatName: string | null;
    }>;

    return rows.map((row) =>
      rowToMessage({
        ...row,
        isFromMe: Boolean(row.isFromMe),
      }),
    );
  } catch (error) {
    console.error("Error searching messages:", error);
    return [];
  }
}

export function storeContact(
  sessionId: string,
  contact: {
    jid: string;
    name?: string | null;
    notify?: string | null;
    phoneNumber?: string | null;
  },
): void {
  const db = getDb();
  try {
    db.insert(contacts)
      .values({
        sessionId,
        jid: contact.jid,
        name: contact.name ?? null,
        notify: contact.notify ?? null,
        phoneNumber: contact.phoneNumber ?? null,
      })
      .onConflictDoUpdate({
        target: [contacts.sessionId, contacts.jid],
        set: {
          name: sql`COALESCE(excluded.name, ${contacts.name})`,
          notify: sql`COALESCE(excluded.notify, ${contacts.notify})`,
          phoneNumber: sql`COALESCE(excluded.phone_number, ${contacts.phoneNumber})`,
        },
      })
      .run();
  } catch (error) {
    console.error("Error storing contact:", error);
  }
}
