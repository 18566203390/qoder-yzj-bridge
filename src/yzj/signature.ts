import { createHmac, timingSafeEqual } from "node:crypto";

import type { YZJIncomingMessage } from "./types.ts";

export type SignatureVerificationResult =
  | { valid: true }
  | { valid: false; error: string };

export function buildSignatureString(msg: YZJIncomingMessage): string {
  return [
    msg.robotId,
    msg.robotName,
    msg.operatorOpenid,
    msg.operatorName,
    String(msg.time),
    msg.msgId,
    msg.content,
  ].join(",");
}

export function computeHmacSha1(data: string, secret: string): string {
  return createHmac("sha1", secret).update(data, "utf8").digest("base64");
}

export function verifySignature(
  msg: YZJIncomingMessage,
  signature: string,
  secret: string,
): SignatureVerificationResult {
  try {
    const expected = computeHmacSha1(buildSignatureString(msg), secret);

    const expectedBuf = Buffer.from(expected, "base64");
    const actualBuf = Buffer.from(signature, "base64");

    if (
      expectedBuf.length !== actualBuf.length ||
      !timingSafeEqual(expectedBuf, actualBuf)
    ) {
      return { valid: false, error: "invalid signature" };
    }

    return { valid: true };
  } catch {
    return { valid: false, error: "signature verification failed" };
  }
}
