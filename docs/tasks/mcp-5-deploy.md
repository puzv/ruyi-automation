# MCP-5 部署准备

背景见 `docs/MCP_PLAN.md` 阶段 5。前置：MCP-1 ~ MCP-4 已完成。不要安装依赖，不要执行 Docker / kubectl，不要执行迁移。

## 1. 镜像构建上下文包含 Skill

`deploy/scripts/build-context.js` 的 `allowed()` 白名单（新布局）当前不包含仓库根的 `skills/`，镜像中将缺少 Skill 文件，`/api/skill/ruyi-audience.zip` 会 500。
- 新布局下允许 `skills/ruyi-audience/` 下的 `.md` 文件（只允许这个目录与扩展名，写成精确正则）。
- `deploy/test/container-preparation.test.js` 补充：`skills/ruyi-audience/SKILL.md`、`skills/ruyi-audience/references/workflow.md` 被允许；`skills/other/x.md`、`skills/ruyi-audience/a.js`、旧布局下的 skills 文件被排除。
- 同时检查 `apps/server/src/modules/skill/routes.js`：文件缺失时应返回 503 `{ ok:false, message:'Skill 文件不可用，请联系管理员' }`，而不是抛出 500 原始错误；补测试。

## 2. K8s 配置

`deploy/k8s/ruyi-upload-dashboard.yaml`（当前在用的配置）：
- 新增环境变量 `RUYI_PUBLIC_URL`，值写占位 `https://<平台对外地址>`，上方注释说明：MCP 工具生成的登录地址、一次性上传/下载地址都基于它，必须是同事电脑可访问的 HTTPS 地址，末尾不带 `/`。
- 不改其他字段。

## 3. 文档

`deploy/README.md` 末尾新增「MCP 接入上线检查」一节（中文，简洁）：
1. 远程库执行迁移 007（`ruyi_api_tokens`）、008（`ruyi_transfer_tickets`）：先 `node scripts/migrate.js plan` 核对 SQL，再由负责人执行 `up`（需输入库名确认）。
2. 设置 `RUYI_PUBLIC_URL`。
3. 网关/Ingress：`/mcp` 与 `/api/transfer/` 需放行；读超时 ≥ 60 秒（`wait_for_job` 最长 50 秒）；请求体上限 ≥ 预期最大上传文件（应用自身单文件上限 1GB）；`/mcp` 需透传 `Authorization` 请求头。
4. 上线后自检：`curl -s -o /dev/null -w '%{http_code}' -X POST https://<地址>/mcp` 应为 401；在网页生成令牌后按 `docs/MCP_USAGE.md` 接入并调用 `get_overview`。

## 完成标准
`npm test`（若沙箱阻塞浏览器测试请说明）与 `node deploy/test/container-preparation.test.js` 通过；最后用中文列出改动文件、验证方式、未完成或不确定之处。
