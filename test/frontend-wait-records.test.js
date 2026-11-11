const assert = require('node:assert/strict')
async function main() {
  const { groupWaitRecords, waitRecordRange } = await import('../apps/web/src/wait-records.js')
  const base = { taskId: 'task-a', task: 'analyse', status: 'waiting_platform', outcome: 'not_ready', exitCode: 2, userId: 1 }
  const record = (id, fields = {}) => ({ ...base, id, startedAt: `2026-11-10T00:00:0${id}Z`, ...fields })
  let groups = groupWaitRecords([record(1), record(2), record(3)])
  assert.equal(groups.length, 1); assert.equal(groups[0].records.length, 3)
  assert.deepEqual(waitRecordRange(groups[0]), { first: '2026-11-10T00:00:01Z', last: '2026-11-10T00:00:03Z' })
  assert.deepEqual(waitRecordRange(groupWaitRecords([record(3), record(2), record(1)])[0]), { first: '2026-11-10T00:00:01Z', last: '2026-11-10T00:00:03Z' }, '倒序操作记录按实际时间显示首次最近')
  assert.equal(groups.flatMap((group) => group.records).length, 3, '分组保留所有原始记录')
  for (const middle of [
    { userId: 2 }, { taskId: 'task-b' }, { task: 'create' }, { status: 'failed', outcome: 'failure', exitCode: 1 },
    { status: 'cancelled' }, { status: 'interrupted' }, { exitSignal: 'SIGTERM' }, { stateExpired: true },
    { status: 'waiting_login', outcome: 'login_required' },
  ]) assert.equal(groupWaitRecords([record(1), record(2, middle), record(3)]).length, 3, JSON.stringify(middle))
  assert.equal(groupWaitRecords([record(1, { taskId: undefined }), record(2, { taskId: undefined })]).length, 2)
  assert.equal(groupWaitRecords([record(1, { userId: undefined }), record(2, { userId: undefined })]).length, 2)
  const log = (id, detail = {}) => ({ id, action: 'job.finish', username: 'alice', detail: { taskId: 'task-a', task: 'analyse', status: 'waiting_platform', outcome: 'not_ready', code: 2, ...detail } })
  groups = groupWaitRecords([log(1), log(2)])
  assert.equal(groups.length, 1)
  assert.equal(groupWaitRecords([log(1, { taskId: undefined }), log(2, { taskId: undefined })]).length, 2, '旧审计无taskId不猜测归并')
  assert.equal(groupWaitRecords([log(1, { status: 'waiting_login', outcome: 'login_required', stateExpired: true }), log(2, { status: 'waiting_login', outcome: 'login_required', stateExpired: true })]).length, 1)
  assert.equal(groupWaitRecords([log(1), { ...log(2), action: 'task.resume' }, log(3)]).length, 3)
  console.log('等待检查前端聚合测试通过：相邻同用户/任务/步骤/类别合并，失败取消分隔，缺失归属不猜测')
}
module.exports = main
if (require.main === module) main().catch((error) => { console.error(error); process.exitCode = 1 })
