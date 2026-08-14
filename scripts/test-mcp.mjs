import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const RECIPIENT = "31682013119@s.whatsapp.net";
const TEST_MSG = "MCP test van Cursor — als je dit ziet werkt het!";
const SESSION_NAME = process.env.WA_SESSION_NAME || "test";

const transport = new StdioClientTransport({
  command: "bun",
  args: ["src/main.ts"],
  cwd: new URL("..", import.meta.url).pathname,
});

const client = new Client(
  { name: "mcp-test", version: "1.0.0" },
  { capabilities: {} },
);

await client.connect(transport);

const tools = await client.listTools();
console.log("Tools:", tools.tools.map((t) => t.name).join(", "));

let sessions = await client.callTool({
  name: "list_sessions",
  arguments: {},
});
console.log("\nlist_sessions:", JSON.stringify(sessions, null, 2));

let sessionId = null;
try {
  const listed = JSON.parse(sessions.content?.[0]?.text ?? "[]");
  const existing = listed.find((s) => s.name === SESSION_NAME);
  if (existing) {
    sessionId = existing.session_id;
  }
} catch {
  // ignore
}

if (!sessionId) {
  const created = await client.callTool({
    name: "create_session",
    arguments: { name: SESSION_NAME },
  });
  console.log("\ncreate_session:", JSON.stringify(created, null, 2));
  try {
    sessionId = JSON.parse(created.content?.[0]?.text ?? "{}").session_id;
  } catch {
    // ignore
  }
}

if (!sessionId) {
  console.error("No session_id available");
  await client.close();
  process.exit(1);
}

console.log("\nWaiting for WhatsApp connection / QR scan...");
for (let i = 0; i < 40; i++) {
  await new Promise((r) => setTimeout(r, 3000));
  const session = await client.callTool({
    name: "get_session",
    arguments: { session_id: sessionId },
  });
  const info = JSON.parse(session.content?.[0]?.text ?? "{}");
  console.log(`status=${info.status} qr_url=${info.qr_url ?? "(none)"}`);
  if (info.status === "connected") break;
}

const search = await client.callTool({
  name: "search_contacts",
  arguments: { session_id: sessionId, query: "31682013119" },
});
console.log("\nsearch_contacts:", JSON.stringify(search, null, 2));

const chat = await client.callTool({
  name: "get_chat",
  arguments: { session_id: sessionId, chat_jid: RECIPIENT },
});
console.log("\nget_chat:", JSON.stringify(chat, null, 2));

const sent = await client.callTool({
  name: "send_message",
  arguments: {
    session_id: sessionId,
    recipient: RECIPIENT,
    message: TEST_MSG,
  },
});
console.log("\nsend_message:", JSON.stringify(sent, null, 2));

await client.close();
