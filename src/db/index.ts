import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { mkdirSync } from "node:fs";
import path from "node:path";

import * as schema from "./schema.ts";

const DATA_DIR = path.join(import.meta.dirname, "..", "..", "data");
export const DB_PATH = path.join(DATA_DIR, "whatsapp.db");

let sqlite: Database | null = null;
let dbInstance: ReturnType<typeof drizzle<typeof schema>> | null = null;

export type AppDb = ReturnType<typeof drizzle<typeof schema>>;

export function getSqlite(): Database {
  if (!sqlite) {
    mkdirSync(DATA_DIR, { recursive: true });
    sqlite = new Database(DB_PATH);
    sqlite.exec("PRAGMA journal_mode = WAL");
    sqlite.exec("PRAGMA foreign_keys = ON");
  }
  return sqlite;
}

export function getDb(): AppDb {
  if (!dbInstance) {
    dbInstance = drizzle(getSqlite(), { schema });
  }
  return dbInstance;
}

export function initializeDatabase(): AppDb {
  const client = getSqlite();

  client.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL DEFAULT 'disconnected',
      phone_jid TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  client.exec(`
    CREATE TABLE IF NOT EXISTS chats (
      session_id TEXT NOT NULL,
      jid TEXT NOT NULL,
      name TEXT,
      last_message_time TEXT,
      PRIMARY KEY (session_id, jid),
      FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
    );
  `);

  client.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      session_id TEXT NOT NULL,
      id TEXT NOT NULL,
      chat_jid TEXT NOT NULL,
      sender TEXT,
      content TEXT NOT NULL,
      timestamp TEXT NOT NULL,
      is_from_me INTEGER NOT NULL,
      PRIMARY KEY (session_id, id, chat_jid),
      FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
    );
  `);

  client.exec(`
    CREATE TABLE IF NOT EXISTS contacts (
      session_id TEXT NOT NULL,
      jid TEXT NOT NULL,
      name TEXT,
      notify TEXT,
      phone_number TEXT,
      PRIMARY KEY (session_id, jid),
      FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
    );
  `);

  client.exec(`
    CREATE TABLE IF NOT EXISTS jid_mapping (
      session_id TEXT NOT NULL,
      phone_jid TEXT NOT NULL,
      lid TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      PRIMARY KEY (session_id, phone_jid, lid),
      FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
    );
  `);

  client.exec(
    `CREATE INDEX IF NOT EXISTS idx_jid_mapping_lid ON jid_mapping (session_id, lid);`,
  );
  client.exec(
    `CREATE INDEX IF NOT EXISTS idx_jid_mapping_phone ON jid_mapping (session_id, phone_jid);`,
  );
  client.exec(
    `CREATE INDEX IF NOT EXISTS idx_messages_timestamp ON messages (session_id, timestamp);`,
  );
  client.exec(
    `CREATE INDEX IF NOT EXISTS idx_messages_chat_jid ON messages (session_id, chat_jid);`,
  );
  client.exec(
    `CREATE INDEX IF NOT EXISTS idx_messages_sender ON messages (session_id, sender);`,
  );
  client.exec(
    `CREATE INDEX IF NOT EXISTS idx_chats_last_message_time ON chats (session_id, last_message_time);`,
  );

  client.exec(
    `UPDATE chats SET last_message_time = NULL WHERE last_message_time IN ('undefined', 'null', '');`,
  );

  return getDb();
}

export function closeDatabase(): void {
  if (sqlite) {
    try {
      sqlite.close();
    } catch (error) {
      console.error("Error closing database:", error);
    }
    sqlite = null;
    dbInstance = null;
  }
}
