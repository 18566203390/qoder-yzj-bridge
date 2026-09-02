# QoderCLI 云之家桥接

这是一个常驻在本机或内网服务器上的桥接服务：云之家机器人收到消息后，在受控项目目录中调用本机 `qodercli`，再将最终结果或流式文本分段回复给云之家。

它独立于父目录的 OpenClaw 插件，不加载 OpenClaw，也不会使用 `bypass_permissions` 或把云之家消息拼入 shell 命令。

## 工作流程

```text
云之家用户 → 云之家机器人 → 本桥接服务 → qodercli → 受控项目目录
                                      ↓
                              云之家分段文本回复
```

每位云之家用户、每个项目都有独立的 Qoder 会话。机器人只能切换到服务端配置的项目别名，不能传入任意本机路径。

## 部署前准备

- Node.js 22 或更高版本。
- QoderCLI 已安装并完成登录；建议使用 `qodercli --version` 确认版本。
- 运行服务的账号对 `projects` 中的项目目录具有所需访问权限。
- 使用 WebSocket 模式时，服务器需要出站访问云之家和 Qoder 服务；不需要公网入站端口。
- 使用 Webhook 模式时，云之家必须能访问该服务的 HTTPS/Webhook 入口，纯内网通常应优先使用 WebSocket 模式。

## 首次配置与启动

在桥接目录执行：

```bash
cd /Users/wulonglong/Documents/openclaw-yzj/qoder-yzj-bridge
npm ci
qodercli login
qodercli --version
cp config.example.json config.json
```

编辑 `config.json`。下面是内网 WebSocket 部署的最小示例；将路径、云之家 token 和用户标识替换为真实值，且不要将该文件提交到 Git：

```json
{
  "qodercliPath": "/opt/homebrew/bin/qodercli",
  "cwd": "/srv/qoder-projects/bridge",
  "projects": [
    { "alias": "bridge", "cwd": "/srv/qoder-projects/bridge" },
    { "alias": "api", "cwd": "/srv/qoder-projects/api" }
  ],
  "registryPath": "/var/lib/qoder-yzj-bridge/registry.json",
  "dedupePath": "/var/lib/qoder-yzj-bridge/dedupe.json",
  "statePath": "/var/lib/qoder-yzj-bridge/state.json",
  "account": {
    "sendMsgUrl": "https://www.yunzhijia.com/gateway/robot/webhook/send?yzjtype=0&yzjtoken=REPLACE_ME",
    "inboundMode": "websocket"
  },
  "whitelist": ["yunzhijia_user_openid_1"],
  "maxReplyLength": 2048,
  "streamChunkChars": 1000,
  "adapterTimeoutMs": 120000,
  "heartbeatMs": 30000,
  "staleMs": 120000
}
```

| 字段 | 作用 |
| --- | --- |
| `qodercliPath` | `qodercli` 的绝对路径；用 `command -v qodercli` 查询。 |
| `cwd` | 兼容旧配置的默认项目目录；建议同时配置 `projects`。 |
| `projects` | 可切换项目白名单。`alias` 是机器人命令使用的名称，`cwd` 必须是绝对路径。 |
| `registryPath` / `dedupePath` / `statePath` | 用户会话、消息去重和运行状态文件；服务账号须可写。 |
| `account.sendMsgUrl` | 云之家机器人发送接口 URL，包含 `yzjtoken`。 |
| `account.inboundMode` | 推荐显式设置为 `websocket`；`webhook` 需要 `webhookHost`、`webhookPort` 和可访问的回调地址。 |
| `whitelist` | 允许使用机器人的 `operatorOpenid` 列表；空数组会拒绝所有消息。 |
| `maxReplyLength` | 单条云之家消息最大字符数。 |
| `streamChunkChars` | Qoder 流式文本每段的目标最大字符数，不能大于 `maxReplyLength`。 |
| `adapterTimeoutMs` | 单次 Qoder 任务最长等待时间，单位毫秒。 |

启动服务（默认使用本目录的 `config.json`）：

```bash
npm start
```

若需要使用其他配置文件：

```bash
npm run start:config -- /absolute/path/to/config.json
```

看到 `[websocket] connected` 和 `[bridge] started in websocket mode` 后，表示桥接已经连上云之家。生产环境请用 `systemd`、supervisord 或容器编排保持该进程常驻，并在升级配置、桥接代码或 QoderCLI 后重启服务。

## 云之家使用方式

| 消息 | 效果 |
| --- | --- |
| `项目列表` | 显示允许切换的项目别名和当前项目。 |
| `当前项目` | 显示当前用户正在使用的项目。 |
| `切换项目 api` | 切换到 `api` 项目；切回时恢复该项目此前的 Qoder 会话。 |
| 任意普通问题 | 在当前项目目录执行 Qoder 任务并返回结论。 |

Qoder 产生的 `assistant/text` 会按 `streamChunkChars` 顺序分段发送。thinking、工具调用、hook 和工具回传不会发送给云之家；任务结束时会发送剩余文本，不重复已推送内容。

## Webhook 模式

若必须使用 Webhook，在 `account` 中显式设置：

```json
"inboundMode": "webhook",
"webhookPath": "/webhook/yzj"
```

并补充根级配置：

```json
"webhookHost": "0.0.0.0",
"webhookPort": 3000
```

若配置了 `account.secret`，所有入站请求必须携带有效的 HMAC-SHA1 签名。Webhook 的公网暴露、反向代理和证书配置属于部署变更，应完成网络评审后再启用。

## 安全边界

- 云之家消息通过 stdin NDJSON 传给 Qoder，不作为 CLI 参数或 shell 片段。
- 工作目录只来自本地 `projects` 配置；机器人不能新增、修改或浏览任意路径。
- 会话按 `sha256(robotId:operatorOpenid)` 隔离，状态文件不保存原始用户标识。
- 重复 `msgId` 在 10 分钟内会被丢弃。
- 原始消息、云之家 token、签名、Qoder stderr 不会写入日志、状态或机器人回复。
- 权限请求、未知根事件、超时和异常退出会失败，不会自动批准。

## 升级与验证

```bash
qodercli --version
npm run typecheck
npm test
```

QoderCLI、`config.json` 或桥接代码变更后，重启桥接进程，再在云之家发送 `当前项目` 或一个只读问题进行验证。
