import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { jidNormalizedUser } from "@whiskeysockets/baileys";
import type { P } from "pino";

import {
  type Message as DbMessage,
  type Chat as DbChat,
  getMessages,
  getChats,
  getChat,
  getMessagesAround,
  searchDbForContacts,
  searchMessages,
} from "./db/queries.ts";

import {
  createSession,
  deleteSession,
  getSession,
  listSessions,
  requireSession,
  sendSessionMessage,
} from "./sessions.ts";

const sessionIdSchema = z
  .string()
  .min(1)
  .describe("WhatsApp session ID (from create_session or list_sessions)");

function formatDbMessageForJson(msg: DbMessage) {
  return {
    id: msg.id,
    chat_jid: msg.chat_jid,
    chat_name: msg.chat_name ?? "Unknown Chat",
    sender_jid: msg.sender ?? null,
    sender_display: msg.sender
      ? msg.sender.split("@")[0]
      : msg.is_from_me
        ? "Me"
        : "Unknown",
    content: msg.content,
    timestamp: msg.timestamp.toISOString(),
    is_from_me: msg.is_from_me,
  };
}

function formatDbChatForJson(chat: DbChat) {
  return {
    jid: chat.jid,
    name: chat.name ?? chat.jid.split("@")[0] ?? "Unknown Chat",
    is_group: chat.jid.endsWith("@g.us"),
    last_message_time: chat.last_message_time?.toISOString() ?? null,
    last_message_preview: chat.last_message ?? null,
    last_sender_jid: chat.last_sender ?? null,
    last_sender_display: chat.last_sender
      ? chat.last_sender.split("@")[0]
      : chat.last_is_from_me
        ? "Me"
        : null,
    last_is_from_me: chat.last_is_from_me ?? null,
  };
}

function formatSessionForJson(session: {
  id: string;
  name: string;
  status: string;
  phoneJid: string | null;
  qrUrl: string | null;
  createdAt?: string;
  updatedAt?: string;
}) {
  return {
    session_id: session.id,
    name: session.name,
    status: session.status,
    phone_jid: session.phoneJid,
    qr_url: session.qrUrl,
    created_at: session.createdAt ?? null,
    updated_at: session.updatedAt ?? null,
  };
}

function toolError(message: string) {
  return {
    isError: true as const,
    content: [{ type: "text" as const, text: message }],
  };
}

function toolJson(data: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(data, null, 2),
      },
    ],
  };
}

