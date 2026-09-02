import fs from "node:fs/promises";
import path from "node:path";

import { createBridgeService } from "./bridge-service.ts";
import type { BridgeConfig } from "./yzj/types.ts";

type ConfigFile = {
  qodercliPath: string;
  cwd: string;
  projects?: Array<{ alias: string; cwd: string }>;
  registryPath: string;
  dedupePath: string;
  statePath: string;
  account: {
    sendMsgUrl: string;
    secret?: string;
    webhookPath?: string;
    inboundMode?: "webhook" | "websocket";
  };
  whitelist: string[];
  webhookPort?: number;
  webhookHost?: string;
  maxPayloadBytes?: number;
  maxReplyLength?: number;
  adapterTimeoutMs?: number;
  heartbeatMs?: number;
  staleMs?: number;
};

function readConfig(): Promise<ConfigFile> {
  const configPath = process.argv[2];
  if (!configPath) {
    console.error("Usage: qoder-yzj-bridge <config.json>");
    process.exit(1);
  }
  return fs.readFile(path.resolve(configPath), "utf8").then((raw) => JSON.parse(raw) as ConfigFile);
}

function validateConfig(config: ConfigFile): BridgeConfig {
  if (!path.isAbsolute(config.qodercliPath)) {
    throw new Error("qodercliPath must be absolute");
  }
  if (!path.isAbsolute(config.cwd)) {
    throw new Error("cwd must be absolute");
  }
  for (const project of config.projects ?? []) {
    if (!/^[A-Za-z0-9_.-]{1,64}$/.test(project.alias)) {
      throw new Error(`invalid project alias: ${project.alias}`);
    }
    if (!path.isAbsolute(project.cwd)) {
      throw new Error(`project cwd must be absolute: ${project.alias}`);
    }
  }
  return config as BridgeConfig;
}

async function main(): Promise<void> {
  const file = await readConfig();
  const config = validateConfig(file);

  const logger = {
    info: (message: string) => console.log(message),
    warn: (message: string) => console.warn(message),
    error: (message: string) => console.error(message),
  };

  const service = createBridgeService(config, logger);

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, async () => {
      await service.stop();
      process.exit(0);
    });
  }

  await service.start();
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
