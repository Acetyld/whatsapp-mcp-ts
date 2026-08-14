import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import fs from "node:fs";

const DATA_DIR = path.join(import.meta.dirname, "..", "data");
const DB_PATH = path.join(DATA_DIR, "whatsapp.db");

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

let dbInstance: DatabaseSync | null = null;

function getDb(): DatabaseSync {
  if (!dbInstance) {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
    dbInstance = new DatabaseSync(DB_PATH);
  }
  return dbInstance;
}

export function initializeDatabase(): DatabaseSync {
  const db = getDb();

  db.exec("PRAGMA journal_mode = WAL");

  db.exec(`
        CREATE TABLE IF NOT EXISTS chats (
            jid TEXT PRIMARY KEY,
            name TEXT,
            last_message_time TEXT -- Store dates as ISO strings
        );
    `);

  db.exec(`
        CREATE TABLE IF NOT EXISTS messages (
            id TEXT,
            chat_jid TEXT,
            sender TEXT,      -- JID of the sender (can be group participant or contact)
            content TEXT,
            timestamp TEXT, -- Store dates as ISO strings
            is_from_me INTEGER, -- Store booleans as 0 or 1
            PRIMARY KEY (id, chat_jid),
            FOREIGN KEY (chat_jid) REFERENCES chats(jid) ON DELETE CASCADE
        );
    `);

  db.exec(`
      CREATE TABLE IF NOT EXISTS contacts (
        jid TEXT PRIMARY KEY,
        name TEXT,
        notify TEXT,
        phone_number TEXT
      );
    `);

  db.exec(`
      CREATE TABLE IF NOT EXISTS jid_mapping (
        phone_jid TEXT NOT NULL,
        lid TEXT NOT NULL,
        created_at TEXT DEFAULT (datetime('now')),
        PRIMARY KEY (phone_jid, lid)
      );
    `);

  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_jid_mapping_lid ON jid_mapping (lid);`,
  );
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_jid_mapping_phone ON jid_mapping (phone_jid);`,
  );

  db.exec(
    `UPDATE chats SET last_message_time = NULL WHERE last_message_time IN ('undefined', 'null', '');`,
  );

  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_messages_timestamp ON messages (timestamp);`,
  );
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_messages_chat_jid ON messages (chat_jid);`,
  );
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_messages_sender ON messages (sender);`,
  );
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_chats_last_message_time ON chats (last_message_time);`,
  );

  return db;
}

function normalizeChatTimestamp(
  value: Date | string | null | undefined,
): string | null {
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (value == null || String(value) === "undefined" || String(value) === "null") {
    return null;
  }
  return String(value);
}

export function chatExists(jid: string): boolean {
  const db = getDb();
  const row = db.prepare("SELECT 1 FROM chats WHERE jid = ?").get(jid);
  return row != null;
}

export function storeJidMapping(phoneJid: string, lid: string): void {
  const db = getDb();
  try {
    const stmt = db.prepare(`
      INSERT INTO jid_mapping (phone_jid, lid)
      VALUES (@phone_jid, @lid)
      ON CONFLICT(phone_jid, lid) DO NOTHING
    `);
    stmt.run({ phone_jid: phoneJid, lid });
  } catch (error) {
    console.error("Error storing jid mapping:", error);
  }
}

function lookupMappedJid(jid: string): string | null {
  const db = getDb();
  const asPhone = db
    .prepare("SELECT lid FROM jid_mapping WHERE phone_jid = ? LIMIT 1")
    .get(jid) as { lid: string } | undefined;
  if (asPhone?.lid) return asPhone.lid;

  const asLid = db
    .prepare("SELECT phone_jid FROM jid_mapping WHERE lid = ? LIMIT 1")
    .get(jid) as { phone_jid: string } | undefined;
  return asLid?.phone_jid ?? null;
}

function chatHasMessages(jid: string): boolean {
  const db = getDb();
  const row = db
    .prepare("SELECT 1 FROM messages WHERE chat_jid = ? LIMIT 1")
    .get(jid);
  return row != null;
}

