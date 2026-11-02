# MCP-4 Skill 与全流程说明

背景见 `docs/MCP_PLAN.md` 阶段 4。前置：MCP-1 ~ MCP-3 已完成。本任务以文档为主，代码改动只限于提供 Skill 下载。不要安装依赖。

Skill 是给 AI agent 看的“操作手册”：MCP 让 agent 能调用平台功能，Skill 告诉它在什么场景、按什么顺序、遵守哪些规则去调用。
Claude Code 从 `~/.claude/skills/<名称>/SKILL.md` 加载，Codex 从 `~/.codex/skills/<名称>/SKILL.md` 加载，格式相同。

## 1. Skill 内容

新建目录 `skills/ruyi-audience/`（仓库根），包含：

### `SKILL.md`
- frontmatter：
  ```yaml
  ---
  name: ruyi-audience
  description: |
    如翼 / DataNexus 人群包自动化平台操作手册。当用户要求上传 idfa / oaid / pn 人群包文件、
    创建人群包、做人群洞悉（分析）、下载洞悉结果，或询问人群包任务进度时使用。
    依赖已接入的 ruyi MCP 服务（工具 get_overview、prepare_upload、run_task、wait_for_job 等）。
  ---
  ```
- 正文（中文，简洁，面向模型）：
  1. **前置检查**：先调用 `get_overview`。若没有 ruyi 系列工具，告诉用户按 `docs/MCP_USAGE.md`（给出平台上的说明入口）接入后停止。
  2. **流程总览**：导入 → upload → 等平台处理 → create → 等平台生成人群 → analyse → 等洞悉结果 → download → prepare_download 取回 ZIP；说明每一步完成的判断依据（以 `get_overview` 的计数与 `check_platform` 的 ready 为准）。
  3. **导入文件**：确认用户给出的路径；用 shell 列出目录中**文件名**符合规则（含 idfa/oaid/pn，.txt/.csv）的文件，向用户确认清单后调用 `prepare_upload`，用一条 curl 上传全部文件。**只看文件名，绝不读取、预览、统计文件内容**（不要用 cat / head / wc 等）。文件很多时分批，每批重新获取地址。
  4. **提交任务**：每次 `run_task` 前用一句话告诉用户将做什么；用户已明确要求“跑完整个流程”时视为对后续常规步骤的授权，但遇到异常（任务失败、计数不符预期）必须停下来说明。
  5. **等待**：`run_task` 后循环调用 `wait_for_job` 直到结束。平台处理阶段（文件处理、生成人群、生成洞悉结果）通常需要几分钟到几十分钟：
     - 若自动推进已开启，平台就绪后会自动提交 create / analyse，agent 只需定期 `get_overview` 观察（间隔不少于 2 分钟）；
     - 若未开启，用 `check_platform` 判断是否就绪（间隔不少于 2 分钟），就绪后提交下一步；
     - 等待超过 30 分钟仍未就绪时，向用户汇报当前状态并询问是否继续等待，不要无限轮询。
     - 询问用户是否开启自动推进可减少等待操作；不要擅自修改自动推进设置。
  6. **下载结果**：download 任务结束后调用 `prepare_download`，用 curl 保存到用户指定目录（未指定时问用户），保存后告知文件路径与大小；不要解压并读取结果内容，除非用户明确要求查看。
  7. **异常处理表**：
     | 情况 | 处理 |
     |---|---|
     | 提示平台未登录 / 登录失效 | 把登录地址告诉用户，停止，等用户登录后再继续 |
     | 409 已有任务在运行 / 平台检查正在进行 | wait_for_job 当前任务，或 1–2 分钟后重试；不要连续重试 |
     | 任务 failed | 用 get_job 查看日志末尾，向用户说明原因；不要自动重复提交同一任务超过 1 次 |
     | 上传地址失效（404） | 重新 prepare_upload |
     | 令牌无效（401） | 让用户在平台「API 令牌」页面重新生成并更新 MCP 配置 |
  8. **禁止事项**：不读取或输出文件内容；不在回复中展示上传/下载地址以外的敏感信息；不尝试绕过平台登录；不取消不是本次对话提交的任务（除非用户要求）。
- 控制在 150 行以内。

### `references/workflow.md`
各阶段对应的工作区计数字段、自动推进阶段（idle / waitingFiles / readyCreate / waitingAudience / readyAnalyse / waitingResults / resultsReady / stalled / loginRequired）的含义与 agent 应对，取自 `apps/server/src/modules/auto-advance/engine.js` 的 PHASES。

### `references/examples.md`
两个完整示例的工具调用顺序：
1. “把 ~/Downloads/1030 里的文件跑完全流程，结果放到 ~/Desktop/results”。
2. “看看我的任务到哪一步了”。

## 2. 分发

- 新增只读接口 `GET /api/skill/ruyi-audience.zip`（Cookie 或令牌均可，加入令牌白名单），把 `skills/ruyi-audience/` 打包成 ZIP 返回（复用 `packages/shared/runtime/job-results.js` 中的 ZIP 写法，或在该文件导出一个通用的“把若干文件打成 ZIP 流”的函数；不新增依赖）。ZIP 内顶层目录为 `ruyi-audience/`。
- 「API 令牌」页面增加一节“接入 AI 工具”：
  1. 生成令牌；
  2. Claude Code / Codex 的 `mcp add` 命令（平台地址自动填入当前页面的 origin，令牌处显示占位符；刚创建令牌时可一键复制带真实令牌的命令）；
  3. 下载 Skill 并解压到 `~/.claude/skills/`（Claude Code）或 `~/.codex/skills/`（Codex）。
- 更新 `docs/MCP_USAGE.md` 与之一致。

## 3. 测试
- `npm test` 中新增对 `skills/ruyi-audience/SKILL.md` 的检查：frontmatter 含 name 与 description，正文提到的工具名都真实存在于 MCP 工具列表（从 mcp 模块导出工具名常量供测试读取）。
- ZIP 接口测试：Cookie 与令牌均可下载，内容含 `ruyi-audience/SKILL.md`；未登录 401。
- 前端测试：接入说明中的命令包含当前 origin + `/mcp`。

## 不要做
- 不改 MCP 工具行为（如发现工具需要调整，在总结中列出，不要直接改）。
- 不读 `.env`、`state-test.json`、`upload/`、`ruyi-profile/`。

## 完成标准
`npm test` 与 `npm run test:all` 全部通过；最后用中文列出改动文件、验证方式、未完成或不确定之处。
