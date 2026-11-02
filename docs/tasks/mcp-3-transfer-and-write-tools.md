# MCP-3 文件上传、任务执行与结果下载

背景见 `docs/MCP_PLAN.md` 阶段 3。前置：MCP-1、MCP-2 已完成。不要安装任何依赖。

核心思路：**文件不经过模型**。AI 调用工具拿到一次性地址，再让用户电脑上的 agent 执行 `curl` 直接把文件传给服务器，或从服务器下载结果。地址里的票据短时有效、只能用一次、绑定用户，所以不需要把长期令牌写进命令。

## 1. 一次性票据表（新增迁移，不改已有迁移）

`db/migrations/20261030_008_create_transfer_tickets.js`：

```
ruyi_transfer_tickets
  id          BIGINT UNSIGNED AUTO_INCREMENT PK
  user_id     BIGINT UNSIGNED NOT NULL，外键 ruyi_users(id)
  purpose     ENUM('upload','download') NOT NULL
  job_id      CHAR(36) NULL              下载票据对应的任务
  secret_hash CHAR(64) NOT NULL UNIQUE   SHA-256(票据明文)
  expires_at  DATETIME NOT NULL
  used_at     DATETIME NULL
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  KEY idx_user (user_id)
```
utf8mb4_unicode_ci，中文 COMMENT，无 MySQL 8 语法。

仓储 `apps/server/src/modules/transfer/repository.js`：
- `createTicket`：明文为 `randomBytes(32).toString('base64url')`（43 位），只存哈希。
- `consumeTicket(db, { secret, purpose })`：**原子领用**：`UPDATE ... SET used_at=NOW() WHERE secret_hash=? AND purpose=? AND used_at IS NULL AND expires_at>NOW()`，影响 1 行才算成功，再查出 user（join ruyi_users，要求 status='active'）与 job_id。用户已停用时视为无效。
- 不需要清理任务；过期票据留在表中即可（数据量很小），在迁移注释中说明。

## 2. 把导入逻辑抽成共用函数

把 `apps/server/src/modules/files/routes.js` 中 `POST /api/import-folder` 的“读取 multipart、按规则过滤、写入 raw/<importId>/<n>/、统计 count/skipped/files”逻辑抽到同目录 `import.js`（如 `importMultipartFiles(req, workspace)`），`/api/import-folder` 改为调用它，**行为与返回值保持完全一致**（现有测试必须原样通过）。新的上传接口复用同一函数，并复用“当前用户有任务运行时拒绝导入”（409）的检查。

## 3. 票据接口（不走 guard 的 Cookie / 令牌鉴权，凭票据访问）

路由放在 `/api/transfer/` 下，guard 中对这两个路由放行（与 `/api/health` 同样的方式，按 `routeOptions.url` 精确匹配），由路由自己校验票据：

| 接口 | 说明 |
|---|---|
| `POST /api/transfer/upload/:ticket` | multipart，字段名 `files`（可多个，与 `/api/import-folder` 一致）。领用 purpose=upload 的票据，设置 `request.user` 后调用共用导入函数。返回 `{ ok, count, skipped, files }`（files 为已导入的文件名，最多 100 个）。 |
| `GET /api/transfer/download/:ticket` | 领用 purpose=download 的票据，按 job_id 返回该任务结果 ZIP（复用 `jobs/routes.js` 中 results.zip 的校验与 `zipStream`，必要时把 `resultsFor` 抽成共用函数）。 |

要求：
- 票据格式不对、不存在、已用过、已过期、用途不符，一律 404 `{ ok:false, message:'链接无效或已过期，请重新获取' }`（不区分原因）。
- **先领用再处理**：即使后续导入失败，票据也作废（失败时提示重新获取链接）。
- 操作记录：上传成功/失败写 `file.import`，detail 与网页导入一致并加 `via:'transfer_ticket'`；下载写 `job.results_download`（targetType job，targetId 任务 id）。均需 userId/username。注意 `sanitizeDetail` 会过滤含 token/state 等字样的键名。
- **票据不得进入日志**：`app.js` 的 onResponse 日志目前打印 `request.url`，对 `/api/transfer/` 路由改为打印 `routeOptions.url`（即 `/api/transfer/upload/:ticket`）。错误处理器同理检查。
- 上传接口的 multipart 限制与 `/api/import-folder` 相同。

## 4. 写工具（加到 MCP-2 的 mcp 模块）

