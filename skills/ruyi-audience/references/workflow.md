# 整任务字段和状态

上传一次性地址 POST 成功返回 201：
`{ ok: true, taskId, item: { id, name, status: "queued", currentStep: "upload", version, fileCount, skipped } }`。
一个上传批次对应一个整任务编号，目录、清单和后续结果按任务隔离。已自动入队，不需要再逐个提交流程。

get_overview 返回 platformLogin、tasks（最近 20 个）、total、automatic 和 nextStep；全部任务用 list_tasks 分页。
get_task 返回 id / taskId、name、status、currentStep、version、nextCheckAt、errorMessage、最近 50 条 jobs、jobCount，及最新子流程日志末尾 logTail（最多 8KB）。
wait_for_task 不读取日志；超时返回 timedOut=true，只有 queued / running 继续等待。

| status | 含义与操作 |
|---|---|
| queued | 等待用户 FIFO 队列调度 |
| running | 正在推进或等待外部平台；后台默认 30 秒检查一次 |
| waiting_login | 用户统一等待登录；本人重新登录并明确恢复后 resume_task |
| interrupted | 已停止或服务中断；明确要求后 continue_task 继续未完成步骤 |
| succeeded | 四个步骤完成，可 prepare_download |
| failed | 真正失败，说明原因，不自动重新创建 |
| cancelled | 取消，例如移除最后一个文件；不自动重试 |

currentStep 是 upload / create / analyse / download。某轮子流程 waiting_platform 表示平台还在计算，不代表整任务失败。
check_platform 仅检查保存的登录状态；每个任务由 Worker 自动检查自己的平台进度，不返回旧全局工作区 ready 数量。
get_task 的 jobs 仅包含明确关联的本任务子流程。不能拿子流程编号当作 taskId；prepare_download 始终按整任务找最近成功 download 子流程并绑定一次性票据。

stop / continue / rename / delete / exclude 支持 version；查询后提交版本可防止并发覆盖。resume_task 恢复该用户所有等待登录任务，必须说明此范围。
票据在使用时再次验证有效用户、归属、登录（上传）或未删除成功整任务（下载），失效后不能复用。
