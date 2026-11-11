---
name: ruyi-audience
description: 如翼 / DataNexus 整任务操作手册；上传 idfa、oaid、pn 文件，自动创建人群包、洞悉、下载结果，或查询任务进度时使用，依赖 ruyi MCP。
---

# 如翼整任务

先调用 `get_overview` 检查平台登录与当前整任务。没有 ruyi 工具时，请用户在平台「API 令牌 → 接入 AI 工具」按接入说明配置；不要尝试绕过认证。
平台登录不是 valid 时，给出 platformLogin.loginUrl，等待用户本人登录，不反复重试。

每次上传会创建独立整任务，自动执行上传、创建人群包、洞悉和下载；同一用户先进先出、同时运行一个任务。
用户明确要求全流程时直接完成，无需逐阶段确认。用户只要求单独上传、创建或洞悉时，先解释新系统自动执行全流程，确认其是否接受，不擅自扩大授权。
已有运行任务不妨碍创建另一任务排队；同任务内文件名不能重复，跨任务可同名。每次上传是一个任务，不随意分批导致多个任务。

1. 只列出用户指定目录的普通文件名，筛选文件名包含 idfa、oaid 或 pn 且扩展名为 txt/csv 的非隐藏文件。不读取、预览或统计内容。
2. 调用 `prepare_upload`，使用一次性 uploadUrl，在一条 curl 中以多个 files 字段上传全部文件。可加 name 字段设置任务名；不把长期令牌写入 curl。链接有效期 10 分钟、只能使用一次。
3. 上传响应为 201，保留 taskId（也见 item.id），核对 item.fileCount / skipped。上传成功已自动入队，不调用旧单步骤执行工具。响应丢失先 `list_tasks` 核对，避免重复上传。
4. 用 `get_task` 查询，或循环 `wait_for_task`（单次最多 50 秒）。queued / running 继续等待；timedOut 不代表失败。平台尚未处理完成时保持 running，后台默认每 30 秒重试。
5. succeeded 后用 `prepare_download` 传整任务 taskId，curl 直接保存 ZIP 到用户指定目录。未指定目录先询问，不覆盖已有文件。下载后仅报告路径和文件元数据大小，不解压或读取结果内容，除非用户明确要求查看。

等待某阶段超过 30 分钟，汇报阶段并询问是否继续等待。
只问进度时只使用只读工具，不上传、不停止、不恢复。

## 状态与恢复

- waiting_login：给登录地址并停止等待；用户登录后明确要求恢复，才用 `resume_task`。说明它会恢复当前用户所有等待登录任务，confirm 传 true。
- interrupted：保留已完成步骤；用户明确要求后用 `continue_task`，从未完成步骤重新入队。
- failed / cancelled：说明原因与已完成范围，不自动重复创建或重新执行。
- `stop_task`：仅按用户明确指令停止；退出后为 interrupted，可以继续。
- `delete_task`：软删除非运行任务；运行任务需先停止。删除与停止是不同操作。
- `list_task_files`：查看原始文件名；`exclude_task_file` 仅在任务开始前移除，最后一个被移除会取消任务。
- `rename_task`：改名；写操作优先传查询到的 version，冲突则刷新，不盲目覆盖。

旧 list_jobs / get_job / wait_for_job / cancel_job 仅为整任务别名，其中 jobId 也必须传整任务编号。
run_task / set_auto_advance 已弃用，不能用它们执行旧工作区步骤。

不得读取或向模型传输人群文件与结果文件内容；不得输出令牌、登录态、凭据或票据原文。一次性地址仅用于 curl。日志只摘述必要且无敏感数据的原因，不替用户登录。

字段说明见 [references/workflow.md](references/workflow.md)，调用示例见 [references/examples.md](references/examples.md)。
