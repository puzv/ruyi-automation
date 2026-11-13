const crypto = require('node:crypto')
const path = require('node:path')
const { sql } = require('kysely')

const PENDING = { upload: ['pending', 'uploading'], create: ['uploaded'], analyse: ['created'], download: ['analysed'] }
const STAGES = new Set(['pending', 'uploading', 'uploaded', 'created', 'analysed', 'downloaded', 'empty'])
function failure(message, code = 'TASK_DATABASE_ERROR') { return Object.assign(new Error(message), { code }) }
function validPath(value) {
  if (typeof value !== 'string' || !/^execution\/(idfa|oaid|pn)\//.test(value) || value.includes('\\') || value.includes('\0')
    || value.split('/').some((p) => !p || p === '.' || p === '..')) throw failure('任务执行文件路径无效')
  return value
}
async function leased(db, ctx, fn) {
  if (!ctx?.taskId || !ctx.jobId || !ctx.claimToken || !ctx.taskClaimToken || !ctx.userId) throw failure('缺少任务执行租约')
  try {
    return await db.transaction().execute(async (trx) => {
      const task = await trx.selectFrom('ruyi_tasks').selectAll().where('id', '=', ctx.taskId).where('user_id', '=', ctx.userId)
        .where('status', '=', 'running').where('claim_token', '=', ctx.taskClaimToken).where('cancel_requested', '=', 0)
        .where('deleted_at', 'is', null).forUpdate().executeTakeFirst()
      if (!task) throw failure('整任务租约已失效，停止执行')
      const job = await trx.selectFrom('ruyi_jobs').selectAll().where('id', '=', ctx.jobId).where('task_id', '=', ctx.taskId)
        .where('user_id', '=', ctx.userId).where('status', '=', 'running').where('claim_token', '=', ctx.claimToken)
        .where('cancel_requested', '=', 0).forUpdate().executeTakeFirst()
      if (!job || job.task !== task.current_step) throw failure('任务流程租约已失效，停止执行')
      return fn(trx, task, job)
    })
  } catch (error) {
    if (error.code === 'TASK_DATABASE_ERROR' || error.code === 'UNCERTAIN_PLATFORM_OPERATION') throw error
    throw failure('无法保存或读取任务执行状态，已停止执行，请联系管理员')
  }
}
const filesQuery = (db, ctx) => db.selectFrom('ruyi_task_files').selectAll().where('task_id', '=', ctx.taskId).where('user_id', '=', ctx.userId).orderBy('sequence')
const listFiles = (db, ctx) => leased(db, ctx, (trx) => filesQuery(trx, ctx).execute())
const assertLease = (db, ctx) => leased(db, ctx, () => true)
function pendingFiles(db, ctx, step) {
  if (!PENDING[step]) throw failure('任务流程无效')
  return listFiles(db, ctx).then((rows) => {
    const order = { pending: 0, uploading: 0, uploaded: 1, created: 2, analysed: 3, downloaded: 4 }
    const required = { upload: 0, create: 1, analyse: 2, download: 3 }[step]
    if (rows.some((r) => !r.excluded_at && r.stage !== 'empty' && (order[r.stage] === undefined || order[r.stage] < required))) {
      throw failure('任务文件存在尚未完成的前置流程，已停止自动推进，请核对任务状态')
    }
    const pending = rows.filter((r) => !r.excluded_at && PENDING[step].includes(r.stage))
    if (pending.some((r) => r.pending_operation)) throw failure('上次平台操作结果尚未确认，请核对平台状态后继续，避免重复提交', 'UNCERTAIN_PLATFORM_OPERATION')
    return pending
  })
}
function prepareMappings(db, ctx, { username }) {
  return leased(db, ctx, async (trx) => {
    const rows = await filesQuery(trx, ctx).execute()
    if (rows.some((r) => !r.excluded_at && !r.platform_name)) {
      const previous = await trx.selectFrom('ruyi_jobs').select(['id', 'status', 'error_message', 'log_path']).where('task_id', '=', ctx.taskId).where('user_id', '=', ctx.userId)
        .where('id', '!=', ctx.jobId).execute()
      // 登录检查在打开日志、启动浏览器之前返回，只有这类失败可证明没有平台副作用。
      if (previous.some((row) => row.status !== 'failed' || row.error_message !== '请先完成平台登录' || row.log_path)) {
        throw failure('旧任务数据库状态不完整，请先核对平台处理结果；为避免重复提交，已停止自动执行')
      }
    }
    for (const row of rows) {
      if (row.excluded_at) continue
      if (row.platform_name) {
        validPath(row.current_path)
        if (!/^[a-zA-Z0-9_]+$/.test(row.platform_name) || row.platform_name.length > 30
          || path.basename(row.current_path) !== `${row.platform_name}${path.extname(row.original_name).toLowerCase()}`
          || !row.current_path.startsWith(`execution/${row.file_type}/`)) throw failure('任务数据库文件映射无效')
        continue
      }
      if (row.stage !== 'pending' || !['idfa', 'oaid', 'pn'].includes(row.file_type) || !/^[a-z0-9_]+$/.test(username)
        || !Number.isSafeInteger(Number(row.sequence)) || Number(row.sequence) < 1) throw failure('任务文件状态不完整，请核对后重试')
      const key = crypto.createHash('sha256').update(ctx.taskId).digest('hex').slice(0, 8)
      const name = `${username}_${row.file_type}_${key}_${row.sequence}`
      if (name.length > 30) throw failure('平台名称超过 30 个字符，请缩短用户名或减少单次文件数量')
      const extension = path.extname(row.original_name).toLowerCase()
      if (!/^\.(txt|csv)$/.test(extension)) throw failure('任务文件格式无效')
      const stage = Number(row.size_bytes) === 0 ? 'empty' : 'pending'
      const currentPath = `execution/${row.file_type}/${stage === 'empty' ? 'done/' : ''}${name}${extension}`
      await trx.updateTable('ruyi_task_files').set({ platform_name: name, current_path: currentPath, stage, version: sql`version + 1` })
        .where('id', '=', row.id).where('task_id', '=', ctx.taskId).where('user_id', '=', ctx.userId).where('excluded_at', 'is', null).executeTakeFirst()
      Object.assign(row, { platform_name: name, current_path: currentPath, stage })
    }
    return rows
  })
}
function transitionFile(db, ctx, { fileId, fromStages, toStage, currentPath }) {
  if (!STAGES.has(toStage) || !Array.isArray(fromStages) || !fromStages.length || fromStages.some((s) => !STAGES.has(s))) throw failure('任务文件阶段无效')
  if (currentPath !== undefined) validPath(currentPath)
  return leased(db, ctx, async (trx, _task, job) => {
    const graph = { upload: { pending: ['uploading', 'empty'], uploading: ['uploaded'], uploaded: ['uploaded'] },
      create: { uploaded: ['created'] }, analyse: { created: ['analysed', 'empty'] }, download: { analysed: ['downloaded'] } }
    if (fromStages.some((stage) => !graph[job.task]?.[stage]?.includes(toStage))) throw failure('任务文件推进方向与当前流程不一致')
    const row = await filesQuery(trx, ctx).where('id', '=', fileId).where('excluded_at', 'is', null).forUpdate().executeTakeFirst()
    if (!row || !fromStages.includes(row.stage) || (row.pending_operation && row.operation_job_id !== ctx.jobId)) throw failure('任务文件存在未确认操作或状态已变化，停止推进')
    const values = { stage: toStage, error_message: null, pending_operation: null, operation_job_id: null, version: sql`version + 1` }
    if (job.task === 'analyse' && toStage === 'analysed') values.audience_cleanup_pending = 1
    if (currentPath !== undefined) values.current_path = currentPath
    const result = await trx.updateTable('ruyi_task_files').set(values).where('id', '=', fileId).where('task_id', '=', ctx.taskId)
      .where('user_id', '=', ctx.userId).where('excluded_at', 'is', null).where('stage', 'in', fromStages).executeTakeFirst()
    if (Number(result.numUpdatedRows) !== 1) throw failure('任务文件状态已变化，停止推进')
    return filesQuery(trx, ctx).where('id', '=', fileId).executeTakeFirstOrThrow()
  })
}
function beginOperation(db, ctx, { fileId, operation }) {
  const allowed = { upload: ['pending', 'uploading'], create: ['uploaded'], analyse: ['created'], download: ['analysed'] }
  if (!allowed[operation]) throw failure('任务平台操作无效')
  return leased(db, ctx, async (trx, _task, job) => {
    if (job.task !== operation) throw failure('平台操作与当前任务流程不一致')
    const row = await filesQuery(trx, ctx).where('id', '=', fileId).where('excluded_at', 'is', null).forUpdate().executeTakeFirst()
    if (!row || !allowed[operation].includes(row.stage)) throw failure('任务文件阶段已变化，停止执行')
    if (row.pending_operation) throw failure('上次平台操作结果尚未确认，请核对后继续，避免重复提交', 'UNCERTAIN_PLATFORM_OPERATION')
    await trx.updateTable('ruyi_task_files').set({ pending_operation: operation, operation_job_id: ctx.jobId, version: sql`version + 1` })
      .where('id', '=', fileId).where('task_id', '=', ctx.taskId).where('user_id', '=', ctx.userId).executeTakeFirst()
    return row
  })
}
function cleanupEligible(row) {
  return Number(row.audience_cleanup_pending) === 1 && !row.excluded_at && !row.audience_deleted_at && !row.pending_operation
    && ['analysed', 'downloaded'].includes(row.stage)
    && typeof row.platform_name === 'string' && /^[a-zA-Z0-9_]{1,30}$/.test(row.platform_name)
}
function cleanupCandidates(db, ctx) {
  return leased(db, ctx, async (trx, _task, job) => {
    if (!['analyse', 'download'].includes(job.task)) throw failure('当前流程不允许清理平台人群')
    return (await filesQuery(trx, ctx).execute()).filter(cleanupEligible)
  })
}
function assertCleanupEligible(db, ctx, fileId) {
  return leased(db, ctx, async (trx, _task, job) => {
    if (!['analyse', 'download'].includes(job.task)) throw failure('当前流程不允许清理平台人群')
    const row = await filesQuery(trx, ctx).where('id', '=', fileId).forUpdate().executeTakeFirst()
    if (!row || !cleanupEligible(row)) throw failure('任务文件不满足平台人群清理条件，停止删除')
    return row
  })
}
function markAudienceDeleted(db, ctx, fileId) {
  return leased(db, ctx, async (trx, _task, job) => {
    if (!['analyse', 'download'].includes(job.task)) throw failure('当前流程不允许清理平台人群')
    const row = await filesQuery(trx, ctx).where('id', '=', fileId).forUpdate().executeTakeFirst()
    if (row?.audience_deleted_at) return row
    if (!row || !cleanupEligible(row)) throw failure('任务文件不满足平台人群清理条件，停止记录')
    await trx.updateTable('ruyi_task_files').set({ audience_deleted_at: new Date(), audience_cleanup_pending: 0, version: sql`version + 1` })
      .where('id', '=', fileId).where('task_id', '=', ctx.taskId).where('user_id', '=', ctx.userId)
      .where('excluded_at', 'is', null).where('audience_deleted_at', 'is', null).executeTakeFirst()
    return filesQuery(trx, ctx).where('id', '=', fileId).executeTakeFirstOrThrow()
  })
}
module.exports = { listFiles, pendingFiles, assertLease, prepareMappings, transitionFile, beginOperation,
  cleanupCandidates, assertCleanupEligible, markAudienceDeleted, PENDING, validPath }
