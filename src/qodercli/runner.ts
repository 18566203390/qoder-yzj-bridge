import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import path from "node:path";

import type {
  CliInvocation,
  CliProcessRunner,
  CliRawResult,
} from "../contracts.ts";

export type SpawnFn = (
  command: string,
  args: readonly string[],
  options: {
    shell: false;
    cwd: string;
    env: NodeJS.ProcessEnv;
    stdio: ["pipe", "pipe", "pipe"];
  },
) => ChildProcessWithoutNullStreams;

export type RunnerConfig = {
  qodercliPath: string;
  allowedCwds?: readonly string[];
  /** @deprecated 使用 allowedCwds */
  allowedCwd?: string;
  defaultTimeoutMs?: number;
  maxOutputBytes?: number;
  spawn?: SpawnFn;
};

const PERMISSION_BYPASS_FLAGS = new Set([
  "--dangerously-skip-permissions",
  "--permission-mode",
]);

const ALLOWED_ENV_KEYS = new Set([
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "TMPDIR",
  "XDG_CONFIG_HOME",
  "XDG_CACHE_HOME",
  "XDG_DATA_HOME",
]);

const COMPLETE_TASK_SYSTEM_PROMPT =
  "Treat each inbound request as a complete task. Perform the necessary allowed work in this turn and return only a final, factual answer. Do not reply with plans, progress updates, promises to continue, or requests for another message. If a permission is required but unavailable, state that final blocker clearly.";

function isAbsolutePath(value: string): boolean {
  return path.isAbsolute(value) && path.normalize(value) === value;
}

function validateSafeIdentifier(value: string, name: string): void {
  if (!value || typeof value !== "string") {
    throw new TypeError(`${name} must be a non-empty string`);
  }
  if (!/^[A-Za-z0-9_.-]{1,128}$/.test(value)) {
    throw new TypeError(`${name} contains unsafe characters`);
  }
}

function buildArgs(invocation: CliInvocation): string[] {
  const args: string[] = [
    "--cwd",
    invocation.cwd,
  ];

  if (invocation.resume) {
    args.push("--resume", invocation.sessionId);
  } else {
    args.push("--session-id", invocation.sessionId);
  }

  args.push(
    "--print",
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--append-system-prompt",
    COMPLETE_TASK_SYSTEM_PROMPT,
  );

  return args;
}

function assertNoBypassArgs(args: readonly string[]): void {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (PERMISSION_BYPASS_FLAGS.has(arg)) {
      throw new Error(`disallowed qodercli argument: ${arg}`);
    }
    if (arg === "bypass_permissions" && i > 0 && args[i - 1] === "--permission-mode") {
      throw new Error("disallowed qodercli permission mode: bypass_permissions");
    }
  }
}

function buildMinimalEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ALLOWED_ENV_KEYS) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  // The parent agent context sets this and breaks qodercli SDK streaming.
  delete env.QODER_AGENT_SDK_ENTRYPOINT;
  return env;
}

export function createRunner(config: RunnerConfig): CliProcessRunner {
  const qodercliPath = config.qodercliPath;
  const allowedCwds = config.allowedCwds ?? (config.allowedCwd ? [config.allowedCwd] : []);

  if (!isAbsolutePath(qodercliPath)) {
    throw new TypeError("qodercliPath must be an absolute, normalized path");
  }
  if (!Array.isArray(allowedCwds) || allowedCwds.length === 0 || !allowedCwds.every(isAbsolutePath)) {
    throw new TypeError("allowedCwds must contain absolute, normalized paths");
  }

  const resolvedQodercliPath = path.resolve(qodercliPath);
  const resolvedAllowedCwds = new Set(allowedCwds.map((cwd) => path.resolve(cwd)));
  const defaultTimeoutMs = config.defaultTimeoutMs ?? 120_000;
  const maxOutputBytes = config.maxOutputBytes ?? 1_048_576;
  const spawnFn = config.spawn ?? (spawn as unknown as SpawnFn);

  return async (
    invocation: CliInvocation,
    options?: { signal?: AbortSignal; onStdoutLine?: (line: string) => void },
  ): Promise<CliRawResult> => {
    const cwd = path.resolve(invocation.cwd);
    if (!resolvedAllowedCwds.has(cwd)) {
      throw new TypeError(
        `invocation cwd ${cwd} is outside allowed cwd workspaces`,
      );
    }
    validateSafeIdentifier(invocation.sessionId, "sessionId");

    const args = buildArgs(invocation);
    assertNoBypassArgs(args);

    const env = buildMinimalEnv();

    const child = spawnFn(resolvedQodercliPath, args, {
      shell: false,
      cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    const stdin = child.stdin;
    if (!stdin) {
      throw new Error("qodercli stdin is not available");
    }

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let stdoutTruncated = false;
    let stderrTruncated = false;
    let stdoutRemainder = "";

    child.stdout.on("data", (chunk: Buffer) => {
      if (stdoutTruncated) return;
      stdoutBytes += chunk.length;
      if (stdoutBytes > maxOutputBytes) {
        stdoutTruncated = true;
        child.stdout.destroy();
        return;
      }
      stdoutChunks.push(chunk);
      const lines = (stdoutRemainder + chunk.toString("utf8")).split("\n");
      stdoutRemainder = lines.pop() ?? "";
      for (const line of lines) {
        const normalized = line.trim();
        if (normalized) options?.onStdoutLine?.(normalized);
      }
    });

    child.stderr.on("data", (chunk: Buffer) => {
      if (stderrTruncated) return;
      stderrBytes += chunk.length;
      if (stderrBytes > maxOutputBytes) {
        stderrTruncated = true;
        child.stderr.destroy();
        return;
      }
      stderrChunks.push(chunk);
    });

    const input = invocation.messages
      .map((message) =>
        JSON.stringify({ type: "user", message } satisfies StreamJsonInputLine),
      )
      .join("\n");

    if (input) {
      stdin.write(input + "\n");
    }
    stdin.end();

    const abortSignal = options?.signal;
    let timedOut = false;
    let exitCode: number | null = null;

    await new Promise<void>((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
        setTimeout(() => {
          if (!child.killed) child.kill("SIGKILL");
        }, 5_000);
      }, defaultTimeoutMs);

      function onAbort() {
        clearTimeout(timeoutId);
        child.kill("SIGTERM");
        setTimeout(() => {
          if (!child.killed) child.kill("SIGKILL");
        }, 2_000);
      }

      abortSignal?.addEventListener("abort", onAbort, { once: true });

      child.on("error", (err) => {
        clearTimeout(timeoutId);
        abortSignal?.removeEventListener("abort", onAbort);
        reject(err);
      });

      child.on("close", (code) => {
        clearTimeout(timeoutId);
        abortSignal?.removeEventListener("abort", onAbort);
        exitCode = code ?? null;
        resolve();
      });
    });

    const stdout = Buffer.concat(stdoutChunks).toString("utf8");
    const stderr = Buffer.concat(stderrChunks).toString("utf8");

    return {
      exitCode,
      stdoutLines: stdout
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0),
      stderr,
      timedOut,
    };
  };
}

type StreamJsonInputLine = {
  type: "user";
  message: {
    role: "user";
    content: Array<{ type: "text"; text: string }>;
  };
};
