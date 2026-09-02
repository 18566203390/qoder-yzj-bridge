export type TextContentBlock = { type: "text"; text: string };

export type CliMessage = {
  role: "user";
  content: TextContentBlock[];
};

export type CliInvocation = {
  cwd: string;
  sessionId: string;
  resume: boolean;
  messages: CliMessage[];
};

export type CliVersionInfo = {
  qodercli: string;
  protocol: string;
};

export type CliSuccess = {
  ok: true;
  version: CliVersionInfo;
  replyText: string;
  usage?: unknown;
};

export type CliFailureReason =
  | "timeout"
  | "nonzero_exit"
  | "parse_error"
  | "contract_violation"
  | "permission_denied"
  | "internal";

export type CliFailure = {
  ok: false;
  reason: CliFailureReason;
  exitCode?: number | null;
  stderrSnippet?: string;
  details?: string;
};

export type CliResult = CliSuccess | CliFailure;

export type CliRawResult = {
  exitCode: number | null;
  stdoutLines: string[];
  stderr: string;
  timedOut: boolean;
};

export type CliProcessRunner = (
  invocation: CliInvocation,
  options?: { signal?: AbortSignal; onStdoutLine?: (line: string) => void },
) => Promise<CliRawResult>;

export type CliRunner = (
  invocation: CliInvocation,
  options?: { signal?: AbortSignal },
) => Promise<CliResult>;
