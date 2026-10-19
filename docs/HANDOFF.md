# 交接说明：如翼自动化平台重构（由 Codex 接管）

写给：接手本项目的 Codex 主代理（及其子代理）。

## 你的角色
你接替 Claude Code，负责**统筹规划与验收**；具体编码可以交给你的子代理。工作方式与之前相同：
1. 每个任务先写一份任务说明到 `docs/tasks/<阶段>.<序号>-<名称>.md`（参考 `docs/tasks/2.*.md` 的写法：背景、要做的事、约束、测试、完成标准）。
2. 让子代理按任务说明编码。
3. **你亲自审查**：列出实际改动的文件、确认敏感文件没被动过、读改动、自己重跑测试、补测边界情况。不要只看子代理的自述。
4. 一个**阶段**完成后停下，给负责人一份验收清单，**负责人亲自验收通过后才进入下一阶段**。
5. 只在负责人要求时提交 git；直接在 `main` 上工作，不开分支。

## 必读文件（按顺序）
1. `AGENTS.md`：代码规则、禁止事项、数据库约束
2. `docs/REFACTOR_PLAN.md`：总体计划、已定技术决定、各阶段范围与进度
3. `docs/tasks/2.1`～`2.4`：最近的任务说明，作为写法范例
4. 最近两次提交：`git show --stat 906f954 145f0d2`

## 当前状态（截至提交 145f0d2）
- **阶段 1 已验收**：API 从 Vite 插件拆成独立 Fastify 服务（`server/`），前端为生产构建，`npm start` 启动。
- **阶段 2 已验收并提交**：账号密码登录、会话、权限（普通用户/管理员）、强制改密码、登录锁定、只追加的操作记录、前端登录与记录页面。
- **下一步：阶段 3（用户数据隔离）尚未开始**，见下方说明。
- 工作区未提交内容：`upload/analyseToDoList.json`（运行时数据，不要提交）、`artifacts/` 与 `.vscode/`（与重构无关，不要提交）。

## 环境
- 本机 Docker 容器 `ruyi-mysql`（MySQL 5.7，`127.0.0.1:3306`，自动重启）。开发库 `ruyi_dev`，测试库 `ruyi_test`，账号 `ruyi` / `ruyi`。两个库都已迁移，当前无数据。
- `.env` 指向 `ruyi_dev`（不要读取或打印它；测试通过环境变量传入连接信息）。
- 测试：`npm test`（无需数据库）、`npm run test:all`（包含数据库测试，只连接 `ruyi_test`）。
- 依赖由负责人或主代理安装；子代理沙箱可能无法访问 npm 源，不要让子代理安装依赖。
- 子代理需要连接本地数据库时，沙箱必须允许网络访问（之前使用 `-c sandbox_workspace_write.network_access=true`）。
- 生产远程库是**共享库 `bsg_dw`（MySQL 5.7）**，尚未执行迁移。**不要连接它**，除非负责人明确要求，并且要先运行 `node scripts/migrate.js plan` 给负责人过目。

## 绝对不能做的事
- 不读取、不修改、不打印：`state-test.json`（真实平台登录凭证）、`*.state.json`、`ruyi-profile/`、`.env`、`upload/` 下的数据文件。审查时用 `shasum` 确认 `state-test.json` 和 `.env` 没被改过。
- 不修改 `db/migrations/` 里已有的迁移文件；改表结构只能新增迁移文件，并且必须通过 `db/migration-guard.js` 的安全检查（只允许 `ruyi_` 表的 DDL，`up` 中不能出现 DROP）。
- 不使用 MySQL 8 专有语法：`SKIP LOCKED`、CTE（WITH）、窗口函数、`utf8mb4_0900_ai_ci`。
- 不对 `ruyi_operation_logs` 执行 UPDATE/DELETE（测试清理 `ruyi_test` 除外）。
- 不对远程库执行 `migrate.js down`（脚本已经禁止）。

