const { browserHeadless } = require('@ruyi/shared/config')
// 自动推进引擎：在服务端按用户轮询平台，平台处理完成后自动提交下一个任务。
//
// 与“检测当前状态”的区别：那是用户手动触发的一次性检查；这里由后台定时执行，
// 且只推进到“洞悉结果就绪”为止——结果下载仍由用户手动发起。
//
// 只在确实有待办时探测平台（每次探测都要启动无头浏览器），并且：
// - 同一用户同时只允许一个任务在运行，运行期间不探测；
// - 复用 state.platformProbes，避免与手动检查同时启动浏览器；
// - 只对近期有任务活动的用户生效，避免服务重启后替用户补做很久以前的待办；
// - 状态长时间没有变化就停下并提示人工确认，避免为卡住的结果无限启动浏览器。
const fs = require('node:fs')
const path = require('node:path')
const { randomUUID } = require('node:crypto')

const jobs = require('@ruyi/shared/runtime/repos/jobs')
const users = require('@ruyi/shared/runtime/repos/users')
const autoAdvanceRepo = require('@ruyi/shared/runtime/repos/auto-advance')
const { loadUserState } = require('@ruyi/shared/runtime/platform-state/index')
const { writeLog } = require('@ruyi/shared/runtime/audit')
const { getWorkspaceStatus, readTaskItems, readPendingAnalyseItems, resolveWorkspace, ensureWorkspace } = require('@ruyi/shared/runtime/workspace')
const { groupPlatformNames } = require('@ruyi/automation/lib/file-manifest')
const platform = require('../files/platform')
const runtime = require('../../state')

// 默认 5 分钟一轮。每次探测都要启动无头浏览器，平台侧的处理本身也是分钟级，
// 更密的间隔只会增加平台压力而不会让结果更早出现。
const DEFAULT_INTERVAL_MS = 5 * 60 * 1000
const MIN_INTERVAL_MS = 15000
const DEFAULT_MAX_STALLED = 20
const ACTIVITY_HOURS = 12
const LOGIN_RETRY_MS = 5 * 60 * 1000
// Two retries after the initial automatic submission (three attempts total).
const MAX_NOT_READY_RETRIES = 2
// 迁移 006 未执行时给出可操作的提示，而不是把 MySQL 的英文报错直接抛到界面。
const MISSING_TABLE = '自动推进尚未初始化（数据库缺少 ruyi_auto_advance 表），请联系管理员执行迁移 006'

// 界面与接口统一使用这些阶段名，文案在服务端集中维护。
const PHASES = {
  idle: '当前没有需要自动推进的任务',
  waitingFiles: '正在等待平台处理上传文件',
  readyCreate: '平台文件已就绪，正在创建人群包',
  waitingAudience: '正在等待平台生成人群包',
  readyAnalyse: '人群包已就绪，正在提交人群洞悉',
  waitingResults: '正在等待洞悉结果生成',
  resultsReady: '洞悉结果已就绪，请手动下载',
  stalled: '平台状态长时间未变化，请手动检查',
  loginRequired: '平台登录已失效，请重新登录',
  error: '自动检查失败，稍后重试',
  paused: '自动推进已关闭',
}

function configuredInterval(value) {
  const number = Number(value ?? process.env.RUYI_AUTO_ADVANCE_INTERVAL_MS)
  if (!Number.isFinite(number) || number <= 0) return DEFAULT_INTERVAL_MS
  return Math.max(MIN_INTERVAL_MS, Math.floor(number))
}

