# MCP-2 MCP 服务与只读工具

背景见 `docs/MCP_PLAN.md` 阶段 2。前置：MCP-1（个人访问令牌）已完成。
依赖 `@modelcontextprotocol/sdk` 与 `zod` 已由 Claude 安装到 `@ruyi/server`，不要再安装任何依赖。

## 1. 端点

新增模块 `apps/server/src/modules/mcp/`，在 `app.js` 的 auth 分支注册（未启用鉴权时不注册）。

- `POST /mcp`：每个请求新建一个 `McpServer` + `StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })`（无状态模式），
  `reply.hijack()` 后 `transport.handleRequest(request.raw, reply.raw, request.body)`；`reply.raw` 的 close 事件中关闭 transport 与 server。
  已验证的 CommonJS 用法：
  ```js
  const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js')
  const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js')
  const z = require('zod')
  ```
  处理过程中抛错且响应尚未发出时，返回 500 与 JSON-RPC 错误体（`{ jsonrpc:'2.0', error:{ code:-32603, message:'服务内部错误' }, id:null }`），并用 `request.log.error` 记录。
- `GET /mcp`、`DELETE /mcp` 返回 405 `{ ok:false, message:'仅支持 POST' }`（无状态模式不提供 SSE 流与会话）。
- `GET /.well-known/oauth-protected-resource`、`GET /.well-known/oauth-authorization-server`（以及其后带路径的变体）返回 404 JSON。原因：MCP 客户端收到 401 时会探测这些地址，若落到单页应用回退会拿到 index.html 而报出难懂的错误。
- **鉴权**：`/mcp` 不在 `/api/` 下，现有 guard 不会处理，需在该路由的 onRequest/preHandler 中自行鉴权：**只接受 `Authorization: Bearer` 令牌**（复用 MCP-1 的令牌校验函数，必要时从 guard.js 导出），不接受 Cookie（防止浏览器跨站调用）。失败返回 401 `{ ok:false, code:'UNAUTHENTICATED', message:'需要有效的 API 令牌' }` 并带 `WWW-Authenticate: Bearer realm="ruyi"`；需改密码的用户返回 403。

## 2. 工具调用业务接口的方式

工具内部**不直接读写数据库或工作区**，统一通过 `app.inject()` 调用现有 `/api/*` 接口，以复用用户隔离、并发限制、登录态检查与操作记录：

```js
app.inject({ method, url, payload, headers: {
  authorization: request.headers.authorization,
  'user-agent': `ruyi-mcp/${版本} (${原始 user-agent 截断})`,
}, remoteAddress: request.ip })
```
版本取自 `apps/server/package.json`。封装成一个 `callApi(method, url, body)` 帮助函数，返回 `{ status, data }`。

**错误映射**（统一函数，工具返回 `{ isError: true, content:[{ type:'text', text }] }`）：
- 409 且 `code === 'PLATFORM_LOGIN_REQUIRED'`、或平台登录态非 valid：`如翼平台未登录或登录已失效，请在浏览器打开 <平台地址>/#/platform-login 完成登录后再继续。不要重试。`
- 其他 4xx：使用接口返回的中文 message。5xx：`平台服务出错，请稍后重试`。
- 平台地址：环境变量 `RUYI_PUBLIC_URL`（去掉末尾 `/`）；未设置时用 `${request.protocol}://${request.host}`。新增 `packages/shared` 或 mcp 模块内的小函数，后续阶段生成上传/下载地址也会用到。

## 3. 服务说明（instructions）

`new McpServer({ name: 'ruyi', version }, { instructions })`，`instructions` 是连接时自动发给模型的中文说明，内容（可润色，但要点不能少）：

- 本服务操作如翼 / DataNexus 人群包工作流，流程固定为：导入文件 → 上传（upload）→ 平台处理文件 → 创建人群包（create）→ 平台生成人群 → 人群洞悉（analyse）→ 平台生成结果 → 下载结果（download）。
- 开始前先调用 `get_overview` 了解当前进度与建议的下一步。
- 平台登录只能由用户本人在网页完成；工具提示未登录时，把登录地址告诉用户并停止，不要重试。
- 任务提交后是异步执行的，用 `wait_for_job` 等待；一次最多等 50 秒，未结束可再次调用。平台侧处理通常需要几分钟到几十分钟。
- `check_platform` 会启动浏览器访问平台，较慢，不要频繁调用（两次间隔至少 1 分钟）；提示“正在进行”时等待后再试。
- 绝不读取、输出或转述人群包文件内容（设备号、手机号等）。

## 4. 只读工具（全部设置 `annotations: { readOnlyHint: true, openWorldHint: <是否访问外部平台> }`）

每个工具返回：`content` 为一段**中文摘要** + 换行 + 关键数据的 JSON；同时返回 `structuredContent`（同一份数据对象）。

