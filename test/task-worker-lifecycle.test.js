const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { createWorker } = require('../apps/worker/src')
const { prepareTaskExecution, carryTaskResults } = require('../packages/shared/runtime/task-execution')
const { beginResults, recordResult, sealResults, finishResults, resultEntries } = require('../packages/shared/runtime/job-results')
const { randomUUID } = require('node:crypto')
const { EventEmitter } = require('node:events')
const { executeTask } = require('../apps/worker/src/execution')

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
async function until(check, message) {
  for (let i = 0; i < 2000; i++) { if (check()) return; await pause(2) }
  assert.fail(message)
}
function fixture(rows) {
  const records = [], tasks = rows.map((row, i) => ({ id: `task-${i}`, user_id: i + 1, username: `user_${i}`, status: 'queued', current_step: 'upload', ...row }))
  const repository = {
    async setTaskNextCheck(_db, args) { const task = tasks.find((t) => t.id === args.id); task.next_check_at = args.nextCheckAt; return true },
    async recoverStaleTasks() { return [] }, async heartbeatTasks() {},
    async claimNextTask(_db, options) {
      if (tasks.filter((t) => t.status === 'running').length >= options.maxConcurrent) return null
      const task = tasks.find((t) => t.status === 'queued' && !tasks.some((r) => r.user_id === t.user_id && ['running', 'waiting_login'].includes(r.status)))
      if (!task) return null
      Object.assign(task, { status: 'running', claim_token: options.claimToken }); return { ...task }
    },
    async getTaskForUser(_db, id) { return { ...tasks.find((t) => t.id === id) } },
    async updateTaskStep(_db, args) { const t = tasks.find((t) => t.id === args.id); if (t.claim_token !== args.claimToken || t.status !== 'running') return false; t.current_step = args.currentStep; return true },
    async finishTask(_db, args) { const t = tasks.find((t) => t.id === args.id); if (t.claim_token !== args.claimToken || t.status !== 'running') return false; Object.assign(t, { status: args.status }); return true },
    async markUserWaitingLogin(_db, args) { for (const t of tasks) if (t.user_id === args.userId && ['queued', 'running'].includes(t.status)) { t.status = 'waiting_login'; t.claim_token = null } },
  }
  const jobRepository = {
    async recoverStaleJobs() { return [] }, async heartbeat() {}, async listCancelRequested() { return [] },
    async claimNextJob() { return null },
    async enqueueTaskJob(_db, args) { const j = { id: args.id, task_id: args.taskId, user_id: args.userId, task: args.task, claim_token: args.claimToken }; records.push(j); return j },
    async finishJob(_db, args) { Object.assign(records.find((j) => j.id === args.id), args); return true },
  }
  const db = { selectFrom() { const q = { selectAll() { return q }, where() { return q }, async execute() { return tasks.filter((t) => t.status === 'running' && t.cancel_requested) } }; return q } }
  return { tasks, records, options: { db, taskRepository: repository, jobRepository, auditWriter: async () => {}, retryMs: 10, pollMs: 2, maxConcurrent: 2 } }
}

