import test from "node:test";
import assert from "node:assert/strict";

import { isWebSocketStale } from "../../src/yzj/websocket-helpers.ts";

test("does not mark an active websocket stale when only pong is absent", () => {
  assert.equal(
    isWebSocketStale({
      now: 50_000,
      lastPongAt: 1_000,
      lastActivityAt: 49_000,
      staleMs: 45_000,
    }),
    false,
  );
  assert.equal(
    isWebSocketStale({
      now: 50_000,
      lastPongAt: 1_000,
      lastActivityAt: 1_000,
      staleMs: 45_000,
    }),
    true,
  );
});
