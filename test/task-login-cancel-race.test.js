const assert = require('node:assert/strict')
const { createWorker } = require('../apps/worker/src')
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
async function main() {
  for (const race of ['cancel', 'lost_lease', 'already_waiting']) {
    const task = { id: 'task', user_id: 1, username: 'fake_user', current_step: 'upload', status: 'queued' }
    const finished = [], records = []
    let claimed = false, freezeCalled = false
    const tasks = {
      async recoverStaleTasks() { return [] }, async heartbeatTasks() {}, async setTaskNextCheck() { return true },
      async claimNextTask(_db, args) { if (claimed) return null; claimed = true; Object.assign(task, { status: 'running', claim_token: args.claimToken }); return { ...task } },
      async getTaskForUser() { return { ...task } },
      async finishTask(_db, args) { finished.push(args.status); task.status = args.status; return true },
      async markUserWaitingLogin() {
        freezeCalled = true
        if (race === 'cancel') task.cancel_requested = 1
        if (race === 'lost_lease') task.claim_token = 'other-worker-lease'
        if (race === 'already_waiting') { task.status = 'waiting_login'; task.claim_token = null }
        return false
      },
    }
    const jobs = {
      async recoverStaleJobs() { return [] }, async heartbeat() {}, async listCancelRequested() { return [] }, async claimNextJob() { return null },
      async enqueueTaskJob(_db, args) { const job = { id: args.id, task_id: args.taskId, user_id: 1, claim_token: args.claimToken }; records.push(job); return job },
      async finishJob() { return true },
    }
    const worker = createWorker({ db: {}, taskRepository: tasks, jobRepository: jobs, auditWriter: async () => {},
      pollMs: 2, runner: async () => ({ status: 'failed', loginRequired: true }) })
    await worker.start()
    for (let i = 0; i < 200 && !freezeCalled; i++) await pause(2)
    assert.equal(freezeCalled, true)
    await pause(10)
    if (race === 'cancel') { assert.equal(task.status, 'interrupted'); assert.deepEqual(finished, ['interrupted']) }
    else { assert.deepEqual(finished, [], '丢失租约或已经等待登录不得覆盖为失败') }
    await worker.stop()
    assert.equal(records.length, 1)
  }
  console.log('登录冻结与取消竞态测试通过：取消优先，丢失租约和等待登录不覆盖终态')
}
main().catch((error) => { console.error(error); process.exitCode = 1 })
