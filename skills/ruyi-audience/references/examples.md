# 工具调用示例

以下是顺序示例，jobId 与一次性地址必须取自实际返回；不展示任何真实令牌或数据内容。用户要求跑完整个流程时直接执行，无需逐步确认或事先说明，仅在关键节点简要汇报；只要求单个步骤时只执行该步骤。全流程授权不包含异常重试或修改自动推进设置。

## 1. “把 ~/Downloads/1030 里的文件跑完全流程，结果放到 ~/Desktop/results”

1. `get_overview({})`：检查登录、已有任务、工作区基线、自动推进设置。未登录就给出 `platformLogin.loginUrl` 并停止；有其他批次待办时停下说明并询问。
2. 展开并确认源目录和目标目录，仅列文件名（例如 `find "$HOME/Downloads/1030" -maxdepth 1 -type f -print`）。筛选名称含 idfa / oaid / pn、扩展名 .txt / .csv、非点开头的普通文件，直接使用筛选清单；跳过的不合规文件在汇报中说明，需要用户取舍时才停下询问。不读取或统计内容。
3. `prepare_upload({})` → 取 `uploadUrl` → 一条 shell curl 直接上传清单里的全部文件：

   ```sh
   curl -sS -f -F "files=@$HOME/Downloads/1030/a_pn.txt" -F "files=@$HOME/Downloads/1030/b_oaid.csv" '<uploadUrl>'
   ```

   核对导入响应 count / skipped；分批时每批重新 prepare_upload，不重用地址。
4. `get_overview({})` 核对待上传增量。`run_task({task:"upload"})` → 取 upload 的 jobId → 循环 `wait_for_job({jobId:"实际上传任务 ID",timeoutSeconds:50})`，直到 succeeded。上传完成后简要汇报进度；其他终态停下说明并询问。
5. 以下按自动推进**未开启**示例：`get_overview({})` 检查 `createCount`，每隔至少 2 分钟 `check_platform({})`，直到 `ready.create:true`。`run_task({task:"create"})` → 循环 `wait_for_job` 到 succeeded → `get_overview` 核对计数变化并简要汇报任务完成。
6. 每隔至少 2 分钟 `check_platform({})`，直到 `ready.analyse:true`。`run_task({task:"analyse"})` → 循环 `wait_for_job` 到 succeeded → `get_overview` 核对计数变化并简要汇报任务完成。
7. 每隔至少 2 分钟 `check_platform({})`，直到 `ready.download:true`。`run_task({task:"download"})` → 循环 `wait_for_job` 到 succeeded，检查 resultFiles 和概览并简要汇报任务完成。
8. `prepare_download({jobId:"实际下载任务 ID"})` → 取 downloadUrl。确认目标目录并避免覆盖，直接保存：

   ```sh
   mkdir -p "$HOME/Desktop/results"
   curl -sS -fL -o "$HOME/Desktop/results/ruyi-results-实际任务ID.zip" '<downloadUrl>'
   ```

   只用文件元数据检查存在与大小，告知绝对保存路径和字节数；不解压、不预览结果。

若第 1 步发现自动推进**已开启**，第 5–6 步改为每隔至少 2 分钟 `get_overview`，后台自动提交 create / analyse；发现 activeJob 时对其 id 用 `wait_for_job`，核对成功与计数，不重复 run_task。到 autoAdvance.phase 为 resultsReady 后执行第 7 步的手动 download，再保存 ZIP。
任一平台等待阶段超过 30 分钟未就绪，报告当前阶段与计数并问是否继续；任一任务失败或数量异常，停下说明并询问，不自动继续。

## 2. “看看我的任务到哪一步了”

1. `get_overview({})` 获取 workspace、platformLogin、activeJob、autoAdvance、nextStep。
2. 有 activeJob：`get_job({jobId:"activeJob.id 的实际值"})` 查询任务状态；用户只问进度，无需阻塞等待任务结束。
3. 没有 activeJob 但需确认最近完成 / 失败任务：`list_jobs({page:1,pageSize:10})`，必要时 `get_job({jobId:"实际任务 ID"})` 查日志末尾。
4. 自动推进未开启且计数指向平台等待、需要实时确认时才 `check_platform({})`；距上次检查不足 2 分钟就沿用已知信息并标明尚未重新检查，不连续调用。
5. 汇报当前阶段、待办数量、运行任务与下一步。例如“洞悉已提交，待下载 3 项，平台仍有 1 项结果生成中；自动推进已关闭”。不据此提交任务、导入文件或更改设置。
6. 登录失效就给出登录地址并停止；任务失败仅说明原因与可选下一步，等待用户明确要求后再处理。
