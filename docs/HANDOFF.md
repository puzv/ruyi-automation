# 交接说明：如翼自动化平台重构（第二次交接给 Codex）

写给：接手本项目的 Codex 主代理（及其子代理）。截至提交 `edae2d3`（2026-10-20）。

## 你的角色与工作方式
你负责**统筹规划与验收**，编码可以交给子代理。工作方式不变：
1. 每个任务先写任务说明到 `docs/tasks/<阶段>.<序号>-<名称>.md`（参考 `docs/tasks/4.*`、`5.*`：背景、要做的事、约束、测试、完成标准）。
2. 子代理编码；**你亲自审查**：列出实际改动文件，`shasum` 确认 `state-test.json`、`.env` 未被改，读改动，自己重跑 `npm run test:all`，补测边界。
3. 子代理沙箱无法启动 Chromium；涉及真实浏览器的检查由主代理用 `lib/playwright-env` + Playwright 无头模式完成（参考本仓库历史任务中的做法）。
4. 一个阶段完成后停下，给负责人逐步验收清单；负责人验收通过后再进入下一阶段。
5. 直接在 `main` 上工作；只在负责人要求时提交 git。
6. 与负责人沟通用中文；给出的 shell 命令行尾不要写 `# 注释`（负责人用 zsh）。

## 必读文件（按顺序）
1. `AGENTS.md`：代码规则、禁止事项、数据库与登录态约束
2. `docs/REFACTOR_PLAN.md`：技术决定、各阶段范围与进度（最权威）
3. 本文件“剩余工作”一节
4. `docs/STAGE3-4_ACCEPTANCE.md`、`docs/STAGE5_ACCEPTANCE.md`：待负责人执行的验收清单

## 当前状态
| 阶段 | 内容 | 状态 |
|---|---|---|
| 1 | API 从 Vite 插件拆为独立 Fastify 服务 | 已验收、已提交 |
| 2 | 账号密码登录、权限、操作记录 | 已验收、已提交 |
| 3 | 用户数据隔离、平台名称映射 | 已提交，**待负责人验收** |
| 4 | 平台登录态加密存库、网页内扫码登录、按用户加载登录态 | 已提交，**待负责人验收** |
| 5A | 任务队列与 Worker | 已提交，**待负责人验收** |
| 5B | 人群文件流水线状态入表 | 未开始（推迟） |
| 6 | K8s 部署 | 未开始 |

阶段 3/4/5A 的验收被推迟，原因是负责人的如翼账号暂时无法登录。三个阶段的自动化测试和主代理的端到端检查（使用假任务脚本）都已通过，**唯一没跑过的是真实平台上的完整业务流程**。

## 环境
- **生产数据库**：远程共享库 `bsg_dw`（MySQL 5.7.40），连接信息在项目 `.env` 中（不要读取或打印 `.env`；需要连接时让程序通过 `db/env.js` 加载）。负责人要求：**只用 `bsg_dw`，不得改动库中已有的任何表**。迁移 001–005 已执行，库中有 7 张 `ruyi_` 表；原有 48 张表结构在执行前后一致。
  - 今后任何新迁移：先 `node scripts/migrate.js plan` 给负责人看 SQL → 负责人同意 → 执行前后对原有表做结构快照对比。
  - 该账号拥有 `ALL PRIVILEGES ON *.*`，迁移脚本的安全检查（`db/migration-guard.js`）是唯一防线，不要绕过。
- **本地开发库**：Docker 容器 `ruyi-mysql`（MySQL 5.7，`127.0.0.1:3306`，账号 `ruyi`/`ruyi`），库 `ruyi_dev`、`ruyi_test`。`.env.local-dev.bak` 是指向本地库的配置备份。
- **测试**：`npm test`（无需数据库）、`npm run test:all`（含数据库测试，只连 `ruyi_test`，库名不对会拒绝运行）。子代理需要访问本地数据库时，沙箱必须开启网络（`-c sandbox_workspace_write.network_access=true`）。
- **依赖**由主代理安装，不让子代理安装（沙箱可能连不上 npm 源）。
- **加密密钥** `RUYI_STATE_KEY` 在 `.env` 中，丢失则所有平台登录态无法解密（需重新扫码）。

## 绝对不能做的事
- 不读取、不修改、不打印：`state-test.json`、`*.state.json`、`ruyi-profile/`、`.env`、`.env.*.bak`、`upload/` 下的数据文件。
- 不改动 `bsg_dw` 中任何非 `ruyi_` 表；不对 `bsg_dw` 执行 `migrate.js down`（脚本已禁止远程回滚）。
- 不修改 `db/migrations/` 中已有文件；表结构变更只能新增迁移，且必须通过 `db/migration-guard.js`。
- 不使用 MySQL 8 语法（`SKIP LOCKED`、CTE、窗口函数、`utf8mb4_0900_ai_ci`）；UPDATE 中不能子查询同一张表。
- 不对 `ruyi_operation_logs` 执行 UPDATE/DELETE（测试清理 `ruyi_test` 除外）。
- 登录态明文只能存在于内存或权限 600 的临时文件中，不得写日志、接口响应或操作记录。

## 剩余工作

