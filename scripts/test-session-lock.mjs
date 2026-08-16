/**
 * Smoke tests for session authDir locking (no live WhatsApp).
 * Run: bun scripts/test-session-lock.mjs
 */
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  existsSync,
  writeFileSync as write,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { acquireSessionLock } from "../src/session-lock.ts";

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

const root = mkdtempSync(path.join(tmpdir(), "wa-lock-"));
const authDir = path.join(root, "session-a");
const here = path.dirname(fileURLToPath(import.meta.url));

try {
  const lock1 = acquireSessionLock(authDir);
  assert(existsSync(path.join(authDir, ".wa_session.lock")), "lock file written");

  let refused = false;
  try {
    acquireSessionLock(authDir);
  } catch (error) {
    refused = String(error.message).includes("already in use");
  }
  assert(refused, "second acquire in same process must refuse");

  lock1.release();
  const lock2 = acquireSessionLock(authDir);
  lock2.release();

  // Stale lock from a dead PID must be reclaimable.
  writeFileSync(
    path.join(authDir, ".wa_session.lock"),
    JSON.stringify({ pid: 999999999, startedAt: new Date().toISOString() }) +
      "\n",
  );
  const lock3 = acquireSessionLock(authDir);
  lock3.release();

  // Cross-process: child holds lock, parent must refuse.
  const holderPath = path.join(root, "hold-lock.mjs");
  write(
    holderPath,
    `
import { acquireSessionLock } from ${JSON.stringify(
      path.join(here, "../src/session-lock.ts"),
    )};
const lock = acquireSessionLock(${JSON.stringify(authDir)});
process.stdout.write("CHILD_LOCKED\\n");
await new Promise((r) => setTimeout(r, 8000));
lock.release();
`,
  );

  const child = spawn("bun", [holderPath], {
    stdio: ["ignore", "pipe", "pipe"],
  });

  await new Promise((resolve, reject) => {
    let buf = "";
    const timer = setTimeout(
      () => reject(new Error("child lock timeout")),
      5000,
    );
    child.stdout.on("data", (chunk) => {
      buf += chunk.toString();
      if (buf.includes("CHILD_LOCKED")) {
        clearTimeout(timer);
        resolve(undefined);
      }
    });
    child.stderr.on("data", (chunk) => {
      process.stderr.write(chunk);
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code && code !== 0) {
        clearTimeout(timer);
        reject(new Error(`child exited early with ${code}`));
      }
    });
  });

  let crossRefused = false;
  try {
    acquireSessionLock(authDir);
  } catch (error) {
    crossRefused = String(error.message).includes("already in use");
  }
  assert(crossRefused, "parent must refuse while child holds lock");

  child.kill("SIGTERM");
  await new Promise((r) => child.on("close", r));

  // After child dies, lock must be reclaimable (stale PID).
  const lock4 = acquireSessionLock(authDir);
  lock4.release();

  console.log("session-lock tests passed");
} finally {
  rmSync(root, { recursive: true, force: true });
}
