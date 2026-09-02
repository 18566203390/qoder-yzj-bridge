import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";

import { WebSocketServer } from "ws";

import { createBridgeService } from "../src/bridge-service.ts";
import { buildSignatureString, computeHmacSha1 } from "../src/yzj/signature.ts";
import type { BridgeConfig, YZJIncomingMessage, YZJOutgoingMessage } from "../src/yzj/types.ts";

type RecordingLogger = {
  logger: {
    info: (message: string) => void;
    warn: (message: string) => void;
    error: (message: string) => void;
  };
  lines: string[];
};

function makeRecordingLogger(): RecordingLogger {
  const lines: string[] = [];
  return {
    lines,
    logger: {
      info: (m) => lines.push(m),
      warn: (m) => lines.push(m),
      error: (m) => lines.push(m),
    },
  };
}

const originalFetch = globalThis.fetch;

function installCapturingFetch(): { bodies: YZJOutgoingMessage[]; urls: string[] } {
  const bodies: YZJOutgoingMessage[] = [];
  const urls: string[] = [];
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    urls.push(String(url));
    bodies.push(JSON.parse(String(init?.body)) as YZJOutgoingMessage);
    return {
      ok: true,
      status: 200,
      json: async () => ({ success: true, data: { type: 2, content: "ok" } }),
    } as unknown as Response;
  }) as typeof fetch;
  return { bodies, urls };
}

function restoreFetch(): void {
  globalThis.fetch = originalFetch;
}

async function tempDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

async function writeRecordingQodercli(
  dir: string,
  invocationLogPath: string,
): Promise<string> {
  const script = path.join(dir, "qodercli");
  const content = `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
function argValue(name) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : null;
}
const sessionId = argValue("--session-id") ?? argValue("--resume");
const resume = args.includes("--resume");
const lines = [];
process.stdin.on("data", (chunk) => {
  for (const line of chunk.toString("utf8").split("\\n")) {
    if (line.trim()) lines.push(JSON.parse(line.trim()));
  }
});
process.stdin.on("end", () => {
  const text = lines.map((l) => l.message?.content?.map((c) => c.text).join("")).join("");
  fs.appendFileSync(${JSON.stringify(invocationLogPath)}, JSON.stringify({ sessionId, resume, text }) + "\\n");
  console.log(JSON.stringify({ type: "system", subtype: "init", qodercli_version: "1", protocol_version: "1" }));
  console.log(JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "echo:" + text }] } }));
  console.log(JSON.stringify({ type: "result", subtype: "success" }));
});
`;
  await fs.writeFile(script, content, { mode: 0o755 });
  return script;
}

async function writeFailingQodercli(dir: string): Promise<string> {
  const script = path.join(dir, "qodercli-fail");
  const content = `#!/usr/bin/env node
const lines = [];
process.stdin.on("data", (chunk) => {
  for (const line of chunk.toString("utf8").split("\\n")) {
    if (line.trim()) lines.push(JSON.parse(line.trim()));
  }
});
process.stdin.on("end", () => {
  const text = lines.map((l) => l.message?.content?.map((c) => c.text).join("")).join("");
  console.error("qodercli internal crash, echoed input: " + text);
  process.exit(3);
});
`;
  await fs.writeFile(script, content, { mode: 0o755 });
  return script;
}

async function readInvocationLog(invocationLogPath: string): Promise<
  Array<{ sessionId: string | null; resume: boolean; text: string }>
> {
  let raw: string;
  try {
    raw = await fs.readFile(invocationLogPath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  return raw
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line));
}

function makeMessage(
  operatorOpenid: string,
  msgId: string,
  content: string,
): YZJIncomingMessage {
  return {
    type: 2,
    robotId: "robot-1",
    robotName: "Robot",
    operatorOpenid,
    operatorName: "User",
    time: 1,
    msgId,
    content,
    groupType: 0,
  };
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail("waitFor timed out");
}

