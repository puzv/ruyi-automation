# 脚本运行流程说明

## 1. 总体流程

整套脚本把任务拆成四个有状态阶段，通过目录文件和 JSON 清单交接，因此中断后可从上次成功位置继续：

```text
raw/*
  -> uploadAll.js
     -> 清理 occupation、生成 createGroupToDoList.json
     -> move.js 按 idfa/oaid 分目录
     -> upload.js（每批最多 5 个，成功后移入 */done/）
  -> createAllGroup.js -> createGroup.js
     -> 选择上传文件、填写人群信息、提交
     -> 成功写入 analysetodolist.json，移除创建清单项
  -> analyseAll.js -> analyse.js
     -> 选择人群包、填写任务名、设置固定筛选、提交
     -> 确认跳转后写入 done.json，移除分析清单项
  -> downloadAll.js -> download.js
     -> 结果页逐页查找/搜索、点击下载
     -> 有效下载保存 result/，从 done.json 删除
```

## 2. 各脚本职责

### `uploadAll.js`

上传阶段编排器：预处理 `raw/`、生成创建清单、调用 `move.js`，然后串行启动 `upload.js`。每次子进程结束都重新扫描待上传文件；数量不下降就停止，避免无限循环。

### `move.js`

纯文件操作：扫描 `raw/`，文件名含 `idfa` 移入 `idfa/`，含 `oaid` 移入 `oaid/`，其他跳过；目标已存在时不覆盖。不访问网络，也不写 JSON。

### `upload.js`

使用持久化 Playwright Chrome 打开数据平台导入页，最多选择 5 个文件，等待每个文件出现上传成功提示，等待提交按钮可用后提交并在必要时重试最多 10 次。确认跳转到如翼人群页面后才移动文件。`uploadAll.js` 会再次启动它处理另一种类型。

### `createAllGroup.js` / `createGroup.js`

前者循环并检查清单是否减少，后者完成单项页面交互：按关键字选择 IDFA/OAID 地址，从清单匹配文件（兼容带/不带扩展名），勾选文件，填写名称和描述，提交后更新两个清单。

### `analyseAll.js` / `analyse.js`

前者循环 `analysetodolist.json` 并排除已在 `done.json` 的项目；后者选择人群包、填任务名、设置固定筛选，只有 URL 跳转到指定成功页面才记录完成。

### `downloadAll.js` / `download.js`

前者按 `done.json` 循环；后者在结果页逐页查找任务，必要时搜索，监听 Playwright 下载事件并保存文件。小于 1 KB 的下载会尝试解析 JSON，明确 `success:false` 时视为失败并保留清单项。

## 3. 清单状态转换

```text
raw 文件名
  -> createGroupToDoList.json（生成时去扩展名）
  -> analysetodolist.json（人群提交成功）
  -> done.json（洞察提交并确认跳转）
  -> result/文件（下载成功）并从 done.json 删除
```

清单更新发生在页面动作确认之后。页面异常、超时或子进程非零退出时，待处理项通常会保留。

## 4. 运行时控制点

浏览器脚本都以 `launchPersistentContext` 使用共享 `ruyi-profile`，可视运行并在 `finally` 中关闭上下文。批处理使用 Node `spawnSync` 串行调用单项脚本，不会并发操作浏览器或清单。每个阶段都检查清单是否变短，检查失败即停止，要求人工核实网页状态。

## 5. 典型中断路径

- 登录过期：在 Chrome 完成登录/验证，按终端提示回车后重试导航。
- profile 被占用：退出所有使用该 profile 的 Chrome 后重试。
- 上传成功提示不足：本批不会移动文件；确认平台未接收重复文件后再重试。
- 创建或分析超时：清单不变；先在网页确认是否已创建，再决定重试。
- 下载返回错误：项目留在 `done.json`；检查结果生成状态、权限和网络后重试。

