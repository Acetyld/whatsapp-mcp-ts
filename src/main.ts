import { pino } from "pino";
import { initializeDatabase } from "./db/index.ts";
import { startMcpServer } from "./mcp.ts";
import {
  initSessionManager,
  restoreSessions,
  stopAllSessions,
} from "./sessions.ts";

const dataDir = process.env.WHATSAPP_MCP_DATA_DIR || ".";
const waLogger = pino(
  {
    level: process.env.LOG_LEVEL || "info",
    timestamp: pino.stdTimeFunctions.isoTime,
  },
  pino.destination(`${dataDir}/wa-logs.txt`),
);

const mcpLogger = pino(
  {
    level: process.env.LOG_LEVEL || "info",
    timestamp: pino.stdTimeFunctions.isoTime,
  },
  pino.destination(`${dataDir}/mcp-logs.txt`),
);

async function main() {
  mcpLogger.info("Starting WhatsApp MCP Server...");

  try {
    mcpLogger.info("Initializing database...");
    initializeDatabase();
    mcpLogger.info("Database initialized successfully.");

    initSessionManager(waLogger);
    mcpLogger.info("Restoring WhatsApp sessions with saved credentials...");
    await restoreSessions();
  } catch (error: any) {
    mcpLogger.fatal(
      { err: error },
      "Failed during initialization",
    );
    process.exit(1);
  }

  try {
    mcpLogger.info("Starting MCP server...");
    await startMcpServer(mcpLogger, waLogger);
    mcpLogger.info("MCP Server started and listening.");
  } catch (error: any) {
    mcpLogger.fatal({ err: error }, "Failed to start MCP server");
    process.exit(1);
  }

  mcpLogger.info("Application setup complete. Running...");
}

async function shutdown(signal: string) {
  mcpLogger.info(`Received ${signal}. Shutting down gracefully...`);

  try {
    stopAllSessions();
  } catch (error) {
    mcpLogger.warn({ err: error }, "Error while stopping WhatsApp sessions");
  }

  waLogger.flush();
  mcpLogger.flush();

  process.exit(0);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

main().catch((error) => {
  mcpLogger.fatal({ err: error }, "Unhandled error during application startup");
  waLogger.flush();
  mcpLogger.flush();
  process.exit(1);
});
