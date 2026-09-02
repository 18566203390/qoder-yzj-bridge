import { buildUserMessage } from "../qodercli/session-adapter.ts";
import { SessionRegistry } from "../qodercli/session-registry.ts";
import { InboundDedupeStore } from "./dedupe.ts";
import { verifySignature } from "./signature.ts";
import { YZJSender } from "./sender.ts";
import { checkWhitelist } from "./whitelist.ts";
import type { BridgeConfig, BridgeState, Logger, YZJIncomingMessage } from "./types.ts";

export type InboundResult =
  | { kind: "replied"; replyText: string }
  | { kind: "rejected"; reason: string }
  | { kind: "error"; error: string };

export type InboundRouterDeps = {
  config: BridgeConfig;
  registry: SessionRegistry;
  dedupe: InboundDedupeStore;
  sender: YZJSender;
  state: BridgeState;
  logger: Logger;
};

export class InboundRouter {
  private readonly config: BridgeConfig;
  private readonly registry: SessionRegistry;
  private readonly dedupe: InboundDedupeStore;
  private readonly sender: YZJSender;
  private readonly state: BridgeState;
  private readonly logger: Logger;

  constructor(deps: InboundRouterDeps) {
    this.config = deps.config;
    this.registry = deps.registry;
    this.dedupe = deps.dedupe;
    this.sender = deps.sender;
    this.state = deps.state;
    this.logger = deps.logger;
  }

  async handle(
    message: YZJIncomingMessage,
    options?: { signature?: string },
  ): Promise<InboundResult> {
    const now = Date.now();
    this.state.lastInboundAt = now;

    const signatureCheck = this.verifySignatureIfNeeded(message, options?.signature);
    if (!signatureCheck.valid) {
      this.logger.warn?.(`[YZJ] signature rejected for sender ${message.operatorOpenid}: ${signatureCheck.error}`);
      this.state.lastError = signatureCheck.error;
      return { kind: "rejected", reason: signatureCheck.error };
    }

    const whitelist = checkWhitelist(message.operatorOpenid, this.config.whitelist);
    if (!whitelist.allowed) {
      this.logger.warn?.(`[YZJ] whitelist rejected sender ${message.operatorOpenid}: ${whitelist.reason}`);
      this.state.lastError = whitelist.reason;
      return { kind: "rejected", reason: whitelist.reason };
    }

    const unique = this.dedupe.markSeen(message.robotId, message.msgId);
    if (!unique) {
      this.logger.info?.(`[YZJ] duplicate message ${message.msgId} from ${message.operatorOpenid}`);
      return { kind: "rejected", reason: "duplicate message" };
    }

    const projectReply = await this.handleProjectCommand(message);
    if (projectReply !== undefined) {
      return this.sendReply(projectReply, message.operatorOpenid);
    }

    const stream = new ReplySegmentBuffer(
      this.sender,
      this.config.streamChunkChars ?? 1000,
    );
    const cliResult = await this.registry.send(
      message.robotId,
      message.operatorOpenid,
      buildUserMessage(message.content),
      { onText: (text) => stream.append(text) },
    );

    if (!cliResult.ok) {
      const error = cliResult.reason;
      this.logger.error?.(`[YZJ] qodercli failed for ${message.operatorOpenid}: ${error}`);
      this.state.lastError = error;
      return { kind: "error", error };
    }

    const streamed = await stream.finish(cliResult.replyText || "");
    if (!streamed.ok) {
      this.state.lastError = streamed.error;
      return { kind: "error", error: streamed.error };
    }
    this.state.lastOutboundAt = Date.now();
    this.state.lastError = null;
    this.logger.info?.(`[YZJ] replied to ${message.operatorOpenid}`);
    return { kind: "replied", replyText: cliResult.replyText || "" };
  }

  private async handleProjectCommand(message: YZJIncomingMessage): Promise<string | undefined> {
    const content = message.content.trim();
    if (content === "项目列表") {
      const current = this.registry.getCurrentProject(message.robotId, message.operatorOpenid);
      return `可用项目：${this.registry.listProjects().join(", ")}\n当前项目：${current}`;
    }
    if (content === "当前项目") {
      return `当前项目：${this.registry.getCurrentProject(message.robotId, message.operatorOpenid)}`;
    }
    const match = /^切换项目\s+(\S+)$/.exec(content);
    if (!match) return undefined;
    const alias = match[1]!;
    const changed = await this.registry.switchProject(message.robotId, message.operatorOpenid, alias);
    return changed ? `已切换到项目：${alias}` : `未找到项目：${alias}`;
  }

  private async sendReply(replyText: string, operatorOpenid: string): Promise<InboundResult> {
    const sendResult = await this.sender.send(replyText);

    if (!sendResult.ok) {
      const error = sendResult.error;
      this.logger.error?.(`[YZJ] reply failed for ${operatorOpenid}: ${error}`);
      this.state.lastError = error;
      return { kind: "error", error };
    }

    this.state.lastOutboundAt = Date.now();
    this.state.lastError = null;
    this.logger.info?.(`[YZJ] replied to ${operatorOpenid}`);
    return { kind: "replied", replyText };
  }

  private verifySignatureIfNeeded(
    message: YZJIncomingMessage,
    signature: string | undefined,
  ): { valid: true } | { valid: false; error: string } {
    const secret = this.config.account.secret;

    if (secret && signature) {
      return verifySignature(message, signature, secret);
    }

    if (secret && !signature) {
      return { valid: false, error: "signature required" };
    }

    if (!secret && signature) {
      return { valid: false, error: "secret not configured" };
    }

    return { valid: true };
  }
}

class ReplySegmentBuffer {
  private readonly sender: YZJSender;
  private readonly chunkChars: number;
  private buffer = "";
  private receivedText = false;
  private chain: Promise<{ ok: true } | { ok: false; error: string }> = Promise.resolve({ ok: true });

  constructor(sender: YZJSender, chunkChars: number) {
    this.sender = sender;
    this.chunkChars = Math.max(1, chunkChars);
  }

  append(text: string): void {
    this.receivedText = true;
    this.buffer += text;
    while (this.buffer.length >= this.chunkChars) {
      const newline = this.buffer.lastIndexOf("\n", this.chunkChars - 1);
      const end = newline >= 0 ? newline + 1 : this.chunkChars;
      this.enqueue(this.buffer.slice(0, end));
      this.buffer = this.buffer.slice(end);
    }
  }

  async finish(finalText: string): Promise<{ ok: true } | { ok: false; error: string }> {
    if (!this.receivedText) this.buffer = finalText;
    if (this.buffer) {
      this.enqueue(this.buffer);
      this.buffer = "";
    }
    return this.chain;
  }

  private enqueue(text: string): void {
    if (!text) return;
    this.chain = this.chain.then(async (previous) => {
      if (!previous.ok) return previous;
      return this.sender.send(text);
    });
  }
}
