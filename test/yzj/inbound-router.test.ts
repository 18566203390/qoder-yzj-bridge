import test from "node:test";
import assert from "node:assert/strict";

import { InboundRouter } from "../../src/yzj/inbound-router.ts";
import { InboundDedupeStore } from "../../src/yzj/dedupe.ts";
import { YZJSender } from "../../src/yzj/sender.ts";
import { computeHmacSha1 } from "../../src/yzj/signature.ts";
import type { BridgeConfig, BridgeState, YZJIncomingMessage } from "../../src/yzj/types.ts";
import type { SessionRegistry } from "../../src/qodercli/session-registry.ts";
import type { CliResult } from "../../src/contracts.ts";

function makeMessage(content: string): YZJIncomingMessage {
  return {
    type: 2,
    robotId: "robot-1",
    robotName: "Robot",
    operatorOpenid: "openid-a",
    operatorName: "Alice",
    time: 1234567890,
    msgId: `msg-${content.replace(/\s/g, "-")}`,
    content,
    groupType: 0,
  };
}

function makeRegistry(result: CliResult): SessionRegistry {
  return {
    send: async () => result,
  } as unknown as SessionRegistry;
}

function makeSender(outcome: { ok: true } | { ok: false; error: string }): YZJSender {
  return {
    send: async () => outcome,
  } as unknown as YZJSender;
}

function makeDedupe(): InboundDedupeStore {
  return new InboundDedupeStore("/tmp/qoder-yzj-dedupe-test.json");
}

const baseConfig: BridgeConfig = {
  qodercliPath: "/tmp/qodercli",
  cwd: "/tmp/ws",
  registryPath: "/tmp/registry.json",
  dedupePath: "/tmp/dedupe.json",
  statePath: "/tmp/state.json",
  account: {
    sendMsgUrl: "https://yzj.example.com/send?yzjtoken=token",
  },
  whitelist: ["openid-a"],
};

const logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

function makeState(): BridgeState {
  return {
    running: true,
    connected: false,
    lastError: null,
    lastInboundAt: null,
    lastOutboundAt: null,
  };
}

test("rejects message when whitelist is empty", async () => {
  const state = makeState();
  const router = new InboundRouter({
    config: { ...baseConfig, whitelist: [] },
    registry: makeRegistry({ ok: true, version: { qodercli: "1", protocol: "1" }, replyText: "hi" }),
    dedupe: makeDedupe(),
    sender: makeSender({ ok: true }),
    state,
    logger,
  });

  const result = await router.handle(makeMessage("hello"));

  assert.equal(result.kind, "rejected");
  assert.equal((result as { reason: string }).reason, "whitelist empty");
  assert.notEqual(state.lastInboundAt, null);
});

test("rejects message when sender not in whitelist", async () => {
  const state = makeState();
  const router = new InboundRouter({
    config: { ...baseConfig, whitelist: ["openid-b"] },
    registry: makeRegistry({ ok: true, version: { qodercli: "1", protocol: "1" }, replyText: "hi" }),
    dedupe: makeDedupe(),
    sender: makeSender({ ok: true }),
    state,
    logger,
  });

  const result = await router.handle(makeMessage("hello"));

  assert.equal(result.kind, "rejected");
  assert.equal((result as { reason: string }).reason, "sender not in whitelist");
});

test("routes message and sends reply", async () => {
  const state = makeState();
  const router = new InboundRouter({
    config: baseConfig,
    registry: makeRegistry({ ok: true, version: { qodercli: "1", protocol: "1" }, replyText: "hello back" }),
    dedupe: makeDedupe(),
    sender: makeSender({ ok: true }),
    state,
    logger,
  });

  const result = await router.handle(makeMessage("hello"));

  assert.equal(result.kind, "replied");
  assert.equal((result as { replyText: string }).replyText, "hello back");
  assert.notEqual(state.lastOutboundAt, null);
  assert.equal(state.lastError, null);
});

test("rejects duplicate messages", async () => {
  const dedupe = makeDedupe();
  const state = makeState();
  const router = new InboundRouter({
    config: baseConfig,
    registry: makeRegistry({ ok: true, version: { qodercli: "1", protocol: "1" }, replyText: "hi" }),
    dedupe,
    sender: makeSender({ ok: true }),
    state,
    logger,
  });

  const msg = makeMessage("duplicate");
  const r1 = await router.handle(msg);
  const r2 = await router.handle(msg);

  assert.equal(r1.kind, "replied");
  assert.equal(r2.kind, "rejected");
  assert.equal((r2 as { reason: string }).reason, "duplicate message");
});

test("returns error when qodercli fails", async () => {
  const state = makeState();
  const router = new InboundRouter({
    config: baseConfig,
    registry: makeRegistry({ ok: false, reason: "internal" }),
    dedupe: makeDedupe(),
    sender: makeSender({ ok: true }),
    state,
    logger,
  });

  const result = await router.handle(makeMessage("hello"));

  assert.equal(result.kind, "error");
  assert.equal((result as { error: string }).error, "internal");
  assert.equal(state.lastError, "internal");
});

test("returns error when sender fails", async () => {
  const state = makeState();
  const router = new InboundRouter({
    config: baseConfig,
    registry: makeRegistry({ ok: true, version: { qodercli: "1", protocol: "1" }, replyText: "hi" }),
    dedupe: makeDedupe(),
    sender: makeSender({ ok: false, error: "network error" }),
    state,
    logger,
  });

  const result = await router.handle(makeMessage("hello"));

  assert.equal(result.kind, "error");
  assert.equal((result as { error: string }).error, "network error");
  assert.equal(state.lastError, "network error");
});

