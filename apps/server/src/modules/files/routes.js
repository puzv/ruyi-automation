const { scripts } = require('@ruyi/shared/tasks')
const fs = require('node:fs')
const path = require('node:path')
const { randomUUID } = require('node:crypto')
const multipart = require('@fastify/multipart')
const { uploadRoot } = require('@ruyi/shared/config')
const { closeBrowserContext } = require('@ruyi/automation/lib/browser.js')
const { groupPlatformNames } = require('@ruyi/automation/lib/file-manifest')
const { decodeUploadedFileName, resolveWorkspace, ensureWorkspace, getWorkspaceStatus, readTaskItems } = require('@ruyi/shared/runtime/workspace')
const { inspectPlatformFiles, inspectAnalyseAudience, inspectInsightResults } = require('./platform')
const { startJob, jobBelongsToUser, cleanupJobStates } = require('../jobs/memory')
const { loadUserState, getStatusSummary } = require('@ruyi/shared/runtime/platform-state/index')
const state = require('../../state')
const jobs = require('@ruyi/shared/runtime/repos/jobs')
const { registerJobRoutes } = require('../jobs/routes')
const { writeLog, auditFromRequest } = require('@ruyi/shared/runtime/audit')

async function registerRoutes(api, options = {}) {
  const dataRoot = options.uploadRoot || uploadRoot
  const workspaceFor = (req) => resolveWorkspace(req.user, dataRoot)
  const legacyStarts = new Set()
  const userHasRunningJob = (req) => options.auth ? jobs.hasRunningJob(api.db, req.user.id) : legacyStarts.has(req.user?.id) || [...state.jobs.values()].some((job) => job.running && jobBelongsToUser(job, req.user))
  const loginRequired = (res) => res.code(409).send({ ok: false, code: 'PLATFORM_LOGIN_REQUIRED', message: '请先完成平台登录' })
  const loadState = async (req) => {
    try { return await loadUserState(api.db, req.user.id, api.stateKeys) } catch (_) { return null }
  }
  api.removeContentTypeParser('application/json')
  api.addContentTypeParser('application/json', { parseAs: 'string', bodyLimit: 2 * 1024 * 1024 }, (_req, body, done) => {
    try { done(null, body === '' ? {} : JSON.parse(body)) } catch (error) {
      error.statusCode = 400
      done(error)
    }
  })
  // 沿用内存接收行为；后续阶段改为流式写盘，暂将单文件上限设为 1GB。
  await api.register(multipart, { limits: { fileSize: 1024 * 1024 * 1024, parts: Infinity, files: Infinity, fields: Infinity, fieldSize: 1024 * 1024 } })
  api.addHook('onClose', async () => {
    await cleanupJobStates()
    for (const context of [...state.activeContexts]) await closeBrowserContext(context).catch(() => {})
  })

  api.get('/api/status', (req, res) => res.send({ ok: true, ...getWorkspaceStatus(workspaceFor(req)) }))
  api.get('/api/login-status', async (req, res) => {
    if (options.auth) {
      const summary = await getStatusSummary(api.db, req.user.id)
      const valid = summary.status === 'valid'
      return res.send({ ok: true, sites: { ruyi: valid, datanexus: valid }, loggedIn: valid, state: summary })
    }
    return res.code(404).send({ ok: false, message: '接口不存在' })
  })
  api.get('/api/runtime-mode', (_req, res) => res.send({ ok: true, headless: state.headlessMode }))
  api.post('/api/runtime-mode', (req, res) => {
    if (typeof req.body?.headless !== 'boolean') {
      return res.code(400).send({ ok: false, message: 'headless 必须是布尔值' })
    }
    state.headlessMode = req.body.headless
    return res.send({ ok: true, headless: state.headlessMode })
  })
  api.get('/api/platform-status', async (req, res) => {
    if (req.user) {
      if (state.platformProbes.has(req.user.id)) return res.code(409).send({ ok: false, message: '平台状态检查正在进行，请稍后重试' })
      state.platformProbes.add(req.user.id)
    } else {
      if ([...state.jobs.values()].some((job) => job.running)) {
        return res.code(409).send({ ok: false, message: '已有脚本正在运行，请等待完成' })
      }
    }
    try {
      const loaded = req.user ? await loadState(req) : null
      if (req.user && !loaded) return loginRequired(res)
      const storageState = loaded?.state
      const workspace = workspaceFor(req)
      const names = readTaskItems(['createGroupToDoList.json', 'creategrouptodolist.json'], workspace)
      const analyseNames = readTaskItems(['analyseToDoList.json'], workspace)
      const doneNames = readTaskItems(['done.json'], workspace)
      const groups = groupPlatformNames(workspace, names)
      const result = { idfaPending: 0, oaidPending: 0, pnPending: 0, insightPending: 0, resultPending: 0 }
      const errors = []
      // 按工作流顺序逐个访问平台地址；单个阶段失败不阻断后续阶段。
      const checks = [
        ['PN 文件列表', async () => { if (groups.pn.length) result.pnPending = (await inspectPlatformFiles('pn', groups.pn, storageState)).missingCount }],
        ['IDFA 文件列表', async () => { if (groups.idfa.length) result.idfaPending = (await inspectPlatformFiles('idfa', groups.idfa, storageState)).missingCount }],
        ['OAID 文件列表', async () => { if (groups.oaid.length) result.oaidPending = (await inspectPlatformFiles('oaid', groups.oaid, storageState)).missingCount }],
        ['人群列表', async () => { if (analyseNames.length) result.insightPending = await inspectAnalyseAudience(analyseNames, storageState) }],
        ['洞悉结果列表', async () => { if (doneNames.length) result.resultPending = await inspectInsightResults(doneNames, storageState) }],
      ]
      for (const [label, check] of checks) {
        try { await check() } catch (error) { errors.push(`${label}：${error.message}`) }
      }
      return res.send({ ok: true, ...result, errors })
    } finally {
      if (req.user) state.platformProbes.delete(req.user.id)
    }
  })
  api.post('/api/import-folder', async (req, res) => {
    req.auditImport = { count: 0, skipped: 0, files: [] }
    if (req.user && await userHasRunningJob(req)) return res.code(409).send({ ok: false, message: '当前用户有任务正在运行，请完成后再导入文件' })
    let files
    try {
      files = []
      if (req.isMultipart()) {
        for await (const part of req.parts()) {
          if (!part.file) continue
          if (part.fieldname !== 'files') throw new Error('非预期的文件字段')
          files.push({ originalname: part.filename, buffer: await part.toBuffer() })
        }
      }
    } catch (error) {
      return res.code(400).send({ ok: false, message: error.message })
    }
    if (req.user && await userHasRunningJob(req)) return res.code(409).send({ ok: false, message: '当前用户有任务正在运行，请完成后再导入文件' })
    try {
      const workspace = ensureWorkspace(workspaceFor(req))
      const rawDir = path.join(workspace, 'raw')
      const importId = req.user ? randomUUID() : null
      let count = 0
      let skipped = 0
      for (const file of files) {
        const relative = decodeUploadedFileName(file.originalname || file.filename).replace(/^[/\\]+/, '')
        const fileName = path.basename(relative.replace(/\\/g, '/'))
        if (fileName.startsWith('.') || !/(?:idfa|oaid|pn)/i.test(fileName) || !/\.(?:txt|csv)$/i.test(fileName)) {
          skipped += 1
          req.auditImport.skipped = skipped
          continue
        }
        const targetDir = req.user ? path.join(rawDir, importId, String(count + 1)) : rawDir
        fs.mkdirSync(targetDir, { recursive: true })
        const target = path.resolve(targetDir, fileName)
        if (!target.startsWith(`${rawDir}${path.sep}`)) throw new Error('非法文件路径')
        if (fs.existsSync(target)) throw new Error(`文件已存在，不会覆盖：${path.basename(target)}`)
        fs.writeFileSync(target, file.buffer, { flag: 'wx' })
        count += 1
        req.auditImport.count = count
        if (req.auditImport.files.length < 100) req.auditImport.files.push(fileName)
      }
      return res.send({ ok: true, count, skipped })
    } catch (error) {
      return res.code(400).send({ ok: false, message: error.code ? '文件导入失败，请联系管理员' : error.message })
    }
  })
  api.post('/api/run/:task', async (req, res) => {
    const script = scripts[req.params.task]
    if (!script) return res.code(404).send({ ok: false, message: '未知操作' })
    if (options.auth) {
      if (!await loadState(req)) return loginRequired(res)
      const id = randomUUID()
      const origin = auditFromRequest(req, {})
      const result = await jobs.enqueueJob(api.db, { id, userId: req.user.id, username: req.user.username,
        task: req.params.task, headless: state.headlessMode, requestId: origin.requestId })
      if (!result.ok) return res.code(result.reason === 'busy' ? 503 : 409).send({ ok: false,
        message: result.reason === 'busy' ? '服务繁忙，请稍后重试' : '排队任务过多，请等待已有任务完成' })
      const job = await jobs.getJob(api.db, id)
      const position = await jobs.queuePosition(api.db, job) + 1
      api.worker?.wake()
      return res.send({ ok: true, id, status: 'queued', position })
    }
    if (req.user) {
      if (userHasRunningJob(req)) return res.code(409).send({ ok: false, message: '当前用户已有任务正在运行，请等待完成' })
      const runningCount = [...state.jobs.values()].filter((job) => job.running).length + legacyStarts.size
      const configuredMax = Number(process.env.RUYI_MAX_CONCURRENT_JOBS)
      const maxJobs = Number.isSafeInteger(configuredMax) && configuredMax > 0 ? configuredMax : 2
      if (runningCount >= maxJobs) return res.code(409).send({ ok: false, message: `服务器繁忙，当前已有 ${runningCount} 个任务在运行，请稍后再试` })
      // 读取登录态之前预留名额，避免并行请求在异步查询期间绕过上限。
      legacyStarts.add(req.user.id)
    } else {
      if ([...state.jobs.values()].some((job) => job.running)) return res.code(409).send({ ok: false, message: '已有脚本正在运行，请等待完成' })
    }
    try {
      const platformState = req.user ? await loadState(req) : null
      if (req.user && !platformState) return loginRequired(res)
      const workspace = ensureWorkspace(workspaceFor(req))
      const origin = auditFromRequest(req, {})
      const id = startJob(req.params.task, script, {
        user: req.user, uploadDir: workspace, platformState, db: api.db, keys: api.stateKeys, log: api.log,
        onFinish: api.auditEnabled ? async (job) => {
          if (job.stateExpired) await writeLog(api.db, {
            ...origin, action: 'platform.state_expired', result: 'success', detail: { jobId: job.id },
          }, api.log)
          await writeLog(api.db, {
            ...origin, action: 'job.finish', targetType: 'job', targetId: job.id,
            result: job.code === 0 ? 'success' : 'failure',
            detail: { task: job.task, code: job.code, signal: job.signal, durationMs: job.durationMs,
              stateRefreshed: job.stateRefreshed, stateExpired: job.stateExpired },
          }, api.log)
        } : undefined,
      })
      return res.send({ ok: true, id })
    } finally {
      if (req.user) legacyStarts.delete(req.user.id)
    }
  })
  if (options.auth) {
    await registerJobRoutes(api, { dataRoot })
  } else {
    api.get('/api/jobs/:id', (req, res) => {
      const job = state.jobs.get(req.params.id)
      if (!job || !jobBelongsToUser(job, req.user)) return res.code(404).send({ ok: false, message: '任务不存在' })
      res.send(job)
    })
  }
}

module.exports = { registerRoutes }
