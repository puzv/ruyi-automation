const path = require('node:path')
const fs = require('node:fs')
const repo = require('./repos/task-execution')
let connection
function enabled() {
  return ['RUYI_TASK_ID', 'RUYI_EXECUTION_JOB_ID', 'RUYI_JOB_CLAIM_TOKEN', 'RUYI_TASK_CLAIM_TOKEN'].some((key) => Boolean(process.env[key]))
}
function context() {
  return { taskId: process.env.RUYI_TASK_ID, userId: process.env.RUYI_USER_ID,
    jobId: process.env.RUYI_EXECUTION_JOB_ID, claimToken: process.env.RUYI_JOB_CLAIM_TOKEN,
    taskClaimToken: process.env.RUYI_TASK_CLAIM_TOKEN }
}
function db() {
  if (!enabled()) throw new Error('缺少整任务数据库上下文')
  if (!connection) connection = require('../../../db').createDb()
  return connection
}
async function close() { if (connection) { const value = connection; connection = null; await value.destroy() } }
function mapping(row) {
  if (typeof row.current_path !== 'string' || !/^execution\/(idfa|oaid|pn)\//.test(row.current_path)
    || row.current_path.includes('\\') || row.current_path.split('/').some((part) => !part || part === '.' || part === '..')) {
    throw Object.assign(new Error('任务执行文件路径无效'), { code: 'TASK_DATABASE_ERROR' })
  }
  return { id: row.id, platformName: row.platform_name, originalName: row.original_name,
    type: row.file_type, jobId: row.task_id, sequence: Number(row.sequence), stage: row.stage,
    originalPath: row.original_path, currentPath: row.current_path.replace(/^execution\//, '') }
}
async function files() { return repo.listFiles(db(), context()) }
async function pending(step) {
  let rows = await repo.pendingFiles(db(), context(), step)
  if (process.env.RUYI_TASK_FILE_ID) rows = rows.filter((row) => row.id === process.env.RUYI_TASK_FILE_ID)
  return rows
}
async function requireMapping(root, name) {
  const stem = path.basename(name).replace(/\.(txt|csv)$/i, '')
  const row = (await files()).find((item) => !item.excluded_at && item.platform_name === stem)
  if (!row) throw Object.assign(new Error('数据库中找不到任务文件映射，已停止执行'), { code: 'TASK_DATABASE_ERROR' })
  return mapping(row)
}
async function updateStage(root, name, stage, currentPath) {
  const row = await requireMapping(root, name)
  return repo.transitionFile(db(), context(), { fileId: row.id, fromStages: [row.stage], toStage: stage,
    ...(currentPath ? { currentPath: `execution/${path.relative(root, currentPath).split(path.sep).join('/')}` } : {}) })
}
async function beginOperation(root, name, operation) {
  const row = await requireMapping(root, name)
  return repo.beginOperation(db(), context(), { fileId: row.id, operation })
}
async function candidates(root) {
  return (await pending('upload')).map((row) => {
    const record = mapping(row)
    const file = path.join(root, record.currentPath)
    let cursor = root
    for (const part of ['', ...record.currentPath.split('/')]) {
      cursor = path.join(cursor, part)
      if (fs.lstatSync(cursor).isSymbolicLink()) throw new Error('任务执行路径包含符号链接')
    }
    const stat = fs.lstatSync(file)
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('任务执行文件不安全')
    return { path: file, originalName: record.originalName, type: record.type, record }
  })
}
async function runAll(step, script, spawn = require('node:child_process').spawnSync) {
  const { TASK_OUTCOME } = require('./task-outcome')
  if (!path.isAbsolute(script)) throw new Error('任务执行脚本必须使用绝对路径')
  if (step === 'upload') {
    let remaining = await pending(step)
    while (remaining.length) {
      const childEnv = { ...process.env }
      delete childEnv.RUYI_TASK_FILE_ID
      const result = spawn(process.execPath, [script], { stdio: 'inherit', env: childEnv })
      if (result.error || result.status !== TASK_OUTCOME.SUCCESS) return TASK_OUTCOME.FAILURE
      const next = await pending(step)
      if (next.length >= remaining.length) throw Object.assign(new Error('上传脚本退出成功但文件阶段未推进，已停止执行'), { code: 'TASK_DATABASE_ERROR' })
      remaining = next
    }
    return TASK_OUTCOME.SUCCESS
  }
  const initial = await pending(step)
  for (const row of initial) {
    await repo.assertLease(db(), context())
    const result = spawn(process.execPath, [script], {
      stdio: 'inherit', env: { ...process.env, RUYI_TASK_FILE_ID: row.id },
    })
    if (result.error || (result.status !== 0 && result.status !== TASK_OUTCOME.NOT_READY)) return TASK_OUTCOME.FAILURE
    if (result.status === 0 && (await pending(step)).some((item) => item.id === row.id)) {
      throw Object.assign(new Error('脚本退出成功但文件阶段未推进，已停止执行'), { code: 'TASK_DATABASE_ERROR' })
    }
  }
  return (await pending(step)).length ? TASK_OUTCOME.NOT_READY : TASK_OUTCOME.SUCCESS
}
module.exports = { enabled, context, db, close, mapping, files, pending, requireMapping, updateStage, beginOperation, candidates, runAll }
