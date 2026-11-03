# 如翼 MCP 接入

MCP 配合 ruyi-audience Skill 提供完整流程指引。当前提供 10 个工具：工作区概览、平台检查、任务列表、任务详情、等待任务，以及 prepare_upload、run_task、cancel_job、set_auto_advance、prepare_download。文件使用一次性地址配合 curl 直接传输，不经过模型。

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
4. 在 agent 中问：“如翼平台现在进行到哪一步了？”。应先获得工作区概览，再按建议查看任务。

平台登录只能由用户本人在网页完成。若工具提示未登录，请打开返回的 `/#/platform-login` 地址完成登录，再继续；不要让 agent 反复重试。平台检查会访问外部平台，较慢，两次检查至少间隔 2 分钟。等待任务单次最多 50 秒，未结束可以再次等待。

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

完整对话示例：用户说“把 ~/data 里的文件跑完全流程，结果保存到 ~/Downloads”。AI 预期按以下顺序操作：

1. 调用 `get_overview`。未登录时提示用户打开返回的登录页并停止，登录后再继续；已有任务时先 `wait_for_job`。
2. 只列出 ~/data 下文件名，筛选名称含 idfa、oaid 或 pn、扩展名为 .txt 或 .csv 的文件；不读取、预览或统计内容；先向用户确认清单。
3. 调用 `prepare_upload`，用返回的上传地址执行一条 curl 命令，为每个文件添加 `-F "files=@路径"`。链接有效期 10 分钟，只能用一次；文件很多时分批，每批重新获取。核对导入响应 count / skipped，不符预期时停止说明。失败后先核对概览，避免重复导入已成功文件。
4. 向用户说明将上传文件到平台，调用 `run_task({task:"upload"})`，再用 `wait_for_job` 等待结束。
5. 间隔至少 2 分钟调用 `check_platform`，确认 `ready.create` 后说明将创建人群包，调用 `run_task({task:"create"})` 并等待。
6. 等待平台生成人群，`check_platform` 确认 `ready.analyse` 后说明将提交洞悉，调用 `run_task({task:"analyse"})` 并等待。
7. 等待平台生成结果，`check_platform` 确认 `ready.download` 后说明将下载结果，调用 `run_task({task:"download"})` 并等待。
8. 调用 `prepare_download({jobId:"下载任务 ID"})`，用返回地址执行 `curl -sS -fL -o ~/Downloads/ruyi-results-<jobId>.zip '<downloadUrl>'`，先确认目录且避免覆盖已有文件；保存后只用文件元数据取得大小，报告绝对路径与大小，不解压或读取内容。用户未指定保存目录时先询问。

每次 run_task 前说明操作。用户明确要求“跑完整个流程”视为后续常规步骤授权；客户端仍可能显示工具批准提示。任务只有 succeeded 才算成功，timedOut:true 表示仍在执行；每次成功后核对工作区计数变化。失败、其他非成功终态、数量异常时停止说明，等待用户决定，不擅自重复提交。工作区 createCount / analyseCount / doneCount 仅代表待办，平台 ready 才是就绪依据。

自动推进已开启时，先根据 `get_overview` 和任务列表判断当前进度，避免重复提交；每隔至少 2 分钟查看概览，后台自动提交 create / analyse，出现 activeJob 时等待，resultsReady 后手动提交 download。自动推进不会自动上传或下载结果；未经用户同意不要修改开关。409 冲突应等待已有任务结束后重新检查。可用 `cancel_job` 取消任务，`set_auto_advance` 开关自动推进。所有工具参数和对话均不得包含文件内容，也不要将长期 API 令牌写进传输命令。

平台处理文件、生成人群、生成洞悉结果通常需几分钟到几十分钟。单阶段等待超过 30 分钟仍未就绪时，汇报当前状态并询问是否继续，不无限轮询。上传地址失效（404）重新 prepare_upload；令牌无效（401）请在 API 令牌页重新生成并更新配置。不要取消非本次对话提交的任务，除非用户明确要求。只问进度时只查询并汇报，不提交任务或改设置。

Claude Code / Codex 的真实连接与平台全流程需在可访问平台的环境验收，文档及自动化测试不能替代实际联调。