### A. 负责人验收（不需要写代码，但可能产生修复任务）
1. 负责人在 `bsg_dw` 上创建管理员：`npm run user:create-admin -- <用户名> <显示名>`，再在网页上创建普通用户。
2. 按 `docs/STAGE3-4_ACCEPTANCE.md`、`docs/STAGE5_ACCEPTANCE.md` 验收。重点风险：
   - 网页内扫码登录（本机模式：登录窗口弹在运行服务的电脑上）是否顺利完成并保存登录态
   - 新命名规则 `<用户名>_<类型>_<8位短串>_<序号>` 在如翼/DataNexus 上能否正常上传、搜索、创建人群、洞悉、下载（30 字符上限）
   - 下载结果按原始文件名保存
   - 任务结束后登录态回写续期
3. 验收中发现的问题按“任务说明 → 子代理修复 → 审查”流程处理。

### B. 阶段 6：K8s 部署（主要剩余开发工作）
部署配置现位于主仓库 `deploy/`（`k8s/` 下仍是最初的模板，与线上实际不一致）。线上目前运行旧镜像 `harbor.ge.cn/b2d/common/ruyi-upload:desktop-39c1a12`，namespace `b2d-bsgdw`，PVC `ruyi-upload-data`（nfs-client，10Gi），NodePort 暴露 5173（应用）和 6080（无密码桌面）。部署方式是负责人在 Kubernetes Dashboard 粘贴 YAML（本机没有 kubectl 集群配置）。

需要做的：
1. **Dockerfile**：基于新代码重建。启动命令改为 `npm start`（不再用 `npm --prefix web run dev`）；构建时执行 `npm run build:web`；镜像中包含 Xvfb、openbox、x11vnc（只监听 `127.0.0.1:5900`），**不再需要 websockify/noVNC 服务端和 6080 端口**（远程桌面由后端鉴权 WebSocket 转发，见 `server/platform-login/vnc-proxy.js`）。
2. **启动脚本**：启动 Xvfb `:99` + openbox + x11vnc（`-localhost -rfbport 5900 -forever -shared`，可加 `-nopw`，因为只监听本机且入口有鉴权）+ `npm start`；设置 `RUYI_LOGIN_DISPLAY=vnc`、`DISPLAY=:99`。参考现有 `deploy/scripts/start-desktop.sh`。
3. **Secret**：数据库连接（`RUYI_DB_*`）与 `RUYI_STATE_KEY` 放入 K8s Secret，以环境变量注入。**`RUYI_STATE_KEY` 必须与负责人本地 `.env` 中的一致**，否则本地登录的平台登录态在线上无法解密（也可以接受线上重新扫码）。
4. **存储**：用户工作区 `RUYI_UPLOAD_DIR` 指向 PVC（例如 `/data/upload`）；不再需要 `/data/profile`（emptyDir 可删）。
5. **Service**：删除桌面 NodePort（6080）；应用入口仍为 5173。若平台同事能提供 Ingress + HTTPS，设置 `RUYI_COOKIE_SECURE=1`。
6. **资源**：每个运行中的任务约 0.5–1.5GB 内存。按 `RUYI_MAX_CONCURRENT_JOBS`（默认 2）调整 limits（建议内存 ≥ 4Gi）；`/dev/shm` 用 `emptyDir: { medium: Memory, sizeLimit: 1Gi }`。
7. **更新策略**：保持 `Recreate`、单副本（Worker 内嵌）。如需拆分，API 设 `RUYI_WORKER=off`，另起 Worker Deployment 运行 `npm run worker`（两者共享 PVC，需 ReadWriteMany）。
8. **迁移旧数据**：线上 PVC 中旧的 `/data/upload` 数据若需要保留，用 `scripts/migrate-user-workspace.js` 复制到某个用户名下（先 dry-run）。
9. **验证项**（阶段 4 中未能实测）：Xvfb + x11vnc + 后端 WebSocket 转发 + 网页 noVNC 组件的完整链路；远程桌面同时只允许 1 人登录。
10. 把实际生效的 K8s YAML、Dockerfile 保存在主仓库 `deploy/` 并更新其中 README；当前阶段尚未完成线上 K8s 更新。

### C. 推迟的工作（负责人尚未要求）
- **5B 流水线入表**：把 `createGroupToDoList.json`、`analyseToDoList.json`、`done.json`、`file-manifest.json` 改为数据库表；等开始做“分析下载结果文件”功能时再做。
- **文件分析功能**：负责人最初提到的需求，尚未设计。
- 管理员查看他人任务日志内容（目前只能看状态）。
- 接入公司 SSO；向 DBA 申请仅限 `ruyi_` 表的低权限数据库账号；数据库密码已在对话中出现过，建议更换。
- 已知遗留：`lib/browser.js` 的持久 Profile 分支与 `lib/preflight.js` 只供命令行单机脚本使用；如果负责人确认不再用命令行，可以清理，并删除 `ruyi-profile/`。

## 关键设计（不要推翻，除非与负责人商量）
- 后端 Node.js CommonJS + Fastify 5；数据库 Kysely + mysql2；前端 Vue 3 + Vite，不引入 vue-router 或组件库。
- 平台登录态用 Playwright storageState，AES-256-GCM 加密存 `ruyi_platform_states`，AAD 绑定 `user_id`；判断“已登录”看业务元素并持续 3 秒（`lib/storage-state.js`）。
- 任务：`ruyi_jobs` 入队 → Worker 在命名锁内认领 → 包装器（`scripts/job-wrapper.js`）启动脚本 → 临时解密的登录态文件（600）→ 结束后回写/标记过期并删除 → 写 `job.finish`。
- 每个用户独立工作区 `upload/users/<用户名>/`；平台名称 `<用户名>_<类型>_<任务短串>_<序号>`，映射存 `file-manifest.json`。
