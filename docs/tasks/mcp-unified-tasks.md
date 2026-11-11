# MCP 统一整任务

MCP 与网页共用 `/api/tasks`、任务队列和文件隔离；不修改表结构。上传一次性票据消费时调用 `createFromMultipart`，在接收前后复查平台登录，返回 HTTP 201、taskId 与 item。上传成功已自动入队，自动执行 upload / create / analyse / download；同用户可以同时提交多组任务，按 FIFO 顺序运行。

新增 list_tasks / get_task / wait_for_task / stop_task / continue_task / resume_task，以及文件清单、排除、改名和软删除工具。写操作沿用版本检查及网页 API，管理员接口不开放给令牌。resume_task 仍沿用网页语义，恢复该用户所有等待登录任务，必须告知范围并明确恢复。

旧 list_jobs / get_job / wait_for_job / cancel_job 为整任务别名，jobId 必须传整任务编号。run_task 和 set_auto_advance 只返回弃用说明，不提交旧独立流程，不修改旧自动推进配置。get_overview 不再读取旧工作区；check_platform 只报告登录，平台进度由各任务自动检查。

get_task 返回最近 50 条子流程与 jobCount，可附最新子流程日志末尾 8KB；等待轮询不读取日志。下载要求整任务成功、本人所属且未软删，票据仍绑定该任务最近成功 download 子流程，无需修改票据表。消费下载票据再次检查任务归属、状态和软删除。

验证使用真实 MCP SDK、真实 Fastify 路由与 multipart，内存仓储和伪造文件；不读取真实数据，不改数据库结构，不删除操作记录。测试覆盖 schema、令牌权限、跨用户、状态等待、继续/停止请求、票据单次/失效、跨任务同名文件隔离。`ruyi_test` 缺少整任务表，本次不宣称完成真实 MySQL 整任务集成或外部平台全流程验收。
