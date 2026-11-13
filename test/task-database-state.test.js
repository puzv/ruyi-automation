const assert = require('node:assert/strict')
const repo = require('../packages/shared/runtime/repos/task-execution')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { prepareTaskExecution } = require('../packages/shared/runtime/task-execution')

function fixture() {
  const ctx = { taskId: '11111111-1111-4111-8111-111111111111', userId: 7, jobId: 'job-1', claimToken: 'job-lease', taskClaimToken: 'task-lease' }
  const tables = {
    ruyi_tasks: [{ id: ctx.taskId, user_id: 7, status: 'running', claim_token: ctx.taskClaimToken, cancel_requested: 0, deleted_at: null, current_step: 'upload' }],
    ruyi_jobs: [{ id: ctx.jobId, task_id: ctx.taskId, user_id: 7, task: 'upload', status: 'running', claim_token: ctx.claimToken, cancel_requested: 0 }],
    ruyi_task_files: [{ id: 'file-1', task_id: ctx.taskId, user_id: 7, sequence: 1, original_name: 'oaid_原始.txt', original_path: 'raw/1/original.txt', current_path: 'raw/1/original.txt', stage: 'pending', file_type: 'oaid', size_bytes: 10, excluded_at: null }],
  }
  function query(table, update = false) {
    const conditions = []
    const q = {
      selectAll() { return this }, select() { return this }, orderBy() { return this }, forUpdate() { return this },
      where(column, op, value) { conditions.push([column, op, value]); return this },
      set(values) { this.values = values; return this },
      matches(row) { return conditions.every(([key, op, value]) => op === 'in' ? value.includes(row[key]) : op === '!=' ? row[key] !== value : op === 'is' ? (row[key] ?? null) === value : row[key] === value) },
      async execute() { return tables[table].filter((r) => this.matches(r)).map((r) => ({ ...r })) },
      async executeTakeFirst() {
        if (update) {
          const rows = tables[table].filter((r) => this.matches(r))
          for (const row of rows) for (const [key, value] of Object.entries(this.values)) row[key] = key === 'version' ? Number(row.version || 1) + 1 : value
          return { numUpdatedRows: BigInt(rows.length) }
        }
        return (await this.execute())[0]
      },
      async executeTakeFirstOrThrow() { const row = await this.executeTakeFirst(); if (!row) throw Error('missing'); return row },
    }
    return q
  }
  const db = { transaction() { return { execute: async (fn) => fn(db) } }, selectFrom: (t) => query(t), updateTable: (t) => query(t, true) }
  return { db, ctx, tables, file: tables.ruyi_task_files[0], task: tables.ruyi_tasks[0], job: tables.ruyi_jobs[0] }
}

