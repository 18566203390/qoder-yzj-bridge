import type { Logger, YZJAccountConfig, YZJOutgoingMessage, YZJResponse } from "./types.ts";
import { MessageType } from "./types.ts";

export type YZJSendResult =
  | { ok: true }
  | { ok: false; error: string };

export type YZJSenderConfig = {
  account: YZJAccountConfig;
  logger: Logger;
  maxReplyLength?: number;
  timeoutMs?: number;
  fetch?: typeof fetch;
};

const DEFAULT_MAX_REPLY_LENGTH = 2000;
const DEFAULT_TIMEOUT_MS = 10_000;

export class YZJSender {
  private readonly account: YZJAccountConfig;
  private readonly logger: Logger;
  private readonly maxReplyLength: number;
  private readonly timeoutMs: number;
  private readonly fetchFn: typeof fetch;

  constructor(config: YZJSenderConfig) {
    this.account = config.account;
    this.logger = config.logger;
    this.maxReplyLength = config.maxReplyLength ?? DEFAULT_MAX_REPLY_LENGTH;
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchFn = config.fetch ?? globalThis.fetch;
  }

  async send(text: string): Promise<YZJSendResult> {
    const content = text.slice(0, this.maxReplyLength);
    const body: YZJOutgoingMessage = {
      msgtype: MessageType.TEXT,
      content,
    };

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);

    let response: Response;
    try {
      response = await this.fetchFn(this.account.sendMsgUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error?.(`[YZJ] send request failed: ${message}`);
      return { ok: false, error: "send request failed" };
    } finally {
      clearTimeout(timeoutId);
    }

    if (!response.ok) {
      this.logger.error?.(`[YZJ] send HTTP error: ${response.status}`);
      return { ok: false, error: `send HTTP error: ${response.status}` };
    }

    let payload: YZJResponse;
    try {
      payload = await response.json() as YZJResponse;
    } catch {
      this.logger.error?.("[YZJ] send response is not valid JSON");
      return { ok: false, error: "send response is not valid JSON" };
    }

    if (!payload.success) {
      const error = payload.error ?? "unknown YZJ error";
      this.logger.error?.(`[YZJ] send rejected: ${error}`);
      return { ok: false, error: `send rejected: ${error}` };
    }

    return { ok: true };
  }
}