## 关键设计（不要推翻，除非与负责人商量）
- 后端：Node.js CommonJS + Fastify 5；数据库：Kysely + mysql2；前端：Vue 3 + Vite，不引入 vue-router 或组件库。
- 平台登录态（如翼 / DataNexus）使用 Playwright **storageState**，已实测可用：`lib/storage-state.js`；`lib/browser.js` 中设置 `RUYI_STATE_FILE` 即走该模式；关闭浏览器时只在仍处于业务页面时回写登录态。
- 判断“平台已登录”必须看**登录后才出现的业务元素并持续约 3 秒**，不能只看 URL：如翼会先显示页面框架，再跳转到 `sso.e.qq.com`。现有 `server/platform.js` 的 `inspectLoginStatus` 仍是旧的弱判断，计划在阶段 4 替换。
- 表 `ruyi_platform_states` 已建好（加密登录态，计划在阶段 4 使用）。
- 抢任务用原子 `UPDATE ... WHERE status='queued' ORDER BY id LIMIT 1` 加 `claim_token`（阶段 5）。

## 阶段 3：用户数据隔离（下一步）
目标：两个用户互相看不到对方的文件、任务和结果，同一平台账号下的人群包不会互相串用。

需要解决的问题（请先读代码确认，再拆任务）：
1. **目录**：现在所有人共用 `config.uploadRoot`（`upload/`）。改为每个用户一个目录 `<数据根目录>/users/<用户名>/`，子目录结构与现在相同（raw/idfa/oaid/pn/result 和三个 JSON 清单）。服务端根据 `request.user` 计算路径，前端不能传路径。
2. **任务脚本**：`server/jobs.js` 的 `startJob` 启动脚本时传入该用户的 `RUYI_UPLOAD_DIR`。脚本已经支持这个环境变量（`config.js`），**脚本本身尽量不改**。
3. **平台上的同名冲突**（重点）：多个用户共用同一个如翼 / DataNexus 账号，脚本**按文件名**在平台上查找和匹配人群包（`createGroup.js`、`analyse.js`、`download.js`、`server/platform.js`）。必须在上传时给平台显示名加用户名前缀（例如 `alice_0101_pn`），后续匹配都用带前缀的名字，否则会悄悄选中别人的数据。确定前缀加在哪一步（`uploadAll.js` 的文件名整理，或 `upload.js`），并保证清单 JSON 里存的也是带前缀的名字。通过环境变量 `RUYI_USER` 传入，未设置时保持现在的行为（单机使用不受影响）。
4. **并发**：现在全局只允许一个任务运行（`server/state.js` 的 `jobs`），而且所有任务共用同一个浏览器 Profile。阶段 3 的建议：**仍然全局只跑一个浏览器任务**（Profile 只有一份，阶段 4 改用 storageState 后再放开），但任务列表、`GET /api/jobs/:id`、状态接口要按用户隔离：A 不能查看 B 的任务日志。
5. **接口**：`/api/status`、`/api/import-folder`、`/api/run/:task`、`/api/jobs/:id`、`/api/platform-status` 都要按用户处理。
6. **迁移**：现有 `upload/` 里的数据怎么处理（例如提供一次性脚本把它归到某个指定用户名下），需要和负责人确认。

验收建议：两个账号分别导入文件，互相看不到对方的待处理数量和文件；A 运行任务时 B 看不到 A 的日志；平台上的人群包名称带用户名前缀。

## 已知问题（先不用修）
- `server/platform.js` 的 `advanceExternalLoginFlow` 用到了未导入的 `waitForProfileRelease`（Profile 被外部 Chrome 占用时才会走到这里），从原代码原样搬过来的，阶段 4 会整体替换。
- 部署仓库 `~/playwright-upload-deploy` 的 Dockerfile 仍用 `npm --prefix web run dev` 启动，也没有数据库配置，线上 K8s 运行的是旧镜像 `39c1a12`。**不要用新代码重建镜像**，阶段 6 统一处理。
- K8s 上的桌面入口（NodePort 6080）没有密码，负责人知道这件事。

## 和负责人沟通
- 用中文，简洁直接；给出的 shell 命令不要在行尾写 `# 注释`（负责人用 zsh，`#` 会被当成参数）。
- 每个阶段结束时提供：做了什么、你验证了什么、行为上有哪些变化、逐步验收清单。
