import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  createSessionAdapter,
  buildUserMessage,
  type SessionAdapter,
} from "../../src/qodercli/session-adapter.ts";
import {
  SessionRegistry,
  hashSender,
} from "../../src/qodercli/session-registry.ts";
import type {
  CliInvocation,
  CliProcessRunner,
  CliRawResult,
  CliResult,
} from "../../src/contracts.ts";

function makeFakeAdapter(
  responses: Array<{
    result: CliResult;
    delayMs?: number;
  }>,
): { adapter: SessionAdapter; calls: CliInvocation[] } {
  const calls: CliInvocation[] = [];
  let index = 0;

  const runner: CliProcessRunner = async (invocation) => {
    calls.push(invocation);
    const response = responses[index++] ?? responses[responses.length - 1]!;
    if (response.delayMs) {
      await new Promise((resolve) => setTimeout(resolve, response.delayMs));
    }
    const result = response.result;
    if (result.ok) {
      return {
        exitCode: 0,
        stdoutLines: [
          JSON.stringify({
            type: "system",
            subtype: "init",
            qodercli_version: "1",
            protocol_version: "1",
          }),
          JSON.stringify({
            type: "assistant",
            message: {
              role: "assistant",
              content: [{ type: "text", text: result.replyText }],
            },
          }),
          JSON.stringify({ type: "result", subtype: "success" }),
        ],
        stderr: "",
        timedOut: false,
      };
    }
    return {
      exitCode: 1,
      stdoutLines: [],
      stderr: "fake error",
      timedOut: false,
    };
  };

  return {
    adapter: createSessionAdapter({ runner }),
    calls,
  };
}

async function tempStorage(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "qoder-yzj-bridge-"));
  return path.join(dir, "registry.json");
}

test("same sender reuses session id and resumes", async () => {
  const { adapter, calls } = makeFakeAdapter([
    { result: { ok: true, version: { qodercli: "1", protocol: "1" }, replyText: "first" } },
    { result: { ok: true, version: { qodercli: "1", protocol: "1" }, replyText: "second" } },
  ]);
  const storagePath = await tempStorage();
  const registry = new SessionRegistry({
    storagePath,
    adapter,
    cwd: "/tmp/ws",
  });

  const r1 = await registry.send("robot-1", "openid-a", buildUserMessage("hi"));
  const r2 = await registry.send("robot-1", "openid-a", buildUserMessage("again"));

  assert.equal(r1.ok, true);
  assert.equal(r2.ok, true);
  assert.equal(calls.length, 2);
  assert.equal(calls[0]!.resume, false);
  assert.equal(calls[1]!.resume, true);
  assert.equal(calls[0]!.sessionId, calls[1]!.sessionId);

  const sessionId = registry.getSessionId(hashSender("robot-1", "openid-a"));
  assert.equal(sessionId, calls[0]!.sessionId);
});

test("different senders get different sessions", async () => {
  const { adapter, calls } = makeFakeAdapter([
    { result: { ok: true, version: { qodercli: "1", protocol: "1" }, replyText: "a" } },
    { result: { ok: true, version: { qodercli: "1", protocol: "1" }, replyText: "b" } },
  ]);
  const storagePath = await tempStorage();
  const registry = new SessionRegistry({
    storagePath,
    adapter,
    cwd: "/tmp/ws",
  });

  await registry.send("robot-1", "openid-a", buildUserMessage("hi"));
  await registry.send("robot-1", "openid-b", buildUserMessage("hi"));

  assert.notEqual(calls[0]!.sessionId, calls[1]!.sessionId);
  assert.equal(registry.getSessionId(hashSender("robot-1", "openid-a")), calls[0]!.sessionId);
});

test("first failure does not create session mapping", async () => {
  const { adapter } = makeFakeAdapter([
    { result: { ok: false, reason: "internal" } },
  ]);
  const storagePath = await tempStorage();
  const registry = new SessionRegistry({
    storagePath,
    adapter,
    cwd: "/tmp/ws",
  });

  const result = await registry.send("robot-1", "openid-a", buildUserMessage("hi"));

  assert.equal(result.ok, false);
  assert.equal(registry.getSessionId(hashSender("robot-1", "openid-a")), undefined);
});

