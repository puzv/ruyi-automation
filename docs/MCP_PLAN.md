# MCP 接入计划书

目标：用户在自己电脑上的 AI agent（Claude Code、Codex、Cursor 等）连上平台后，一句话即可完成
**上传文件 → 创建人群包 → 洞悉分析 → 下载结果** 全流程，且权限、隔离、审计与网页端一致。

分工：Claude 写任务说明、审核代码、实测；Codex 编码；**每个阶段结束由用户验收后再进入下一阶段**。
不做 git 提交，除非用户要求。

---

## 一、整体架构

```
用户电脑                                        平台服务器（现有 Fastify 服务）
┌──────────────────────┐   HTTPS + Bearer Token   ┌─────────────────────────────────┐
│ Claude Code / Codex  │ ───────────────────────> │ POST /mcp（新增）                │
│ （用户自己的 agent） │ <─────────────────────── │   工具 → app.inject → 现有 /api/* │
│                      │                          │                                 │
│ curl 直传文件 ───────┼──── 一次性上传地址 ────> │ /api/transfer/upload/:ticket    │
│ curl 下载结果 <──────┼──── 一次性下载地址 ───── │ /api/transfer/download/:ticket  │
└──────────────────────┘                          └─────────────────────────────────┘
```

### 关键设计决定

| 决定 | 原因 |
|---|---|
| MCP 内嵌在现有服务，挂在 `/mcp`，使用官方 SDK 的 Streamable HTTP **无状态模式** + JSON 响应 | 同事只需填网址和 token；无状态不依赖粘性会话；JSON 响应避开网关对 SSE 长连接的兼容问题 |
| 工具内部通过 `app.inject()` 调用现有 `/api/*` 接口，透传用户的 Authorization | 用户隔离、并发限制、平台登录检查、操作记录全部复用，不复制业务逻辑 |
| 新增**个人访问令牌（API Token）**，库里只存 SHA-256 哈希 | AI 客户端无法使用浏览器 cookie |
| Token 只允许访问业务接口；`/api/auth/*`、`/api/admin/*`、`/api/api-tokens*`、`/api/platform-login*` 拒绝 Token | Token 泄露时不能改密码、建新 Token、做管理操作或进入远程桌面 |
| 文件上传/下载走**一次性地址 + curl**，不经过模型 | 文件太大、模型复写会出错、数据不能发到外部模型；也避免把长期 Token 写进命令让模型看到 |
| 长任务采用「提交得到任务 ID + 查询/等待」 | 单次工具调用会超时；另提供 `wait_for_job` 最多等 50 秒，减少轮询次数 |
| 写操作靠 agent 客户端的调用确认 + 工具注解（readOnlyHint / destructiveHint）+ Skill 规则约束，不在服务端做二次确认 | Claude Code 等客户端调用工具前本身会征求用户同意，服务端再做确认会让流程繁琐 |
| 核心规则同时写进 MCP 的 `instructions`（连接时自动发给模型）和 Skill | 没装 Skill 的客户端也能拿到最低限度的规则 |
| 平台登录仍由人在网页远程桌面完成 | AI 无法也不应代替人登录；工具发现未登录时返回登录页地址并停止 |

### 数据安全红线（所有阶段适用）
- 工具返回值只能包含：文件名、数量、状态、任务 ID、时间、错误说明；**不得包含 idfa / oaid / 手机号等文件内容**。
- 任务日志返回前截断到最后 8KB，并审核日志里不出现数据行。
- Token、上传/下载票据、平台登录态不得出现在日志、操作记录、工具返回值（一次性地址除外）中。

---

## 二、工具清单（最终形态）

| 工具 | 类型 | 对应现有接口 | 说明 |
|---|---|---|---|
| `get_overview` | 只读 | `/api/status`、`/api/login-status`、`/api/jobs/active`、`/api/auto-advance` | 工作区各阶段数量、平台是否登录、当前任务、自动推进状态 |
| `check_platform` | 只读（较慢） | `/api/platform-status` | 访问如翼平台核对待处理数；409 时返回“稍后重试” |
| `list_jobs` / `get_job` | 只读 | `/api/jobs`、`/api/jobs/:id` | 任务列表 / 详情（日志截断） |
| `wait_for_job` | 只读 | `/api/jobs/:id` | 服务端最多等待 50 秒，任务结束或超时即返回 |
| `prepare_upload` | 写 | 新增票据 | 返回 10 分钟内有效、只能用一次的上传地址和 curl 示例 |
| `run_task` | 写 | `/api/run/:task` | task ∈ upload / create / analyse / download |
| `cancel_job` | 写 | `/api/jobs/:id/cancel` | |
| `set_auto_advance` | 写 | `/api/auto-advance` | 开关自动推进 |
| `prepare_download` | 只读（生成票据） | 新增票据 | 下载任务结果 ZIP 的一次性地址 |

---

## 三、阶段计划

### 阶段 0：准备（Claude 完成，无需验收）
- 用户批准新增依赖 `@modelcontextprotocol/sdk`（及其 peer 依赖 `zod`）后，由 Claude 安装。
- 技术验证：确认 SDK 能以 CommonJS 方式加载，能在 Fastify 中通过 `reply.hijack()` 处理 `/mcp` 请求，确认部署镜像的 Node 版本可用。
- 确认平台对外访问地址（新增环境变量 `RUYI_PUBLIC_URL`，用于生成一次性地址）。

