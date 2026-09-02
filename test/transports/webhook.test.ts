import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

import { createWebhookTransport } from "../../src/transports/webhook.ts";
import { InboundRouter } from "../../src/yzj/inbound-router.ts";
import type { BridgeConfig, BridgeState, YZJIncomingMessage } from "../../src/yzj/types.ts";
import type { InboundResult } from "../../src/yzj/inbound-router.ts";

const logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

function makeConfig(overrides: Partial<BridgeConfig> = {}): BridgeConfig {
  return {
    qodercliPath: "/tmp/qodercli",
    cwd: "/tmp/ws",
    registryPath: "/tmp/registry.json",
    dedupePath: "/tmp/dedupe.json",
    statePath: "/tmp/state.json",
    account: {
      sendMsgUrl: "https://yzj.example.com/send?yzjtoken=token",
      webhookPath: "/yzj/webhook",
    },
    whitelist: ["openid-a"],
    webhookPort: 0,
    webhookHost: "127.0.0.1",
    ...overrides,
  };
}

function makeState(): BridgeState {
  return {
    running: false,
    connected: false,
    lastError: null,
    lastInboundAt: null,
    lastOutboundAt: null,
  };
}

function makeRouter(result: InboundResult): InboundRouter {
  return {
    handle: async () => result,
  } as unknown as InboundRouter;
}

function post(
  url: string,
  payload: unknown,
  headers: Record<string, string> = {},
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
          ...headers,
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

test("webhook returns success on reply", async () => {
  const state = makeState();
  const transport = createWebhookTransport(
    makeConfig(),
    state,
    makeRouter({ kind: "replied", replyText: "hello" }),
    logger,
  );
  await transport.start();
  const addr = transport.address() as { port: number };

  const result = await post(`http://127.0.0.1:${addr.port}/yzj/webhook`, {
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
  assert.equal((result.body as { data: { content: string } }).data.content, "hello");
  assert.equal(state.connected, true);

  await transport.stop();
});

test("webhook returns failure on rejection", async () => {
  const transport = createWebhookTransport(
    makeConfig(),
    makeState(),
    makeRouter({ kind: "rejected", reason: "not allowed" }),
    logger,
  );
  await transport.start();
  const addr = transport.address() as { port: number };

  const result = await post(`http://127.0.0.1:${addr.port}/yzj/webhook`, {
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
  assert.equal((result.body as { success: boolean }).success, false);
  assert.equal((result.body as { error: string }).error, "not allowed");

  await transport.stop();
});

test("webhook returns 404 for wrong path", async () => {
  const transport = createWebhookTransport(
    makeConfig(),
    makeState(),
    makeRouter({ kind: "replied", replyText: "" }),
    logger,
  );
  await transport.start();
  const addr = transport.address() as { port: number };

  const result = await post(`http://127.0.0.1:${addr.port}/wrong`, {
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

  assert.equal(result.status, 404);

  await transport.stop();
});

test("webhook rejects oversized payload", async () => {
  const transport = createWebhookTransport(
    makeConfig({ maxPayloadBytes: 10 }),
    makeState(),
    makeRouter({ kind: "replied", replyText: "" }),
    logger,
  );
  await transport.start();
  const addr = transport.address() as { port: number };

  const result = await post(`http://127.0.0.1:${addr.port}/yzj/webhook`, {
    type: 2,
    content: "this payload is too large",
  });

  assert.equal(result.status, 413);

  await transport.stop();
});

test("webhook passes signature header to router", async () => {
  let receivedSignature: string | undefined;
  const router = {
    handle: async (_msg: YZJIncomingMessage, options?: { signature?: string }) => {
      receivedSignature = options?.signature;
      return { kind: "replied" as const, replyText: "ok" };
    },
  } as unknown as InboundRouter;

  const transport = createWebhookTransport(makeConfig(), makeState(), router, logger);
  await transport.start();
  const addr = transport.address() as { port: number };

  await post(
    `http://127.0.0.1:${addr.port}/yzj/webhook`,
    {
      type: 2,
      robotId: "robot-1",
      robotName: "Robot",
      operatorOpenid: "openid-a",
      operatorName: "Alice",
      time: 1,
      msgId: "msg-1",
      content: "hi",
      groupType: 0,
    },
    { "x-yzj-sign": "signature-value" },
  );

  assert.equal(receivedSignature, "signature-value");

  await transport.stop();
});