async function main() {
  const f = fixture()
  await repo.prepareMappings(f.db, f.ctx, { username: 'alice' })
  assert.match(f.file.platform_name, /^alice_oaid_[a-f0-9]{8}_1$/)
  assert.equal(f.file.current_path, `execution/oaid/${f.file.platform_name}.txt`)
  const name = f.file.platform_name
  await repo.prepareMappings(f.db, f.ctx, { username: 'alice' })
  assert.equal(f.file.platform_name, name, '重试复用数据库稳定映射')
  assert.equal((await repo.pendingFiles(f.db, f.ctx, 'upload')).length, 1)
  await repo.beginOperation(f.db, f.ctx, { fileId: f.file.id, operation: 'upload' })
  assert.equal(f.file.pending_operation, 'upload')
  await assert.rejects(repo.pendingFiles(f.db, f.ctx, 'upload'), /未确认/)
  await assert.rejects(repo.beginOperation(f.db, f.ctx, { fileId: f.file.id, operation: 'upload' }), /未确认/)
  await repo.transitionFile(f.db, f.ctx, { fileId: f.file.id, fromStages: ['pending'], toStage: 'uploading' })
  await repo.transitionFile(f.db, f.ctx, { fileId: f.file.id, fromStages: ['uploading'], toStage: 'uploaded', currentPath: `execution/oaid/done/${name}.txt` })
  assert.equal(f.file.pending_operation, null)
  assert.equal((await repo.pendingFiles(f.db, f.ctx, 'upload')).length, 0)
  await assert.rejects(repo.transitionFile(f.db, f.ctx, { fileId: f.file.id, fromStages: ['uploaded'], toStage: 'downloaded' }), /推进方向/)
  f.task.current_step = f.job.task = 'create'
  await repo.beginOperation(f.db, f.ctx, { fileId: f.file.id, operation: 'create' })
  f.job.id = f.ctx.jobId = 'job-2'
  await assert.rejects(repo.transitionFile(f.db, f.ctx, { fileId: f.file.id, fromStages: ['uploaded'], toStage: 'created' }), /未确认/)
  f.file.pending_operation = null; f.file.operation_job_id = null
  await repo.transitionFile(f.db, f.ctx, { fileId: f.file.id, fromStages: ['uploaded'], toStage: 'created' })
  f.file.excluded_at = new Date()
  assert.equal((await repo.pendingFiles(f.db, f.ctx, 'analyse')).length, 0)
  for (const patch of [{ userId: 99 }, { claimToken: 'stale' }, { taskClaimToken: 'stale' }]) {
    await assert.rejects(repo.listFiles(f.db, { ...f.ctx, ...patch }), /租约/)
  }
  f.task.cancel_requested = 1
  await assert.rejects(repo.listFiles(f.db, f.ctx), /租约/)
  f.task.cancel_requested = 0; f.job.cancel_requested = 1
  await assert.rejects(repo.listFiles(f.db, f.ctx), /租约/)
  const old = fixture()
  old.tables.ruyi_jobs.push({ id: 'old-job', task_id: old.ctx.taskId, user_id: 7 })
  await assert.rejects(repo.prepareMappings(old.db, old.ctx, { username: 'alice' }), /旧任务/)
  Object.assign(old.tables.ruyi_jobs[1], { status: 'failed', error_message: '请先完成平台登录', log_path: null })
  await repo.prepareMappings(old.db, old.ctx, { username: 'alice' })
  assert.ok(old.file.platform_name, '登录检查前退出且无平台副作用允许恢复初始化')
  await assert.rejects(repo.listFiles({ transaction() { throw Error('sensitive db detail') } }, f.ctx), /无法保存或读取/)
  const cleanup = fixture()
  cleanup.task.current_step = cleanup.job.task = 'analyse'
  Object.assign(cleanup.file, { stage: 'analysed', platform_name: 'alice_oaid_task_1', pending_operation: null, audience_deleted_at: null })
  assert.equal((await repo.cleanupCandidates(cleanup.db, cleanup.ctx)).length, 0, '不追溯自动删除历史洞悉人群')
  cleanup.file.stage = 'created'
  await repo.transitionFile(cleanup.db, cleanup.ctx, { fileId: cleanup.file.id, fromStages: ['created'], toStage: 'analysed' })
  assert.equal(cleanup.file.audience_cleanup_pending, 1, '清理资格与洞悉成功阶段同事务写入')
  assert.equal((await repo.cleanupCandidates(cleanup.db, cleanup.ctx)).length, 1)
  assert.equal((await repo.assertCleanupEligible(cleanup.db, cleanup.ctx, cleanup.file.id)).platform_name, cleanup.file.platform_name)
  await assert.rejects(repo.assertCleanupEligible(cleanup.db, cleanup.ctx, 'other-file'), /不满足/)
  for (const patch of [{ stage: 'created' }, { excluded_at: new Date() }, { pending_operation: 'analyse' }, { platform_name: 'unsafe/name' }]) {
    const before = { ...cleanup.file }
    Object.assign(cleanup.file, patch)
    assert.equal((await repo.cleanupCandidates(cleanup.db, cleanup.ctx)).length, 0)
    await assert.rejects(repo.markAudienceDeleted(cleanup.db, cleanup.ctx, cleanup.file.id), /不满足/)
    Object.assign(cleanup.file, before)
  }
  cleanup.task.current_step = cleanup.job.task = 'download'
  cleanup.file.stage = 'downloaded'
  await repo.markAudienceDeleted(cleanup.db, cleanup.ctx, cleanup.file.id)
  assert.ok(cleanup.file.audience_deleted_at instanceof Date)
  assert.equal(cleanup.file.audience_cleanup_pending, 0)
  assert.equal((await repo.cleanupCandidates(cleanup.db, cleanup.ctx)).length, 0)
  await repo.markAudienceDeleted(cleanup.db, cleanup.ctx, cleanup.file.id)
  await assert.rejects(repo.cleanupCandidates(cleanup.db, { ...cleanup.ctx, taskClaimToken: 'stale' }), /租约/)
  cleanup.task.current_step = cleanup.job.task = 'create'
  await assert.rejects(repo.cleanupCandidates(cleanup.db, cleanup.ctx), /不允许/)
  assert.throws(() => repo.validPath('execution/oaid/../../escape.txt'), /路径无效/)
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-db-execution-')), execution = path.join(root, 'execution')
  fs.mkdirSync(path.join(root, 'raw')); fs.mkdirSync(execution)
  const input = { original_name: 'oaid.txt', original_path: 'raw/input.txt', platform_name: 'alice_oaid_12345678_1', current_path: 'execution/oaid/alice_oaid_12345678_1.txt', stage: 'pending', size_bytes: 4 }
  fs.writeFileSync(path.join(root, input.original_path), 'fake')
  prepareTaskExecution(root, execution, [input])
  const target = path.join(root, input.current_path)
  assert.equal(fs.readFileSync(target, 'utf8'), 'fake')
  assert.equal(fs.readdirSync(path.join(execution, 'oaid')).length, 1)
  fs.writeFileSync(target, 'fa')
  assert.throws(() => prepareTaskExecution(root, execution, [input]), /大小不完整/)
  const outside = path.join(root, 'outside'); fs.mkdirSync(outside)
  fs.symlinkSync(outside, path.join(execution, 'pn'))
  assert.throws(() => prepareTaskExecution(root, execution, [{ ...input, current_path: 'execution/pn/nested/file.txt' }]), /目录不安全/)
  assert.deepEqual(fs.readdirSync(outside), [], '校验父目录之前不得沿符号链接创建外部目录')
  prepareTaskExecution(root, execution, [{ ...input, stage: 'uploaded', current_path: 'execution/oaid/missing.txt' }])
  assert.equal(fs.existsSync(path.join(execution, 'oaid/missing.txt')), false, '已上传后不得重新复制原件')
  console.log('数据库执行状态测试通过：双租约、用户隔离、稳定命名、状态机、排除、未确认平台操作防重放、旧任务安全阻断及数据库故障脱敏')
}
module.exports = main()
module.exports.catch((error) => { console.error(error); process.exitCode = 1 })