除特别说明外，均通过 `callApi`（`app.inject`）调用现有接口。生成地址用 MCP-2 的平台地址函数（`RUYI_PUBLIC_URL`）。

| 工具 | 输入 | 行为 | annotations |
|---|---|---|---|
| `prepare_upload` | 无 | 当前用户有排队/运行中任务时直接返回错误（与导入接口一致）。否则创建 10 分钟有效的上传票据，返回 `{ uploadUrl, expiresAt, curlExample, rules }`。curlExample：`curl -sS -F "files=@/path/to/a_idfa.txt" -F "files=@/path/to/b_pn.csv" '<uploadUrl>'`；rules：文件名需包含 idfa、oaid 或 pn，扩展名 .txt 或 .csv；一个链接只能用一次，多个文件请在一条命令中一起上传；上传文件夹时先列出其中符合规则的文件再逐个加 `-F`。文本中强调**不要读取文件内容**。 | readOnly:false, destructive:false, idempotent:false |
| `run_task` | `task`：enum upload / create / analyse / download | `POST /api/run/:task`；返回 `{ jobId, status, position }` 和提示“用 wait_for_job 等待”。 | readOnly:false, destructive:false, idempotent:false, openWorld:true |
| `cancel_job` | `jobId` | `POST /api/jobs/:id/cancel` | destructive:true |
| `set_auto_advance` | `enabled: boolean` | `POST /api/auto-advance` | idempotent:true |
| `prepare_download` | `jobId` | 先 `GET /api/jobs/:id/results` 校验可下载（复用接口的错误信息）；通过后创建 10 分钟有效的下载票据，返回 `{ downloadUrl, expiresAt, fileCount, size, curlExample }`，curlExample：`curl -sS -fL -o ./ruyi-results-<jobId>.zip '<downloadUrl>'`，提示用户可指定保存目录。 | readOnly:false, idempotent:false |

同时：
- 更新 MCP-2 中 `get_overview` 的 `nextStep`：现在可以引用这些工具名（例如 `run_upload` 建议 `run_task(upload)`、`import_files` 建议 `prepare_upload`；`resultsReady` 时建议 `run_task(download)`，下载任务完成后建议 `prepare_download`）。
- 补充 `instructions`：上传/下载必须用 prepare_upload / prepare_download 返回的地址配合 curl 完成，不要读取文件内容、不要把文件内容作为参数传给任何工具；提交任务（run_task）前向用户说明将要执行的操作；下载任务结束后用 prepare_download 取回结果。
- 更新 `docs/MCP_USAGE.md`，补充一个完整对话示例（从“把 ~/data 里的文件跑完全流程”开始，列出 AI 预期的工具调用顺序）。

## 5. 测试

在 `test/mcp.test.js` 中补充（或新建 `test/mcp-transfer.test.js` 并加入 package.json 与 `test:all`），仍只用 `ruyi_test`，禁止启动浏览器与脚本：
- `prepare_upload` 返回的地址可用 `fetch` + `FormData` 上传：合规文件进入该用户工作区 `raw/`，不合规文件计入 skipped；同一地址再次使用 404；过期票据（直接改测试库 expires_at）404；download 票据用于上传 404。
- 用户有运行中任务时 `prepare_upload` 返回 isError；票据创建后、上传前任务开始运行，上传返回 409 且票据已作废。
- 两个用户的票据互不影响：A 的上传地址只能写入 A 的工作区。
- `/api/import-folder` 原有测试全部不变地通过。
- `run_task` 非法 task 被 schema 拒绝；合法 task 入队（测试中 worker 不启动或被封堵），操作记录 job.start 的 detail 含 `via:'api_token'`、user_agent 以 `ruyi-mcp/` 开头。
- `prepare_download`：非下载任务、未结束任务返回 isError；对造好的结果目录（参照 `test/job-results.test.js` 的构造方式）返回地址，`fetch` 得到 ZIP（校验 PK 头与 Content-Disposition），第二次 404；B 不能为 A 的任务生成票据。
- 服务日志中不出现票据明文（给 app 传入自定义 logger 收集输出后断言）。
- `listTools` 共 10 个工具，写工具的 annotations 与上表一致。

## 不要做
- 不新增依赖、不改已有迁移；`/api/import-folder` 对外行为不变。
- 不读 `.env`、`state-test.json`、`upload/`、`ruyi-profile/`。

## 完成标准
`npm test` 与 `npm run test:all` 全部通过；最后用中文列出改动文件、验证方式、未完成或不确定之处。
