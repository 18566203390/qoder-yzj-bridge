export type WhitelistCheckResult =
  | { allowed: true }
  | { allowed: false; reason: string };

export function checkWhitelist(
  operatorOpenid: string,
  whitelist: string[],
): WhitelistCheckResult {
  if (whitelist.length === 0) {
    return { allowed: false, reason: "whitelist empty" };
  }

  const normalizedSender = operatorOpenid.trim();
  if (!normalizedSender) {
    return { allowed: false, reason: "sender identifier missing" };
  }

  const allowed = whitelist.some((entry) => entry.trim() === normalizedSender);
  if (!allowed) {
    return { allowed: false, reason: "sender not in whitelist" };
  }

  return { allowed: true };
}