| 工具 | 输入 | 行为 |
|---|---|---|
| `get_overview` | 无 | 并行调用 `GET /api/status`、`GET /api/platform-state`、`GET /api/jobs/active`、`GET /api/auto-advance`，汇总为 `{ workspace:{ status, pendingUpload, createCount, analyseCount, doneCount }, platformLogin:{ status, loginUrl }, activeJob, autoAdvance:{ enabled, phase, message }, nextStep }`。**不返回 createNames 等文件清单**（只给数量）。 |
| `check_platform` | 无 | `GET /api/platform-status`；把 idfaPending / oaidPending / pnPending / insightPending / resultPending 解释成中文（平台尚未就绪的文件数 / 人群数 / 结果数），并给出 `ready:{ create, analyse, download }`（对应工作区有待办且平台待处理数为 0）。接口 409 且不是登录问题时，提示“平台检查正在进行，请 1 分钟后再试”。`openWorldHint: true`。 |
| `list_jobs` | `page?`（≥1）、`pageSize?`（1–20，默认 10） | `GET /api/jobs`；每项只返回 id、task、status、position、queuedAt、startedAt、finishedAt、exitCode、errorMessage、resultFiles。 |
| `get_job` | `jobId`（uuid） | `GET /api/jobs/:id`；返回任务字段 + `logTail`：日志最后 **8KB**，并把工作区绝对路径（`uploadRoot` 前缀）替换为 `<工作区>`。 |
| `wait_for_job` | `jobId`、`timeoutSeconds?`（5–50，默认 45） | 每 2 秒 `GET /api/jobs/:id` 一次，状态不再是 queued/running 或到时即返回；返回内容同 `get_job`，另加 `timedOut: boolean`。客户端断开（`reply.raw` close）时立即停止轮询。 |

`nextStep`（`get_overview`）按以下顺序取第一条满足的，给出中文建议，并在 JSON 中带 `action` 字段：

1. 平台登录态不是 valid → `login`：提示去网页登录。
2. 有排队/运行中的任务 → `wait_job`：建议 `wait_for_job`。
3. pendingUpload > 0 → `run_upload`：建议提交上传任务。
4. createCount > 0 → `wait_platform_files`：文件已上传，等待平台处理后创建人群；若自动推进已开启说明会自动创建，否则建议稍后 `check_platform`。
5. analyseCount > 0 → `wait_audience`：同理（自动推进会自动提交洞悉）。
6. doneCount > 0 → `wait_results`：洞悉已提交，结果就绪后需要下载（自动推进不会自动下载）；`autoAdvance.phase === 'resultsReady'` 时改为 `run_download`。
7. 否则 → `import_files`：当前无待办，可导入新文件。

阶段 2 只有只读工具，`nextStep` 文案中提到的写操作用“下一阶段将提供”之类措辞即可，或只描述应做的事，**不要**引用尚不存在的工具名。

## 5. 文档

新增 `docs/MCP_USAGE.md`（面向同事，中文）：
1. 在平台「API 令牌」页面生成令牌。
2. Claude Code：`claude mcp add --transport http --scope user ruyi <平台地址>/mcp --header "Authorization: Bearer <令牌>"`。
3. Codex：`export RUYI_TOKEN=<令牌>` 后 `codex mcp add ruyi --url <平台地址>/mcp --bearer-token-env-var RUYI_TOKEN`。
4. 验证：在 agent 中问“如翼平台现在进行到哪一步了？”。
5. 安全提示：令牌等同于账号，不要提交到代码仓库或分享；泄露后立即在网页吊销。

## 6. 测试

新增 `test/mcp.test.js`（数据库测试，只用 `ruyi_test`，开头的安全校验、浏览器/子进程封堵、数据清理方式与 `test/api-tokens.test.js` 一致），package.json 新增 `test:mcp` 并加入 `test:all`。
使用 SDK 客户端连接真实监听端口（`app.listen({ port: 0, host: '127.0.0.1' })`）：
```js
const { Client } = require('@modelcontextprotocol/sdk/client/index.js')
const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js')
```
覆盖：
- 无 Authorization、无效令牌、只带 Cookie 均 401；已吊销令牌 401。
- `GET /mcp` 405；`/.well-known/oauth-protected-resource` 返回 404 JSON 而不是 HTML。
- 初始化后 `client.getInstructions()` 含“平台登录”“wait_for_job”“不读取”等要点；`listTools` 恰好 5 个工具且均 `readOnlyHint: true`。
- `get_overview`：在测试工作区放入待上传文件，返回 pendingUpload 正确、`nextStep.action` 正确；结果中不出现文件名清单。
- 用户 A 的令牌 `get_job` 用户 B 的任务 → isError、提示任务不存在。
- `get_job` 日志超过 8KB 时只返回末尾 8KB，且绝对路径已替换。
- `wait_for_job`：任务在等待期间被测试改为 succeeded 时提前返回 `timedOut:false`；保持 running 时 `timeoutSeconds:5` 到时返回 `timedOut:true`。
- 未保存平台登录态时 `check_platform` 返回 isError，文本包含 `#/platform-login`，且没有启动浏览器。
- 通过 MCP 发出的请求在操作记录中的 user_agent 以 `ruyi-mcp/` 开头（可借助一次会写审计的调用验证；若只读工具都不写审计，则改为断言 inject 时传入的 headers，任选其一并在总结中说明）。

## 不要做
- 不实现写操作工具（上传、提交任务、取消、下载、自动推进开关）——那是 MCP-3。
- 不新增依赖、不改已有迁移、不改业务接口行为。
- 不读 `.env`、`state-test.json`、`upload/`、`ruyi-profile/`。

## 完成标准
`npm test` 与 `npm run test:all` 全部通过；最后用中文列出改动文件、验证方式、未完成或不确定之处。
