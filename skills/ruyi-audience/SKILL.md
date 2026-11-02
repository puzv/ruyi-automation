---
name: ruyi-audience
description: |
  如翼 / DataNexus 人群包自动化平台操作手册。当用户要求上传 idfa / oaid / pn 人群包文件、
  创建人群包、做人群洞悉（分析）、下载洞悉结果，或询问人群包任务进度时使用。
  依赖已接入的 ruyi MCP 服务（工具 get_overview、prepare_upload、run_task、wait_for_job 等）。
---

# 如翼人群包流程

## 前置检查

先调用 `get_overview`，读取工作区计数、`platformLogin`、`activeJob`、`autoAdvance` 与下一步建议。
若没有 ruyi 系列工具，告诉用户打开平台「API 令牌 → 接入 AI 工具」（`<平台地址>/#/api-tokens`），按 `docs/MCP_USAGE.md` 接入后停止。
平台状态不是 `valid` 时给出返回的 `platformLogin.loginUrl`，等待用户亲自登录后再继续。
已有排队或运行任务时先等待，不重复导入或提交；只问进度时只用只读工具并报告当前阶段。
字段、阶段及完成条件见 [references/workflow.md](references/workflow.md)；完整调用示例见 [references/examples.md](references/examples.md)。

## 标准流程与授权

导入 → upload → 等平台处理文件 → create → 等平台生成人群 → analyse → 等洞悉结果 → download → prepare_download 取回 ZIP。
用户要求“跑完整个流程”或类似表述时，直接按流程执行各步骤，不需要每步征求确认或事先说明；在上传完成、各任务完成、结果保存等关键节点简要汇报进度即可。
用户只要求单个步骤时，只做该步骤，不自动继续后续步骤。
只有出现任务失败、计数与预期不符、工作区已有其他批次待办、等待超过 30 分钟、文件清单中有不合规文件需要用户取舍等异常时，才停下说明并询问，不把异常当作继续执行的授权。

1. **导入文件**：确认用户路径，只用 shell 列出普通文件的文件名，筛选名称含 idfa / oaid / pn 且扩展名为 .txt / .csv（大小写不敏感、排除点开头文件）。按筛选清单直接调用 `prepare_upload`；不合规文件被跳过时在汇报中说明，需要用户取舍时先停下询问。
   只看文件名，绝不读取、预览或统计文件内容，不使用 cat / head / wc 等内容命令。
   用返回的 `uploadUrl` 在一条 curl 中以多个 `-F 'files=@绝对路径'` 上传全部文件，正确转义路径；不要把长期令牌加进 curl。
   文件很多时分批，每批重新获取地址；地址 10 分钟有效且只能用一次。检查导入响应 `count` / `skipped`，与筛选清单不符时停止说明并询问。
2. **上传平台**：重新 `get_overview`，确认 `workspace.pendingUpload` 的变化符合导入结果，调用 `run_task({task:"upload"})`。
   取得 `jobId` 后循环 `wait_for_job`（单次最多 50 秒）；`timedOut:true` 只是仍在执行。
   只有 `status:"succeeded"` 才是任务成功，随后核对概览中待上传减少、待创建出现；其他终态必须处理后再继续。
3. **创建**：`workspace.createCount > 0` 仅代表有待办。未开自动推进时，等 `check_platform` 的 `ready.create:true`，提交 `run_task({task:"create"})` 并等待成功；再核对待创建减少、待洞悉出现。
4. **洞悉**：`workspace.analyseCount > 0` 时等 `ready.analyse:true`，提交 `run_task({task:"analyse"})` 并等待成功；再核对待洞悉减少、待下载出现。
5. **下载**：`workspace.doneCount > 0` 时等 `ready.download:true`（或自动推进 `phase:"resultsReady"`），提交 `run_task({task:"download"})` 并等待成功，核对 `resultFiles` 和最新工作区状态。
   若概览已有本批下载的 `resultJob`，先核对任务与产物，避免重复下载；失败任务虽可能有部分结果，不能声称全流程成功。

## 平台等待与自动推进

平台处理文件、生成人群、生成洞悉结果通常需几分钟到几十分钟；本地任务成功不代表平台已就绪。
自动推进已开启时，平台就绪后后台会自动提交 create / analyse：只需定期 `get_overview`，间隔不少于 2 分钟；有 `activeJob` 时用 `wait_for_job`，不要重复提交或额外频繁检查平台。
自动推进不会上传或下载；`resultsReady` 后仍需提交 download。
未开启时用 `check_platform` 判断就绪，两次调用间隔不少于 2 分钟。以结构化 `ready` 为准，不因待处理数为零或摘要文字就自行推定成功。
等待一个平台阶段超过 30 分钟仍未就绪，汇报当前计数、阶段及任务并询问是否继续等待，不无限轮询。
可询问用户是否开启自动推进以减少等待操作；未经同意不要调用 `set_auto_advance` 修改设置。出现 stalled / error 时说明异常，不用开关重置来绕过问题。

## 保存结果

download 成功后调用 `prepare_download({jobId:"下载任务 ID"})`，用返回的 `downloadUrl` 配合 curl 保存到用户指定目录；未指定目录先询问。
例如 `curl -sS -fL -o '/绝对目录/ruyi-results-任务ID.zip' '<downloadUrl>'`；先确认目录存在，不覆盖用户已有文件。
保存成功后仅通过文件元数据取得大小，告知绝对路径与大小。不要解压或读取结果内容，除非用户明确要求查看。

## 异常处理

| 情况 | 处理 |
|---|---|
| 平台未登录 / 登录失效 | 给出登录地址并停止，用户登录后再继续 |
| 409 已有任务运行 / 平台检查正在进行 | 对当前任务用 `wait_for_job`，或等待 1–2 分钟后再检查；平台检查之间至少 2 分钟，不连续重试 |
| 任务 failed | 用 `get_job` 看 `logTail`，说明原因并停止；未经用户确认不重提，同一任务自动重复提交不得超过 1 次 |
| 上传地址失效（404） | 重新 `prepare_upload`；其他传输失败也先核对概览，避免重复导入已成功文件 |
| 令牌无效（401） | 让用户在平台「API 令牌」页重新生成并更新 MCP 配置 |
| 任务 cancelled / interrupted 或数量异常 | 汇报状态与已完成范围，等待用户决定，不继续下一阶段 |

## 禁止事项

- 不读取、输出、转述人群文件内容，不把内容传给模型或工具；只允许 curl 直接传输。
- 不在回复中展示上传 / 下载地址以外的敏感信息，不输出令牌、票据原文或平台登录态；日志仅摘述不含敏感数据的必要原因。
- 不尝试绕过平台登录，不替用户登录。
- 不取消非本次对话提交的任务，除非用户明确要求；`cancel_job` 前说明影响。
