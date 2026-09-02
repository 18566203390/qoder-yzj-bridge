import fs from "node:fs/promises";
import path from "node:path";

import { createRunner } from "./qodercli/runner.ts";
import { createSessionAdapter } from "./qodercli/session-adapter.ts";
import { SessionRegistry } from "./qodercli/session-registry.ts";
import { InboundDedupeStore } from "./yzj/dedupe.ts";
import { InboundRouter } from "./yzj/inbound-router.ts";
import { YZJSender } from "./yzj/sender.ts";
import { BridgeStateStore } from "./state-store.ts";
import { createWebhookTransport, type WebhookTransport } from "./transports/webhook.ts";
import { createWebSocketTransport } from "./transports/websocket.ts";
import type { AddressInfo } from "node:net";

import type { BridgeConfig, BridgeState, Logger } from "./yzj/types.ts";

export type BridgeService = {
  start(): Promise<void>;
  stop(): Promise<void>;
  getState(): BridgeState;
  getWebhookAddress(): AddressInfo | string | null;
};

export function createBridgeService(config: BridgeConfig, logger: Logger): BridgeService {
  const projects = config.projects ?? [{ alias: "default", cwd: config.cwd }];
  const stateStore = new BridgeStateStore(config.statePath);
  const dedupe = new InboundDedupeStore(config.dedupePath);
  const registry = new SessionRegistry({
    storagePath: config.registryPath,
    adapter: createSessionAdapter({
      runner: createRunner({
        qodercliPath: config.qodercliPath,
        allowedCwds: projects.map((project) => project.cwd),
        defaultTimeoutMs: config.adapterTimeoutMs,
      }),
      timeoutMs: config.adapterTimeoutMs,
    }),
    projects,
  });

  const state: BridgeState = stateStore.defaultState();
  const sender = new YZJSender({
    account: config.account,
    logger,
    maxReplyLength: config.maxReplyLength,
  });
  const router = new InboundRouter({
    config,
    registry,
    dedupe,
    sender,
    state,
    logger,
  });

  const mode = config.account.inboundMode ?? "webhook";
  const transports: Array<{ start(): Promise<void>; stop(): Promise<void> }> = [];
  let webhookTransport: WebhookTransport | undefined;

  if (mode === "webhook") {
    webhookTransport = createWebhookTransport(config, state, router, logger);
    transports.push(webhookTransport);
  } else if (mode === "websocket") {
    transports.push(createWebSocketTransport(config, state, router, logger));
  } else {
    throw new TypeError(`unsupported inbound mode: ${mode}`);
  }

  let running = false;

  return {
    async start() {
      if (running) return;
      await ensureParentDirectories(config);
      await dedupe.load();
      await registry.load();
      Object.assign(state, await stateStore.load());
      state.running = true;
      await stateStore.save(state);

      for (const transport of transports) {
        await transport.start();
      }
      running = true;
      logger.info?.(`[bridge] started in ${mode} mode`);
    },

    async stop() {
      if (!running) return;
      running = false;
      state.running = false;

      for (const transport of transports) {
        await transport.stop().catch((err) => {
          logger.error?.(`[bridge] transport stop error: ${err instanceof Error ? err.message : String(err)}`);
        });
      }

      await dedupe.save();
      await registry.save();
      await stateStore.save(state);
      logger.info?.("[bridge] stopped");
    },

    getState() {
      return state;
    },

    getWebhookAddress() {
      return webhookTransport?.address() ?? null;
    },
  };
}

async function ensureParentDirectories(config: BridgeConfig): Promise<void> {
  const paths = [config.registryPath, config.dedupePath, config.statePath];
  for (const p of paths) {
    await fs.mkdir(path.dirname(p), { recursive: true, mode: 0o700 });
  }
}
