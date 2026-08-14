import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const RECIPIENT = "31682013119@s.whatsapp.net";
const TEST_MSG = "MCP test van Cursor — als je dit ziet werkt het!";

const transport = new StdioClientTransport({
  command: "node",
  args: ["src/main.ts"],
  cwd: new URL("..", import.meta.url).pathname,
});

const client = new Client(
  { name: "mcp-test", version: "1.0.0" },
  { capabilities: {} },
);

await client.connect(transport);

console.log("Wachten op WhatsApp-verbinding...");
await new Promise((r) => setTimeout(r, 15000));

const tools = await client.listTools();
console.log("Tools:", tools.tools.map((t) => t.name).join(", "));

const search = await client.callTool({
  name: "search_contacts",
  arguments: { query: "31682013119" },
});
console.log("\nsearch_contacts:", JSON.stringify(search, null, 2));

const chat = await client.callTool({
  name: "get_chat",
  arguments: { chat_jid: RECIPIENT },
});
console.log("\nget_chat:", JSON.stringify(chat, null, 2));

const sent = await client.callTool({
  name: "send_message",
  arguments: { recipient: RECIPIENT, message: TEST_MSG },
});
console.log("\nsend_message:", JSON.stringify(sent, null, 2));

await client.close();
