/**
 * Unit-style check that unpaired QR exhaustion stops reconnecting
 * (no live WhatsApp network required — mocks scheduleReconnect logic).
 * Run: bun scripts/test-qr-retry-cap.mjs
 */

function shouldStopUnpaired({
  paired,
  errorMessage,
  unpairedReconnects,
  unpairedStartedAt,
  now,
  maxUnpairedReconnects = 2,
  maxUnpairedMs = 3 * 60_000,
}) {
  const qrRefsEnded = errorMessage.includes("QR refs attempts ended");
  if (paired) return false;
  return (
    qrRefsEnded ||
    unpairedReconnects >= maxUnpairedReconnects ||
    now - unpairedStartedAt >= maxUnpairedMs
  );
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

const t0 = 1_000_000;

assert(
  shouldStopUnpaired({
    paired: false,
    errorMessage: "QR refs attempts ended",
    unpairedReconnects: 0,
    unpairedStartedAt: t0,
    now: t0 + 1000,
  }),
  "QR refs ended must stop immediately",
);

assert(
  !shouldStopUnpaired({
    paired: false,
    errorMessage: "Connection Closed",
    unpairedReconnects: 0,
    unpairedStartedAt: t0,
    now: t0 + 1000,
  }),
  "first soft close may still retry",
);

assert(
  shouldStopUnpaired({
    paired: false,
    errorMessage: "Connection Closed",
    unpairedReconnects: 2,
    unpairedStartedAt: t0,
    now: t0 + 1000,
  }),
  "reconnect budget must stop unpaired loops",
);

assert(
  shouldStopUnpaired({
    paired: false,
    errorMessage: "Connection Closed",
    unpairedReconnects: 0,
    unpairedStartedAt: t0,
    now: t0 + 3 * 60_000,
  }),
  "time budget must stop unpaired loops",
);

assert(
  !shouldStopUnpaired({
    paired: true,
    errorMessage: "QR refs attempts ended",
    unpairedReconnects: 99,
    unpairedStartedAt: t0,
    now: t0 + 99 * 60_000,
  }),
  "paired sessions ignore QR-exhaustion stop (message shouldn't happen)",
);

console.log("qr-retry-cap logic tests passed");
