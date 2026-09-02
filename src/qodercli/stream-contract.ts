import type {
  CliFailure,
  CliFailureReason,
  CliResult,
  CliVersionInfo,
} from "../contracts.ts";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function fail(
  reason: CliFailureReason,
  details?: string,
): CliFailure {
  return { ok: false, reason, details };
}

export function parseStreamContract(lines: string[]): CliResult {
  let version: CliVersionInfo | undefined;
  let replyText = "";
  let usage: unknown;
  let terminal = false;

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      return fail("parse_error", `line ${index + 1} is not valid JSON`);
    }

    if (!isPlainObject(event)) {
      return fail("contract_violation", `line ${index + 1} is not an object`);
    }

    const type = typeof event.type === "string" ? event.type : "";
    const subtype = typeof event.subtype === "string" ? event.subtype : "";

    if (!version) {
      if (type === "system" && subtype === "init") {
        const qodercliVersion = event.qodercli_version;
        const protocolVersion = event.protocol_version;
        if (typeof qodercliVersion !== "string" || typeof protocolVersion !== "string") {
          return fail("contract_violation", "system/init missing version fields");
        }
        version = { qodercli: qodercliVersion, protocol: protocolVersion };
        continue;
      }
      if (type === "system") continue;
      return fail("contract_violation", "system/init must precede non-system events");
    }

    if (terminal) {
      return fail("contract_violation", "event received after terminal result");
    }

    if (type === "assistant") {
      const message = isPlainObject(event.message) ? event.message : undefined;
      const content = Array.isArray(message?.content) ? message.content : [];
      for (const block of content) {
        if (
          isPlainObject(block) &&
          block.type === "text" &&
          typeof block.text === "string"
        ) {
          replyText += block.text;
        }
      }
      continue;
    }

    if (type === "system") {
      continue;
    }

    if (type === "user") {
      continue;
    }

    if (type === "result") {
      terminal = true;
      usage = event.usage;
      if (subtype === "success") {
        const denials = event.permission_denials;
        if (Array.isArray(denials) && denials.length > 0) {
          return fail("permission_denied", "permission request was denied or unattended");
        }
        continue;
      }
      if (subtype.startsWith("error_")) {
        return fail("internal", `CLI terminal error: ${subtype}`);
      }
      return fail("contract_violation", `unexpected result subtype: ${subtype}`);
    }

    return fail("contract_violation", `unknown event type: ${type}/${subtype}`);
  }

  if (!version) {
    return fail("contract_violation", "missing system/init event");
  }
  if (!terminal) {
    return fail("contract_violation", "missing terminal result event");
  }

  return { ok: true, version, replyText, usage };
}
