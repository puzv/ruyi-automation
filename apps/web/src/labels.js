export const actionLabels = {
  'auth.login': '登录', 'auth.register': '注册账号', 'auth.logout': '退出', 'auth.password_change': '修改密码',
  'admin.user_create': '创建用户', 'admin.user_disable': '停用用户', 'admin.user_enable': '启用用户',
  'admin.password_reset': '重置密码', 'admin.logs_view': '查看操作记录', 'file.import': '导入文件',
  'job.start': '启动任务', 'job.cancel': '取消任务', 'job.finish': '任务结束', 'platform.login_open': '打开平台登录',
  'platform.state_expired': '平台登录已过期',
  'platform.login_start': '开始平台登录', 'platform.login': '平台登录', 'platform.logout': '清除平台登录',
  'profile.release': '释放 Profile', 'runtime.mode_change': '切换运行模式',
}
export const taskLabels = { upload: '上传文件', create: '创建人群', analyse: '人群洞悉', download: '下载结果' }
export const jobStatusLabels = {
  queued: '排队中', running: '运行中', succeeded: '成功', failed: '失败', cancelled: '已取消', interrupted: '已中断',
}
export function isActiveJob(job) {
  return job?.status === 'queued' || job?.status === 'running'
}
export function jobNotice(job) {
  const label = taskLabels[job.task] || '任务'
  if (isActiveJob(job) && job.cancelRequested) return '正在停止任务…'
  if (job.status === 'queued') {
    // 接口的 position 是含自身的一基排位，界面展示前方任务数量。
    const ahead = Math.max(0, Number(job.position || 0) - 1)
    return ahead ? `${label}排队中，前面还有 ${ahead} 个任务` : `${label}即将开始`
  }
  if (job.status === 'running') return `${label}运行中...`
  if (job.status === 'succeeded') return `${label}已完成`
  if (job.status === 'failed') return `${label}执行失败：${job.errorMessage || '请查看日志'}`
  if (job.status === 'cancelled') return `${label}已取消`
  if (job.status === 'interrupted') return `${label}因服务重启中断，请重新运行`
  return label
}
export function jobDuration(job, now = Date.now()) {
  if (!job.startedAt || (!job.finishedAt && job.status !== 'running')) return '—'
  const start = new Date(job.startedAt).getTime()
  const end = job.finishedAt ? new Date(job.finishedAt).getTime() : now
  if (!Number.isFinite(start) || !Number.isFinite(end)) return '—'
  const seconds = Math.max(0, Math.floor((end - start) / 1000))
  return `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`
}
const reasonLabels = { unknown_user: '用户名不存在', wrong_password: '密码错误', locked: '账号锁定', disabled: '账号停用', invalid_request: '请求无效' }
const targetLabels = { user: '用户', file_batch: '文件批次', job: '任务' }

export function formatTime(value) {
  if (!value) return '—'
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) return '—'
  const parts = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(date)
  const fields = Object.fromEntries(parts.map(({ type, value: part }) => [type, part]))
  return `${fields.year}-${fields.month}-${fields.day} ${fields.hour}:${fields.minute}:${fields.second}`
}
export function logTarget(log) {
  const type = targetLabels[log.targetType] || log.targetType
  return [type, log.targetId].filter((part) => part != null && part !== '').join(' · ') || '—'
}
export function logDescription(log) {
  const detail = log.detail || {}
  if (log.action === 'auth.login' && log.result === 'failure') {
    const reason = reasonLabels[detail.reason] || detail.reason
    return [log.errorMessage, reason].filter(Boolean).join('；') || '—'
  }
  if (log.result === 'failure' && log.errorMessage) return log.errorMessage
  if (log.action === 'file.import') return `导入 ${detail.count ?? 0} 个，跳过 ${detail.skipped ?? 0} 个`
  const task = taskLabels[detail.task] || detail.task
  if (log.action === 'job.finish') {
    const duration = Number.isFinite(Number(detail.durationMs)) && detail.durationMs != null ? `${Number((Number(detail.durationMs) / 1000).toFixed(2))} 秒` : '未知'
    return `${task || '任务'}，耗时 ${duration}，退出码 ${detail.code ?? '未知'}`
  }
  return task || '—'
}
