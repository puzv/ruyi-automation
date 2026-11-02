# MCP-1 个人访问令牌（API Token）

背景见 `docs/MCP_PLAN.md` 阶段 1。AI agent 无法使用浏览器 Cookie，需要每个用户能生成自己的令牌，
用 `Authorization: Bearer <令牌>` 调用业务接口。本任务只做令牌本身，不做 MCP。

## 1. 数据表（新增迁移，不改已有迁移）

新文件 `db/migrations/20261030_007_create_api_tokens.js`，风格参照 `20261022_006_create_auto_advance.js`：

```
ruyi_api_tokens
  id            BIGINT UNSIGNED AUTO_INCREMENT PK
  user_id       BIGINT UNSIGNED NOT NULL，外键 ruyi_users(id)
  name          VARCHAR(64) NOT NULL        用户填写的用途说明
  display_prefix CHAR(13) NOT NULL          令牌前 13 个字符，仅用于列表中辨认
  secret_hash   CHAR(64) NOT NULL UNIQUE    SHA-256(令牌明文) 的 hex
  last_used_at  DATETIME NULL
  expires_at    DATETIME NOT NULL
  revoked_at    DATETIME NULL
  created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  KEY idx_user (user_id)
```
utf8mb4_unicode_ci，表与列加中文 COMMENT。不用 MySQL 8 语法。`down` 只 DROP 本表。

## 2. 令牌格式与仓储

- 明文：`ruyi_pat_` + `crypto.randomBytes(32).toString('base64url')`（共 52 字符）。库中只存哈希，明文只在创建接口的响应里出现一次。
- 新增 `apps/server/src/modules/api-tokens/repository.js`：create、listForUser、findActiveByHash（join ruyi_users，要求未吊销、未过期、用户 status='active'，返回用户信息，形状与 `auth/repository.js` 的 findActiveSession 一致）、touch（距上次超过 1 分钟才更新 last_used_at）、revoke（只能吊销自己的）、countActiveForUser。

## 3. 接口（`apps/server/src/modules/api-tokens/routes.js`，在 app.js 的 auth 分支中注册）

| 接口 | 说明 |
|---|---|
| `GET /api/api-tokens` | 当前用户的令牌列表：id、name、displayPrefix、createdAt、lastUsedAt、expiresAt、revokedAt、status（active / expired / revoked）。不返回哈希 |
| `POST /api/api-tokens` | body `{ name, expiresInDays }`；name 去首尾空白后 1–64 字符；expiresInDays 只能是 30 / 90 / 365；每人有效令牌最多 10 个（超出返回 409）。响应 `{ ok, token: <明文>, item: <列表项> }` |
| `POST /api/api-tokens/:id/revoke` | 吊销自己的令牌；不存在或不属于自己返回 404；重复吊销返回 ok |

以上三个接口**只允许 Cookie 会话**调用，令牌调用一律 403。

## 4. 鉴权（修改 `apps/server/src/modules/auth/guard.js`）

- 请求带 `Authorization` 头时只按令牌鉴权，不再回退到 Cookie：格式必须是 `Bearer ruyi_pat_<43 位 base64url>`，否则或查不到有效令牌均返回 401 `{ ok:false, code:'UNAUTHENTICATED', message:'令牌无效或已过期' }`。
- 令牌鉴权成功后：`request.user = publicUser(...)`，`request.authMethod = 'token'`，`request.apiTokenId = id`，`request.sessionTokenHash` 保持 null；调用 touch。Cookie 鉴权成功时 `request.authMethod = 'session'`。在 app.js 中 decorateRequest 这两个新字段。
- 令牌请求如果用户 mustChangePassword，返回 403 `PASSWORD_CHANGE_REQUIRED`（与现有一致）。
- **令牌只允许访问白名单路由**（按 `request.routeOptions.url` 匹配，与现有 guard 相同的取值方式），其他一律 403 `{ code:'TOKEN_FORBIDDEN', message:'API 令牌无权访问该接口' }`：

```
GET  /api/auth/me
GET  /api/status            GET  /api/login-status      GET  /api/platform-status
GET  /api/platform-state
POST /api/import-folder     POST /api/run/:task
GET  /api/jobs              GET  /api/jobs/active       GET  /api/jobs/:id
GET  /api/jobs/:id/log      GET  /api/jobs/:id/results  GET  /api/jobs/:id/results.zip
POST /api/jobs/:id/cancel
GET  /api/auto-advance      POST /api/auto-advance      POST /api/auto-advance/check
GET  /api/auto-advance/phases
GET  /api/logs/mine
```
  白名单放在单独的常量里并写注释说明原因（令牌泄露时不能改密码、建令牌、做管理操作、进入远程桌面、改全局运行模式）。管理员的令牌同样不能访问 `/api/admin/*`。
