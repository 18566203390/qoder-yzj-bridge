import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { BridgeStateStore } from "../src/state-store.ts";

async function tempStatePath(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "qoder-yzj-bridge-state-"));
  return path.join(dir, "state.json");
}

test("default state when file does not exist", async () => {
  const store = new BridgeStateStore("/tmp/qoder-yzj-missing/state.json");
  const state = await store.load();

  assert.equal(state.running, false);
  assert.equal(state.connected, false);
  assert.equal(state.lastError, null);
  assert.equal(state.lastInboundAt, null);
  assert.equal(state.lastOutboundAt, null);
});

test("save and load roundtrip", async () => {
  const storagePath = await tempStatePath();
  const store = new BridgeStateStore(storagePath);

  await store.save({
    running: true,
    connected: true,
    lastError: "oops",
    lastInboundAt: 1000,
    lastOutboundAt: 2000,
  });

  const state = await store.load();
  assert.equal(state.running, true);
  assert.equal(state.connected, true);
  assert.equal(state.lastError, "oops");
  assert.equal(state.lastInboundAt, 1000);
  assert.equal(state.lastOutboundAt, 2000);
});

test("state file is created with restricted permissions", async () => {
  const storagePath = await tempStatePath();
  const store = new BridgeStateStore(storagePath);

  await store.save({
    running: false,
    connected: false,
    lastError: null,
    lastInboundAt: null,
    lastOutboundAt: null,
  });

  const stat = await fs.stat(storagePath);
  // eslint-disable-next-line no-bitwise
  assert.equal(stat.mode & 0o777, 0o600);
});
