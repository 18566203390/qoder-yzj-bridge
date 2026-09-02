import test from "node:test";
import assert from "node:assert/strict";

import { YZJSender } from "../../src/yzj/sender.ts";
import { MessageType } from "../../src/yzj/types.ts";

function makeFakeFetch(
  responses: Array<{
    ok: boolean;
    status: number;
    json: unknown;
  }>,
): { fetch: typeof fetch; calls: RequestInit[] } {
  const calls: RequestInit[] = [];
  let index = 0;

  const fakeFetch: typeof fetch = async (_url, init) => {
    calls.push(init ?? {});
    const response = responses[index++] ?? responses[responses.length - 1]!;
    return {
      ok: response.ok,
      status: response.status,
      json: async () => response.json,
    } as Response;
  };

  return { fetch: fakeFetch, calls };
}

const baseAccount = {
  sendMsgUrl: "https://yzj.example.com/send?yzjtoken=secret-token",
};

const logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

test("sends text message with correct payload", async () => {
  const { fetch, calls } = makeFakeFetch([
    { ok: true, status: 200, json: { success: true, data: { type: 2, content: "hello" } } },
  ]);
  const sender = new YZJSender({ account: baseAccount, logger, fetch });

  const result = await sender.send("hello");

  assert.equal(result.ok, true);
  assert.equal(calls.length, 1);
  const body = JSON.parse(calls[0]!.body as string);
  assert.equal(body.msgtype, MessageType.TEXT);
  assert.equal(body.content, "hello");
});

test("truncates reply to max length", async () => {
  const longText = "a".repeat(100);
  const { fetch, calls } = makeFakeFetch([
    { ok: true, status: 200, json: { success: true, data: { type: 2, content: longText.slice(0, 10) } } },
  ]);
  const sender = new YZJSender({ account: baseAccount, logger, maxReplyLength: 10, fetch });

  await sender.send(longText);

  const body = JSON.parse(calls[0]!.body as string);
  assert.equal(body.content.length, 10);
  assert.equal(body.content, "a".repeat(10));
});

test("returns error on HTTP failure", async () => {
  const { fetch } = makeFakeFetch([
    { ok: false, status: 500, json: {} },
  ]);
  const sender = new YZJSender({ account: baseAccount, logger, fetch });

  const result = await sender.send("hello");

  assert.equal(result.ok, false);
  assert.match(result.error, /500/);
});

test("returns error when YZJ reports failure", async () => {
  const { fetch } = makeFakeFetch([
    { ok: true, status: 200, json: { success: false, data: { type: 2, content: "" }, error: "bad request" } },
  ]);
  const sender = new YZJSender({ account: baseAccount, logger, fetch });

  const result = await sender.send("hello");

  assert.equal(result.ok, false);
  assert.match(result.error, /bad request/);
});

test("returns error on invalid JSON response", async () => {
  const fakeFetch: typeof fetch = async () =>
    ({
      ok: true,
      status: 200,
      json: async () => {
        throw new Error("boom");
      },
    }) as unknown as Response;

  const sender = new YZJSender({ account: baseAccount, logger, fetch: fakeFetch as unknown as typeof fetch });
  const result = await sender.send("hello");

  assert.equal(result.ok, false);
  assert.match(result.error, /not valid JSON/);
});
