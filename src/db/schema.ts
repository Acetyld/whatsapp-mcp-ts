import { sql } from "drizzle-orm";
import {
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
} from "drizzle-orm/sqlite-core";

export const sessionStatuses = [
  "pending_qr",
  "connecting",
  "connected",
  "disconnected",
  "logged_out",
] as const;

export type SessionStatus = (typeof sessionStatuses)[number];

export const sessions = sqliteTable("sessions", {
  id: text("id").primaryKey(),
  name: text("name").notNull().unique(),
  status: text("status").notNull().default("disconnected"),
  phoneJid: text("phone_jid"),
  createdAt: text("created_at")
    .notNull()
    .default(sql`(datetime('now'))`),
  updatedAt: text("updated_at")
    .notNull()
    .default(sql`(datetime('now'))`),
});

export const chats = sqliteTable(
  "chats",
  {
    sessionId: text("session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    jid: text("jid").notNull(),
    name: text("name"),
    lastMessageTime: text("last_message_time"),
  },
  (table) => [
    primaryKey({ columns: [table.sessionId, table.jid] }),
    index("idx_chats_last_message_time").on(
      table.sessionId,
      table.lastMessageTime,
    ),
  ],
);

export const messages = sqliteTable(
  "messages",
  {
    sessionId: text("session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    id: text("id").notNull(),
    chatJid: text("chat_jid").notNull(),
    sender: text("sender"),
    content: text("content").notNull(),
    timestamp: text("timestamp").notNull(),
    isFromMe: integer("is_from_me", { mode: "boolean" }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.sessionId, table.id, table.chatJid] }),
    index("idx_messages_timestamp").on(table.sessionId, table.timestamp),
    index("idx_messages_chat_jid").on(table.sessionId, table.chatJid),
    index("idx_messages_sender").on(table.sessionId, table.sender),
  ],
);

export const contacts = sqliteTable(
  "contacts",
  {
    sessionId: text("session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    jid: text("jid").notNull(),
    name: text("name"),
    notify: text("notify"),
    phoneNumber: text("phone_number"),
  },
  (table) => [primaryKey({ columns: [table.sessionId, table.jid] })],
);

export const jidMapping = sqliteTable(
  "jid_mapping",
  {
    sessionId: text("session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    phoneJid: text("phone_jid").notNull(),
    lid: text("lid").notNull(),
    createdAt: text("created_at").default(sql`(datetime('now'))`),
  },
  (table) => [
    primaryKey({ columns: [table.sessionId, table.phoneJid, table.lid] }),
    index("idx_jid_mapping_lid").on(table.sessionId, table.lid),
    index("idx_jid_mapping_phone").on(table.sessionId, table.phoneJid),
  ],
);

export type SessionRow = typeof sessions.$inferSelect;
export type ChatRow = typeof chats.$inferSelect;
export type MessageRow = typeof messages.$inferSelect;
export type ContactRow = typeof contacts.$inferSelect;