test("websocket mode gives two whitelisted users isolated qodercli sessions", async (t) => {
  const captured = installCapturingFetch();
  t.after(restoreFetch);

  const dir = await tempDir("qoder-yzj-ws-isolation-");
  const invocationLogPath = path.join(dir, "invocations.jsonl");
  const qodercliPath = await writeRecordingQodercli(dir, invocationLogPath);

  const wsServer = new WebSocketServer({ port: 0 });
  await new Promise<void>((resolve) => wsServer.once("listening", resolve));
  const wsPort = (wsServer.address() as { port: number }).port;
  t.after(() => {
    wsServer.close();
    return new Promise<void>((resolve) => wsServer.once("close", () => resolve()));
  });

  const config: BridgeConfig = {
    qodercliPath,
    cwd: dir,
    registryPath: path.join(dir, "registry.json"),
    dedupePath: path.join(dir, "dedupe.json"),
    statePath: path.join(dir, "state.json"),
    account: {
      sendMsgUrl: `http://127.0.0.1:${wsPort}/send?yzjtoken=ws-token-value`,
      inboundMode: "websocket",
    },
    whitelist: ["openid-a", "openid-b"],
    heartbeatMs: 10_000,
    staleMs: 30_000,
    adapterTimeoutMs: 30_000,
  };

  const recording = makeRecordingLogger();
  const service = createBridgeService(config, recording.logger);
  await service.start();
  t.after(() => service.stop());

  const sockets: Array<import("ws").WebSocket> = [];
  wsServer.on("connection", (socket) => sockets.push(socket));

  await waitFor(() => sockets.length === 1);
  assert.equal(service.getState().connected, true);

  const send = (msg: YZJIncomingMessage) =>
    sockets[0]!.send(JSON.stringify(msg));

  send(makeMessage("openid-a", "msg-a-1", "first-from-a"));
  send(makeMessage("openid-b", "msg-b-1", "first-from-b"));

  await waitFor(() => captured.bodies.length === 2);
  const replyTexts = captured.bodies.map((b) => b.content).sort();
  assert.deepEqual(replyTexts, ["echo:first-from-a", "echo:first-from-b"]);

  send(makeMessage("openid-a", "msg-a-2", "second-from-a"));
  await waitFor(() => captured.bodies.length === 3);

  await service.stop();

  const invocations = await readInvocationLog(invocationLogPath);
  assert.equal(invocations.length, 3);

  const byText = new Map(invocations.map((i) => [i.text, i]));
  const first = byText.get("first-from-a")!;
  const second = byText.get("second-from-a")!;
  const other = byText.get("first-from-b")!;

  assert.ok(first.sessionId, "first call should carry a session id");
  assert.equal(first.resume, false);
  assert.equal(second.resume, true);
  assert.equal(second.sessionId, first.sessionId);
  assert.ok(other.sessionId && other.sessionId !== first.sessionId);

  const registryRaw = await fs.readFile(config.registryPath, "utf8");
  const registry = JSON.parse(registryRaw) as { entries: Record<string, unknown> };
  const keys = Object.keys(registry.entries);
  assert.equal(keys.length, 2);
  for (const key of keys) {
    assert.match(key, /^[0-9a-f]{64}$/);
  }
  assert.ok(!registryRaw.includes("openid-a"));
  assert.ok(!registryRaw.includes("openid-b"));
});

test("logs, replies, and persisted state never contain yzj secrets, message bodies, or CLI stderr", async (t) => {
  const TOKEN_VALUE = "token-secret-XYZ";
  const SECRET_VALUE = "webhook-secret-XYZ";
  const SIGNATURE_VALUE = "bad-signature-value-XYZ";
  const CONTENT_VALUE = "leaky-message-body-XYZ";

  const capturing = installCapturingFetch();
  t.after(restoreFetch);

  const dir = await tempDir("qoder-yzj-leak-");
  const qodercliPath = await writeFailingQodercli(dir);

  const config: BridgeConfig = {
    qodercliPath,
    cwd: dir,
    registryPath: path.join(dir, "registry.json"),
    dedupePath: path.join(dir, "dedupe.json"),
    statePath: path.join(dir, "state.json"),
    account: {
      sendMsgUrl: `https://yzj.example.com/send?yzjtoken=${TOKEN_VALUE}`,
      secret: SECRET_VALUE,
      webhookPath: "/yzj/webhook",
      inboundMode: "webhook",
    },
    whitelist: ["openid-a"],
    webhookPort: 0,
    webhookHost: "127.0.0.1",
    adapterTimeoutMs: 30_000,
  };

  const recording = makeRecordingLogger();
  const service = createBridgeService(config, recording.logger);
  await service.start();
  t.after(() => service.stop());

  const address = service.getWebhookAddress() as { port: number };
  const failureMessage = makeMessage("openid-a", "msg-fail-1", CONTENT_VALUE);
  const validSignature = computeHmacSha1(
    buildSignatureString(failureMessage),
    SECRET_VALUE,
  );

  const failure = await post(
    `http://127.0.0.1:${address.port}/yzj/webhook`,
    failureMessage,
    validSignature,
  );
  assert.equal(failure.status, 500);
  assert.equal((failure.body as { error: string }).error, "nonzero_exit");
  assert.equal(service.getState().lastError, "nonzero_exit");

  const badSignatureMessage = makeMessage("openid-a", "msg-fail-2", "another-body");
  const rejected = await post(
    `http://127.0.0.1:${address.port}/yzj/webhook`,
    badSignatureMessage,
    SIGNATURE_VALUE,
  );
  assert.equal(rejected.status, 200);
  assert.equal((rejected.body as { error: string }).error, "invalid signature");

  await service.stop();

  const stateRaw = await fs.readFile(config.statePath, "utf8");

  const forbidden = [TOKEN_VALUE, SECRET_VALUE, SIGNATURE_VALUE, CONTENT_VALUE, "qodercli internal crash"];
  const allLogs = recording.lines.join("\n");
  for (const value of forbidden) {
    assert.ok(!allLogs.includes(value), `logs must not contain ${value}`);
    assert.ok(!stateRaw.includes(value), `state.json must not contain ${value}`);
    assert.ok(
      !JSON.stringify(failure.body).includes(value),
      `error reply must not contain ${value}`,
    );
  }

  assert.equal(capturing.bodies.length, 0);

  let registryRaw: string;
  try {
    registryRaw = await fs.readFile(config.registryPath, "utf8");
  } catch {
    registryRaw = "";
  }
  assert.ok(!registryRaw.includes("openid-a"));
});

function post(
  url: string,
  payload: unknown,
  signature: string,
): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(payload);
    const req = http.request(
      url,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(data),
          "x-yzj-sign": signature,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf8");
          try {
            resolve({ status: res.statusCode ?? 0, body: JSON.parse(raw) });
          } catch {
            resolve({ status: res.statusCode ?? 0, body: raw });
          }
        });
      },
    );
    req.on("error", reject);
    req.write(data);
    req.end();
  });
}
