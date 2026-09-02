import type {
  CliInvocation,
  CliMessage,
  CliProcessRunner,
  CliResult,
} from "../contracts.ts";
import { parseStreamContract } from "./stream-contract.ts";

export type SessionAdapter = {
  send(
    invocation: CliInvocation,
    options?: { signal?: AbortSignal; onText?: (text: string) => void },
  ): Promise<CliResult>;
};

export type SessionAdapterConfig = {
  runner: CliProcessRunner;
  /** @deprecated 调用方应在 invocation 中提供受控 cwd */
  cwd?: string;
  expectedProtocolVersion?: string;
  timeoutMs?: number;
  parse?: (lines: string[]) => CliResult;
};

function abortAfter(
  ms: number,
  parentSignal?: AbortSignal,
): { signal: AbortSignal; cleanup: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);

  function onParentAbort() {
    controller.abort();
  }

  parentSignal?.addEventListener("abort", onParentAbort, { once: true });

  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timer);
      parentSignal?.removeEventListener("abort", onParentAbort);
    },
  };
}

export function createSessionAdapter(config: SessionAdapterConfig): SessionAdapter {
  const parse = config.parse ?? parseStreamContract;
  const timeoutMs = config.timeoutMs ?? 60_000;

  return {
    async send(invocation, options): Promise<CliResult> {
      const { signal, cleanup } = abortAfter(timeoutMs, options?.signal);
      try {
        const raw = await config.runner(
          { ...invocation, cwd: config.cwd ?? invocation.cwd },
          {
            signal,
            onStdoutLine: (line) => {
              const text = extractAssistantText(line);
              if (text) options?.onText?.(text);
            },
          },
        );

        if (raw.timedOut) {
          return { ok: false, reason: "timeout" };
        }
        if (raw.exitCode !== 0) {
          return {
            ok: false,
            reason: "nonzero_exit",
            exitCode: raw.exitCode,
            stderrSnippet: raw.stderr.slice(-500),
          };
        }

        const parsed = parse(raw.stdoutLines);
        if (
          parsed.ok &&
          config.expectedProtocolVersion &&
          parsed.version.protocol !== config.expectedProtocolVersion
        ) {
          return {
            ok: false,
            reason: "contract_violation",
            details:
              `expected protocol ${config.expectedProtocolVersion}, got ${parsed.version.protocol}`,
          };
        }
        return parsed;
      } finally {
        cleanup();
      }
    },
  };
}

function extractAssistantText(line: string): string {
  let event: unknown;
  try {
    event = JSON.parse(line);
  } catch {
    return "";
  }
  if (!event || typeof event !== "object") return "";
  const record = event as Record<string, unknown>;
  if (record.type !== "assistant" || !record.message || typeof record.message !== "object") return "";
  const content = (record.message as Record<string, unknown>).content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block): block is Record<string, unknown> => Boolean(block) && typeof block === "object")
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text as string)
    .join("");
}

export function buildUserMessage(text: string): CliMessage {
  return {
    role: "user",
    content: [{ type: "text", text }],
  };
}
