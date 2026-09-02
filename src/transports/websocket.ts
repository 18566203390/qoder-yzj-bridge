import WebSocket from "ws";

import { InboundRouter } from "../yzj/inbound-router.ts";
import {
  classifyWebSocketPayload,
  DEFAULT_WEBSOCKET_HEALTH,
  deriveYZJWebSocketUrl,
  getReconnectDelayMs,
  isWebSocketStale,
  shouldReconnectAfterInvalidFrames,
} from "../yzj/websocket-helpers.ts";
import type { BridgeConfig, BridgeState, Logger } from "../yzj/types.ts";

export type WebSocketTransport = {
  start(): Promise<void>;
  stop(): Promise<void>;
};

export function createWebSocketTransport(
  config: BridgeConfig,
  state: BridgeState,
  router: InboundRouter,
  logger: Logger,
): WebSocketTransport {
  const heartbeatMs = config.heartbeatMs ?? DEFAULT_WEBSOCKET_HEALTH.heartbeatMs;
  const staleMs = config.staleMs ?? DEFAULT_WEBSOCKET_HEALTH.staleMs;
  const url = deriveYZJWebSocketUrl(config.account.sendMsgUrl);

  let ws: WebSocket | undefined;
  let stopped = false;
  let reconnectAttempt = 0;
  let reconnectTimer: NodeJS.Timeout | undefined;
  let heartbeatTimer: NodeJS.Timeout | undefined;
  let lastPongAt = Date.now();
  let lastActivityAt = Date.now();
  let consecutiveInvalidFrames = 0;

  return {
    async start() {
      stopped = false;
      connect();
    },

    async stop() {
      stopped = true;
      clearTimers();
      if (ws) {
        const socket = ws;
        ws = undefined;
        socket.terminate();
      }
      state.connected = false;
    },
  };

  function connect(): void {
    if (stopped || ws) return;

    try {
      ws = new WebSocket(url);
    } catch (err) {
      logger.error?.(`[websocket] failed to create socket: ${err instanceof Error ? err.message : String(err)}`);
      scheduleReconnect();
      return;
    }

    ws.on("open", () => {
      state.connected = true;
      reconnectAttempt = 0;
      consecutiveInvalidFrames = 0;
      lastPongAt = Date.now();
      lastActivityAt = Date.now();
      logger.info?.("[websocket] connected");
      startHeartbeat();
    });

    ws.on("message", (data) => {
      lastActivityAt = Date.now();
      handleMessage(data).catch((err) => {
        logger.error?.(`[websocket] message handler error: ${err instanceof Error ? err.message : String(err)}`);
      });
    });

    ws.on("pong", () => {
      lastPongAt = Date.now();
      lastActivityAt = Date.now();
    });

    ws.on("ping", () => {
      ws?.pong();
      lastActivityAt = Date.now();
    });

    ws.on("close", () => {
      logger.info?.("[websocket] disconnected");
      cleanupSocket();
      scheduleReconnect();
    });

    ws.on("error", (err) => {
      logger.error?.(`[websocket] error: ${err.message}`);
      state.lastError = err.message;
      cleanupSocket();
      scheduleReconnect();
    });
  }

  async function handleMessage(data: WebSocket.RawData): Promise<void> {
    let payload: unknown;
    try {
      payload = JSON.parse(data.toString("utf8"));
    } catch {
      payload = data.toString("utf8");
    }

    const result = classifyWebSocketPayload(payload);

    if (result.kind === "control") {
      if (result.ack && ws?.readyState === WebSocket.OPEN) {
        ws.send(result.ack);
      }
      return;
    }

    if (result.kind === "invalid") {
      consecutiveInvalidFrames += 1;
      if (shouldReconnectAfterInvalidFrames(consecutiveInvalidFrames)) {
        logger.warn?.(`[websocket] too many invalid frames, reconnecting`);
        reconnect();
      }
      return;
    }

    consecutiveInvalidFrames = 0;
    await router.handle(result.message);
  }

  function startHeartbeat(): void {
    clearTimers();
    heartbeatTimer = setInterval(() => {
      const now = Date.now();

      if (isWebSocketStale({ now, lastPongAt, lastActivityAt, staleMs })) {
        logger.warn?.("[websocket] connection stale, reconnecting");
        reconnect();
        return;
      }

      if (now - lastActivityAt >= heartbeatMs && ws?.readyState === WebSocket.OPEN) {
        ws.ping();
      }
    }, heartbeatMs);
  }

  function scheduleReconnect(): void {
    if (stopped) return;
    clearTimers();
    const delay = getReconnectDelayMs(reconnectAttempt);
    reconnectAttempt += 1;
    reconnectTimer = setTimeout(() => {
      logger.info?.(`[websocket] reconnecting after ${delay}ms`);
      connect();
    }, delay);
  }

  function reconnect(): void {
    if (ws) {
      const socket = ws;
      ws = undefined;
      socket.terminate();
    }
    cleanupSocket();
    scheduleReconnect();
  }

  function cleanupSocket(): void {
    state.connected = false;
    clearTimers();
  }

  function clearTimers(): void {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = undefined;
    }
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = undefined;
    }
  }
}
