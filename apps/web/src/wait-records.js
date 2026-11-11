function waitKind(record) {
  const detail = record.detail || record
  if (record.action && record.action !== 'job.finish') return null
  const code = detail.code ?? detail.exitCode
  if (detail.status === 'waiting_platform' && detail.outcome === 'not_ready'
    && code === 2 && !detail.signal && !detail.exitSignal && !detail.stateExpired) return 'waiting_platform'
  if (detail.status === 'waiting_login' && detail.outcome === 'login_required'
    && !detail.signal && !detail.exitSignal) return 'waiting_login'
  return null
}

// 只合并当前列表中相邻且有可靠业务归属的等待检查，不跨越失败、取消或用户边界。
export function groupWaitRecords(records, { taskId, userId, username } = {}) {
  const groups = []
  for (const record of records || []) {
    const detail = record.detail || record
    const kind = waitKind(record)
    const businessId = detail.taskId || record.taskId || taskId
    const owner = record.userId ?? detail.userId ?? userId ?? record.username ?? detail.username ?? username
    const step = detail.task || record.task
    const key = kind && businessId && step && owner != null
      ? JSON.stringify([owner, businessId, step, kind]) : null
    const previous = groups.at(-1)
    if (key && previous?.key === key) {
      previous.records.push(record)
    } else groups.push({ id: record.id, key, kind, record, records: [record] })
  }
  return groups
}

export function waitRecordRange(group) {
  const values = group.records.map((record) => record.createdAt || record.startedAt || record.queuedAt)
    .filter(Boolean).sort((a, b) => new Date(a) - new Date(b))
  return { first: values[0], last: values.at(-1) }
}