- 远程桌面 WebSocket（`platform-login/vnc-proxy.js`）只认 Cookie，保持不变。

## 5. 操作记录

- `audit/actions.js`：`POST /api/api-tokens` → `token.create`，`POST /api/api-tokens/:id/revoke` → `token.revoke`；targetType `api_token`，targetId 为令牌 id；detail 只放 `{ name, expiresInDays }`（创建时）。**明文、哈希、前缀都不得写入。** 注意 `sanitizeDetail` 会过滤键名含 token 的字段，命名时避开。
- `packages/shared/runtime/audit.js` 的 `auditFromRequest`：当 `request.authMethod === 'token'` 时，在 detail 中合并 `{ via: 'api_token', credentialId: request.apiTokenId }`（原 detail 为空时新建对象），使通过令牌发起的导入、提交任务等操作可以与网页操作区分。

## 6. 前端

- 新增 `apps/web/src/views/ApiTokensView.vue`，侧边栏「我的操作记录」下方加「API 令牌」，路由 `#/api-tokens`（App.vue 中按现有方式接入）。
- 创建表单：名称、有效期下拉（30 / 90 / 365 天，默认 90）。创建成功后在页面显著位置显示明文一次，带「复制」按钮和提示“关闭后无法再次查看，请立即保存”；刷新或离开页面后不再显示。
- 列表：名称、`displayPrefix…`、创建时间、最后使用、过期时间、状态；有效令牌可吊销（先 `confirm`）。
- 页面附一段简短说明：令牌用于 AI 工具接入平台，可访问工作区与任务，不能做管理操作；不要分享给他人。
- 样式沿用现有页面（参照 MyJobsView / AdminUsersView），文字用中文。

## 7. 测试

- 新增 `test/api-tokens.test.js`（数据库测试，只用 `ruyi_test`，开头校验与其他 DB 测试相同；清理顺序注意外键，`ruyi_api_tokens` 先于 `ruyi_users` 删除）。在 package.json 新增 `test:api-tokens` 脚本并加入 `test:all`；同时把 `ruyi_api_tokens` 加入**其他会删除 ruyi_users 的测试**的清理列表，避免外键报错。覆盖：
  - 创建 → 明文只出现一次；库里 secret_hash 等于明文 SHA-256，且库中任何列都不含明文。
  - 用令牌访问 `/api/status` 成功并且是该用户自己的工作区；访问 `/api/admin/users`（管理员令牌）、`/api/api-tokens`、`POST /api/auth/change-password`、`POST /api/runtime-mode`、`POST /api/platform-login` 均 403 TOKEN_FORBIDDEN。
  - 格式错误、不存在、已吊销、已过期（直接改测试库 expires_at）、用户被停用的令牌均 401；带错误 Authorization 头同时带有效 Cookie 也是 401。
  - 吊销他人令牌 404；名称/有效期非法 400；第 11 个有效令牌 409。
  - 操作记录：token.create / token.revoke 存在且 detail 中无明文和哈希；令牌调用 `POST /api/run/:task` 失败或成功的 job.start 记录 detail 含 `via: 'api_token'`（测试中不得真正启动脚本，参照 server-auth.test.js 的封堵方式）。
- 新增 `test/frontend-api-tokens.test.js` 加入 `npm test`（参照 frontend-jobs.test.js 的组件挂载方式）：创建后显示明文、列表渲染、吊销调用正确接口。
- 先在 `ruyi_test` 执行迁移：`RUYI_DB_HOST=127.0.0.1 RUYI_DB_PORT=3306 RUYI_DB_USER=ruyi RUYI_DB_PASSWORD=ruyi RUYI_DB_NAME=ruyi_test RUYI_MIGRATE_CONFIRM=ruyi_test node scripts/migrate.js up`。只允许对本机 ruyi_test 执行。

## 不要做
- 不做 MCP、不新增依赖、不改已有迁移、不改 `/api/import-folder` 等业务逻辑。
- 不读 `.env`、`state-test.json`、`upload/`、`ruyi-profile/`。

## 完成标准
`npm test` 与 `npm run test:all` 全部通过；最后用中文列出改动文件、验证方式、未完成或不确定之处。
