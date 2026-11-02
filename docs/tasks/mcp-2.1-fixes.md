# MCP-2 修复（Claude 审核发现）

在 MCP-2 基础上修改，不新增依赖。

1. **`get_overview` 在自动推进关闭时整体失败**：服务以 `RUYI_AUTO_ADVANCE=off` 启动时 `/api/auto-advance` 路由不存在（404），`get_overview` 因此直接报错。修复：
   - `get_overview` 中自动推进接口返回 404 时视为 `{ enabled:false, phase:'unavailable', message:'服务未启用自动推进' }`，其余流程照常；`nextStep` 中按“未开启”处理。
   - 同时把令牌白名单检查移到路由不存在判断之后：令牌访问不存在的 `/api/*` 路由应返回 404「接口不存在」，而不是 403（Fastify 中未匹配路由的 `routeOptions.url` 为 undefined，可据此放行给后面的 404 处理）。白名单仍然只对已注册的路由生效，补测试：令牌访问 `/api/not-exist` → 404。
2. **`nextStep` 文案**：MCP-3 会提供写工具，本阶段文案保留“在网页…”即可，但请把 `get_overview` 中 `nextStep` 的规则抽成独立函数 `decideNextStep(workspace, platform, active, auto)` 并导出，便于 MCP-3 修改与测试；为它补充覆盖 7 个分支的单元测试（放进 `test/mcp-tools.test.js`）。
3. **工具描述过于简略**：模型主要依赖 description 决定何时调用。按下表改写（中文）：
   - `get_overview`：查看当前用户的人群包工作流进度（待上传、待创建、待洞悉、待下载数量）、平台登录状态、正在运行的任务和自动推进状态，并给出下一步建议。开始任何操作前先调用。
   - `check_platform`：启动浏览器访问如翼平台，核对已上传文件、人群包、洞悉结果在平台上是否已就绪。耗时 10 秒到数分钟，两次调用至少间隔 1 分钟；只在需要判断能否进行下一步时调用。
   - `list_jobs`：分页列出当前用户提交过的任务（上传、创建、洞悉、下载）及状态。
   - `get_job`：查看单个任务的状态和日志末尾，用于了解任务失败原因。
   - `wait_for_job`：等待任务结束，单次最多 50 秒；返回 timedOut=true 表示仍在进行，可再次调用。
4. `test/mcp.test.js` 第 95 行请求头里的 user-agent 已由 Claude 改为 ASCII（`fetch` 不允许非 Latin-1 请求头），保留该修改。

完成后运行 `npm test`（数据库测试若沙箱无法连接，说明即可，Claude 会复验）。最后用中文列出改动文件、验证方式、未完成或不确定之处。
