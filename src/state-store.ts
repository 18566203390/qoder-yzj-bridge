import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

import type { BridgeState } from "./yzj/types.ts";

const STATE_VERSION = 1;

type PersistedState = {
  version: number;
  running: boolean;
  connected: boolean;
  lastError: string | null;
  lastInboundAt: number | null;
  lastOutboundAt: number | null;
};

export class BridgeStateStore {
  private readonly storagePath: string;

  constructor(storagePath: string) {
    this.storagePath = path.resolve(storagePath);
  }

  async load(): Promise<BridgeState> {
    let raw: string;
    try {
      raw = await fs.readFile(this.storagePath, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        return this.defaultState();
      }
      throw err;
    }

    const parsed = JSON.parse(raw) as PersistedState;
    if (parsed.version !== STATE_VERSION) {
      throw new Error(`unsupported bridge state version: ${parsed.version}`);
    }

    return {
      running: parsed.running ?? false,
      connected: parsed.connected ?? false,
      lastError: parsed.lastError ?? null,
      lastInboundAt: parsed.lastInboundAt ?? null,
      lastOutboundAt: parsed.lastOutboundAt ?? null,
    };
  }

  async save(state: BridgeState): Promise<void> {
    const payload: PersistedState = {
      version: STATE_VERSION,
      running: state.running,
      connected: state.connected,
      lastError: state.lastError,
      lastInboundAt: state.lastInboundAt,
      lastOutboundAt: state.lastOutboundAt,
    };

    const dir = path.dirname(this.storagePath);
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    const tmp = path.join(dir, `.bridge-state-${randomUUID()}.tmp`);
    await fs.writeFile(tmp, JSON.stringify(payload, null, 2), {
      mode: 0o600,
      flag: "w",
    });
    await fs.rename(tmp, this.storagePath);
  }

  defaultState(): BridgeState {
    return {
      running: false,
      connected: false,
      lastError: null,
      lastInboundAt: null,
      lastOutboundAt: null,
    };
  }
}
