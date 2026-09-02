import http from "node:http";
import type { AddressInfo } from "node:net";

import { InboundRouter } from "../yzj/inbound-router.ts";
import type { BridgeConfig, BridgeState, Logger, YZJIncomingMessage } from "../yzj/types.ts";

export type WebhookTransport = {
  start(): Promise<void>;
  stop(): Promise<void>;
  address(): AddressInfo | string | null;
};

const DEFAULT_MAX_PAYLOAD_BYTES = 256_000;

export function createWebhookTransport(
  config: BridgeConfig,
  state: BridgeState,
  router: InboundRouter,
  logger: Logger,
): WebhookTransport {
  const maxPayloadBytes = config.maxPayloadBytes ?? DEFAULT_MAX_PAYLOAD_BYTES;
  const webhookPath = config.account.webhookPath ?? "/yzj/webhook";
  const host = config.webhookHost ?? "127.0.0.1";
  const port = config.webhookPort ?? 3000;

  let server: http.Server | undefined;

  return {
    async start() {
      server = http.createServer((req, res) => {
        handleRequest(req, res).catch((err) => {
          logger.error?.(`[webhook] unhandled error: ${err instanceof Error ? err.message : String(err)}`);
          if (!res.headersSent) {
            res.writeHead(500, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ success: false, error: "internal error" }));
          }
        });
      });

      await new Promise<void>((resolve, reject) => {
        server!.listen(port, host, () => {
          state.connected = true;
          resolve();
        });
        server!.once("error", reject);
      });

      logger.info?.(`[webhook] listening on ${host}:${port}${webhookPath}`);
    },

    async stop() {
      if (!server) return;
      await new Promise<void>((resolve, reject) => {
        server!.close((err) => {
          if (err) reject(err);
          else resolve();
        });
      });
      server = undefined;
      state.connected = false;
    },

    address() {
      return server?.address() ?? null;
    },
  };

  async function handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (req.method !== "POST" || req.url !== webhookPath) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: false, error: "not found" }));
      return;
    }

    const signature = extractSignature(req.headers);
    const chunks: Buffer[] = [];
    let total = 0;

    for await (const chunk of req) {
      total += chunk.length;
      if (total > maxPayloadBytes) {
        res.writeHead(413, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: false, error: "payload too large" }));
        return;
      }
      chunks.push(chunk);
    }

    let message: YZJIncomingMessage;
    try {
      message = JSON.parse(Buffer.concat(chunks).toString("utf8")) as YZJIncomingMessage;
    } catch {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: false, error: "invalid JSON" }));
      return;
    }

    const result = await router.handle(message, signature ? { signature } : undefined);

    if (result.kind === "replied") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: true, data: { type: 2, content: result.replyText } }));
      return;
    }

    if (result.kind === "rejected") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: false, error: result.reason }));
      return;
    }

    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ success: false, error: result.error }));
  }
}

function extractSignature(headers: http.IncomingHttpHeaders): string | undefined {
  const value = headers["x-yzj-sign"] ?? headers["sign"];
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value[0];
  return undefined;
}
