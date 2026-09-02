import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";

import { createBridgeService } from "../src/bridge-service.ts";
import type { BridgeConfig } from "../src/yzj/types.ts";

const logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

const originalFetch = globalThis.fetch;

function installMockFetch(): void {
  globalThis.fetch = async () =>
    ({
      ok: true,
      status: 200,
      json: async () => ({ success: true, data: { type: 2, content: "ok" } }),
    }) as unknown as Response;
}

function restoreFetch(): void {
  globalThis.fetch = originalFetch;
}

async function tempDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "qoder-yzj-bridge-service-"));
}

async function writeFakeQodercli(dir: string): Promise<string> {
  const script = path.join(dir, "qodercli");
  const content = `#!/usr/bin/env node
const lines = [];
process.stdin.on('data', (chunk) => {
  for (const line of chunk.toString('utf8').split('\\n')) {
    if (line.trim()) lines.push(JSON.parse(line.trim()));
  }
});
process.stdin.on('end', () => {
  const text = lines.map(l => l.message?.content?.map((c) => c.text).join('')).join('');
  console.log(JSON.stringify({ type: 'system', subtype: 'init', qodercli_version: '1', protocol_version: '1' }));
  console.log(JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'echo:' + text }] } }));
  console.log(JSON.stringify({ type: 'result', subtype: 'success' }));
});
`;
  await fs.writeFile(script, content, { mode: 0o755 });
  return script;
}

function makeConfig(dir: string, qodercliPath: string): BridgeConfig {
  return {
    qodercliPath,
    cwd: dir,
    registryPath: path.join(dir, "registry.json"),
    dedupePath: path.join(dir, "dedupe.json"),
    statePath: path.join(dir, "state.json"),
    account: {
      sendMsgUrl: "https://yzj.example.com/send?yzjtoken=token",
      webhookPath: "/yzj/webhook",
      inboundMode: "webhook",
    },
    whitelist: ["openid-a"],
    webhookPort: 0,
    webhookHost: "127.0.0.1",
  };
}

function post(url: string, payload: unknown): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(payload);
    const req = http.request(
      url,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(data),
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

test("bridge service starts webhook server and routes message through qodercli", async (t) => {
  installMockFetch();
  t.after(restoreFetch);

  const dir = await tempDir();
  const qodercliPath = await writeFakeQodercli(dir);
  const config = makeConfig(dir, qodercliPath);
  const service = createBridgeService(config, logger);

  await service.start();
  const state = service.getState();
  assert.equal(state.running, true);

  const address = service.getWebhookAddress() as { port: number };
  const result = await post(`http://127.0.0.1:${address.port}/yzj/webhook`, {
    type: 2,
    robotId: "robot-1",
    robotName: "Robot",
    operatorOpenid: "openid-a",
    operatorName: "Alice",
    time: 1,
    msgId: "msg-1",
    content: "hi",
    groupType: 0,
  });

  assert.equal(result.status, 200);
  assert.equal((result.body as { success: boolean }).success, true);
  assert.equal((result.body as { data: { content: string } }).data.content, "echo:hi");

  await service.stop();
  assert.equal(service.getState().running, false);
});

test("bridge service persists state on stop", async (t) => {
  installMockFetch();
  t.after(restoreFetch);

  const dir = await tempDir();
  const qodercliPath = await writeFakeQodercli(dir);
  const config = makeConfig(dir, qodercliPath);
  const service = createBridgeService(config, logger);

  await service.start();
  const address = service.getWebhookAddress() as { port: number };
  await post(`http://127.0.0.1:${address.port}/yzj/webhook`, {
    type: 2,
    robotId: "robot-1",
    robotName: "Robot",
    operatorOpenid: "openid-a",
    operatorName: "Alice",
    time: 1,
    msgId: "msg-2",
    content: "hello",
    groupType: 0,
  });
  await service.stop();

  const raw = await fs.readFile(config.statePath, "utf8");
  const persisted = JSON.parse(raw);
  assert.equal(persisted.running, false);
  assert.equal(typeof persisted.lastInboundAt, "number");
});