export async function startMcpServer(
  mcpLogger: P.Logger,
  waLogger: P.Logger,
): Promise<void> {
  mcpLogger.info("Initializing MCP server...");

  const server = new McpServer({
    name: "whatsapp-baileys-ts",
    version: "0.2.0",
    capabilities: {
      tools: {},
      resources: {},
    },
  });

  server.tool(
    "create_session",
    {
      name: z
        .string()
        .min(1)
        .describe("Human-readable name for this WhatsApp session"),
    },
    async ({ name }) => {
      mcpLogger.info(`[MCP Tool] create_session name="${name}"`);
      try {
        const session = await createSession(name);
        return toolJson(formatSessionForJson(session));
      } catch (error: any) {
        mcpLogger.error(
          `[MCP Tool Error] create_session failed: ${error.message}`,
        );
        return toolError(`Error creating session: ${error.message}`);
      }
    },
  );

  server.tool("list_sessions", {}, async () => {
    mcpLogger.info("[MCP Tool] list_sessions");
    try {
      const sessions = listSessions().map(formatSessionForJson);
      return toolJson(sessions);
    } catch (error: any) {
      mcpLogger.error(
        `[MCP Tool Error] list_sessions failed: ${error.message}`,
      );
      return toolError(`Error listing sessions: ${error.message}`);
    }
  });

  server.tool(
    "get_session",
    {
      session_id: sessionIdSchema,
    },
    async ({ session_id }) => {
      mcpLogger.info(`[MCP Tool] get_session ${session_id}`);
      try {
        const session = getSession(session_id);
        if (!session) {
          return toolError(`Session not found: ${session_id}`);
        }
        return toolJson(formatSessionForJson(session));
      } catch (error: any) {
        mcpLogger.error(
          `[MCP Tool Error] get_session failed: ${error.message}`,
        );
        return toolError(`Error getting session: ${error.message}`);
      }
    },
  );

  server.tool(
    "delete_session",
    {
      session_id: sessionIdSchema,
    },
    async ({ session_id }) => {
      mcpLogger.info(`[MCP Tool] delete_session ${session_id}`);
      try {
        await deleteSession(session_id);
        return {
          content: [
            {
              type: "text" as const,
              text: `Session ${session_id} deleted (auth + stored data removed).`,
            },
          ],
        };
      } catch (error: any) {
        mcpLogger.error(
          `[MCP Tool Error] delete_session failed: ${error.message}`,
        );
        return toolError(`Error deleting session: ${error.message}`);
      }
    },
  );

  server.tool(
    "search_contacts",
    {
      session_id: sessionIdSchema,
      query: z
        .string()
        .min(1)
        .describe("Search term for contact name or phone number part of JID"),
    },
    async ({ session_id, query }) => {
      mcpLogger.info(
        `[MCP Tool] search_contacts session=${session_id} query="${query}"`,
      );
      try {
        requireSession(session_id);
        const contacts = searchDbForContacts(session_id, query, 20);
        const formattedContacts = contacts.map((c) => ({
          jid: c.jid,
          name: c.name ?? c.jid.split("@")[0],
        }));
        return toolJson(formattedContacts);
      } catch (error: any) {
        mcpLogger.error(
          `[MCP Tool Error] search_contacts failed: ${error.message}`,
        );
        return toolError(`Error searching contacts: ${error.message}`);
      }
    },
  );

  server.tool(
    "list_messages",
    {
      session_id: sessionIdSchema,
      chat_jid: z
        .string()
        .describe(
          "The JID of the chat (e.g., '123456@s.whatsapp.net' or 'group@g.us')",
        ),
      limit: z
        .number()
        .int()
        .positive()
        .optional()
        .default(20)
        .describe("Max messages per page (default 20)"),
      page: z
        .number()
        .int()
        .nonnegative()
        .optional()
        .default(0)
        .describe("Page number (0-indexed, default 0)"),
    },
    async ({ session_id, chat_jid, limit, page }) => {
      mcpLogger.info(
        `[MCP Tool] list_messages session=${session_id} chat=${chat_jid} limit=${limit} page=${page}`,
      );
      try {
        requireSession(session_id);
        const messages = getMessages(session_id, chat_jid, limit, page);
        if (!messages.length && page === 0) {
          return {
            content: [
              {
                type: "text" as const,
                text: `No messages found for chat ${chat_jid}.`,
              },
            ],
          };
        } else if (!messages.length) {
          return {
            content: [
              {
                type: "text" as const,
                text: `No more messages found on page ${page} for chat ${chat_jid}.`,
              },
            ],
          };
        }
        return toolJson(messages.map(formatDbMessageForJson));
      } catch (error: any) {
        mcpLogger.error(
          `[MCP Tool Error] list_messages failed for ${chat_jid}: ${error.message}`,
        );
        return toolError(
          `Error listing messages for ${chat_jid}: ${error.message}`,
        );
      }
    },
  );

  server.tool(
    "list_chats",
    {
      session_id: sessionIdSchema,
      limit: z
        .number()
        .int()
        .positive()
        .optional()
        .default(20)
        .describe("Max chats per page (default 20)"),
      page: z
        .number()
        .int()
        .nonnegative()
        .optional()
        .default(0)
        .describe("Page number (0-indexed, default 0)"),
      sort_by: z
        .enum(["last_active", "name"])
        .optional()
        .default("last_active")
        .describe("Sort order: 'last_active' (default) or 'name'"),
      query: z
        .string()
        .optional()
        .describe("Optional filter by chat name or JID"),
      include_last_message: z
        .boolean()
        .optional()
        .default(true)
        .describe("Include last message details (default true)"),
    },
    async ({
      session_id,
      limit,
      page,
      sort_by,
      query,
      include_last_message,
    }) => {
      mcpLogger.info(
        `[MCP Tool] list_chats session=${session_id} limit=${limit} page=${page} sort=${sort_by}`,
      );
      try {
        requireSession(session_id);
        const chats = getChats(
          session_id,
          limit,
          page,
          sort_by,
          query ?? null,
          include_last_message,
        );
        if (!chats.length && page === 0) {
          return {
            content: [
              {
                type: "text" as const,
                text: `No chats found${query ? ` matching "${query}"` : ""}.`,
              },
            ],
          };
        } else if (!chats.length) {
          return {
            content: [
              {
                type: "text" as const,
                text: `No more chats found on page ${page}${
                  query ? ` matching "${query}"` : ""
                }.`,
              },
            ],
          };
        }
        return toolJson(chats.map(formatDbChatForJson));
      } catch (error: any) {
        mcpLogger.error(`[MCP Tool Error] list_chats failed: ${error.message}`);
        return toolError(`Error listing chats: ${error.message}`);
      }
    },
  );

  server.tool(
    "get_chat",
    {
      session_id: sessionIdSchema,
      chat_jid: z.string().describe("The JID of the chat to retrieve"),
      include_last_message: z
        .boolean()
        .optional()
        .default(true)
        .describe("Include last message details (default true)"),
    },
    async ({ session_id, chat_jid, include_last_message }) => {
      mcpLogger.info(
        `[MCP Tool] get_chat session=${session_id} chat=${chat_jid}`,
      );
      try {
        requireSession(session_id);
        const chat = getChat(session_id, chat_jid, include_last_message);
        if (!chat) {
          return toolError(`Chat with JID ${chat_jid} not found.`);
        }
        return toolJson(formatDbChatForJson(chat));
      } catch (error: any) {
        mcpLogger.error(
          `[MCP Tool Error] get_chat failed for ${chat_jid}: ${error.message}`,
        );
        return toolError(
          `Error retrieving chat ${chat_jid}: ${error.message}`,
        );
      }
    },
  );

  server.tool(
    "get_message_context",
    {
      session_id: sessionIdSchema,
      message_id: z
        .string()
        .describe("The ID of the target message to get context around"),
      before: z
        .number()
        .int()
        .nonnegative()
        .optional()
        .default(5)
        .describe("Number of messages before (default 5)"),
      after: z
        .number()
        .int()
        .nonnegative()
        .optional()
        .default(5)
        .describe("Number of messages after (default 5)"),
    },
    async ({ session_id, message_id, before, after }) => {
      mcpLogger.info(
        `[MCP Tool] get_message_context session=${session_id} msg=${message_id}`,
      );
      try {
        requireSession(session_id);
        const context = getMessagesAround(
          session_id,
          message_id,
          before,
          after,
        );
        if (!context.target) {
          return toolError(`Message with ID ${message_id} not found.`);
        }
        return toolJson({
          target: formatDbMessageForJson(context.target),
          before: context.before.map(formatDbMessageForJson),
          after: context.after.map(formatDbMessageForJson),
        });
      } catch (error: any) {
        mcpLogger.error(
          `[MCP Tool Error] get_message_context failed: ${error.message}`,
        );
        return toolError(
          `Error retrieving context for message ${message_id}: ${error.message}`,
        );
      }
    },
  );

  server.tool(
    "send_message",
    {
      session_id: sessionIdSchema,
      recipient: z
        .string()
        .describe(
          "Recipient JID (user or group, e.g., '12345@s.whatsapp.net' or 'group123@g.us')",
        ),
      message: z.string().min(1).describe("The text message to send"),
    },
    async ({ session_id, recipient, message }) => {
      mcpLogger.info(
        `[MCP Tool] send_message session=${session_id} to=${recipient}`,
      );

      let normalizedRecipient: string;
      try {
        requireSession(session_id);
        normalizedRecipient = jidNormalizedUser(recipient);
        if (!normalizedRecipient.includes("@")) {
          throw new Error('JID must contain "@" symbol');
        }
      } catch (normError: any) {
        mcpLogger.error(
          `[MCP Tool Error] Invalid recipient or session: ${normError.message}`,
        );
        return toolError(
          `Invalid request: ${normError.message}. Provide a valid session_id and JID.`,
        );
      }

      try {
        const result = await sendSessionMessage(
          session_id,
          normalizedRecipient,
          message,
        );

        if (result && result.key && result.key.id) {
          return {
            content: [
              {
                type: "text" as const,
                text: `Message sent successfully to ${normalizedRecipient} (ID: ${result.key.id}).`,
              },
            ],
          };
        }
        return toolError(
          `Failed to send message to ${normalizedRecipient}. See server logs for details.`,
        );
      } catch (error: any) {
        mcpLogger.error(
          `[MCP Tool Error] send_message failed: ${error.message}`,
        );
        return toolError(`Error sending message: ${error.message}`);
      }
    },
  );

  server.tool(
    "search_messages",
    {
      session_id: sessionIdSchema,
      query: z
        .string()
        .min(1)
        .describe("The text content to search for within messages"),
      chat_jid: z
        .string()
        .optional()
        .describe(
          "Optional: The JID of a specific chat to search within. If omitted, searches all chats.",
        ),
      limit: z
        .number()
        .int()
        .positive()
        .optional()
        .default(10)
        .describe("Max messages per page (default 10)"),
      page: z
        .number()
        .int()
        .nonnegative()
        .optional()
        .default(0)
        .describe("Page number (0-indexed, default 0)"),
    },
    async ({ session_id, chat_jid, query, limit, page }) => {
      const searchScope = chat_jid ? `in chat ${chat_jid}` : "across all chats";
      mcpLogger.info(
        `[MCP Tool] search_messages session=${session_id} ${searchScope} query="${query}"`,
      );
      try {
        requireSession(session_id);
        const messagesList = searchMessages(
          session_id,
          query,
          chat_jid,
          limit,
          page,
        );

        if (!messagesList.length && page === 0) {
          return {
            content: [
              {
                type: "text" as const,
                text: `No messages found containing "${query}"${
                  chat_jid ? ` in chat ${chat_jid}` : ""
                }.`,
              },
            ],
          };
        } else if (!messagesList.length) {
          return {
            content: [
              {
                type: "text" as const,
                text: `No more messages found containing "${query}" on page ${page}.`,
              },
            ],
          };
        }

        return toolJson(messagesList.map(formatDbMessageForJson));
      } catch (error: any) {
        mcpLogger.error(
          `[MCP Tool Error] search_messages failed: ${error.message}`,
        );
        return toolError(`Error searching messages: ${error.message}`);
      }
    },
  );

  // waLogger kept for parity / future per-tool WA logging
  void waLogger;

  server.resource("db_schema", "schema://whatsapp/main", async (uri) => {
    mcpLogger.info(`[MCP Resource] Request for ${uri.href}`);
    const schemaText = `
TABLE sessions (id TEXT PK, name TEXT UNIQUE, status TEXT, phone_jid TEXT, created_at TEXT, updated_at TEXT)
TABLE chats (session_id TEXT, jid TEXT, name TEXT, last_message_time TEXT, PK(session_id, jid), FK(session_id) REFERENCES sessions(id))
TABLE messages (session_id TEXT, id TEXT, chat_jid TEXT, sender TEXT, content TEXT, timestamp TEXT, is_from_me BOOLEAN, PK(session_id, id, chat_jid), FK(session_id) REFERENCES sessions(id))
TABLE contacts (session_id TEXT, jid TEXT, name TEXT, notify TEXT, phone_number TEXT, PK(session_id, jid), FK(session_id) REFERENCES sessions(id))
TABLE jid_mapping (session_id TEXT, phone_jid TEXT, lid TEXT, PK(session_id, phone_jid, lid), FK(session_id) REFERENCES sessions(id))
            `.trim();
    return {
      contents: [
        {
          uri: uri.href,
          text: schemaText,
        },
      ],
    };
  });

  const transport = new StdioServerTransport();
  mcpLogger.info("MCP server configured. Connecting stdio transport...");

  try {
    await server.connect(transport);
    mcpLogger.info(
      "MCP transport connected. Server is ready and listening via stdio.",
    );
  } catch (error: any) {
    mcpLogger.error(
      `[FATAL] Failed to connect MCP transport: ${error.message}`,
      error,
    );
    process.exit(1);
  }

  mcpLogger.info(
    "MCP Server setup complete. Waiting for requests from client...",
  );
}
