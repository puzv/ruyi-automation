# MCP-6 验收反馈修正

用户验收中提出 / 发现的问题，不新增依赖、不改迁移。

## 1. 操作记录全部显示中文（用户要求）

`apps/web/src/labels.js`：
- `actionLabels` 补充 MCP 新增的动作：`token.create` → `生成 API 令牌`，`token.revoke` → `吊销 API 令牌`，`job.results_download` → `下载任务结果`。
- `targetLabels` 补充：`api_token` → `API 令牌`。
- `logDescription`：
  - `detail.via === 'api_token'` 时在说明末尾追加 `（AI 工具）`；`detail.via === 'transfer_ticket'` 时追加 `（AI 工具 · 一次性链接）`。例如「上传文件（AI 工具）」「导入 1 个，跳过 0 个（AI 工具 · 一次性链接）」。
  - `token.create` 显示 `名称：<name>，有效期 <expiresInDays> 天`。
  - `job.results_download` 显示 `下载结果 ZIP`（再按上条追加来源）。
- 检查服务端所有写入 `ruyi_operation_logs` 的 action（`grep -rn "action" apps packages scripts`），确保每一个都在 `actionLabels` 中有中文名称，界面上不再出现英文动作编码；列表与下拉筛选都用这份映射。
- 补充 `test/` 中前端标签测试（新建或放入已有前端测试）：遍历服务端出现的全部 action 编码，断言均有中文标签；断言上述几种说明文案。

## 2. MCP 服务说明强化“不读内容”

验收中发现：未安装 Skill 时，AI 下载结果后用 python 打开了 ZIP 内的文件读取内容。
`apps/server/src/modules/mcp/routes.js` 的 `instructions` 中，把“不读取内容”扩展为：不得以任何方式（cat、head、python、解压后打开等）读取、预览或统计**人群包文件和下载的结果文件**的内容；下载完成后只报告保存路径与文件大小，除非用户明确要求查看结果。
`prepare_download` 的返回文案同步加上“下载后不要解压或打开查看，只报告路径和大小”。
同步更新 `test/mcp.test.js` 中对 instructions 要点的断言。

## 3. Skill：明确跑全流程时无需逐步确认（用户偏好）

用户反馈 AI 跑全流程时不逐步确认、直接执行更顺畅。修改 `skills/ruyi-audience/SKILL.md`「标准流程与授权」：
- 用户要求“跑完整个流程”或类似表述时，直接按流程执行各步骤，**不需要每步征求确认或事先说明**，在关键节点（上传完成、各任务完成、结果保存）简要汇报进度即可。
- 只有在异常情况下才停下询问：任务失败、计数与预期不符、工作区已有其他批次待办、等待超过 30 分钟、文件清单中有不合规文件需要用户取舍。
- 用户只要求单个步骤时，只做该步骤，不自动继续后续步骤。
相应调整第 1–5 步中“说明后提交”“向用户确认清单后”等措辞（不合规文件被跳过时在汇报中说明即可）。同步 `references/examples.md`。
`test/skill.test.js` 若有相关断言一并更新。

## 完成标准
`npm test` 通过（沙箱阻塞浏览器/数据库测试时请说明）；最后用中文列出改动文件、验证方式、未完成或不确定之处。
