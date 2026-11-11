# 如翼 MCP 接入

MCP 与网页共用整任务系统：每次上传创建独立任务，自动完成上传、创建人群包、洞悉和下载。主要工具为 get_overview、list_tasks、get_task、wait_for_task、prepare_upload、prepare_download、stop_task、continue_task、resume_task，另提供文件清单、改名与删除。文件使用一次性地址配合 curl 直接传输，不经过模型。

本地正常开发环境可使用 `http://localhost:5173/mcp`（Vite 会将 `/mcp` 与 `/api` 代理到后端默认 5174）；也可直连 `http://localhost:5174/mcp`。网页复制的连接命令使用当前页面地址，因此从 5173 打开页面时无需手动改成 5174。生产环境使用平台实际 HTTPS 地址。

1. 登录平台，在「API 令牌」页面生成个人令牌并妥善保存。平台地址应使用同事电脑可访问的 HTTPS 地址。
2. 在 Claude Code 中接入（替换平台地址和令牌）：

   ```sh
   claude mcp remove ruyi --scope user 2>/dev/null; claude mcp add --transport http --scope user ruyi '<平台地址>/mcp' --header 'Authorization: Bearer <令牌>'
   ```

3. 在 Codex 中接入：

   ```sh
   codex mcp remove ruyi 2>/dev/null; mkdir -p ~/.codex && printf '\n[mcp_servers.ruyi]\nurl = "%s"\nhttp_headers = { Authorization = "Bearer %s" }\n' '<平台地址>/mcp' '<令牌>' >> ~/.codex/config.toml && chmod 600 ~/.codex/config.toml
   ```

   命令只需执行一次，配置会永久保存在本机；Codex 会将令牌写入 `~/.codex/config.toml`。令牌到期或吊销后，生成新令牌并重新执行同一条命令即可。平台地址末尾不要重复添加斜杠。

   检查是否接入成功：`claude mcp list` 或 `codex mcp list` 中出现 ruyi。
4. 在 agent 中问：“如翼平台现在进行到哪一步了？”。应先获得整任务概览，再按建议查看任务。

平台登录只能由用户本人在网页完成。若工具提示未登录，请打开返回的 `/#/platform-login` 地址完成登录，再继续；不要让 agent 反复重试。check_platform 只查看登录态；每个整任务自行检查平台进度，未就绪默认每 30 秒重试。等待任务单次最多 50 秒，未结束可以再次等待。

令牌等同于账号凭据，不要提交到代码仓库或分享；留意终端历史与客户端配置中的令牌。泄露后立即在网页吊销并重新生成。工具不会提供人群包文件内容，请勿要求 agent 读取设备号、手机号等数据。


## 安装 Skill

在平台「API 令牌 → 接入 AI 工具」（`<平台地址>/#/api-tokens`）复制接入命令并下载 Skill。命令自动使用当前页面的 origin；刚创建令牌时可复制带真实令牌的命令。下载接口为 `GET /api/skill/ruyi-audience.zip`，支持 Cookie 或 API 令牌认证。

假设浏览器保存为 `~/Downloads/ruyi-audience.zip`，选择对应客户端安装：

```sh
# Claude Code
mkdir -p ~/.claude/skills && unzip -o ~/Downloads/ruyi-audience.zip -d ~/.claude/skills/
```

```sh
# Codex
mkdir -p ~/.codex/skills && unzip -o ~/Downloads/ruyi-audience.zip -d ~/.codex/skills/
```

ZIP 内顶层为 `ruyi-audience/`。最终文件应是 `~/.claude/skills/ruyi-audience/SKILL.md` 或 `~/.codex/skills/ruyi-audience/SKILL.md`，不要额外嵌套一层目录。重新进入客户端会话加载 Skill；安装 Skill 不代替 MCP 接入。

仓库源文件见 [SKILL.md](../skills/ruyi-audience/SKILL.md)、[字段与阶段](../skills/ruyi-audience/references/workflow.md)、[完整调用示例](../skills/ruyi-audience/references/examples.md)。

## 完整流程

用户说“把 ~/data 里的文件跑完全流程，结果保存到 ~/Downloads”，AI 应：

1. get_overview 确认平台登录。未登录就提示本人打开登录页，并停止重试。
2. 仅列出文件名与元数据，筛选普通、非隐藏、名称含 idfa / oaid / pn 且扩展名为 txt/csv 的文件，不读取内容。
3. prepare_upload 获取 10 分钟一次性地址；一条 curl 添加所有 files 字段，可附 name 字段。上传成功返回 201、taskId、item.fileCount 与 skipped。此时已创建整任务并自动入队，不再 run_task。
4. get_task 查看或 wait_for_task({taskId,timeoutSeconds:50}) 等待。queued / running 可继续等，timedOut 不代表失败。平台未就绪时后台自动等待，不能当作失败重提。
5. 整任务 succeeded 后 prepare_download({taskId})，curl 保存 ZIP 到指定目录，不覆盖已有文件；只报告路径与元数据大小，不解压或读取内容，除非用户明确要求。

同用户可提交多个任务排队，文件按任务隔离，跨任务同名不会互相冲突；同一个任务内文件名不能重复。响应丢失先 list_tasks 核对，避免重复创建。
用户只要求单独上传或洞悉时，应解释新系统自动执行全流程，确认是否接受；不得偷偷扩大到全流程。用户已明确全流程则无需逐阶段确认。

waiting_login 时告知用户重新登录；本人明确恢复后 resume_task({taskId,confirm:true})，会恢复该用户所有等待登录任务。
interrupted 时可在明确要求后 continue_task({taskId,version}) 从未完成步骤入队。stop_task 停止后为已中断，可继续；delete_task 软删除非运行任务，运行中先停止。failed / cancelled 不盲目重建。

旧 list_jobs / get_job / wait_for_job / cancel_job 仅为整任务别名，jobId 也必须传整任务 taskId。run_task / set_auto_advance 已弃用，不再执行旧工作区步骤。旧独立 jobs 不出现在新任务概览中，不猜测其整任务归属。

任务详情仅返回最近 50 条流程及 jobCount，日志末尾最多 8KB并隐藏凭据和工作区路径。单阶段等待超过 30 分钟需汇报并询问是否继续；只问进度时仅查询，不提交或恢复任务。
一次性地址失效需重新获取；令牌无效请在 API 令牌页更新配置。长期令牌不可写入传输 curl，不读取人群文件或结果内容。

已安装旧版 Skill 的客户端，请重新下载 ZIP 覆盖安装并重新进入会话，否则旧指引会调用已弃用工具。
自动化测试不替代外部平台真实联调；当前变更与测试限制见 [MCP 整任务契约](tasks/mcp-unified-tasks.md)。