/** Resolve phone JID, LID, or bare number to the chat JID stored in the DB. */
export function resolveChatJid(input: string): string {
  let jid = input.trim();
  if (!jid.includes("@")) {
    const digits = jid.replace(/\D/g, "");
    jid = digits ? `${digits}@s.whatsapp.net` : jid;
  }

  const mapped = lookupMappedJid(jid);
  const candidates = [jid, mapped].filter(
    (value, index, arr): value is string =>
      Boolean(value) && arr.indexOf(value) === index,
  );

  // Prefer the JID that actually has messages (LID chats often hold them).
  for (const candidate of candidates) {
    if (chatHasMessages(candidate)) return candidate;
  }

  for (const candidate of candidates) {
    if (chatExists(candidate)) return candidate;
  }

  const db = getDb();
  const phonePart = jid.split("@")[0];
  const contactRow = db
    .prepare(
      `SELECT jid FROM contacts
       WHERE phone_number = ? OR jid = ? OR phone_number LIKE ?
       LIMIT 1`,
    )
    .get(phonePart, jid, `%${phonePart}%`) as { jid: string } | undefined;
  if (contactRow?.jid) {
    if (chatHasMessages(contactRow.jid)) return contactRow.jid;
    if (chatExists(contactRow.jid)) return contactRow.jid;
    const contactMapped = lookupMappedJid(contactRow.jid);
    if (contactMapped && chatHasMessages(contactMapped)) return contactMapped;
    if (contactMapped && chatExists(contactMapped)) return contactMapped;
  }

  // Prefer mapped LID when phone chat is empty / missing.
  return mapped ?? jid;
}

export function storeChat(chat: Partial<Chat> & { jid: string }): void {
  const db = getDb();
  try {
    const stmt = db.prepare(`
            INSERT INTO chats (jid, name, last_message_time)
            VALUES (@jid, @name, @last_message_time)
            ON CONFLICT(jid) DO UPDATE SET
                name = COALESCE(excluded.name, name),
                last_message_time = COALESCE(excluded.last_message_time, last_message_time)
        `);
    stmt.run({
      jid: chat.jid,
      name: chat.name ?? null,
      last_message_time: normalizeChatTimestamp(chat.last_message_time),
    });
  } catch (error) {
    console.error("Error storing chat:", error);
  }
}

export function storeMessage(message: Message): void {
  const db = getDb();
  try {
    storeChat({ jid: message.chat_jid, last_message_time: message.timestamp });

    const stmt = db.prepare(`
            INSERT OR REPLACE INTO messages (id, chat_jid, sender, content, timestamp, is_from_me)
            VALUES (@id, @chat_jid, @sender, @content, @timestamp, @is_from_me)
        `);

    stmt.run({
      id: message.id,
      chat_jid: message.chat_jid,
      sender: message.sender ?? null,
      content: message.content,
      timestamp: message.timestamp.toISOString(),
      is_from_me: message.is_from_me ? 1 : 0,
    });

    const updateChatTimeStmt = db.prepare(`
            UPDATE chats
            SET last_message_time = MAX(COALESCE(last_message_time, '1970-01-01T00:00:00.000Z'), @timestamp)
            WHERE jid = @jid
        `);
    updateChatTimeStmt.run({
      timestamp: message.timestamp.toISOString(),
      jid: message.chat_jid,
    });
  } catch (error) {
    console.error("Error storing message:", error);
  }
}

function parseDateSafe(dateString: string | null | undefined): Date | null {
  if (!dateString) return null;
  try {
    const date = new Date(dateString);
    return isNaN(date.getTime()) ? null : date;
  } catch (e) {
    return null;
  }
}

function rowToMessage(row: any): Message {
  return {
    id: row.id,
    chat_jid: row.chat_jid,
    sender: row.sender,
    content: row.content,
    timestamp: parseDateSafe(row.timestamp)!,
    is_from_me: Boolean(row.is_from_me),
    chat_name: row.chat_name,
  };
}

function rowToChat(row: any): Chat {
  return {
    jid: row.jid,
    name: row.name,
    last_message_time: parseDateSafe(row.last_message_time),
    last_message: row.last_message,
    last_sender: row.last_sender,
    last_is_from_me:
      row.last_is_from_me !== null ? Boolean(row.last_is_from_me) : null,
  };
}