test("accepts valid webhook signature", async () => {
  const secret = "my-secret";
  const msg = makeMessage("signed");
  const signature = computeHmacSha1(
    [msg.robotId, msg.robotName, msg.operatorOpenid, msg.operatorName, String(msg.time), msg.msgId, msg.content].join(","),
    secret,
  );

  const state = makeState();
  const router = new InboundRouter({
    config: { ...baseConfig, account: { ...baseConfig.account, secret } },
    registry: makeRegistry({ ok: true, version: { qodercli: "1", protocol: "1" }, replyText: "ok" }),
    dedupe: makeDedupe(),
    sender: makeSender({ ok: true }),
    state,
    logger,
  });

  const result = await router.handle(msg, { signature });

  assert.equal(result.kind, "replied");
});

test("rejects invalid webhook signature", async () => {
  const state = makeState();
  const router = new InboundRouter({
    config: { ...baseConfig, account: { ...baseConfig.account, secret: "my-secret" } },
    registry: makeRegistry({ ok: true, version: { qodercli: "1", protocol: "1" }, replyText: "ok" }),
    dedupe: makeDedupe(),
    sender: makeSender({ ok: true }),
    state,
    logger,
  });

  const result = await router.handle(makeMessage("signed"), { signature: "bad" });

  assert.equal(result.kind, "rejected");
  assert.equal((result as { reason: string }).reason, "invalid signature");
});

test("rejects webhook when signature missing but secret configured", async () => {
  const state = makeState();
  const router = new InboundRouter({
    config: { ...baseConfig, account: { ...baseConfig.account, secret: "my-secret" } },
    registry: makeRegistry({ ok: true, version: { qodercli: "1", protocol: "1" }, replyText: "ok" }),
    dedupe: makeDedupe(),
    sender: makeSender({ ok: true }),
    state,
    logger,
  });

  const result = await router.handle(makeMessage("signed"));

  assert.equal(result.kind, "rejected");
  assert.equal((result as { reason: string }).reason, "signature required");
});

test("rejects webhook when signature present but secret not configured", async () => {
  const state = makeState();
  const router = new InboundRouter({
    config: baseConfig,
    registry: makeRegistry({ ok: true, version: { qodercli: "1", protocol: "1" }, replyText: "ok" }),
    dedupe: makeDedupe(),
    sender: makeSender({ ok: true }),
    state,
    logger,
  });

  const result = await router.handle(makeMessage("signed"), { signature: "any" });

  assert.equal(result.kind, "rejected");
  assert.equal((result as { reason: string }).reason, "secret not configured");
});

test("handles project commands locally without invoking qodercli", async () => {
  const state = makeState();
  const replies: string[] = [];
  let cliCalls = 0;
  let currentProject = "api";
  const registry = {
    listProjects: () => ["api", "web"],
    getCurrentProject: () => currentProject,
    switchProject: async (_robotId: string, _operatorOpenid: string, alias: string) => {
      if (alias !== "web") return false;
      currentProject = alias;
      return true;
    },
    send: async () => {
      cliCalls += 1;
      return { ok: true, version: { qodercli: "1", protocol: "1" }, replyText: "qoder reply" };
    },
  } as unknown as SessionRegistry;
  const sender = {
    send: async (text: string) => {
      replies.push(text);
      return { ok: true } as const;
    },
  } as unknown as YZJSender;
  const router = new InboundRouter({
    config: {
      ...baseConfig,
      projects: [
        { alias: "api", cwd: "/tmp/api" },
        { alias: "web", cwd: "/tmp/web" },
      ],
    },
    registry,
    dedupe: makeDedupe(),
    sender,
    state,
    logger,
  });

  await router.handle(makeMessage("项目列表"));
  await router.handle(makeMessage("当前项目"));
  await router.handle(makeMessage("切换项目 web"));
  await router.handle(makeMessage("切换项目 /etc"));

  assert.deepEqual(replies, [
    "可用项目：api, web\n当前项目：api",
    "当前项目：api",
    "已切换到项目：web",
    "未找到项目：/etc",
  ]);
  assert.equal(cliCalls, 0);
});

test("forwards assistant text as ordered Yunzhijia segments without repeating the final reply", async () => {
  const state = makeState();
  const replies: string[] = [];
  const registry = {
    send: async (
      _robotId: string,
      _operatorOpenid: string,
      _message: unknown,
      options?: { onText?: (text: string) => void },
    ) => {
      options?.onText?.("第一段\n");
      options?.onText?.("第二段");
      return { ok: true, version: { qodercli: "1", protocol: "1" }, replyText: "第一段\n第二段" };
    },
  } as unknown as SessionRegistry;
  const sender = {
    send: async (text: string) => {
      replies.push(text);
      return { ok: true } as const;
    },
  } as unknown as YZJSender;
  const router = new InboundRouter({
    config: { ...baseConfig, streamChunkChars: 4 },
    registry,
    dedupe: makeDedupe(),
    sender,
    state,
    logger,
  });

  const result = await router.handle(makeMessage("流式回答"));

  assert.equal(result.kind, "replied");
  assert.deepEqual(replies, ["第一段\n", "第二段"]);
});
