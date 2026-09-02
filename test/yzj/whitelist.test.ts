import test from "node:test";
import assert from "node:assert/strict";

import { checkWhitelist } from "../../src/yzj/whitelist.ts";

test("empty whitelist rejects all senders", () => {
  const result = checkWhitelist("openid-a", []);
  assert.equal(result.allowed, false);
  assert.equal(result.reason, "whitelist empty");
});

test("sender in whitelist is allowed", () => {
  const result = checkWhitelist("openid-a", ["openid-a", "openid-b"]);
  assert.equal(result.allowed, true);
});

test("sender not in whitelist is rejected", () => {
  const result = checkWhitelist("openid-c", ["openid-a", "openid-b"]);
  assert.equal(result.allowed, false);
  assert.equal(result.reason, "sender not in whitelist");
});

test("whitelist entries are trimmed", () => {
  const result = checkWhitelist("openid-a", ["  openid-a  ", "openid-b"]);
  assert.equal(result.allowed, true);
});

test("empty sender identifier is rejected", () => {
  const result = checkWhitelist("", ["openid-a"]);
  assert.equal(result.allowed, false);
  assert.equal(result.reason, "sender identifier missing");
});
