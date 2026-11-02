# 字段与阶段判断

字段来自 MCP 的 `get_overview` / `check_platform`；自动推进阶段来自 `apps/server/src/modules/auto-advance/engine.js` 的 PHASES 与 decide。不要读取工作区内部文件来推断进度。

## 工作区计数

`get_overview.workspace` 只反映当前用户的工作区，不保证每次仅有本次导入的批次。开始前记录基线；有其他待办或数量异常时先说明。

| 字段 | 含义 | 下一步 / 完成依据 |
|---|---|---|
| `status` | 当前工作区阶段的中文提示 | 辅助展示，实际使用下列计数与平台 ready |
| `pendingUpload` | 尚需上传的文件数，含导入区和分类目录中尚未完成的文件 | 导入后核对增量；upload 成功后减少，并产生待创建项 |
| `createCount` | 待创建人群项数 | 大于 0 且 `ready.create:true` 才可手动 create；成功后核对该数减少、`analyseCount` 出现 |
| `analyseCount` | 待洞悉项数，已扣除进入待下载清单的项目 | 大于 0 且 `ready.analyse:true` 才可手动 analyse；成功后核对该数减少、`doneCount` 出现 |
| `doneCount` | 洞悉已提交、待下载项数，不表示平台结果已生成 | 大于 0 且 `ready.download:true` 或自动推进 `resultsReady` 才可 download |

文件数、人群项数与结果文件数未必一一相等；按阶段和本批预期核对，不能把所有计数机械地视为相同单位。下载任务 `succeeded` 后核对 `resultFiles`；通过 `prepare_download` 获取 `fileCount` / `size` 与 ZIP 地址并保存成功，才完成本地交付。

## 平台就绪

`check_platform` 返回如下字段，pending 均表示平台还未处理完成的数量：

| ready 字段 | 实际判断条件 |
|---|---|
| `ready.create` | 工作区 `createCount > 0`，且 `idfaPending + oaidPending + pnPending === 0` |
| `ready.analyse` | 工作区 `analyseCount > 0`，且 `insightPending === 0` |
| `ready.download` | 工作区 `doneCount > 0`，且 `resultPending === 0` |

部分平台检查失败会把三个 ready 全设为 false 并给出 message，不得把默认零当作就绪。结构化 ready 比固定中文摘要更可靠。
平台检查间隔至少 2 分钟；单阶段等待超过 30 分钟要汇报并询问是否继续。

## 自动推进

`get_overview.autoAdvance` 暴露 `enabled`、`phase`、`message`。只有开关为 true 才把 create / analyse 交由自动推进。
引擎按 `createCount → analyseCount → doneCount` 的优先级检查，不因同时存在多个阶段就跳到后面。

| phase | PHASES 含义 | agent 应对 |
|---|---|---|
| `idle` | 当前没有需要自动推进的任务 | 查看工作区与 activeJob；可能暂无待办，也可能历史待办缺少近期任务活动，不能据此宣称全部完成 |
| `waitingFiles` | 正在等待平台处理上传文件 | 至少间隔 2 分钟看概览；有 activeJob 先等任务 |
| `readyCreate` | 平台文件已就绪，正在创建人群包 | 后台会提交 create，观察 activeJob，不重复提交 |
| `waitingAudience` | 正在等待平台生成人群包 | 等待后台检查，不手动 analyse |
| `readyAnalyse` | 人群包已就绪，正在提交人群洞悉 | 后台会提交 analyse，观察 activeJob，不重复提交 |
| `waitingResults` | 正在等待洞悉结果生成 | 等待结果，不提前 download |
| `resultsReady` | 洞悉结果已就绪，请手动下载 | 后台停止探测；说明后手动提交 download |
| `stalled` | 平台状态长时间未变化，请手动检查 | 停止流程并报告，查看相关任务，等待用户决定 |
| `loginRequired` | 平台登录已失效，请重新登录 | 给出 platformLogin.loginUrl，停止并等用户登录 |
| `error` | 自动检查失败，稍后重试 | 汇报异常；不擅自补交任务或切换开关 |
| `paused` | 自动推进已关闭 | 手动检查 ready 后推进；只在用户同意后开启 |

MCP 还可能在未启用引擎时返回 `phase:"unavailable"`（不属于 PHASES），按未开启自动推进处理。
引擎默认约 5 分钟检查一次，仅对近期（默认 12 小时）相关任务活动推进；重复无变化会停止。agent 的 30 分钟询问规则独立于后台停滞阈值。

## 任务状态

`activeJob` 或 `run_task` 提供 `jobId`（概览中的任务对象用 `id`）；调用 `wait_for_job({jobId,timeoutSeconds:50})`，以返回的 `status` 判断。
`queued` / `running` 继续等待；`timedOut:true` 不等于失败；只有 `succeeded` 表示成功。其他终态停止并解释，可通过 `get_job` 的 `logTail` 查原因。
需要查找自动推进的任务时使用 `list_jobs`，按阶段与时间确认关联。`resultJob` 只是一项最近的有结果下载任务提示，可能是失败后的部分结果，必须核对它是否属于本批且成功。
