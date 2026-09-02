import test from "node:test";
import assert from "node:assert/strict";

import { parseStreamContract } from "../../src/qodercli/stream-contract.ts";

function successFixture() {
  return [
    JSON.stringify({
      type: "system",
      subtype: "init",
      qodercli_version: "2026.4.9",
      protocol_version: "1.0.0",
      cwd: "/workspace",
      permissionMode: "default",
    }),
    JSON.stringify({
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "PHASE_ZERO_REPLY" }],
      },
    }),
    JSON.stringify({
      type: "result",
      subtype: "success",
      result: "PHASE_ZERO_REPLY",
      usage: { input_tokens: 10, output_tokens: 2 },
      permission_denials: [],
      stop_reason: "end_turn",
    }),
  ];
}

test("parses verified success contract", () => {
  const result = parseStreamContract(successFixture());

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.version.qodercli, "2026.4.9");
  assert.equal(result.version.protocol, "1.0.0");
  assert.equal(result.replyText, "PHASE_ZERO_REPLY");
  assert.deepEqual(result.usage, { input_tokens: 10, output_tokens: 2 });
});

test("rejects malformed JSON", () => {
  const result = parseStreamContract(["not json"]);

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, "parse_error");
});

test("rejects first event that is not system/init", () => {
  const result = parseStreamContract([
    JSON.stringify({ type: "assistant", message: { content: [] } }),
  ]);

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, "contract_violation");
});

test("rejects system/init missing version fields", () => {
  const result = parseStreamContract([
    JSON.stringify({ type: "system", subtype: "init" }),
  ]);

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, "contract_violation");
});

test("rejects unknown event", () => {
  const result = parseStreamContract([
    JSON.stringify({ type: "system", subtype: "init", qodercli_version: "1", protocol_version: "1" }),
    JSON.stringify({ type: "telemetry", subtype: "heartbeat" }),
  ]);

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, "contract_violation");
});

test("rejects missing terminal result", () => {
  const result = parseStreamContract([
    JSON.stringify({ type: "system", subtype: "init", qodercli_version: "1", protocol_version: "1" }),
    JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "hi" }] } }),
  ]);

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, "contract_violation");
});

test("rejects duplicate terminal results", () => {
  const result = parseStreamContract([
    JSON.stringify({ type: "system", subtype: "init", qodercli_version: "1", protocol_version: "1" }),
    JSON.stringify({ type: "result", subtype: "success" }),
    JSON.stringify({ type: "result", subtype: "success" }),
  ]);

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, "contract_violation");
});

test("rejects permission request event", () => {
  const result = parseStreamContract([
    JSON.stringify({ type: "system", subtype: "init", qodercli_version: "1", protocol_version: "1" }),
    JSON.stringify({ type: "permission", subtype: "request" }),
  ]);

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, "contract_violation");
});

test("rejects terminal error event", () => {
  const result = parseStreamContract([
    JSON.stringify({ type: "system", subtype: "init", qodercli_version: "1", protocol_version: "1" }),
    JSON.stringify({ type: "result", subtype: "error_during_execution" }),
  ]);

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, "internal");
});

test("rejects success with permission denials", () => {
  const result = parseStreamContract([
    JSON.stringify({ type: "system", subtype: "init", qodercli_version: "1", protocol_version: "1" }),
    JSON.stringify({
      type: "result",
      subtype: "success",
      permission_denials: [{ tool: "bash", reason: "user declined" }],
    }),
  ]);

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, "permission_denied");
});

test("concatenates multiple assistant text blocks", () => {
  const result = parseStreamContract([
    JSON.stringify({ type: "system", subtype: "init", qodercli_version: "1", protocol_version: "1" }),
    JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "Hello " }] } }),
    JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "world" }] } }),
    JSON.stringify({ type: "result", subtype: "success" }),
  ]);

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.replyText, "Hello world");
});

test("ignores non-text assistant blocks", () => {
  const result = parseStreamContract([
    JSON.stringify({ type: "system", subtype: "init", qodercli_version: "1", protocol_version: "1" }),
    JSON.stringify({
      type: "assistant",
      message: {
        content: [
          { type: "thinking", thinking: "..." },
          { type: "text", text: "answer" },
        ],
      },
    }),
    JSON.stringify({ type: "result", subtype: "success" }),
  ]);

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.replyText, "answer");
});

test("accepts QoderCLI 1.1 auxiliary system and synthetic user events", () => {
  const result = parseStreamContract([
    JSON.stringify({ type: "system", subtype: "init", qodercli_version: "1.1.38", protocol_version: "1" }),
    JSON.stringify({ type: "system", subtype: "hook_started", hook_id: "hook-1" }),
    JSON.stringify({ type: "assistant", message: { content: [{ type: "thinking", thinking: "checking" }] } }),
    JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "Read" }] } }),
    JSON.stringify({ type: "user", isSynthetic: true, message: { content: [{ type: "tool_result" }] } }),
    JSON.stringify({ type: "system", subtype: "hook_response", hook_id: "hook-1" }),
    JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "技术栈结论" }] } }),
    JSON.stringify({ type: "result", subtype: "success" }),
  ]);

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.replyText, "技术栈结论");
});

test("ignores forward-compatible system and user stream events", () => {
  const result = parseStreamContract([
    JSON.stringify({ type: "system", subtype: "init", qodercli_version: "1.1.38", protocol_version: "1" }),
    JSON.stringify({ type: "system", subtype: "future_status", payload: { opaque: true } }),
    JSON.stringify({ type: "user", message: { content: [{ type: "tool_result" }] } }),
    JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "完成" }] } }),
    JSON.stringify({ type: "result", subtype: "success" }),
  ]);

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.replyText, "完成");
});

test("accepts auxiliary system events emitted before QoderCLI init", () => {
  const result = parseStreamContract([
    JSON.stringify({ type: "system", subtype: "hook_started", hook_id: "hook-1" }),
    JSON.stringify({ type: "system", subtype: "hook_response", hook_id: "hook-1" }),
    JSON.stringify({ type: "system", subtype: "init", qodercli_version: "1.1.38", protocol_version: "1" }),
    JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "完成" }] } }),
    JSON.stringify({ type: "result", subtype: "success" }),
  ]);

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.replyText, "完成");
});