function listWorkspaceNames(dataRoot) {
  try {
    return fs.readdirSync(path.join(path.resolve(dataRoot), 'users'), { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
      .map((entry) => entry.name)
      .sort()
  } catch (_) {
    return []
  }
}

// 纯函数：根据工作区待办与平台探测结果决定下一步，便于单独测试。
function decide(status, pending) {
  if (status.createCount > 0) {
    return Number(pending.files) > 0
      ? { phase: 'waitingFiles', pending: { files: Number(pending.files) } }
      : { phase: 'readyCreate', pending: { files: 0 } }
  }
  if (status.analyseCount > 0) {
    return Number(pending.audiences) > 0
      ? { phase: 'waitingAudience', pending: { audiences: Number(pending.audiences) } }
      : { phase: 'readyAnalyse', pending: { audiences: 0 } }
  }
  if (status.doneCount > 0) {
    return Number(pending.results) > 0
      ? { phase: 'waitingResults', pending: { results: Number(pending.results) } }
      : { phase: 'resultsReady', pending: { results: 0 } }
  }
  return { phase: 'idle', pending: {} }
}

function pendingKey(pending) {
  return ['files', 'audiences', 'results'].map((key) => Number(pending[key] || 0)).join('/')
}

// MySQL 5.7 与 Kysely 对缺表的报错码分别是 ER_NO_SUCH_TABLE / 42P01。
function missingTable(error) {
  return Boolean(error) && (error.code === 'ER_NO_SUCH_TABLE' || /doesn't exist|no such table/i.test(error.message || ''))
}

function createAutoAdvance({ db, keys, dataRoot, log, intervalMs, maxStalled = DEFAULT_MAX_STALLED,
  activityHours = ACTIVITY_HOURS, deps = {} } = {}) {
  const interval = configuredInterval(intervalMs)
  const records = new Map()
  const settingVersions = new Map()
  const userOperations = new Map()
  // started 控制是否已经安排定时器；stopped 只在显式停止后为真。
  // tick() 可以被单独调用（测试与手动唤醒），不受 started 影响。
  let started = false
  let stopped = false
  let timer = null
  let wakeTimer = null
  // 定时检查与唤醒检查共用同一条链：同一时刻只有一轮在探测，不会并发启动多个浏览器，
  // stop() 也能等到所有已开始的检查结束。
  let chain = Promise.resolve()
  let queuedTick = null

  const api = {
    status: deps.getWorkspaceStatus ?? getWorkspaceStatus,
    readItems: deps.readTaskItems ?? readTaskItems,
    readPendingAnalyse: deps.readPendingAnalyseItems ?? readPendingAnalyseItems,
    resolve: deps.resolveWorkspace ?? resolveWorkspace,
    ensure: deps.ensureWorkspace ?? ensureWorkspace,
    groupNames: deps.groupPlatformNames ?? groupPlatformNames,
    inspectFiles: deps.inspectPlatformFiles ?? ((type, names, state) => platform.inspectPlatformFiles(type, names, state, { headless: browserHeadless })),
    inspectAudience: deps.inspectAnalyseAudience ?? ((names, state) => platform.inspectAnalyseAudience(names, state, { headless: browserHeadless })),
    inspectResults: deps.inspectInsightResults ?? ((names, state) => platform.inspectInsightResults(names, state, { headless: browserHeadless })),
    isEnabled: deps.isEnabled ?? ((userId) => autoAdvanceRepo.isEnabled(db, userId)),
    setEnabledRow: deps.setEnabled ?? ((userId, enabled) => autoAdvanceRepo.setEnabled(db, userId, enabled)),
    activeJob: deps.activeJobForUser ?? ((userId) => jobs.activeJobForUser(db, userId)),
    getJob: deps.getJob ?? ((jobId) => jobs.getJob(db, jobId)),
    hasRecentJob: deps.hasRecentJob ?? ((userId, hours, tasks) => jobs.hasJobSince(db, userId, hours, tasks)),
    loadState: deps.loadUserState ?? ((userId) => loadUserState(db, userId, keys)),
    findUser: deps.findByUsername ?? ((username) => users.findByUsername(db, username)),
    listNames: deps.listWorkspaceNames ?? (() => listWorkspaceNames(dataRoot)),
    enqueue: deps.enqueue ?? ((user, task) => enqueueTask(user, task)),
    probes: deps.platformProbes ?? runtime.platformProbes,
    writeLog: deps.writeLog ?? ((entry) => writeLog(db, entry, log)),
    clock: deps.clock ?? (() => Date.now()),
  }

  async function enqueueTask(user, task) {
    const active = await jobs.activeJobForUser(db, user.id)
    if (active) return { ok: false, reason: 'busy', jobId: active.id }
    let platformState
    try { platformState = await loadUserState(db, user.id, keys) } catch (_) { /* 对外统一提示重新登录 */ }
    if (!platformState) return { ok: false, reason: 'login_required' }
    const id = randomUUID()
    const result = await jobs.enqueueJob(db, {
      id, userId: user.id, username: user.username, task, headless: browserHeadless, requestId: null,
    })
    return result.ok ? { ok: true, jobId: id } : { ok: false, reason: result.reason }
  }

  function record(user) {
    let entry = records.get(user.id)
    if (!entry) {
      entry = { userId: user.id, username: user.username, phase: 'idle', message: PHASES.idle,
        pending: {}, checkedAt: null, nextCheckAt: 0, signature: null, stalled: 0, lastJobId: null,
        lastAttempt: null, error: null, busy: false, notReadyRetries: 0, retryPending: false }
      records.set(user.id, entry)
    }
    entry.username = user.username
    return entry
  }

  function setPhase(entry, phase, extra = {}) {
    entry.phase = phase
    entry.message = PHASES[phase]
    Object.assign(entry, extra)
  }

  function workflowSignature(workspace, status) {
    const names = status.createCount > 0
      ? Object.values(api.groupNames(workspace, status.createNames) || {}).flat().sort()
      : status.analyseCount > 0
      ? api.readPendingAnalyse(workspace).map(String).sort()
      : status.doneCount > 0
      ? api.readItems(['done.json'], workspace).map(String).sort()
      : []
    return JSON.stringify({ counts: [status.createCount, status.analyseCount, status.doneCount], names })
  }

  function recentTaskTypes(status) {
    if (status.createCount > 0) return ['upload', 'create']
    if (status.analyseCount > 0) return ['create', 'analyse']
    if (status.doneCount > 0) return ['analyse', 'download']
    return []
  }

  // 同用户的设置写入和实际提交串行；关闭返回时，先前提交已结束，后续提交会读到关闭。
  async function withUserOperation(userId, operation) {
    const previous = userOperations.get(userId) || Promise.resolve()
    const current = previous.catch(() => {}).then(operation)
    userOperations.set(userId, current)
    try { return await current } finally {
      if (userOperations.get(userId) === current) userOperations.delete(userId)
    }
  }

  function changedSetting(userId, version) {
    return (settingVersions.get(userId) || 0) !== version
  }

  async function canContinue(userId, entry, version) {
    if (stopped || changedSetting(userId, version)) return false
    const enabled = await api.isEnabled(userId)
    // 停止后不得再探测或提交：await 期间 stop() 可能已经发生。
    if (stopped || changedSetting(userId, version)) return false
    if (!enabled) {
      stopPolling(entry, 'paused', null)
      entry.pending = {}
      return false
    }
    return true
  }

  function stopPolling(entry, phase, error = null) {
    setPhase(entry, phase, { error })
    entry.nextCheckAt = Number.POSITIVE_INFINITY
  }

  // 只探测当前步骤真正需要的平台数据，减少浏览器启动次数。
  async function probe(workspace, status, storageState) {
    if (status.createCount > 0) {
      const groups = api.groupNames(workspace, status.createNames)
      const result = { files: 0, audiences: 0, results: 0 }
      for (const type of ['pn', 'idfa', 'oaid']) {
        if (!groups[type]?.length) continue
        const checked = await api.inspectFiles(type, groups[type], storageState)
        result.files += Number(checked?.missingCount || 0)
      }
      return result
    }
    if (status.analyseCount > 0) {
      const names = api.readPendingAnalyse(workspace)
      return { files: 0, audiences: Number(await api.inspectAudience(names, storageState) || 0), results: 0 }
    }
    if (status.doneCount > 0) {
      const names = api.readItems(['done.json'], workspace)
      return { files: 0, audiences: 0, results: Number(await api.inspectResults(names, storageState) || 0) }
    }
    return { files: 0, audiences: 0, results: 0 }
  }

  async function check(user, entry) {
    if (entry.busy) return
    entry.busy = true
    const settingVersion = settingVersions.get(user.id) || 0
    const retryLater = (phase, delay, error = null) => {
      setPhase(entry, phase, { error })
      entry.nextCheckAt = api.clock() + delay
    }
    try {
      const workspace = api.resolve(user, dataRoot)
      const status = api.status(workspace)
      const signature = workflowSignature(workspace, status)
      // 结果已就绪且工作区没有新变化：彻底停止探测，等用户手动下载或导入新文件。
      if (entry.phase === 'resultsReady' && entry.signature === signature) {
        entry.nextCheckAt = Number.POSITIVE_INFINITY
        return
      }
      if (entry.signature !== signature) {
        entry.signature = signature
        entry.stalled = 0
        entry.lastAttempt = null
        entry.notReadyRetries = 0
        entry.retryPending = false
      }
      if (!status.createCount && !status.analyseCount && !status.doneCount) {
        setPhase(entry, 'idle', { pending: {}, error: null })
        entry.nextCheckAt = api.clock() + interval
        return
      }
      let enabled
      try {
        enabled = await api.isEnabled(user.id)
      } catch (error) {
        if (changedSetting(user.id, settingVersion)) return
        // 迁移未执行时每轮都会失败，直接停轮询，避免刷日志和反复查库。
        if (missingTable(error)) {
          stopPolling(entry, 'error', MISSING_TABLE)
          log?.warn?.('自动推进：数据库缺少 ruyi_auto_advance 表，已停止检查，请执行迁移 006')
          return
        }
        throw error
      }
      if (changedSetting(user.id, settingVersion)) return
      if (!enabled) {
        stopPolling(entry, 'paused', null)
        entry.pending = {}
        return
      }
      // 有任务在跑（排队或运行中）时平台状态一定还会变，等任务结束再探测。
      const active = await api.activeJob(user.id)
      if (changedSetting(user.id, settingVersion)) return
      if (active) {
        if (entry.phase === 'idle' || entry.phase === 'paused') setPhase(entry, 'waitingFiles', { pending: {} })
        entry.nextCheckAt = api.clock() + Math.ceil(interval / 2)
        return
      }
      if (api.probes.has(user.id)) {
        entry.nextCheckAt = api.clock() + Math.ceil(interval / 2)
        return
      }
      const recent = await api.hasRecentJob(user.id, activityHours, recentTaskTypes(status))
      if (changedSetting(user.id, settingVersion)) return
      if (!recent) {
        // 没有近期任务活动：不替用户处理历史遗留待办，避免非预期地消耗平台额度。
        setPhase(entry, 'idle', { pending: {}, error: '近期没有任务活动，未自动检查平台' })
        entry.nextCheckAt = api.clock() + interval
        return
      }
      let platformState
      try { platformState = await api.loadState(user.id) } catch (_) { platformState = null }
      if (changedSetting(user.id, settingVersion)) return
      if (!platformState) {
        retryLater('loginRequired', LOGIN_RETRY_MS)
        return
      }
      if (!await canContinue(user.id, entry, settingVersion) || changedSetting(user.id, settingVersion)) return
      api.ensure(workspace)
      api.probes.add(user.id)
      let pending
      try {
        pending = await probe(workspace, status, platformState.state)
      } catch (error) {
        if (changedSetting(user.id, settingVersion)) return
        log?.warn?.(`自动推进：平台检查失败（${user.username}）：${error.message}`)
        retryLater(/登录|未打开成功/.test(error.message) ? 'loginRequired' : 'error',
          /登录|未打开成功/.test(error.message) ? LOGIN_RETRY_MS : interval, error.message)
        return
      } finally {
        api.probes.delete(user.id)
      }
      // 探测耗时期间设置已改变时直接丢弃；不能用旧检查覆盖最新开启状态。
      if (!await canContinue(user.id, entry, settingVersion) || changedSetting(user.id, settingVersion)) return
      if (workflowSignature(workspace, api.status(workspace)) !== signature) {
        entry.nextCheckAt = 0
        return
      }
      entry.checkedAt = api.clock()
      const outcome = decide(status, pending)
      const key = pendingKey(outcome.pending)
      if (key === pendingKey(entry.pending) && entry.phase === outcome.phase) {
        entry.stalled += 1
      } else {
        entry.stalled = 0
      }
      entry.pending = outcome.pending
      if (entry.stalled >= maxStalled) {
        stopPolling(entry, 'stalled', '平台状态长时间没有变化，已停止自动检查')
        log?.warn?.(`自动推进：${user.username} 的状态连续 ${entry.stalled} 次没有变化，已暂停检查`)
        return
      }
      if (outcome.phase === 'readyCreate' || outcome.phase === 'readyAnalyse') {
        const task = outcome.phase === 'readyCreate' ? 'create' : 'analyse'
        let previous = null
        let retryingNotReady = false
        if (entry.lastAttempt && entry.lastAttempt.signature === signature && entry.lastAttempt.task === task) {
          try { previous = await api.getJob(entry.lastAttempt.jobId) } catch (_) { previous = null }
        }
        // 上一轮自动提交的任务跑完后待办没有变化：说明脚本没有推进清单
        // （例如平台拒绝、页面改版）。此时继续提交只会反复消耗平台额度，
        // 因此停下并要求人工确认。
        if (previous) {
          const notReady = previous.status === 'failed' && Number(previous.exit_code ?? previous.exitCode) === 2
          if (notReady && entry.notReadyRetries < MAX_NOT_READY_RETRIES) {
            if (!entry.retryPending) {
              // 先等待完整间隔，再把同一任务重新入队；保留上次任务以便限制重试次数。
              entry.retryPending = true
              retryLater(outcome.phase, interval, previous.error_message || previous.errorMessage || '平台暂未就绪，稍后重试')
              return
            }
            entry.notReadyRetries += 1
            entry.retryPending = false
            retryingNotReady = true
            entry.lastAttempt = null
            previous = null
          }
          if (notReady && previous) {
            stopPolling(entry, 'stalled', `${task === 'create' ? '创建人群' : '人群洞悉'}平台暂未就绪，已达到自动重试上限，请手动检查`)
            return
          }
          if (previous) {
            stopPolling(entry, 'stalled', `${task === 'create' ? '创建人群' : '人群洞悉'}任务未推进待办，已停止自动重试，请手动检查`)
            log?.warn?.(`自动推进：${user.username} 的${task}任务未推进待办，已停止自动重试`)
            return
          }
        }
        if (!retryingNotReady && entry.lastAttempt && entry.lastAttempt.signature === signature && entry.lastAttempt.task === task) {
          stopPolling(entry, 'stalled', `${task === 'create' ? '创建人群' : '人群洞悉'}任务状态无法确认且未推进待办，已停止自动重试，请手动检查`)
          return
        }
        await withUserOperation(user.id, async () => {
          if (!await canContinue(user.id, entry, settingVersion) || changedSetting(user.id, settingVersion)) return
          setPhase(entry, outcome.phase, { error: null })
          const result = await api.enqueue(user, task)
          if (result.ok) {
            entry.lastJobId = result.jobId
            entry.lastAttempt = { signature, task, jobId: result.jobId }
            // 入队成功后日志失败不能把任务报告成提交失败。
            try {
              await api.writeLog({
                userId: user.id, username: user.username, action: 'job.start', targetType: 'job', targetId: result.jobId,
                result: 'success', detail: { task, auto: true, queued: true },
              })
            } catch (error) {
              log?.warn?.(`自动推进：任务已提交，但记录操作日志失败（${user.username}）：${error.message}`)
            }
            entry.nextCheckAt = api.clock() + Math.ceil(interval / 2)
          } else if (result.reason === 'login_required') {
            retryLater('loginRequired', LOGIN_RETRY_MS)
          } else {
            retryLater('error', interval, '任务提交失败，请稍后重试')
          }
        })
        return
      }
      if (outcome.phase === 'resultsReady') {
        // 明确停下：结果下载由用户自己决定，引擎不再轮询。
        stopPolling(entry, 'resultsReady', null)
        log?.info?.(`自动推进：${user.username} 的洞悉结果已就绪，等待手动下载`)
        return
      }
      setPhase(entry, outcome.phase, { error: null })
      entry.nextCheckAt = api.clock() + interval
    } catch (error) {
      if (!changedSetting(user.id, settingVersion)) retryLater('error', interval, error.message)
    } finally {
      entry.busy = false
    }
  }

  async function scanUsers() {
    for (const username of api.listNames()) {
      if (stopped) return
      let user
      try { user = await api.findUser(username) } catch (_) { continue }
      if (!user || user.status !== 'active') continue
      const entry = record(user)
      if (entry.busy) continue
      if (entry.nextCheckAt && entry.nextCheckAt > api.clock()) continue
      await check(user, entry)
    }
  }

  // 所有检查（定时、唤醒、手动调用）都经过这里排队，保证全局只有一轮在探测。
  // 尚未开始的排队轮次可以合并：它开始时必然会读到最新的工作区与开关状态。
  function tick() {
    if (stopped) return Promise.resolve()
    if (queuedTick) return queuedTick
    const run = chain.then(() => {
      queuedTick = null
      return stopped ? undefined : scanUsers()
    })
    queuedTick = run
    chain = run.catch(() => {})
    return run
  }

  function schedule(delay = interval) {
    if (stopped) return
    clearTimeout(timer)
    timer = setTimeout(() => {
      timer = null
      tick()
        .catch(() => log?.error?.('自动推进检查失败，将在下次重试'))
        .finally(() => schedule())
    }, delay)
    timer?.unref?.()
  }

  function wake(userId) {
    if (stopped) return
    if (userId != null) {
      const entry = records.get(userId)
      if (entry) entry.nextCheckAt = 0
    }
    clearTimeout(wakeTimer)
    // 任务刚结束时立刻检查一次，但合并同一时刻的多次唤醒。
    wakeTimer = setTimeout(() => {
      wakeTimer = null
      tick().catch(() => log?.error?.('自动推进检查失败，将在下次重试'))
    }, 200)
    wakeTimer?.unref?.()
  }

  async function start() {
    if (started || stopped) return
    started = true
    // 启动后稍等片刻再首次检查，避免和 Worker 恢复中断任务抢浏览器。
    schedule(5000)
  }

  async function stop() {
    started = false
    stopped = true
    clearTimeout(timer); timer = null
    clearTimeout(wakeTimer); wakeTimer = null
    // 等待正在进行的探测与提交结束；排队中的轮次会因 stopped 直接跳过。
    await chain
    records.clear()
  }

  async function describe(userId) {
    let enabled
    try {
      enabled = await api.isEnabled(userId)
    } catch (error) {
      log?.warn?.('自动推进：读取开关失败')
      return { enabled: false, phase: 'error', message: PHASES.error, pending: {}, checkedAt: null,
        nextCheckAt: null, error: missingTable(error) ? MISSING_TABLE : '读取自动推进设置失败，请稍后重试',
        lastJobId: null, stalled: 0 }
    }
    const entry = records.get(userId)
    if (!entry) {
      const phase = enabled ? 'idle' : 'paused'
      return { enabled, phase, message: PHASES[phase], pending: {}, checkedAt: null,
        nextCheckAt: null, error: null, lastJobId: null, stalled: 0 }
    }
    return {
      enabled, phase: entry.phase, message: entry.message, pending: entry.pending,
      checkedAt: entry.checkedAt,
      nextCheckAt: Number.isFinite(entry.nextCheckAt) ? entry.nextCheckAt : null,
      error: entry.error, lastJobId: entry.lastJobId, stalled: entry.stalled,
    }
  }

  async function setEnabled(userId, enabled) {
    return withUserOperation(userId, async () => {
      try {
        await api.setEnabledRow(userId, enabled)
      } catch (error) {
        if (!missingTable(error)) throw error
        return { enabled: false, phase: 'error', message: PHASES.error, pending: {}, checkedAt: null,
          nextCheckAt: null, error: MISSING_TABLE, lastJobId: null, stalled: 0 }
      }
      settingVersions.set(userId, (settingVersions.get(userId) || 0) + 1)
      const entry = records.get(userId)
      if (entry) {
        entry.nextCheckAt = enabled ? 0 : Number.POSITIVE_INFINITY
        entry.stalled = 0
        entry.notReadyRetries = 0
        // 同一批次失败后的防重记录保留，开关不承担重试任务的语义。
        setPhase(entry, enabled ? 'idle' : 'paused', { pending: {}, error: null })
      }
      if (enabled) wake(userId)
      return describe(userId)
    })
  }

  return { start, stop, wake, describe, setEnabled, tick, get interval() { return interval } }
}

module.exports = { createAutoAdvance, decide, PHASES, configuredInterval, missingTable, DEFAULT_INTERVAL_MS }
