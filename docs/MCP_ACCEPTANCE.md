# MCP 接入 · 用户验收清单

Claude 已对每个阶段完成代码审核、全量测试与本机实测，以下是留给你亲自验收的点。
每项后面的 ✅/❌ 由你验收时填写。

## 本机验收环境（Claude 已准备好）

- 本机数据库 Docker 容器 `ruyi-mysql` 已启动，`ruyi_dev`、`ruyi_test` 均已执行新迁移（远程库**未**执行，上线前需要你确认后再执行）。
- 启动独立验收实例（不影响你平时用的 `npm start`）：
  ```sh
  /tmp/ruyi-dev.sh          # 监听 http://127.0.0.1:5199，数据目录 /tmp/ruyi-dev-data，不跑 Worker/自动推进
  RUYI_WORKER=on /tmp/ruyi-dev.sh   # 需要真正执行任务时用这个（会启动浏览器访问如翼平台）
  ```
  若 `/tmp` 被系统清理，脚本内容见本文末尾附录。
- 本机验收账号：`mcpcheck` / `McpCheck123`（管理员，仅存在于本机 `ruyi_dev`）。
- 前端需先构建：`npm run build:web`。

---

## 阶段 1：个人访问令牌（Claude 审核：通过）

Claude 已验证：`npm run test:all` 全部通过；curl 实测令牌可读状态、可导入文件、管理接口/令牌管理/退出登录/URL 编码绕过均被拒；操作记录带 `via: api_token`；服务日志不含令牌明文；页面截图正常。

请你验收：
1. [ ] 登录网页，左侧栏出现「API 令牌」，生成一个令牌，页面只显示一次明文，刷新后消失。
2. [ ] 终端执行（替换令牌）：
   `curl -H "Authorization: Bearer <令牌>" http://127.0.0.1:5199/api/status` → 返回你的工作区状态。
3. [ ] 同一令牌访问 `http://127.0.0.1:5199/api/admin/users` → 返回「API 令牌无权访问该接口」。
4. [ ] 在页面吊销该令牌，再执行第 2 步 → 返回「令牌无效或已过期」。
5. [ ] 「我的操作记录」中能看到生成、吊销令牌的记录。

已知限制：
- 通过 http（非 https、非 localhost）访问时浏览器不允许网页写剪贴板，「复制」会提示失败，需手动选中复制；上线走 https 后正常。

---

## 阶段 2：MCP 服务 + 只读工具（Claude 审核：通过，含 1 轮修复）

Claude 已验证：`npm run test:all` 全部通过；用官方 MCP 客户端连本机实例调用 5 个工具，鉴权、跨用户隔离、参数校验、未登录提示均正常。
审核中发现并已修复：服务关闭自动推进时 `get_overview` 整体报错；令牌访问不存在的接口返回 403 而非 404；工具描述过于简略。

请你验收（先在网页生成一个令牌）：
1. [ ] 把 MCP 接入你自己的 Claude Code（本机实例地址）：
   ```sh
   claude mcp add --transport http ruyi-local http://127.0.0.1:5199/mcp --header "Authorization: Bearer <令牌>"
   ```
   执行 `claude mcp list`，`ruyi-local` 显示已连接。
2. [ ] 在 Claude Code 中问「如翼平台现在进行到哪一步了？」→ AI 调用 `get_overview`，回答与网页「工作区状态」一致。
3. [ ] 平台未登录时，AI 应告诉你登录地址（`/#/platform-login`）并停下，而不是反复调用工具。
4. [ ] 问「我最近有哪些任务？」→ AI 调用 `list_jobs`，与网页「我的任务」一致。
5. [ ] 验收完可执行 `claude mcp remove ruyi-local`（第 3 阶段还会用到，可以先保留）。

---

## 阶段 3：文件上传、任务执行与结果下载（Claude 审核：通过）

Claude 已验证：
- 本机 `ruyi_dev`、`ruyi_test` 执行了迁移 008（`ruyi_transfer_tickets`）；`npm run test:all` 全部通过。
- MCP 客户端实测：`prepare_upload` 返回的地址用 curl 上传成功，不合规文件被跳过；同一地址第二次使用、上传地址拿去下载均返回「链接无效或已过期」。
- 在本机造了一个已完成的下载任务，`prepare_download` + curl 下载到 ZIP，中文文件名正确；地址第二次使用 404。
- `run_task` 非法任务名被拒；平台未登录时提示登录地址。
- 操作记录中分别出现 `file.import (via transfer_ticket)`、`job.start (via api_token)`、`job.results_download`；服务日志只出现 `/api/transfer/upload/:ticket`，不含票据。

**需要你在真实平台上验收（Claude 无法替你完成平台登录）：**
准备：用 `RUYI_WORKER=on /tmp/ruyi-dev.sh` 启动本机实例（会真正执行脚本、访问如翼平台），用 `mcpcheck` 登录网页 →「平台登录」完成如翼登录。准备 1 个小的测试 pn 文件（如 `test_pn_mcp.txt`，内容用你平时测试用的少量号码）。
1. [ ] 在 Claude Code 中说「把 ~/xxx/test_pn_mcp.txt 上传到如翼平台」→ AI 调用 `prepare_upload` 并用 curl 上传；**全程不应 cat/head 文件内容**。网页「工作区状态」待上传 +1。
2. [ ] 说「提交上传任务并等它完成」→ AI 先说明再调用 `run_task(upload)`，随后 `wait_for_job`；网页「我的任务」状态一致。
3. [ ] 「我的操作记录」中 `job.start` 记录的详情含 `via: api_token`。
4. [ ] 让 AI 把一个已完成的下载任务结果保存到 `~/Downloads`（可用网页先跑一次下载）→ 解压内容与网页下载一致。
5. [ ] 把第 1 步 AI 用过的上传地址再 curl 一次 → 「链接无效或已过期」。