async function main() {
  {
    const f = fixture([{}])
    const options = { ...f.options }
    delete options.retryMs
    const before = Date.now()
    const worker = createWorker({ ...options, runner: async () => ({ status: 'failed', outcome: 'not_ready' }) })
    try {
      await worker.start()
      await until(() => f.tasks[0].next_check_at instanceof Date, '未就绪任务应保存默认重试时间')
      const after = Date.now()
      const nextCheckAt = f.tasks[0].next_check_at.getTime()
      assert.ok(nextCheckAt >= before + 120000 && nextCheckAt <= after + 120000, '默认平台重试应为本轮结束后120秒')
      assert.equal(f.records.length, 1, '等待期间不能立即重试')
    } finally {
      await worker.stop()
    }
  }
  {
    const f = fixture([{ current_step: 'analyse' }]);
    const worker = createWorker({ ...f.options, runner: async () => ({ status: 'succeeded' }) });
    await worker.start(); await until(() => f.tasks[0].status === 'succeeded', '中断任务应从未完成步骤继续'); await worker.stop();
    assert.deepEqual(f.records.map((job) => job.task), ['analyse', 'download'], '已完成上传和创建不得重跑');
  }
  {
    let launchedEnv
    const previous = process.env.RUYI_TASK_ID
    process.env.RUYI_TASK_ID = 'inherited-other-task'
    const job = executeTask({ id: 'per-attempt-id', businessTaskId: 'stable-task-id', script: 'uploadAll.js',
      user: { username: 'test_user' }, headless: true,
      spawnImpl(_cmd, _args, options) {
        launchedEnv = options.env
        const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter()
        setImmediate(() => child.emit('close', 0, null)); return child
      } })
    await job.completion
    assert.equal(launchedEnv.RUYI_JOB_ID, 'stable-task-id', '平台命名使用业务task ID而不是每轮job ID')
    assert.equal(launchedEnv.RUYI_TASK_ID, undefined, '任务上下文必须显式传入，不能继承其他执行环境')
    if (previous === undefined) delete process.env.RUYI_TASK_ID
    else process.env.RUYI_TASK_ID = previous
  }
  {
    const f = fixture([{ user_id: 1 }, { user_id: 1 }, { user_id: 2 }]), order = []
    let active = 0, maxActive = 0
    const worker = createWorker({ ...f.options, runner: async ({ job }) => {
      active++; maxActive = Math.max(active, maxActive); order.push([job.task_id, job.task]); await pause(2); active--
      return { status: 'succeeded', outcome: 'success' }
    } })
    await worker.start(); await until(() => f.tasks.every((t) => t.status === 'succeeded'), '四个步骤必须自动执行直到任务完成'); await worker.stop()
    assert.equal(maxActive, 2)
    for (const t of f.tasks) assert.deepEqual(order.filter(([id]) => id === t.id).map(([, step]) => step), ['upload', 'create', 'analyse', 'download'])
    assert.ok(order.findIndex(([id]) => id === 'task-1') > order.findIndex(([id, s]) => id === 'task-0' && s === 'download'), '同用户后任务应等待前任务四步完成')
  }
  {
    const f = fixture([{}, { user_id: 1 }]); let retries = 0
    const audit = []
    const worker = createWorker({ ...f.options, auditWriter: async (_db, entry) => audit.push(entry), runner: async ({ job }) => {
      if (job.task === 'create' && job.task_id === 'task-0' && retries++ === 0) return { status: 'failed', outcome: 'not_ready', exitCode: 2 }
      return { status: 'succeeded', outcome: 'success' }
    } })
    await worker.start(); await until(() => retries === 1, '应进入异步等待')
    assert.equal(f.tasks[0].status, 'running'); assert.equal(f.tasks[1].status, 'queued')
    await until(() => f.tasks.every((t) => t.status === 'succeeded'), 'NOT_READY稍后应重试当前步并继续推进'); await worker.stop()
    assert.equal(f.records.filter((j) => j.task_id === 'task-0' && j.task === 'upload').length, 1)
    assert.equal(f.records.filter((j) => j.task_id === 'task-0' && j.task === 'create').length, 2)
    const check = audit.find((entry) => entry.action === 'job.finish' && entry.detail.outcome === 'not_ready')
    assert.equal(check.result, 'success', '暂未就绪是一次正常检查，不记录为执行失败')
    assert.equal(check.detail.status, 'waiting_platform')
    assert.equal(check.detail.taskId, 'task-0')
    assert.equal(check.detail.code, 2)
    assert.equal(check.errorMessage, null)
    assert.equal(f.records.find((job) => job.exitCode === 2).status, 'failed', '存储仍保留真实退出事实')
  }
  {
    const audit = []
    const f = fixture([{}, { user_id: 1 }, { user_id: 2 }]); const worker = createWorker({ ...f.options, auditWriter: async (_db, entry) => audit.push(entry), runner: async ({ job }) =>
      job.user_id === 1 ? { status: 'failed', loginRequired: true } : { status: 'succeeded' } })
    await worker.start(); await until(() => f.tasks[2].status === 'succeeded', '失效用户不应阻塞其他用户')
    assert.deepEqual(f.tasks.slice(0, 2).map((t) => t.status), ['waiting_login', 'waiting_login'])
    assert.equal(f.records.filter((j) => j.user_id === 1).length, 1)
    const login = audit.find((entry) => entry.action === 'job.finish' && entry.userId === 1)
    assert.equal(login.result, 'success')
    assert.equal(login.detail.taskId, 'task-0')
    assert.equal(login.detail.status, 'waiting_login')
    assert.equal(login.detail.outcome, 'login_required')
    assert.equal(login.errorMessage, null)
    // 显式恢复全部等待任务；当前步骤不退回上传。
    for (const t of f.tasks.slice(0, 2)) t.status = 'queued'
    await worker.stop()
  }
  {
    const f = fixture([{}, { user_id: 1 }])
    const audit = []
    const worker = createWorker({ ...f.options, auditWriter: async (_db, entry) => audit.push(entry), runner: async ({ job }) => job.task_id === 'task-0'
      ? { status: 'failed', errorMessage: '模拟执行失败' } : { status: 'succeeded' } })
    await worker.start(); await until(() => f.tasks[1].status === 'succeeded', '失败任务应让后续同用户任务继续'); await worker.stop()
    assert.equal(f.tasks[0].status, 'failed')
    assert.equal(f.records.filter((j) => j.task_id === 'task-0').length, 1)
    const failure = audit.find((entry) => entry.action === 'job.finish' && entry.result === 'failure')
    assert.equal(failure.detail.status, 'failed'); assert.equal(failure.errorMessage, '模拟执行失败')
  }
  {
    const f = fixture([{}]), audit = []
    const worker = createWorker({ ...f.options, auditWriter: async (_db, entry) => audit.push(entry), runner: async () => ({ status: 'cancelled', outcome: 'not_ready', exitCode: 2 }) })
    await worker.start(); await until(() => f.tasks[0].status === 'cancelled', '取消优先于暂未就绪'); await worker.stop()
    const cancelled = audit.find((entry) => entry.action === 'job.finish')
    assert.equal(cancelled.result, 'failure'); assert.equal(cancelled.detail.status, 'cancelled')
    assert.equal(cancelled.detail.outcome, undefined)
  }
  {
    const f = fixture([{}]); const worker = createWorker({ ...f.options, retryMs: 60000, runner: async () => ({ status: 'failed', outcome: 'not_ready' }) })
    await worker.start(); await until(() => f.records.length === 1 && f.records[0].status === 'failed', '应等待重试')
    f.tasks[0].cancel_requested = 1
    await until(() => f.tasks[0].status === 'interrupted', '等待平台期间应及时停止，不必等60秒重试'); await worker.stop()
    assert.equal(f.records.length, 1)
  }
  {
    const f = fixture([{}]); const worker = createWorker({ ...f.options, retryMs: 60000, runner: async () => ({ status: 'failed', outcome: 'not_ready' }) })
    await worker.start(); await until(() => f.records[0]?.status === 'failed', '应等待重试'); await worker.stop()
    assert.equal(f.tasks[0].status, 'interrupted', '停止不能让整任务永久running')
  }
  {
    const f = fixture([{}]); const worker = createWorker({ ...f.options, runner: async ({ job }) => {
      if (job.task === 'download') f.tasks[0].cancel_requested = 1
      return { status: 'succeeded' }
    } })
    await worker.start(); await until(() => f.tasks[0].status === 'interrupted', '最后一步结束与停止竞态应尊重已提交停止'); await worker.stop()
  }
  {
    const f = fixture([{ current_step: 'analyse' }]); let acknowledgeStop
    const worker = createWorker({ ...f.options, runner: ({ signal }) => new Promise((resolve) => {
      signal.addEventListener('abort', () => { acknowledgeStop = () => resolve({ status: 'cancelled' }) }, { once: true })
    }) })
    await worker.start(); await until(() => f.records.length === 1, '应开始洞悉流程')
    f.tasks[0].cancel_requested = 1
    await until(() => Boolean(acknowledgeStop), '停止请求应中断正在执行的子流程')
    assert.equal(f.tasks[0].status, 'running', '子流程未真正退出前不允许继续任务')
    acknowledgeStop()
    await until(() => f.tasks[0].status === 'interrupted', '退出后应标记已中断')
    assert.equal(f.tasks[0].current_step, 'analyse'); assert.equal(f.records.length, 1)
    await worker.stop()
  }
  {
    const f = fixture([{}]); const worker = createWorker({ ...f.options, runner: async () => {
      f.tasks[0].cancel_requested = 1
      throw new Error('模拟停止时浏览器退出')
    } })
    await worker.start(); await until(() => f.tasks[0].status === 'interrupted', '停止与执行抛错竞态不能标记失败'); await worker.stop()
    assert.equal(f.records.length, 1)
  }
  {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-task-execution-')), execution = path.join(root, 'execution')
    fs.mkdirSync(path.join(root, 'raw', '1'), { recursive: true }); fs.mkdirSync(path.join(execution, 'raw'), { recursive: true })
    const rows = [{ original_name: 'oaid_测试.txt', original_path: 'raw/1/fake.txt' }, { original_name: 'pn_删除.txt', original_path: 'raw/1/never-read.txt', excluded_at: new Date() }]
    fs.writeFileSync(path.join(root, 'raw/1/fake.txt'), 'fake ids only')
    prepareTaskExecution(root, execution, rows)
    assert.deepEqual(fs.readdirSync(path.join(execution, 'raw')), ['oaid_测试.txt'])
    assert.equal(fs.readFileSync(path.join(root, rows[0].original_path), 'utf8'), 'fake ids only')
    fs.mkdirSync(path.join(execution, 'oaid')); fs.renameSync(path.join(execution, 'raw', rows[0].original_name), path.join(execution, 'oaid/platform.txt'))
    Object.assign(rows[0], { platform_name: 'platform', current_path: 'execution/oaid/platform.txt', stage: 'uploaded' })
    prepareTaskExecution(root, execution, rows)
    assert.deepEqual(fs.readdirSync(path.join(execution, 'raw')), [], '数据库已有映射不能重新复制原始文件触发重复上传')
    rows[0].excluded_at = new Date()
    prepareTaskExecution(root, execution, rows)
    assert.ok(fs.existsSync(path.join(execution, '.excluded/platform.txt')))
    assert.equal(fs.readdirSync(execution).some((name) => name.endsWith('.json')), false)
    assert.ok(fs.existsSync(path.join(root, rows[0].original_path)))
    // 跨下载轮次成果合并及停止恢复由 db-job-results.test.js 使用真实文件和数据库仓储验证。
  }
  {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-task-before-manifest-'))
    const execution = path.join(root, 'execution')
    fs.mkdirSync(path.join(root, 'raw', '1'), { recursive: true })
    fs.mkdirSync(path.join(execution, 'raw'), { recursive: true })
    const row = { original_name: '等待登录后删除_oaid.txt', original_path: 'raw/1/fake.txt' }
    const original = path.join(root, row.original_path)
    fs.writeFileSync(original, 'fake preserved ids')
    prepareTaskExecution(root, execution, [row])
    assert.deepEqual(fs.readdirSync(path.join(execution, 'raw')), [row.original_name])
    assert.equal(fs.existsSync(path.join(execution, 'file-manifest.json')), false)
    row.excluded_at = new Date()
    prepareTaskExecution(root, execution, [row])
    assert.deepEqual(fs.readdirSync(path.join(execution, 'raw')), [], '映射生成前排除文件也必须移出上传目录')
    assert.equal(fs.readFileSync(path.join(execution, '.excluded', row.original_name), 'utf8'), 'fake preserved ids')
    assert.equal(fs.readFileSync(original, 'utf8'), 'fake preserved ids', '排除执行副本不得删除或改写原件')
    prepareTaskExecution(root, execution, [row])
    assert.deepEqual(fs.readdirSync(path.join(execution, 'raw')), [], '重复准备不能再次复制已排除文件')
  }
  console.log('整任务Worker生命周期测试通过：四步推进、同用户FIFO、并发、异步等待重试、登录冻结、取消、中断、原件与执行隔离及排除')
}
main().catch((error) => { console.error(error); process.exitCode = 1 })