export function getMessages(
  chatJid: string,
  limit: number = 20,
  page: number = 0,
): Message[] {
  const db = getDb();
  const resolvedJid = resolveChatJid(chatJid);
  try {
    const offset = page * limit;
    const stmt = db.prepare(`
            SELECT m.*, c.name as chat_name
            FROM messages m
            JOIN chats c ON m.chat_jid = c.jid
            WHERE m.chat_jid = ? -- Positional parameter 1
            ORDER BY m.timestamp DESC
            LIMIT ?             -- Positional parameter 2
            OFFSET ?            -- Positional parameter 3
        `);
    const rows = stmt.all(resolvedJid, limit, offset) as any[];
    return rows.map(rowToMessage);
  } catch (error) {
    console.error("Error getting messages:", error);
    return [];
  }
}

export function getChats(
  limit: number = 20,
  page: number = 0,
  sortBy: "last_active" | "name" = "last_active",
  query?: string | null,
  includeLastMessage: boolean = true,
): Chat[] {
  const db = getDb();
  try {
    const offset = page * limit;
    let sql = `
            SELECT
                c.jid,
                COALESCE(c.name, ct.name, ct.notify, ct.phone_number) as name,
                c.last_message_time
                ${
                  includeLastMessage
                    ? `,
                (SELECT m.content FROM messages m WHERE m.chat_jid = c.jid ORDER BY m.timestamp DESC LIMIT 1) as last_message,
                (SELECT m.sender FROM messages m WHERE m.chat_jid = c.jid ORDER BY m.timestamp DESC LIMIT 1) as last_sender,
                (SELECT m.is_from_me FROM messages m WHERE m.chat_jid = c.jid ORDER BY m.timestamp DESC LIMIT 1) as last_is_from_me
                `
                    : ""
                }
            FROM chats c
            LEFT JOIN contacts ct ON c.jid = ct.jid
        `;

    const params: (string | number)[] = [];

    if (query) {
      sql += ` WHERE (LOWER(COALESCE(c.name, ct.name, ct.notify, ct.phone_number)) LIKE LOWER(?) OR c.jid LIKE ?)`;
      params.push(`%${query}%`, `%${query}%`);
    }

    const orderByClause =
      sortBy === "last_active"
        ? "c.last_message_time DESC NULLS LAST"
        : "COALESCE(c.name, ct.name, ct.notify, ct.phone_number) ASC";
    sql += ` ORDER BY ${orderByClause}, c.jid ASC`;

    sql += ` LIMIT ? OFFSET ?`;
    params.push(limit, offset);

    const stmt = db.prepare(sql);
    const rows = stmt.all(...params) as any[];
    return rows.map(rowToChat);
  } catch (error) {
    console.error("Error getting chats:", error);
    return [];
  }
}

export function getChat(
  jid: string,
  includeLastMessage: boolean = true,
): Chat | null {
  const db = getDb();
  const resolvedJid = resolveChatJid(jid);
  try {
    let sql = `
            SELECT
                c.jid,
                COALESCE(c.name, ct.name, ct.notify, ct.phone_number) as name,
                c.last_message_time
                ${
                  includeLastMessage
                    ? `,
                (SELECT m.content FROM messages m WHERE m.chat_jid = c.jid ORDER BY m.timestamp DESC LIMIT 1) as last_message,
                (SELECT m.sender FROM messages m WHERE m.chat_jid = c.jid ORDER BY m.timestamp DESC LIMIT 1) as last_sender,
                (SELECT m.is_from_me FROM messages m WHERE m.chat_jid = c.jid ORDER BY m.timestamp DESC LIMIT 1) as last_is_from_me
                `
                    : ""
                }
            FROM chats c
            LEFT JOIN contacts ct ON c.jid = ct.jid
            WHERE c.jid = ? -- Positional parameter 1
        `;

    const stmt = db.prepare(sql);
    const row = stmt.get(resolvedJid) as any | undefined;
    return row ? rowToChat(row) : null;
  } catch (error) {
    console.error("Error getting chat:", error);
    return null;
  }
}