已知限制：
- 上传仍沿用原接口的整文件读入内存（单文件上限 1GB）；本次未改为流式，如大文件多人并发上传再单独优化。

---

## 阶段 4：Skill 与全流程（Claude 审核：通过）

Claude 已验证：`npm run test:all` 全部通过；`/api/skill/ruyi-audience.zip` 令牌可下载（3 个文件）、未登录 401；「API 令牌」页新增「接入 AI 工具」（Claude Code / Codex 命令自动填入平台地址，Skill 下载链接）。
真实 Claude Code（sonnet）实测：
- 只接 MCP、无 Skill：「把目录里的文件导入平台」→ get_overview → `ls` 列文件名 → prepare_upload → 一条 curl 上传 2 个合规文件 → 汇报状态；**全程未读取文件内容**。
- 装上 Skill：「把目录里的文件跑完整个流程，结果放到 …」→ get_overview 发现平台未登录 → 停下给出登录地址，并主动指出文件异常小、`.docx` 不会上传、待上传数与目录不符，请求确认后再开始。符合 Skill 的“异常先停下说明”。

请你验收（需要平台已登录，见阶段 3 的准备）：
1. [ ] 在「API 令牌」页点「下载如翼 Skill」，`unzip ruyi-audience.zip -d ~/.claude/skills/`，重开 Claude Code。
2. [ ] 准备一个只含 1–2 个测试小文件的目录，说「把 <目录> 里的文件跑完整个如翼流程，结果放到 ~/Downloads/ruyi-test」。
3. [ ] 观察 AI：每次提交任务前先说明；上传后等待；平台处理阶段按间隔检查（未开自动推进时用 check_platform，间隔 ≥2 分钟）；超过 30 分钟会询问是否继续等。
4. [ ] 最终 `~/Downloads/ruyi-test` 中出现结果 ZIP，内容与网页下载一致。
5. [ ] （可选）找一位同事只看「API 令牌」页上的说明完成接入并跑通。

---

## 阶段 5：部署准备（Claude 审核：通过，含 1 处修正）

Claude 已验证：镜像构建白名单加入 `skills/ruyi-audience/*.md`（审核时修正了 Codex 误把文件筛选固定为新布局、会影响旧版本构建的改动）；`deploy/test/container-preparation.test.js` 与 `npm run test:all` 通过；Skill 文件缺失时返回 503 中文提示。

上线前需要你（或运维）完成，均**未**由 Claude 执行：
1. [ ] 远程库执行迁移 007、008：先 `node scripts/migrate.js plan` 核对 SQL，再 `node scripts/migrate.js up`（会要求输入库名）。
2. [ ] `deploy/k8s/ruyi-upload-dashboard.yaml` 中把 `RUYI_PUBLIC_URL` 占位改为真实 HTTPS 地址。
3. [ ] 网关/Ingress：放行 `/mcp`、`/api/transfer/`；读超时 ≥60 秒；请求体上限满足上传需要；透传 `Authorization` 头。
4. [ ] 构建并部署新镜像后：`curl -s -o /dev/null -w '%{http_code}' -X POST https://<地址>/mcp` 返回 401；按 `docs/MCP_USAGE.md` 接入并重复阶段 4 第 2 步。

---

## 验收结果（2026-11-02，用户与 Claude 共同完成）

- 阶段 1–4 本机验收全部通过，真实如翼平台全流程（上传 → 创建 → 洞悉 → 下载）由 AI 自主跑通，约 40 分钟。
- 用户反馈已修正（任务 mcp-6）：操作记录全部中文并标注「AI 工具」来源；MCP 服务说明禁止以任何方式读取人群包与结果文件内容；Skill 改为跑全流程时不逐步确认、仅关键节点汇报。
- 已知：macOS 自带 `unzip -l` 显示 ZIP 中文名乱码（ZIP 已设 UTF-8 标记，访达 / ditto 正常），暂不处理。
- 阶段 5（上线）待执行。

## 本次未提交的改动

全部改动都在工作区，**没有 git commit**。验收通过后告诉 Claude 提交即可。提交时会排除 `upload/`、`.vscode/` 以及 `.env.example` 的删除（除非你确认）。

---

## 附录：/tmp/ruyi-dev.sh

```sh
#!/bin/sh
# 本机验收实例：ruyi_dev 库 + 临时数据目录，不启用 Worker 与自动推进
export RUYI_DB_HOST=127.0.0.1 RUYI_DB_PORT=3306 RUYI_DB_USER=ruyi RUYI_DB_PASSWORD=ruyi RUYI_DB_NAME=ruyi_dev
export RUYI_STATE_KEY=$(cat /tmp/ruyi-dev-key 2>/dev/null || (node -e "process.stdout.write(require('crypto').randomBytes(32).toString('base64'))" | tee /tmp/ruyi-dev-key))
export RUYI_UPLOAD_DIR=/tmp/ruyi-dev-data RUYI_SERVER_PORT=5199 RUYI_SERVER_HOST=127.0.0.1
export RUYI_WORKER=${RUYI_WORKER:-off} RUYI_AUTO_ADVANCE=${RUYI_AUTO_ADVANCE:-off}
mkdir -p /tmp/ruyi-dev-data
exec node /Users/getui/playwright-upload/apps/server/src/main.js
```
