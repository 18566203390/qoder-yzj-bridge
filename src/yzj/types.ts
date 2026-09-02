export type YZJInboundMode = "webhook" | "websocket";

export const MessageType = {
  TEXT: 2,
} as const;

export type MessageType = (typeof MessageType)[keyof typeof MessageType];

export type YZJIncomingMessage = {
  type: number;
  robotId: string;
  robotName: string;
  operatorOpenid: string;
  operatorName: string;
  time: number;
  msgId: string;
  content: string;
  groupType: number;
};

export type YZJOutgoingMessage = {
  msgtype: MessageType;
  content: string;
};

export type YZJResponse = {
  success: boolean;
  data: {
    type: number;
    content: string;
  };
  error?: string;
};

export type YZJAccountConfig = {
  /** 发送消息 URL（必须包含 yzjtoken） */
  sendMsgUrl: string;
  /** Webhook 签名密钥 */
  secret?: string;
  /** Webhook 监听路径 */
  webhookPath?: string;
  /** 入站模式 */
  inboundMode?: YZJInboundMode;
};

export type ProjectConfig = {
  /** 供云之家指令使用的固定项目别名 */
  alias: string;
  /** 该项目的绝对工作目录 */
  cwd: string;
};

export type BridgeConfig = {
  /** qodercli 绝对路径 */
  qodercliPath: string;
  /** 固定工作区绝对路径 */
  cwd: string;
  /** 受控项目白名单；未配置时以 cwd 创建 default 项目，兼容旧配置 */
  projects?: ProjectConfig[];
  /** 会话注册表持久化路径 */
  registryPath: string;
  /** 去重存储路径 */
  dedupePath: string;
  /** 桥接状态持久化路径 */
  statePath: string;
  /** 云之家账户配置 */
  account: YZJAccountConfig;
  /** 允许的发送者标识列表；为空时不处理任何入站消息 */
  whitelist: string[];
  /** Webhook 监听端口 */
  webhookPort?: number;
  /** Webhook 监听地址 */
  webhookHost?: string;
  /** 最大入站负载字节数 */
  maxPayloadBytes?: number;
  /** 最大回复文本长度 */
  maxReplyLength?: number;
  /** 流式回复的单条目标字符数 */
  streamChunkChars?: number;
  /** 单个适配器调用超时 */
  adapterTimeoutMs?: number;
  /** WebSocket 健康检查间隔 */
  heartbeatMs?: number;
  /** WebSocket 判定失活时间 */
  staleMs?: number;
};

export type BridgeState = {
  running: boolean;
  connected: boolean;
  lastError: string | null;
  lastInboundAt: number | null;
  lastOutboundAt: number | null;
};

export type Logger = {
  info?: (message: string) => void;
  warn?: (message: string) => void;
  error?: (message: string) => void;
};