export function getMessagesAround(
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
    const targetStmt = db.prepare(`
             SELECT m.*, c.name as chat_name
             FROM messages m
             JOIN chats c ON m.chat_jid = c.jid
             WHERE m.id = ? -- Positional parameter 1
        `);
    const targetRow = targetStmt.get(messageId) as any | undefined;

    if (!targetRow) {
      return result;
    }
    result.target = rowToMessage(targetRow);
    const targetTimestamp = result.target.timestamp.toISOString();
    const chatJid = result.target.chat_jid;

    const beforeStmt = db.prepare(`
            SELECT m.*, c.name as chat_name
            FROM messages m
            JOIN chats c ON m.chat_jid = c.jid
            WHERE m.chat_jid = ? AND m.timestamp < ? -- Positional params 1, 2
            ORDER BY m.timestamp DESC
            LIMIT ?                                  -- Positional param 3
        `);
    const beforeRows = beforeStmt.all(
      chatJid,
      targetTimestamp,
      before,
    ) as any[];
    result.before = beforeRows.map(rowToMessage).reverse();

    const afterStmt = db.prepare(`
            SELECT m.*, c.name as chat_name
            FROM messages m
            JOIN chats c ON m.chat_jid = c.jid
            WHERE m.chat_jid = ? AND m.timestamp > ? -- Positional params 1, 2
            ORDER BY m.timestamp ASC
            LIMIT ?                                  -- Positional param 3
        `);
    const afterRows = afterStmt.all(chatJid, targetTimestamp, after) as any[];
    result.after = afterRows.map(rowToMessage);

    return result;
  } catch (error) {
    console.error("Error getting messages around:", error);
    return result;
  }
}

export function searchDbForContacts(
  query: string,
  limit: number = 20
): { jid: string; name: string | null }[] {
  const db = getDb();
  try {
    const pattern = `%${query}%`;

    const stmt = db.prepare(`
      SELECT jid, display_name FROM (
        SELECT
          jid,
          COALESCE(name, notify, phone_number, jid) AS display_name
        FROM contacts
        WHERE LOWER(COALESCE(name, notify, phone_number, jid)) LIKE LOWER(?)

        UNION

        SELECT
          c.jid,
          COALESCE(c.name, ct.name, ct.notify, ct.phone_number, c.jid) AS display_name
        FROM chats c
        LEFT JOIN contacts ct ON c.jid = ct.jid
        WHERE LOWER(COALESCE(c.name, ct.name, ct.notify, ct.phone_number, c.jid)) LIKE LOWER(?)
          AND c.jid NOT IN (SELECT jid FROM contacts)
      )
      LIMIT ?
    `);

    const rows = stmt.all(pattern, pattern, limit) as {
      jid: string;
      display_name: string | null;
    }[];

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
  searchQuery: string,
  chatJid?: string | null,
  limit: number = 10,
  page: number = 0,
): Message[] {
  const db = getDb();
  try {
    const offset = page * limit;
    const searchPattern = `%${searchQuery}%`;
    let sql = `
            SELECT m.*, COALESCE(c.name, ct.name, ct.notify, ct.phone_number) as chat_name
            FROM messages m
            JOIN chats c ON m.chat_jid = c.jid
            LEFT JOIN contacts ct ON c.jid = ct.jid
            WHERE LOWER(m.content) LIKE LOWER(?) -- Param 1: searchPattern
        `;
    const params: (string | number | null)[] = [searchPattern];

    if (chatJid) {
      sql += ` AND m.chat_jid = ?`;
      params.push(resolveChatJid(chatJid));
    }

    sql += ` ORDER BY m.timestamp DESC`;
    sql += ` LIMIT ?`;
    params.push(limit);
    sql += ` OFFSET ?`;
    params.push(offset);

    const stmt = db.prepare(sql);
    const rows = stmt.all(...params) as any[];
    return rows.map(rowToMessage);
  } catch (error) {
    console.error("Error searching messages:", error);
    return [];
  }
}

export function closeDatabase(): void {
  if (dbInstance) {
    try {
      dbInstance.close();
      dbInstance = null;
      console.log("Database connection closed.");
    } catch (error) {
      console.error("Error closing database:", error);
    }
  }
}

export function storeContact(contact: {
  jid: string;
  name?: string | null;
  notify?: string | null;
  phoneNumber?: string | null;
}): void {
  const db = getDb();
  try {
    const stmt = db.prepare(`
      INSERT INTO contacts (jid, name, notify, phone_number)
      VALUES (@jid, @name, @notify, @phone_number)
      ON CONFLICT(jid) DO UPDATE SET
        name = COALESCE(excluded.name, name),
        notify = COALESCE(excluded.notify, notify),
        phone_number = COALESCE(excluded.phone_number, phone_number)
    `);

    stmt.run({
      jid: contact.jid,
      name: contact.name ?? null,
      notify: contact.notify ?? null,
      phone_number: contact.phoneNumber ?? null,
    });
  } catch (error) {
    console.error("Error storing contact:", error);
  }
}
