const fs = require('node:fs/promises')
const { constants } = require('node:fs')
const path = require('node:path')
const jobs = require('@ruyi/shared/runtime/repos/jobs')
const { resolveWorkspace } = require('@ruyi/shared/runtime/workspace')
const { resultEntries, zipStream } = require('@ruyi/shared/runtime/job-results')

function pagination(query) {
  const parse = (value, fallback) => value === undefined ? fallback
    : typeof value === 'string' && /^[1-9]\d*$/.test(value) && Number.isSafeInteger(Number(value)) ? Number(value) : null
  const page = parse(query.page, 1), size = parse(query.pageSize, 20)
  const pageSize = Math.min(size, 100)
  return page && size && Number.isSafeInteger((page - 1) * pageSize) ? { page, pageSize } : null
}

async function publicJob(db, row) {
  return { id: row.id, task: row.task, status: row.status,
    position: row.status === 'queued' ? await jobs.queuePosition(db, row) + 1 : 0,
    queuedAt: row.queued_at, startedAt: row.started_at, finishedAt: row.finished_at,
    exitCode: row.exit_code, errorMessage: row.error_message, cancelRequested: Boolean(row.cancel_requested),
    running: row.status === 'running', code: row.exit_code }
}

async function readJobLog(row, dataRoot, maxBytes) {
  if (!row.log_path || !/^[a-f0-9-]{36}$/.test(row.id) || row.log_path !== `logs/${row.id}.log`) return { output: '', truncated: false }
  let file
  try {
    const workspace = resolveWorkspace({ username: row.username }, dataRoot)
    const dir = path.join(workspace, 'logs')
    if ((await fs.lstat(dir)).isSymbolicLink()) return { output: '', truncated: false }
    file = await fs.open(path.join(workspace, row.log_path), constants.O_RDONLY | constants.O_NOFOLLOW)
    const stat = await file.stat()
    if (!stat.isFile()) return { output: '', truncated: false }
    const size = Math.min(stat.size, maxBytes)
    const buffer = Buffer.alloc(size)
    const { bytesRead } = await file.read(buffer, 0, size, Math.max(0, stat.size - size))
    return { output: buffer.subarray(0, bytesRead).toString('utf8'), truncated: stat.size > maxBytes }
  } catch (error) {
    if (['ENOENT', 'ELOOP', 'ENOTDIR'].includes(error.code)) return { output: '', truncated: false }
    throw new Error('读取任务日志失败，请联系管理员')
  } finally {
    await file?.close()
  }
}

async function registerJobRoutes(app, { dataRoot }) {
  const notFound = (reply) => reply.code(404).send({ ok: false, message: '任务不存在' })
  const ownJob = (req) => jobs.getJobForUser(app.db, req.params.id, req.user.id)
  app.get('/api/jobs', async (req, reply) => {
    const paging = pagination(req.query)
    if (!paging) return reply.code(400).send({ ok: false, message: '分页参数必须为正整数' })
    const result = await jobs.listJobs(app.db, { userId: req.user.id, ...paging })
    return { ok: true, ...result, items: await Promise.all(result.items.map((row) => publicJob(app.db, row))), ...paging }
  })
  app.get('/api/jobs/active', async (req) => {
    const row = await jobs.activeJobForUser(app.db, req.user.id)
    return { ok: true, job: row ? await publicJob(app.db, row) : null }
  })
  app.get('/api/jobs/:id', async (req, reply) => {
    const row = await ownJob(req)
    if (!row) return notFound(reply)
    const job = { ...await publicJob(app.db, row), ...(await readJobLog(row, dataRoot, 64 * 1024)) }
    delete job.truncated
    return { ok: true, job, running: job.running, code: job.code, output: job.output }
  })
  app.get('/api/jobs/:id/log', async (req, reply) => {
    const row = await ownJob(req)
    if (!row) return notFound(reply)
    const { output, truncated } = await readJobLog(row, dataRoot, 5 * 1024 * 1024)
    return reply.type('text/plain; charset=utf-8').send(`${truncated ? '（日志过长，仅显示最后 5MB）\n' : ''}${output}`)
  })
  const resultsFor = async (req, reply) => {
    const row = await ownJob(req)
    if (!row) { notFound(reply); return null }
    if (row.task !== 'download' || row.status !== 'succeeded') {
      reply.code(409).send({ ok: false, message: '仅成功的下载结果任务可以下载 ZIP' }); return null
    }
    try {
      const workspace = resolveWorkspace(req.user, dataRoot)
      return { workspace, entries: resultEntries(workspace, row.id) }
    } catch (error) {
      reply.code(409).send({ ok: false, message: error.code === 'ENOENT'
        ? '该任务没有结果归档（旧任务不支持重新下载）'
        : /^(?:结果|本次任务)/.test(error.message) && !error.code ? error.message
          : '本次任务结果不可下载，归档不完整' })
      return null
    }
  }
  app.get('/api/jobs/:id/results', async (req, reply) => {
    const result = await resultsFor(req, reply)
    if (!result) return
    return { ok: true, count: result.entries.files.length, size: result.entries.size }
  })
  app.get('/api/jobs/:id/results.zip', async (req, reply) => {
    const result = await resultsFor(req, reply)
    if (!result) return
    const stream = zipStream(result.workspace, req.params.id, result.entries)
    reply.raw.once('close', () => stream.destroy())
    return reply.header('Cache-Control', 'private, no-store')
      .header('X-Content-Type-Options', 'nosniff')
      .header('Content-Disposition', `attachment; filename="ruyi-results-${req.params.id}.zip"`)
      .header('Content-Length', result.entries.size).type('application/zip').send(stream)
  })
  app.post('/api/jobs/:id/cancel', async (req, reply) => {
    const result = await jobs.requestCancel(app.db, { id: req.params.id, userId: req.user.id })
    if (!result) return notFound(reply)
    return { ok: true, result }
  })
  app.get('/api/admin/jobs', async (req, reply) => {
    const paging = pagination(req.query)
    if (!paging) return reply.code(400).send({ ok: false, message: '分页参数必须为正整数' })
    if (req.query.status && !['queued', 'running', 'succeeded', 'failed', 'cancelled', 'interrupted'].includes(req.query.status)) {
      return reply.code(400).send({ ok: false, message: '任务状态无效' })
    }
    const result = await jobs.listJobs(app.db, { username: req.query.username, status: req.query.status, ...paging })
    return { ok: true, ...result, items: await Promise.all(result.items.map(async (row) => ({
      ...await publicJob(app.db, row), username: row.username,
    }))), ...paging }
  })
}

module.exports = { registerJobRoutes }