### 阶段 1：个人访问令牌
| 任务 | 内容 |
|---|---|
| 1.1 数据表 | 新增迁移 `ruyi_api_tokens`（id、user_id、name、token_prefix、token_hash、last_used_at、expires_at、revoked_at、created_at），repo 与 `ruyi_test` 库测试 |
| 1.2 接口与鉴权 | `GET/POST /api/api-tokens`、`POST /api/api-tokens/:id/revoke`（仅限 cookie 登录）；明文只在创建时返回一次；guard 支持 `Authorization: Bearer ruyi_pat_…`，校验吊销/过期/用户禁用/需改密码，并按上表限制可访问的接口；操作记录新增 `token.create` / `token.revoke`；补测试 |
| 1.3 前端 | 新增「API 令牌」页面：生成（可设名称、有效期）、复制（仅显示一次）、列表、吊销 |

**用户验收**
1. 网页上生成一个 Token，用 `curl -H "Authorization: Bearer <token>" <地址>/api/status` 能拿到自己的工作区状态。
2. 用该 Token 访问 `/api/admin/users`、`/api/api-tokens` 被拒绝。
3. 吊销后同一命令返回 401；操作记录里能看到生成、吊销记录。

### 阶段 2：MCP 服务 + 只读工具
| 任务 | 内容 |
|---|---|
| 2.1 MCP 端点 | 新增 `apps/server/src/modules/mcp/`，`POST /mcp` 无状态模式；鉴权复用 Token；工具通过 `app.inject` 转发并设置 `User-Agent: ruyi-mcp/<版本>`，让操作记录能区分来自 AI 的操作；编写 `instructions` |
| 2.2 只读工具 | `get_overview`、`check_platform`、`list_jobs`、`get_job`、`wait_for_job`；统一返回中文摘要 + 结构化数据；未登录平台时返回登录页地址 |
| 2.3 测试与文档 | 用 SDK 自带客户端在测试中调用 `/mcp`，覆盖鉴权失败、跨用户隔离、日志截断；编写 `docs/MCP_USAGE.md`：Claude Code / Codex 的接入命令 |

**用户验收**
1. 按文档在自己的 Claude Code 中执行 `claude mcp add` 接入平台。
2. 问“我现在任务进行到哪一步了”，回答与网页一致。
3. 平台登录态失效时，AI 提示去网页登录，而不是反复重试。

### 阶段 3：文件上传、任务执行与结果下载
| 任务 | 内容 |
|---|---|
| 3.1 一次性票据 | 新增迁移 `ruyi_transfer_tickets`（用途 upload/download、user_id、job_id、ticket_hash、expires_at、used_at）；`POST /api/transfer/upload/:ticket` 与 `GET /api/transfer/download/:ticket` 免 Token、凭票据访问，过期或已使用即拒绝；把 `/api/import-folder` 的导入逻辑抽成共用函数，两处共用同一过滤规则和操作记录 |
| 3.2 写工具 | `prepare_upload`、`run_task`、`cancel_job`、`set_auto_advance`、`prepare_download`，正确设置工具注解 |
| 3.3 测试 | 票据过期、重复使用、跨用户、非法文件名、运行中任务冲突（409）、下载非下载任务被拒 |

**用户验收**
1. 让 AI 把本机一个测试 pn 文件上传，网页上能看到文件已导入。
2. 让 AI 提交上传任务并等待完成，网页任务列表一致，操作记录显示来自 MCP。
3. 让 AI 把一个已完成下载任务的结果 ZIP 存到本地指定目录，解压内容与网页下载的一致。
4. 同一个上传地址第二次使用被拒绝。

### 阶段 4：Skill 与全流程
| 任务 | 内容 |
|---|---|
| 4.1 Skill | 新增 `skills/ruyi-audience/SKILL.md` 及参考文档：触发场景、标准流程（检查 → 上传 → 创建 → 分析 → 下载）、各阶段完成的判断条件、409 / 未登录 / 失败的处理、禁止事项（不读文件内容、提交写操作前向用户说明）；在网页「API 令牌」页提供下载与安装说明 |
| 4.2 端到端联调 | Claude 用测试数据在 Claude Code 与 Codex 中各跑一遍完整流程，修复发现的问题；与自动推进同时开启时的行为要符合预期 |

**用户验收**
1. 用户本人在 Claude Code 中说“把 ~/xxx 目录里的这批文件跑完整个流程，结果放到 ~/Downloads”，AI 能自行完成并在每次写操作前征求确认。
2. 找一位没接触过的同事，只看 `docs/MCP_USAGE.md` 完成接入并跑通。

### 阶段 5：部署上线
- K8s 配置补充 `RUYI_PUBLIC_URL`，确认对外 HTTPS、网关超时时间（至少 60 秒，满足 `wait_for_job`）和请求体大小（上传）。
- 更新 `deploy/README.md`。

**用户验收**：在服务器环境重复阶段 4 的验收 1。

---

## 四、风险与待确认事项

| 事项 | 影响 | 需要谁决定 |
|---|---|---|
| 新增依赖 `@modelcontextprotocol/sdk`、`zod` | 阶段 0 前必须批准 | 用户 |
| 平台对外地址与 HTTPS | 同事电脑要能访问；当前 K8s Service 为 ClusterIP，需确认网关或 Ingress | 用户 / 运维 |
| 文件名、任务状态会发到外部模型服务 | 是否符合公司数据规定 | 用户 |
| 上传仍是整文件读入内存（现有逻辑，单文件 1GB 上限） | 大文件并发上传时内存压力大；本计划不改，必要时单独立项改为流式写盘 | 后续 |
| Codex 沙箱不能启动浏览器 | 涉及如翼平台的实测由 Claude 完成 | — |
