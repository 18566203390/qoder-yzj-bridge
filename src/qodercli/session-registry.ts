import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import type { CliMessage, CliResult } from "../contracts.ts";
import type { SessionAdapter } from "./session-adapter.ts";
import type { ProjectConfig } from "../yzj/types.ts";

export type SessionRegistryConfig = {
  storagePath: string;
  adapter: SessionAdapter;
  projects?: ProjectConfig[];
  cwd?: string;
};

type SessionEntry = {
  sessionId: string;
  createdAt: number;
  updatedAt: number;
};

type StoredEntry = {
  currentProject: string;
  projects: Record<string, SessionEntry>;
};

type RegistryState = {
  version: number;
  entries: Record<string, StoredEntry>;
};

type LegacyRegistryState = {
  version: 1;
  entries: Record<string, SessionEntry>;
};

export class SessionRegistry {
  private readonly storagePath: string;
  private readonly adapter: SessionAdapter;
  private readonly projects: Map<string, ProjectConfig>;
  private readonly entries = new Map<string, StoredEntry>();
  private readonly queues = new Map<string, Promise<unknown>>();
  private dirty = false;

  constructor(config: SessionRegistryConfig) {
    this.storagePath = path.resolve(config.storagePath);
    this.adapter = config.adapter;
    const configured = config.projects ?? (config.cwd ? [{ alias: "default", cwd: config.cwd }] : []);
    if (configured.length === 0) throw new TypeError("at least one project is required");
    this.projects = new Map();
    for (const project of configured) {
      if (!/^[A-Za-z0-9_.-]{1,64}$/.test(project.alias) || !path.isAbsolute(project.cwd)) {
        throw new TypeError("project alias or cwd is invalid");
      }
      if (this.projects.has(project.alias)) throw new TypeError(`duplicate project alias: ${project.alias}`);
      this.projects.set(project.alias, { alias: project.alias, cwd: path.resolve(project.cwd) });
    }
  }

  async load(): Promise<void> {
    let raw: string;
    try {
      raw = await fs.readFile(this.storagePath, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
      throw err;
    }

    const parsed = JSON.parse(raw) as RegistryState | LegacyRegistryState;
    if (parsed.version === 1) {
      const defaultProject = this.defaultProject();
      for (const [hash, entry] of Object.entries(parsed.entries)) {
        this.entries.set(hash, { currentProject: defaultProject, projects: { [defaultProject]: entry } });
      }
      this.dirty = true;
      await this.save();
      return;
    }
    if (parsed.version !== 2) {
      throw new Error(`unsupported session registry version: ${parsed.version}`);
    }
    for (const [hash, entry] of Object.entries(parsed.entries)) {
      this.entries.set(hash, entry);
    }
    this.dirty = false;
  }

  async save(): Promise<void> {
    if (!this.dirty) return;
    const state: RegistryState = {
      version: 2,
      entries: Object.fromEntries(this.entries),
    };
    const dir = path.dirname(this.storagePath);
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    const tmp = path.join(dir, `.session-registry-${randomUUID()}.tmp`);
    await fs.writeFile(tmp, JSON.stringify(state, null, 2), {
      mode: 0o600,
      flag: "w",
    });
    await fs.rename(tmp, this.storagePath);
    this.dirty = false;
  }

  getSessionId(senderHash: string): string | undefined {
    const entry = this.entries.get(senderHash);
    return entry?.projects[entry.currentProject]?.sessionId;
  }

  listProjects(): readonly string[] {
    return [...this.projects.keys()];
  }

  getCurrentProject(robotId: string, operatorOpenid: string): string {
    return this.entries.get(hashSender(robotId, operatorOpenid))?.currentProject ?? this.defaultProject();
  }

  async switchProject(robotId: string, operatorOpenid: string, alias: string): Promise<boolean> {
    if (!this.projects.has(alias)) return false;
    const senderHash = hashSender(robotId, operatorOpenid);
    return this.enqueue(senderHash, async () => {
      const existing = this.entries.get(senderHash);
      if (existing) {
        existing.currentProject = alias;
      } else {
        this.entries.set(senderHash, { currentProject: alias, projects: {} });
      }
      this.dirty = true;
      await this.save();
      return true;
    });
  }

  async send(
    robotId: string,
    operatorOpenid: string,
    message: CliMessage,
    options?: { onText?: (text: string) => void },
  ): Promise<CliResult> {
    const senderHash = hashSender(robotId, operatorOpenid);

    return this.enqueue(senderHash, async () => {
      const entry = this.entries.get(senderHash) ?? { currentProject: this.defaultProject(), projects: {} };
      const project = this.projects.get(entry.currentProject)!;
      const existing = entry.projects[project.alias];
      const sessionId = existing?.sessionId ?? randomUUID();
      const resume = existing !== undefined;

      const result = await this.adapter.send({
        cwd: project.cwd,
        sessionId,
        resume,
        messages: [message],
      }, options);

      if (result.ok) {
        const now = Date.now();
        if (!existing) {
          entry.projects[project.alias] = { sessionId, createdAt: now, updatedAt: now };
          this.entries.set(senderHash, entry);
        } else {
          existing.updatedAt = now;
        }
        this.dirty = true;
        await this.save();
      }

      return result;
    });
  }

  private defaultProject(): string {
    return this.projects.keys().next().value!;
  }

  private async enqueue<T>(senderHash: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(senderHash) ?? Promise.resolve();
    const next = previous.then(fn, fn);
    this.queues.set(senderHash, next);
    return next as Promise<T>;
  }
}

export function hashSender(robotId: string, operatorOpenid: string): string {
  return createHash("sha256")
    .update(`${robotId}:${operatorOpenid}`, "utf8")
    .digest("hex");
}
