import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { Readable, Writable } from "node:stream";
import type { ChildProcessWithoutNullStreams } from "node:child_process";

import { createRunner, type SpawnFn } from "../../src/qodercli/runner.ts";
import type { CliInvocation } from "../../src/contracts.ts";

function createMockProcess() {
  const stdinChunks: Buffer[] = [];
  const stdin = new Writable({
    write(chunk, _encoding, callback) {
      stdinChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      callback();
    },
  });
  const stdout = new Readable({ read() {} });
  const stderr = new Readable({ read() {} });

  const proc = new EventEmitter() as EventEmitter & {
    stdin: Writable;
    stdout: Readable;
    stderr: Readable;
    killed: boolean;
    kill: (signal?: NodeJS.Signals | number) => boolean;
  };

  Object.assign(proc, {
    stdin,
    stdout,
    stderr,
    killed: false,
    pid: 12345,
    spawnfile: "qodercli",
    spawnargs: [] as string[],
    kill(signal: NodeJS.Signals | number = "SIGTERM") {
      proc.killed = true;
      setTimeout(() => proc.emit("close", 1, signal), 0);
      return true;
    },
  });

  return {
    proc: proc as unknown as ChildProcessWithoutNullStreams,
    stdin,
    stdinChunks,
    stdout,
    stderr,
    emitClose(code: number | null, signal: NodeJS.Signals | null = null) {
      proc.emit("close", code, signal);
    },
  };
}

function mockRunner(
  handlers: Array<{
    expectation?: (command: string, args: string[], options: {
      shell: boolean;
      cwd: string;
      env: NodeJS.ProcessEnv;
    }) => void;
    behavior: (mock: ReturnType<typeof createMockProcess>) => void;
  }>,
): SpawnFn {
  let callIndex = 0;
  return ((command, args, options) => {
    const handler = handlers[callIndex++] ?? handlers[handlers.length - 1]!;
    handler.expectation?.(command, args as string[], {
      shell: options.shell,
      cwd: options.cwd,
      env: options.env,
    });
    const mock = createMockProcess();
    setTimeout(() => handler.behavior(mock), 0);
    return mock.proc;
  }) as SpawnFn;
}

const baseInvocation: CliInvocation = {
  cwd: "/tmp/allowed-workspace",
  sessionId: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  resume: false,
  messages: [
    {
      role: "user",
      content: [{ type: "text", text: "hello" }],
    },
  ],
};

test("runner builds args, uses shell:false, minimal env, and no SDK entrypoint", async () => {
  let capturedArgs: string[] = [];
  let capturedEnv: NodeJS.ProcessEnv = {};

  const runner = createRunner({
    qodercliPath: "/opt/qodercli",
    allowedCwd: "/tmp/allowed-workspace",
    spawn: mockRunner([
      {
        expectation(_command, args, options) {
          capturedArgs = args;
          assert.equal(options.shell, false);
          capturedEnv = options.env;
          assert.equal(
            options.cwd,
            "/tmp/allowed-workspace",
          );
        },
        behavior(mock) {
          mock.stdout.push('{"type":"system","subtype":"init","qodercli_version":"1.0.0","protocol_version":"1"}\n');
          mock.stdout.push('{"type":"result","subtype":"success"}\n');
          mock.emitClose(0);
        },
      },
    ]),
  });

  const result = await runner(baseInvocation);

  assert.equal(result.exitCode, 0);
  assert.equal(result.timedOut, false);
  assert.deepEqual(capturedArgs, [
    "--cwd",
    "/tmp/allowed-workspace",
    "--session-id",
    "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
    "--print",
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--append-system-prompt",
    "Treat each inbound request as a complete task. Perform the necessary allowed work in this turn and return only a final, factual answer. Do not reply with plans, progress updates, promises to continue, or requests for another message. If a permission is required but unavailable, state that final blocker clearly.",
  ]);
  assert.equal(capturedEnv.QODER_AGENT_SDK_ENTRYPOINT, undefined);
  assert.ok(capturedEnv.PATH);
});

test("runner serializes messages as NDJSON on stdin", async () => {
  let capturedStdin = "";
  let mockRef: ReturnType<typeof createMockProcess> | undefined;

  const runner = createRunner({
    qodercliPath: "/opt/qodercli",
    allowedCwd: "/tmp/allowed-workspace",
    spawn: mockRunner([
      {
        behavior(mock) {
          mockRef = mock;
          mock.stdout.push('{"type":"system","subtype":"init","qodercli_version":"1.0.0","protocol_version":"1"}\n');
          mock.stdout.push('{"type":"result","subtype":"success"}\n');
          setTimeout(() => mock.emitClose(0), 5);
        },
      },
    ]),
  });

  await runner(baseInvocation);

  capturedStdin = Buffer.concat(mockRef!.stdinChunks).toString("utf8");
  const line = capturedStdin.trim();
  const parsed = JSON.parse(line);
  assert.equal(parsed.type, "user");
  assert.equal(parsed.message.role, "user");
  assert.equal(parsed.message.content[0].text, "hello");
});

