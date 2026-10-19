const fs = require('node:fs')
const path = require('node:path')
const multipart = require('@fastify/multipart')
const { uploadRoot } = require('../config')
const { launchBrowser, closeBrowserContext } = require('../lib/browser.js')
const { forceReleaseProfile } = require('../lib/preflight.js')
const { decodeUploadedFileName, getWorkspaceStatus, readTaskItems } = require('./workspace')
const { loginTargets, inspectLoginStatus, advanceLoginFlow, advanceExternalLoginFlow, inspectPlatformFiles, inspectAnalyseAudience, inspectInsightResults, trackContext, openExternalUrl } = require('./platform')
const { signalJobProcess, startJob } = require('./jobs')
const state = require('./state')
const { writeLog, auditFromRequest } = require('./audit')

async function registerRoutes(api) {
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
    if (state.loginFlow) {
      state.loginFlow.cancelled = true
      if (state.loginFlow.closeWatch) clearInterval(state.loginFlow.closeWatch)
      state.loginFlow = null
    }
    for (const context of [...state.activeContexts]) await closeBrowserContext(context).catch(() => {})
  })

  api.get('/api/status', (_req, res) => res.send({ ok: true, ...getWorkspaceStatus() }))
  api.get('/api/login-status', async (_req, res) => {
    if (state.profileReleaseRunning) return res.code(409).send({ ok: false, message: 'Profile 资源释放正在进行，请稍候。' })
    if (state.profileProbeRunning) return res.code(409).send({ ok: false, message: '登录状态检查正在进行，请稍后重试。' })
    if ([...state.jobs.values()].some((job) => job.running) || state.loginContexts.size || state.loginFlow) {
      return res.code(409).send({ ok: false, message: '浏览器 Profile 正在执行其他操作，请稍后重试。' })
    }
    state.profileProbeRunning = true
    try {
      const sites = await inspectLoginStatus()
      res.send({ ok: true, sites, loggedIn: Object.values(sites).every(Boolean) })
    } catch (error) {
      res.code(503).send({ ok: false, message: `无法检查登录状态：${error.message}` })
    } finally {
      state.profileProbeRunning = false
    }
  })
  api.post('/api/login-open', async (_req, res) => {
    try {
      if (state.profileReleaseRunning) return res.code(409).send({ ok: false, message: 'Profile 资源释放正在进行，请稍候。' })
      if (state.profileProbeRunning || [...state.jobs.values()].some((job) => job.running)) {
        return res.code(409).send({ ok: false, message: '浏览器 Profile 正在执行其他操作，请稍后重试。' })
      }
      if (state.loginContexts.size || state.loginFlow) {
        return res.code(409).send({ ok: false, message: '登录窗口已打开，请先完成登录后关闭窗口，再重新检测状态。' })
      }
      let status
      state.profileProbeRunning = true
      try {
        status = await inspectLoginStatus()
      } catch (_) {
        // 当前 Profile 可能正被用户打开的 Chrome 占用；此时无法再创建
        // Playwright 上下文，按“两个站点都需要人工确认”处理。
        status = Object.fromEntries(Object.keys(loginTargets).map((key) => [key, false]))
      } finally {
        state.profileProbeRunning = false
      }
      const missing = Object.entries(status).filter(([, loggedIn]) => !loggedIn).map(([key]) => key)
      if (!missing.length) return res.send({ ok: true, opened: [], sites: status })
      let openedContext = null
      try {
        openedContext = trackContext(await launchBrowser({ headless: false }))
        const flow = {
          pending: missing.slice(1),
          currentKey: missing[0],
          context: openedContext,
          page: null,
          closeWatch: null,
          transitioning: false,
          cancelled: false,
          error: null,
        }
        state.loginFlow = flow
        state.loginContexts.add(openedContext)
        const first = openedContext.pages()[0] || await openedContext.newPage()
        flow.page = first
        first.once('close', () => { advanceLoginFlow(flow).catch(() => {}) })
        openedContext.once('close', () => {
          state.loginContexts.delete(openedContext)
          advanceLoginFlow(flow).catch(() => {})
        })
        flow.closeWatch = setInterval(() => {
          if (state.loginFlow !== flow || flow.cancelled) {
            clearInterval(flow.closeWatch)
            flow.closeWatch = null
          } else if (first.isClosed() || openedContext.pages().every((item) => item.isClosed())) {
            clearInterval(flow.closeWatch)
            flow.closeWatch = null
            advanceLoginFlow(flow).catch(() => {})
          }
        }, 500)
        await first.goto(loginTargets[missing[0]].url, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {})
      } catch (error) {
        // If creating/opening the login context failed for a reason other
        // than an already-running Chrome, do not leak a partially-created
        // persistent context (and its Singleton* locks).
        if (openedContext) {
          if (state.loginFlow?.context === openedContext) {
            state.loginFlow.cancelled = true
            state.loginFlow = null
          }
          await closeBrowserContext(openedContext).catch(() => {})
        }
        if (!/ProcessSingleton|profile directory|already in use|Target page, context or browser has been closed/i.test(error.message)) throw error
        // Profile 已被用户打开的 Chrome 占用时，不能再创建第二个
        // Chromium 实例。只打开第一个站点；外部 Chrome 无法提供
        // Playwright 的 page.close 事件，因此由后台轮询 Profile 释放
        // 和登录 Cookie 后再顺序打开下一个站点。
        const flow = {
          external: true,
          pending: missing.slice(1),
          currentKey: missing[0],
          transitioning: false,
          cancelled: false,
          closeWatch: null,
        }
        state.loginFlow = flow
        openExternalUrl(loginTargets[missing[0]].url)
        advanceExternalLoginFlow(flow).catch((error) => {
          if (state.loginFlow === flow) state.loginFlow = null
          flow.error = error
        })
      }
      res.send({ ok: true, opened: missing, sites: status })
    } catch (error) {
      res.code(500).send({ ok: false, message: error.message })
    }
  })
  api.post('/api/profile-release', async (_req, res) => {
    if (state.profileReleaseRunning) return res.code(409).send({ ok: false, message: 'Profile 释放正在进行，请稍候。' })
    if (state.profileProbeRunning) return res.code(409).send({ ok: false, message: '登录或平台状态检查正在进行，请稍候完成后再释放。' })
    state.profileReleaseRunning = true
    const terminatedJobs = []
    try {
      // Tear down contexts owned by this service, then stop workflow child
      // processes. Profile data (cookies/configuration) is never deleted.
      for (const context of [...state.activeContexts]) await closeBrowserContext(context).catch(() => {})
      const runningJobs = [...state.jobs.values()].filter((job) => job.running && job.child)
      for (const job of runningJobs) {
        try { if (signalJobProcess(job, 'SIGTERM')) terminatedJobs.push(job.id) } catch (_) {}
      }
      if (runningJobs.length) await new Promise((resolve) => setTimeout(resolve, 1200))
      for (const job of runningJobs) {
        // The parent may have exited while a spawnSync descendant remains;
        // check/terminate the dedicated process group regardless of the
        // child's `running` flag.
        try { signalJobProcess(job, 'SIGKILL') } catch (_) {}
      }
      const result = forceReleaseProfile({ timeoutMs: 4000, graceMs: 300 })
      const message = result.released
        ? '已强制释放 Profile 相关资源，登录信息和 Profile 数据未被删除。'
        : `释放完成但仍有锁文件占用：${(result.remainingLocks || []).join(', ')}`
      return res.code(result.released ? 200 : 503).send({ ok: result.released, message, ...result, terminatedJobs })
    } catch (error) {
      return res.code(500).send({ ok: false, message: `释放 Profile 失败：${error.message}` })
    } finally {
      state.profileReleaseRunning = false
    }
  })
  api.get('/api/runtime-mode', (_req, res) => res.send({ ok: true, headless: state.headlessMode }))
  api.post('/api/runtime-mode', (req, res) => {
    if (typeof req.body?.headless !== 'boolean') {
      return res.code(400).send({ ok: false, message: 'headless 必须是布尔值' })
    }
    state.headlessMode = req.body.headless
    return res.send({ ok: true, headless: state.headlessMode })
  })
  api.get('/api/platform-status', async (_req, res) => {
    if (state.profileReleaseRunning) return res.code(409).send({ ok: false, message: 'Profile 资源释放正在进行，请稍候。' })
    if (state.profileProbeRunning) return res.code(409).send({ ok: false, message: '平台状态检查正在进行，请稍后重试。' })
    if ([...state.jobs.values()].some((job) => job.running) || state.loginContexts.size || state.loginFlow) {
      return res.code(409).send({ ok: false, message: '浏览器 Profile 正在执行其他操作，请稍后重试。' })
    }
    state.profileProbeRunning = true
    const names = readTaskItems(['createGroupToDoList.json', 'creategrouptodolist.json'])
    const analyseNames = readTaskItems(['analyseToDoList.json'])
    const doneNames = readTaskItems(['done.json'])
    const groups = {
      pn: names.filter((name) => /pn/i.test(name)),
      idfa: names.filter((name) => !/pn/i.test(name) && /idfa/i.test(name)),
      oaid: names.filter((name) => !/pn|idfa/i.test(name) && /oaid/i.test(name)),
    }
    const result = { idfaPending: 0, oaidPending: 0, pnPending: 0, insightPending: 0, resultPending: 0 }
    const errors = []
    try {
      // 按工作流顺序逐个访问平台地址；单个阶段失败不阻断后续阶段。
      const checks = [
        ['PN 文件列表', async () => { if (groups.pn.length) result.pnPending = (await inspectPlatformFiles('pn', groups.pn)).missingCount }],
        ['IDFA 文件列表', async () => { if (groups.idfa.length) result.idfaPending = (await inspectPlatformFiles('idfa', groups.idfa)).missingCount }],
        ['OAID 文件列表', async () => { if (groups.oaid.length) result.oaidPending = (await inspectPlatformFiles('oaid', groups.oaid)).missingCount }],
        ['人群列表', async () => { if (analyseNames.length) result.insightPending = await inspectAnalyseAudience(analyseNames) }],
        ['洞悉结果列表', async () => { if (doneNames.length) result.resultPending = await inspectInsightResults(doneNames) }],
      ]
      for (const [label, check] of checks) {
        try { await check() } catch (error) { errors.push(`${label}：${error.message}`) }
      }
      res.send({ ok: true, ...result, errors })
    } finally {
      state.profileProbeRunning = false
    }
  })
  api.post('/api/import-folder', async (req, res) => {
    req.auditImport = { count: 0, skipped: 0, files: [] }
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
    if (state.profileReleaseRunning) return res.code(409).send({ ok: false, message: 'Profile 资源释放正在进行，请稍候。' })
    try {
      const rawDir = path.resolve(uploadRoot, 'raw')
      fs.mkdirSync(rawDir, { recursive: true })
      let count = 0
      let skipped = 0
      for (const file of files) {
        const relative = decodeUploadedFileName(file.originalname || file.filename).replace(/^[/\\]+/, '')
        const fileName = path.basename(relative)
        if (fileName.startsWith('.') || !/(?:idfa|oaid|pn)/i.test(fileName) || !/\.(?:txt|csv)$/i.test(fileName)) {
          skipped += 1
          req.auditImport.skipped = skipped
          continue
        }
        const target = path.resolve(rawDir, fileName)
        if (!target.startsWith(`${rawDir}${path.sep}`)) throw new Error('非法文件路径')
        if (fs.existsSync(target)) throw new Error(`文件已存在，不会覆盖：${path.basename(target)}`)
        fs.writeFileSync(target, file.buffer)
        count += 1
        req.auditImport.count = count
        if (req.auditImport.files.length < 100) req.auditImport.files.push(fileName)
      }
      res.send({ ok: true, count, skipped })
    } catch (error) { res.code(400).send({ ok: false, message: error.message }) }
  })
  api.post('/api/run/:task', (req, res) => {
    const scripts = { upload: 'uploadAll.js', create: 'createAllGroup.js', analyse: 'analyseAll.js', download: 'downloadAll.js' }
    const script = scripts[req.params.task]
    if (!script) return res.code(404).send({ ok: false, message: '未知操作' })
    if (state.profileReleaseRunning) return res.code(409).send({ ok: false, message: 'Profile 资源释放正在进行，请稍后重试' })
    if (state.profileProbeRunning) return res.code(409).send({ ok: false, message: '登录或平台状态检查正在进行，请稍后重试' })
    if (state.loginContexts.size || state.loginFlow) return res.code(409).send({ ok: false, message: '登录窗口仍在使用 Profile，请完成登录并关闭窗口后再运行任务' })
    if ([...state.jobs.values()].some((job) => job.running)) return res.code(409).send({ ok: false, message: '已有脚本正在运行，请等待完成' })
    const origin = auditFromRequest(req, {})
    const id = startJob(req.params.task, script, {
      onFinish: api.auditEnabled ? (job) => writeLog(api.db, {
        ...origin, action: 'job.finish', targetType: 'job', targetId: job.id,
        result: job.code === 0 ? 'success' : 'failure',
        detail: { task: job.task, code: job.code, signal: job.signal, durationMs: job.durationMs },
      }, api.log) : undefined,
    })
    res.send({ ok: true, id })
  })
  api.get('/api/jobs/:id', (req, res) => {
    const job = state.jobs.get(req.params.id)
    if (!job) return res.code(404).send({ ok: false, message: '任务不存在' })
    res.send(job)
  })
}

module.exports = { registerRoutes }
