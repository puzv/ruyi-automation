# 调用示例

用户：“把 ~/Downloads/1030 的文件跑完全流程，结果保存到 ~/Desktop/results”。

1. get_overview；如未登录，给登录地址，等本人完成。
2. 只列出文件名和元数据，筛选普通、非隐藏且名称含 pn / idfa / oaid 的 txt/csv，不读取内容。
3. prepare_upload 后用一条 curl：
   ```sh
   curl -sS -f -F 'name=1030 人群任务' -F "files=@$HOME/Downloads/1030/a_pn.txt" -F "files=@$HOME/Downloads/1030/b_oaid.csv" '<uploadUrl>'
   ```
4. 保存返回 taskId，核对 item.fileCount；wait_for_task({taskId: "实际整任务编号", timeoutSeconds: 50})，running / queued 可继续等，不再 run_task。
5. succeeded 后 prepare_download({taskId: "实际整任务编号"})，保存：
   ```sh
   mkdir -p "$HOME/Desktop/results"
   curl -sS -fL -o "$HOME/Desktop/results/ruyi-results-实际任务编号.zip" '<downloadUrl>'
   ```
   不覆盖已有文件；只报告绝对路径和元数据大小。

用户：“任务到哪一步了？”只用 list_tasks、get_task，报告 currentStep 和 status，不执行写操作。

用户：“继续这个已中断的任务。”get_task 核对归属、状态、版本，登录有效后 continue_task({taskId, version})，保留已完成步骤和清单。
若 waiting_login，解释 resume_task 恢复当前用户所有等待登录任务；得到明确恢复指令后传 {taskId, confirm: true}。
若 failed / cancelled，不伪装成可继续，不反复上传重建。