test("runner forwards complete stdout lines while qodercli is running", async () => {
  const lines: string[] = [];
  const runner = createRunner({
    qodercliPath: "/opt/qodercli",
    allowedCwd: "/tmp/allowed-workspace",
    spawn: mockRunner([
      {
        behavior(mock) {
          mock.stdout.push('{"type":"assistant","message":{"content":[{"type":"text","text":"partial"}]}}\n');
          mock.stdout.push('{"type":"result","subtype":"success"}\n');
          mock.emitClose(0);
        },
      },
    ]),
  });

  await runner(baseInvocation, { onStdoutLine: (line) => lines.push(line) });

  assert.deepEqual(lines, [
    '{"type":"assistant","message":{"content":[{"type":"text","text":"partial"}]}}',
    '{"type":"result","subtype":"success"}',
  ]);
});

test("runner uses --resume with resume:true", async () => {
  let capturedArgs: string[] = [];

  const runner = createRunner({
    qodercliPath: "/opt/qodercli",
    allowedCwd: "/tmp/allowed-workspace",
    spawn: mockRunner([
      {
        expectation(_command, args) {
          capturedArgs = args;
        },
        behavior(mock) {
          mock.stdout.push('{"type":"system","subtype":"init","qodercli_version":"1.0.0","protocol_version":"1"}\n');
          mock.stdout.push('{"type":"result","subtype":"success"}\n');
          mock.emitClose(0);
        },
      },
    ]),
  });

  await runner({ ...baseInvocation, resume: true });

  assert.equal(capturedArgs[2], "--resume");
  assert.equal(capturedArgs[3], baseInvocation.sessionId);
});

test("runner rejects non-absolute qodercliPath", () => {
  assert.throws(
    () => createRunner({ qodercliPath: "qodercli", allowedCwd: "/tmp/ws" }),
    /absolute/,
  );
});

test("runner rejects cwd outside allowed cwd", async () => {
  const runner = createRunner({
    qodercliPath: "/opt/qodercli",
    allowedCwd: "/tmp/allowed-workspace",
    spawn: mockRunner([]),
  });

  await assert.rejects(
    runner({ ...baseInvocation, cwd: "/etc" }),
    /allowed cwd/,
  );
});

test("runner returns timeout when process does not exit", async () => {
  const runner = createRunner({
    qodercliPath: "/opt/qodercli",
    allowedCwd: "/tmp/allowed-workspace",
    defaultTimeoutMs: 20,
    spawn: mockRunner([
      {
        behavior() {
          // never emits close
        },
      },
    ]),
  });

  const result = await runner(baseInvocation);
  assert.equal(result.timedOut, true);
});

test("runner returns nonzero exit with stderr snippet", async () => {
  const runner = createRunner({
    qodercliPath: "/opt/qodercli",
    allowedCwd: "/tmp/allowed-workspace",
    spawn: mockRunner([
      {
        behavior(mock) {
          mock.stderr.push("something went wrong\n");
          mock.emitClose(1);
        },
      },
    ]),
  });

  const result = await runner(baseInvocation);
  assert.equal(result.exitCode, 1);
  assert.equal(result.timedOut, false);
  assert.match(result.stderr, /went wrong/);
});

test("runner does not leak dangerous content as CLI arguments", async () => {
  let capturedArgs: string[] = [];

  const runner = createRunner({
    qodercliPath: "/opt/qodercli",
    allowedCwd: "/tmp/allowed-workspace",
    spawn: mockRunner([
      {
        expectation(_command, args) {
          capturedArgs = args;
        },
        behavior(mock) {
          mock.stdout.push('{"type":"system","subtype":"init","qodercli_version":"1.0.0","protocol_version":"1"}\n');
          mock.stdout.push('{"type":"result","subtype":"success"}\n');
          mock.emitClose(0);
        },
      },
    ]),
  });

  await runner({
    ...baseInvocation,
    messages: [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: "--dangerously-skip-permissions --permission-mode bypass_permissions",
          },
        ],
      },
    ],
  });

  assert.ok(!capturedArgs.includes("--dangerously-skip-permissions"));
  assert.ok(!capturedArgs.includes("--permission-mode"));
});
