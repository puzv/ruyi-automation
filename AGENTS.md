# 项目规则（供 Codex 等编码助手阅读）

本项目是如翼 / DataNexus 人群包自动化工具，正在从“单人本地工具”重构为“多人使用的平台”。
重构计划与当前进度见 `docs/REFACTOR_PLAN.md`。每次任务只做任务说明里要求的范围，不要顺手改其他内容。

## 代码风格
- Node.js，CommonJS（`require` / `module.exports`），与现有文件一致；`web/` 前端是 Vue 3 + Vite（ESM）。
- 面向用户的提示、日志、错误信息用中文；代码注释保持现有密度，说明“为什么”，不复述代码。
- 不引入任务说明以外的新依赖。

## 不能碰的东西
- 不读取、不修改、不打印：`state-test.json`、`*.state.json`、`ruyi-profile/`、`.env`、`upload/` 下的数据文件。
- 不修改 `db/migrations/` 里已有的迁移文件；表结构变更只能新增迁移文件。
- 不执行 git commit / push / reset / checkout，不删除文件（除非任务明确要求）。
- 不连接任何远程数据库；不执行 `node scripts/migrate.js up`。

## 数据库约束（远程库是共享库 bsg_dw，MySQL 5.7）
- 使用 Kysely + mysql2，连接从 `db/index.js` 的 `createDb()` 获取，不使用 Prisma。
- 所有表名以 `ruyi_` 开头；每张表显式 `DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`。
- 不使用 MySQL 8 专有语法：`SKIP LOCKED`、`NOWAIT`、CTE（`WITH`）、窗口函数、`utf8mb4_0900_ai_ci`。
- 认领任务用原子 `UPDATE ... WHERE status='queued' ORDER BY id LIMIT 1` + `claim_token`。
- `ruyi_operation_logs` 只追加，代码中不得 UPDATE / DELETE 该表。

## 登录态
- 平台登录态使用 Playwright storageState（见 `lib/storage-state.js`、`lib/browser.js` 的 `RUYI_STATE_FILE` 模式）。
- 判断“已登录”必须依据登录后才出现的业务元素并保持数秒，不能只看 URL 或页面文字。
- 检测到已退出登录时不得回写登录态。

## 完成任务前
- 运行 `npm test` 并确保通过；新增逻辑需补充 `test/` 下的测试（使用 Node 自带 `assert`，与现有测试一致）。
- 最后用简短中文列出：改了哪些文件、如何验证、有哪些未完成或不确定的地方。