test("same sender messages are processed serially", async () => {
  const { adapter, calls } = makeFakeAdapter([
    { result: { ok: true, version: { qodercli: "1", protocol: "1" }, replyText: "1" }, delayMs: 30 },
    { result: { ok: true, version: { qodercli: "1", protocol: "1" }, replyText: "2" } },
  ]);
  const storagePath = await tempStorage();
  const registry = new SessionRegistry({
    storagePath,
    adapter,
    cwd: "/tmp/ws",
  });

  const p1 = registry.send("robot-1", "openid-a", buildUserMessage("first"));
  const p2 = registry.send("robot-1", "openid-a", buildUserMessage("second"));
  await Promise.all([p1, p2]);

  assert.equal(calls.length, 2);
  assert.equal(calls[0]!.messages[0]!.content[0]!.text, "first");
  assert.equal(calls[1]!.messages[0]!.content[0]!.text, "second");
});

test("registry persists and loads mappings", async () => {
  const { adapter } = makeFakeAdapter([
    { result: { ok: true, version: { qodercli: "1", protocol: "1" }, replyText: "x" } },
  ]);
  const storagePath = await tempStorage();

  const registry1 = new SessionRegistry({
    storagePath,
    adapter,
    cwd: "/tmp/ws",
  });
  await registry1.send("robot-1", "openid-a", buildUserMessage("hi"));

  const registry2 = new SessionRegistry({
    storagePath,
    adapter,
    cwd: "/tmp/ws",
  });
  await registry2.load();

  assert.equal(
    registry2.getSessionId(hashSender("robot-1", "openid-a")),
    registry1.getSessionId(hashSender("robot-1", "openid-a")),
  );
});

test("registry file is created with restricted permissions", async () => {
  const { adapter } = makeFakeAdapter([
    { result: { ok: true, version: { qodercli: "1", protocol: "1" }, replyText: "x" } },
  ]);
  const storagePath = await tempStorage();
  const registry = new SessionRegistry({
    storagePath,
    adapter,
    cwd: "/tmp/ws",
  });

  await registry.send("robot-1", "openid-a", buildUserMessage("hi"));

  const stat = await fs.stat(storagePath);
  // eslint-disable-next-line no-bitwise
  assert.equal(stat.mode & 0o777, 0o600);
});

test("same sender keeps independent resumable sessions for configured projects", async () => {
  const { adapter, calls } = makeFakeAdapter([
    { result: { ok: true, version: { qodercli: "1", protocol: "1" }, replyText: "one" } },
    { result: { ok: true, version: { qodercli: "1", protocol: "1" }, replyText: "two" } },
    { result: { ok: true, version: { qodercli: "1", protocol: "1" }, replyText: "one-again" } },
  ]);
  const registry = new SessionRegistry({
    storagePath: await tempStorage(),
    adapter,
    projects: [
      { alias: "one", cwd: "/tmp/one" },
      { alias: "two", cwd: "/tmp/two" },
    ],
  });

  await registry.send("robot-1", "openid-a", buildUserMessage("first"));
  await registry.switchProject("robot-1", "openid-a", "two");
  await registry.send("robot-1", "openid-a", buildUserMessage("second"));
  await registry.switchProject("robot-1", "openid-a", "one");
  await registry.send("robot-1", "openid-a", buildUserMessage("third"));

  assert.equal(calls.length, 3);
  assert.equal(calls[0]!.cwd, "/tmp/one");
  assert.equal(calls[1]!.cwd, "/tmp/two");
  assert.equal(calls[2]!.cwd, "/tmp/one");
  assert.equal(calls[0]!.sessionId, calls[2]!.sessionId);
  assert.equal(calls[2]!.resume, true);
});
