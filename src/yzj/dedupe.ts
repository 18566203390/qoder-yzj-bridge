import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

export type DedupeStoreOptions = {
  ttlMs?: number;
  now?: () => number;
};

type DedupeState = {
  version: number;
  entries: Record<string, number>;
};

export class InboundDedupeStore {
  private readonly path: string;
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly seen = new Map<string, number>();
  private dirty = false;

  constructor(storagePath: string, options: DedupeStoreOptions = {}) {
    this.path = path.resolve(storagePath);
    this.ttlMs = options.ttlMs ?? 600_000;
    this.now = options.now ?? (() => Date.now());
  }

  async load(): Promise<void> {
    let raw: string;
    try {
      raw = await fs.readFile(this.path, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
      throw err;
    }

    const parsed = JSON.parse(raw) as DedupeState;
    if (parsed.version !== 1) {
      throw new Error(`unsupported dedupe store version: ${parsed.version}`);
    }

    const now = this.now();
    for (const [key, expiresAt] of Object.entries(parsed.entries)) {
      if (expiresAt > now) this.seen.set(key, expiresAt);
    }
    this.dirty = false;
  }

  async save(): Promise<void> {
    if (!this.dirty) return;
    const state: DedupeState = {
      version: 1,
      entries: Object.fromEntries(this.seen),
    };

    const dir = path.dirname(this.path);
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    const tmp = path.join(dir, `.dedupe-${randomUUID()}.tmp`);
    await fs.writeFile(tmp, JSON.stringify(state, null, 2), {
      mode: 0o600,
      flag: "w",
    });
    await fs.rename(tmp, this.path);
    this.dirty = false;
  }

  markSeen(robotId: string, msgId: string): boolean {
    const normalizedMsgId = msgId.trim();
    if (!normalizedMsgId) return true;

    const now = this.now();
    this.pruneExpired(now);

    const key = `${robotId}:${normalizedMsgId}`;
    const expiresAt = this.seen.get(key);
    if (expiresAt && expiresAt > now) return false;

    this.seen.set(key, now + this.ttlMs);
    this.dirty = true;
    return true;
  }

  clear(): void {
    if (this.seen.size > 0) this.dirty = true;
    this.seen.clear();
  }

  private pruneExpired(now: number): void {
    for (const [key, expiresAt] of this.seen.entries()) {
      if (expiresAt <= now) this.seen.delete(key);
    }
  }
}
