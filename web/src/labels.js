export const actionLabels = {
  'auth.login': '登录', 'auth.logout': '退出', 'auth.password_change': '修改密码',
  'admin.user_create': '创建用户', 'admin.user_disable': '停用用户', 'admin.user_enable': '启用用户',
  'admin.password_reset': '重置密码', 'admin.logs_view': '查看操作记录', 'file.import': '导入文件',
  'job.start': '启动任务', 'job.finish': '任务结束', 'platform.login_open': '打开平台登录',
  'platform.state_expired': '平台登录已过期',
  'platform.login_start': '开始平台登录', 'platform.login': '平台登录', 'platform.logout': '清除平台登录',
  'profile.release': '释放 Profile', 'runtime.mode_change': '切换运行模式',
}
export const taskLabels = { upload: '上传文件', create: '创建人群', analyse: '人群洞悉', download: '下载结果' }
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
