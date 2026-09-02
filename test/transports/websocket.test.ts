import test from "node:test";
import assert from "node:assert/strict";
import { WebSocketServer } from "ws";

import { createWebSocketTransport } from "../../src/transports/websocket.ts";
import { InboundRouter } from "../../src/yzj/inbound-router.ts";
import type { BridgeConfig, BridgeState, YZJIncomingMessage } from "../../src/yzj/types.ts";

const logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

function baseConfig(): BridgeConfig {
  return {
    qodercliPath: "/tmp/qodercli",
    cwd: "/tmp/ws",
    registryPath: "/tmp/registry.json",
    dedupePath: "/tmp/dedupe.json",
    statePath: "/tmp/state.json",
    account: {
      sendMsgUrl: "https://yzj.example.com/send?yzjtoken=token",
      inboundMode: "websocket",
    },
    whitelist: ["openid-a"],
    heartbeatMs: 50,
    staleMs: 200,
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

function makeRouter(): InboundRouter {
  return {
    handle: async () => ({ kind: "replied" as const, replyText: "ok" }),
  } as unknown as InboundRouter;
}

async function withMockServer(
  t: import("node:test").TestContext,
  handler: (port: number, server: WebSocketServer) => Promise<void>,
): Promise<void> {
  const server = new WebSocketServer({ port: 0 });
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const port = (server.address() as { port: number }).port;

  try {
    await handler(port, server);
  } finally {
    server.close();
    await new Promise<void>((resolve) => server.once("close", resolve));
  }
}

test("websocket connects and dispatches business message", async (t) => {
  const state = makeState();
  let received: YZJIncomingMessage | undefined;
  const router = {
    handle: async (msg: YZJIncomingMessage) => {
      received = msg;
      return { kind: "replied" as const, replyText: "ok" };
    },
  } as unknown as InboundRouter;

  await withMockServer(t, async (port, server) => {
    server.on("connection", (socket) => {
      socket.send(
        JSON.stringify({
          type: 2,
          robotId: "robot-1",
          robotName: "Robot",
          operatorOpenid: "openid-a",
          operatorName: "Alice",
          time: 1,
          msgId: "msg-1",
          content: "hi",
          groupType: 0,
        }),
      );
    });

    const config: BridgeConfig = {
      ...baseConfig(),
      account: {
        ...baseConfig().account,
        sendMsgUrl: `http://127.0.0.1:${port}/send?yzjtoken=token`,
      },
    };
    const transport = createWebSocketTransport(config, state, router, logger);

    await transport.start();
    await new Promise((resolve) => setTimeout(resolve, 150));

    assert.equal(state.connected, true);
    assert.equal(received?.content, "hi");

    await transport.stop();
  });
});

test("websocket sends ack for directPush control frame", async (t) => {
  const state = makeState();

  await withMockServer(t, async (port, server) => {
    let ackReceived = false;
    server.on("connection", (socket) => {
      socket.send(JSON.stringify({ cmd: "directPush", seq: 42, needAck: true }));
      socket.on("message", (data) => {
        const payload = data.toString("utf8");
        if (payload.includes('"cmd":"ack"') && payload.includes("42")) {
          ackReceived = true;
        }
      });
    });

    const config: BridgeConfig = {
      ...baseConfig(),
      account: {
        ...baseConfig().account,
        sendMsgUrl: `http://127.0.0.1:${port}/send?yzjtoken=token`,
      },
    };
    const transport = createWebSocketTransport(config, state, makeRouter(), logger);

    await transport.start();
    await new Promise((resolve) => setTimeout(resolve, 150));

    assert.equal(ackReceived, true);

    await transport.stop();
  });
});
