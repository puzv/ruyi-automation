// 自动推进引擎的行为测试：不连数据库、不启动浏览器，全部依赖注入。
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { createAutoAdvance, decide, configuredInterval, DEFAULT_INTERVAL_MS } = require('@ruyi/server/src/modules/auto-advance/engine')
const { getWorkspaceStatus, readTaskItems } = require('@ruyi/shared/runtime/workspace')
const { groupPlatformNames, createPlatformName, jobKey } = require('@ruyi/automation/lib/file-manifest')

const START = 1_700_000_000_000
const INTERVAL = 5 * 60 * 1000
const UPLOAD_JOB = 'abcdef12-0000-0000-0000-000000000000'
const PLATFORM_NAME = createPlatformName({ username: 'alice', type: 'idfa', jobId: UPLOAD_JOB, sequence: 1 })

function workspaceFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-auto-advance-'))
  const workspace = path.join(root, 'users', 'alice')
  fs.mkdirSync(workspace, { recursive: true })
  return {
    root, workspace,
    write(name, values) { fs.writeFileSync(path.join(workspace, name), JSON.stringify(values)) },
    cleanup() { fs.rmSync(root, { recursive: true, force: true }) },
  }
}

// 平台名称必须能在 file-manifest 中找到映射，否则 groupPlatformNames 会拒绝。
function seedCreateTodo(fixture, name = PLATFORM_NAME) {
  fixture.write('createGroupToDoList.json', [name])
  fixture.write('file-manifest.json', { version: 1, files: [{
    platformName: name, originalName: 'a_idfa.txt', type: 'idfa', jobId: UPLOAD_JOB,
    sequence: 1, originalPath: 'raw/1/a_idfa.txt', currentPath: `idfa/${name}.txt`, stage: 'uploaded',
  }] })
}

function build(overrides = {}) {
  let now = START
  const calls = { enqueued: [], probes: [], logs: [] }
  const probes = new Set()
  const state = {
    enabled: true, activeJob: null, recent: true, storageState: { cookies: [], origins: [] },
    files: 0, audiences: 0, results: 0, probeError: null,
  }
  const fixture = workspaceFixture()
  const engine = createAutoAdvance({
    dataRoot: fixture.root, log: { info() {}, warn() {}, error() {} },
    intervalMs: INTERVAL,
    deps: {
      clock: () => now,
      platformProbes: probes,
      listWorkspaceNames: () => ['alice'],
      findByUsername: async (username) => ({ id: 7, username, status: 'active' }),
      isEnabled: async () => state.enabled,
      setEnabled: async (_id, value) => { state.enabled = value },
      activeJobForUser: async () => state.activeJob,
      hasRecentJob: async () => state.recent,
      loadUserState: async () => ({ state: state.storageState, version: 1 }),
      resolveWorkspace: () => fixture.workspace,
      ensureWorkspace: () => fixture.workspace,
      getWorkspaceStatus,
      readTaskItems,
      groupPlatformNames,
      inspectPlatformFiles: async (type, names) => {
        calls.probes.push({ type, names })
        if (state.probeError) throw state.probeError
        return { missingCount: state.files }
      },
      inspectAnalyseAudience: async (names) => {
        calls.probes.push({ type: 'audience', names })
        if (state.probeError) throw state.probeError
        return state.audiences
      },
      inspectInsightResults: async (names) => {
        calls.probes.push({ type: 'result', names })
        if (state.probeError) throw state.probeError
        return state.results
      },
      enqueue: async (_user, task) => { calls.enqueued.push(task); return { ok: true, jobId: `job-${task}` } },
      writeLog: async (entry) => { calls.logs.push(entry) },
      ...overrides,
    },
  })
  return {
    engine, fixture, state, calls, probes,
    // 时钟固定时 nextCheckAt 会拦住重复检查，测试需显式推进时间。
    async tick(advanceMs = 0) {
      now += advanceMs
      await engine.tick()
    },
  }
}

async function testDecide() {
  assert.deepEqual(decide({ createCount: 1, analyseCount: 0, doneCount: 0 }, { files: 2 }),
    { phase: 'waitingFiles', pending: { files: 2 } })
  assert.deepEqual(decide({ createCount: 1, analyseCount: 0, doneCount: 0 }, { files: 0 }),
    { phase: 'readyCreate', pending: { files: 0 } })
  assert.equal(decide({ createCount: 0, analyseCount: 2, doneCount: 0 }, { audiences: 1 }).phase, 'waitingAudience')
  assert.equal(decide({ createCount: 0, analyseCount: 2, doneCount: 0 }, { audiences: 0 }).phase, 'readyAnalyse')
  assert.equal(decide({ createCount: 0, analyseCount: 0, doneCount: 1 }, { results: 1 }).phase, 'waitingResults')
  assert.equal(decide({ createCount: 0, analyseCount: 0, doneCount: 1 }, { results: 0 }).phase, 'resultsReady')
  assert.equal(decide({ createCount: 0, analyseCount: 0, doneCount: 0 }, {}).phase, 'idle')
  assert.equal(configuredInterval(undefined), DEFAULT_INTERVAL_MS)
  // 默认 5 分钟：平台侧处理本身就是分钟级，更密的轮询只会增加平台压力。
  assert.equal(DEFAULT_INTERVAL_MS, 5 * 60 * 1000)
  // 过小的间隔会放大平台压力，必须被抬到下限。
  assert.equal(configuredInterval(1000), 15000)
  assert.equal(configuredInterval(120000), 120000)
}

async function testWaitingThenAdvance() {
  const { engine, fixture, state, calls, probes, tick } = build()
  try {
    seedCreateTodo(fixture)
    state.files = 1
    await tick()
    let status = await engine.describe(7)
    assert.equal(status.phase, 'waitingFiles')
    assert.deepEqual(status.pending, { files: 1 })
    assert.equal(calls.enqueued.length, 0, '平台仍在处理时不能创建人群')
    assert.equal(probes.size, 0, '探测结束后必须释放占位')

    state.files = 0
    await tick(INTERVAL)
    status = await engine.describe(7)
    assert.equal(status.phase, 'readyCreate')
    assert.deepEqual(calls.enqueued, ['create'])
    // 自动提交也要留痕，并用 auto 标记与手动启动区分。
    assert.equal(calls.logs.length, 1)
    assert.deepEqual(calls.logs[0].detail, { task: 'create', auto: true, queued: true })
  } finally { fixture.cleanup() }
}

async function testAwaitAudienceThenAnalyse() {
  const { engine, fixture, state, calls, tick } = build()
  try {
    fixture.write('analyseToDoList.json', ['alice_idfa_abcdef12_1'])
    state.audiences = 2
    await tick()
    assert.equal((await engine.describe(7)).phase, 'waitingAudience')
    assert.equal(calls.enqueued.length, 0)

    state.audiences = 0
    await tick(INTERVAL)
    assert.equal((await engine.describe(7)).phase, 'readyAnalyse')
    assert.deepEqual(calls.enqueued, ['analyse'])
  } finally { fixture.cleanup() }
}

async function testCompletedAnalyseItemsAreNotReportedAsPending() {
  const fixture = workspaceFixture()
  try {
    fixture.write('analyseToDoList.json', ['alice_idfa_abcdef12_1.txt', 'alice_idfa_abcdef12_2'])
    fixture.write('done.json', ['alice_idfa_abcdef12_1', 'alice_idfa_abcdef12_2.txt'])
    const status = getWorkspaceStatus(fixture.workspace)
    assert.equal(status.analyseCount, 0)
    assert.equal(status.workspaceStatus, '等待下载')
  } finally { fixture.cleanup() }
}

async function testAnalyseProbeIgnoresCompletedItems() {
  const { engine, fixture, state, calls, tick } = build()
  try {
    fixture.write('analyseToDoList.json', ['old_processing_pn', 'current_pn'])
    fixture.write('done.json', ['old_processing_pn'])
    state.audiences = 0
    await tick()
    assert.equal((await engine.describe(7)).phase, 'readyAnalyse')
    assert.deepEqual(calls.enqueued, ['analyse'])
    const audienceProbe = calls.probes.find((probe) => probe.type === 'audience')
    assert.deepEqual(audienceProbe.names, ['current_pn'],
      '自动推进探测不能把已完成的旧洞悉项目混入当前待办')
  } finally { fixture.cleanup() }
}

async function testStopsAtResultsReady() {
  const { engine, fixture, state, calls, tick } = build()
  try {
    fixture.write('done.json', ['alice_idfa_abcdef12_1'])
    state.results = 0
    await tick()
    const status = await engine.describe(7)
    assert.equal(status.phase, 'resultsReady')
    // 停止轮询：下次检查时间为空表示不再自动探测。
    assert.equal(status.nextCheckAt, null)
    const probesAfter = calls.probes.length
    await tick(INTERVAL * 10)
    assert.equal(calls.probes.length, probesAfter, '结果就绪后不再探测平台')
    assert.equal(calls.enqueued.length, 0, '结果下载只能由用户手动发起')
  } finally { fixture.cleanup() }
}

async function testNoProbeWhileJobActive() {
  const { engine, fixture, state, calls, tick } = build()
  try {
    fixture.write('analyseToDoList.json', ['alice_idfa_abcdef12_1'])
    state.activeJob = { id: 'running', status: 'running' }
    await tick()
    assert.equal(calls.probes.length, 0, '有任务在跑时不应再启动浏览器')
    assert.equal(calls.enqueued.length, 0)
    // 仍在进行中：保持等待而不是直接判定空闲。
    assert.notEqual((await engine.describe(7)).phase, 'idle')
  } finally { fixture.cleanup() }
}

async function testDisabledAndNoRecentActivity() {
  const { engine, fixture, state, calls, tick } = build()
  try {
    seedCreateTodo(fixture)
    state.enabled = false
    await tick()
    assert.equal((await engine.describe(7)).phase, 'paused')
    assert.equal(calls.probes.length, 0, '关闭后不得探测平台')

    // 重新开启必须清除“已停止”的检查时间，否则永远不会再检查。
    await engine.setEnabled(7, true)
    state.recent = false
    await tick(INTERVAL)
    const status = await engine.describe(7)
    assert.match(status.error, /近期没有任务活动/)
    assert.equal(calls.probes.length, 0, '没有近期任务时不得替用户处理历史待办')
  } finally { fixture.cleanup() }
}

async function testIdleWhenNothingPending() {
  const { engine, fixture, calls, tick } = build()
  try {
    await tick()
    assert.equal((await engine.describe(7)).phase, 'idle')
    assert.equal(calls.probes.length, 0)
  } finally { fixture.cleanup() }
}

async function testLoginRequired() {
  const { engine, fixture, calls, tick } = build({ loadUserState: async () => null })
  try {
    seedCreateTodo(fixture)
    await tick()
    const status = await engine.describe(7)
    assert.equal(status.phase, 'loginRequired')
    assert.equal(status.nextCheckAt, START + 5 * 60 * 1000, '登录失效后隔 5 分钟再试')
    assert.equal(calls.enqueued.length, 0)
  } finally { fixture.cleanup() }
}

// 自动提交的任务跑完后待办没有变化，说明脚本没推进清单，必须停下。
async function testNoRepeatedAttempts() {
  const { engine, fixture, state, calls, tick } = build()
  try {
    seedCreateTodo(fixture)
    state.files = 0
    await tick()
    assert.deepEqual(calls.enqueued, ['create'])
    // 任务结束但待办未变：再来一轮应停止，而不是再次提交。
    await tick(INTERVAL)
    assert.deepEqual(calls.enqueued, ['create'], '不得重复提交同样的任务')
    const status = await engine.describe(7)
    assert.equal(status.phase, 'stalled')
    assert.equal(status.nextCheckAt, null)
  } finally { fixture.cleanup() }
}

async function testNotReadyRetriesAreLimited() {
  const jobsById = new Map()
  const env = build({
    getJob: async (id) => jobsById.get(id) || null,
    enqueue: async (_user, task) => {
      const id = `job-${task}-${jobsById.size + 1}`
      jobsById.set(id, { id, task, status: 'failed', exit_code: 2 })
      env.calls.enqueued.push(task)
      return { ok: true, jobId: id }
    },
  })
  const { engine, fixture, calls, tick } = env
  try {
    seedCreateTodo(fixture)
    await tick()
    assert.deepEqual(calls.enqueued, ['create'])
    // 每次退出码 2 都要先等待一个完整间隔，最多重试三次。
    for (let i = 0; i < 7; i += 1) await tick(INTERVAL)
    assert.equal((await engine.describe(7)).phase, 'stalled')
    assert.equal(calls.enqueued.length, 3, '暂未就绪达到上限后不得继续提交')
  } finally { fixture.cleanup() }
}

async function testStalledDetection() {
  let probes = 0
  const { engine, fixture, tick } = build({
    inspectPlatformFiles: async () => { probes += 1; return { missingCount: 1 } },
  })
  try {
    seedCreateTodo(fixture)
    for (let index = 0; index < 25; index += 1) await tick(INTERVAL)
    const status = await engine.describe(7)
    assert.equal(status.phase, 'stalled')
    assert.ok(probes <= 21, `状态长时间不变后应停止探测，实际探测 ${probes} 次`)
  } finally { fixture.cleanup() }
}

async function testMissingTable() {
  // 迁移 006 未执行时不能把英文 SQL 报错丢到界面，也不能每轮反复查库。
  const missing = () => Object.assign(new Error("Table 'ruyi_test.ruyi_auto_advance' doesn't exist"),
    { code: 'ER_NO_SUCH_TABLE' })
  const { engine, fixture, tick } = build({
    isEnabled: async () => { throw missing() },
    setEnabled: async () => { throw missing() },
  })
  try {
    seedCreateTodo(fixture)
    const described = await engine.describe(7)
    assert.equal(described.phase, 'error')
    assert.match(described.error, /迁移 006/)
    assert.equal(described.enabled, false)
    await tick()
    const after = await engine.describe(7)
    assert.equal(after.phase, 'error')
    assert.match(after.error, /迁移 006/)
    assert.equal(after.nextCheckAt, null, '缺表时必须停止轮询')
    const toggled = await engine.setEnabled(7, false)
    assert.match(toggled.error, /迁移 006/)
    assert.equal(toggled.phase, 'error')
  } finally { fixture.cleanup() }
}

async function testToggle() {
  const { engine, fixture, state } = build()
  try {
    fixture.write('done.json', ['x'])
    const disabled = await engine.setEnabled(7, false)
    assert.equal(disabled.phase, 'paused')
    assert.equal(state.enabled, false)
    const resumed = await engine.setEnabled(7, true)
    assert.equal(resumed.enabled, true)
    assert.equal(resumed.phase, 'idle')
  } finally { fixture.cleanup() }
}

async function testProbeErrorRetries() {
  const { engine, fixture, state, probes, tick } = build()
  try {
    seedCreateTodo(fixture)
    state.probeError = new Error('IDFA 页面需要登录或未打开成功')
    await tick()
    const status = await engine.describe(7)
    assert.equal(status.phase, 'loginRequired')
    assert.equal(status.error, 'IDFA 页面需要登录或未打开成功')
    // 失败后必须释放占位，否则该用户永远不会再被检查。
    assert.equal(probes.size, 0)
  } finally { fixture.cleanup() }
}

async function testProbesNotStartedTwice() {
  const { engine, fixture, calls, probes, tick } = build()
  try {
    seedCreateTodo(fixture)
    // 模拟用户正在手动“检测当前状态”：自动推进必须让路，不能再开一个浏览器。
    probes.add(7)
    await tick()
    assert.equal(calls.probes.length, 0, '已有检查在进行时不得重复启动浏览器')
    assert.equal(calls.enqueued.length, 0)
    // 占位由手动检查负责释放，自动推进不能清掉别人的占位。
    assert.equal(probes.has(7), true)
  } finally { fixture.cleanup() }
}

// 路由必须在 buildApp 时就拿到引擎。曾经因为引擎在 buildApp 之后才创建，
// 传入的是 null，路由被静默跳过，界面和接口全部 404。
async function testRoutesRegistered() {
  const { buildApp } = require('@ruyi/server/src/app')
  const engine = {
    interval: 60000,
    described: null,
    describe: async () => ({ enabled: true, phase: 'idle', message: '当前没有需要自动推进的任务',
      pending: {}, checkedAt: null, nextCheckAt: null, error: null, lastJobId: null, stalled: 0 }),
    setEnabled: async (_id, enabled) => ({ enabled, phase: enabled ? 'idle' : 'paused', message: '', pending: {} }),
    wake() {},
    async stop() {},
  }
  // auth: false 时不会挂业务路由，这里只验证引擎被交给路由层的行为差异。
  const withEngine = buildApp({ auth: false, webDist: path.join(os.tmpdir(), 'ruyi-none'), logger: false,
    autoAdvance: engine })
  assert.equal(withEngine.autoAdvance, engine, '引擎必须挂到 app 上供 preClose 停止')
  await withEngine.close()

  const withoutEngine = buildApp({ auth: false, webDist: path.join(os.tmpdir(), 'ruyi-none'), logger: false })
  assert.equal(withoutEngine.autoAdvance, null)
  // 没有引擎时 preClose 不能报错。
  await withoutEngine.close()

  // 有鉴权时路由应当存在：未登录返回 UNAUTHENTICATED 而不是“接口不存在”。
  const stubDb = { destroy: async () => {} }
  const app = buildApp({ db: stubDb, stateKeys: { current: null, previous: null },
    webDist: path.join(os.tmpdir(), 'ruyi-none'), logger: false, autoAdvance: engine })
  const denied = await app.inject({ method: 'GET', url: '/api/auto-advance' })
  assert.equal(denied.statusCode, 401)
  assert.equal(denied.json().code, 'UNAUTHENTICATED')
  await app.close()
}

function deferred() {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

async function testNewBatchAndWakeGuard() {
  const { engine, fixture, calls, tick } = build()
  try {
    fixture.write('analyseToDoList.json', ['batch_a'])
    await tick()
    engine.wake(7)
    await tick()
    assert.deepEqual(calls.enqueued, ['analyse'], '任务完成 wake 不能清掉同工作流的防重记录')
    assert.equal((await engine.describe(7)).phase, 'stalled')
    await engine.setEnabled(7, false)
    await engine.setEnabled(7, true)
    await tick()
    assert.deepEqual(calls.enqueued, ['analyse'], '关再开不能当作对未推进任务的隐式重试')

    fixture.write('analyseToDoList.json', ['batch_b'])
    engine.wake(7)
    await tick()
    assert.deepEqual(calls.enqueued, ['analyse', 'analyse'], '同数量不同待办签名必须独立')
    fixture.write('analyseToDoList.json', [])
    engine.wake(7)
    await tick()
    fixture.write('analyseToDoList.json', ['batch_c'])
    engine.wake(7)
    await tick()
    assert.deepEqual(calls.enqueued, ['analyse', 'analyse', 'analyse'], '待办归零后新批次不受旧记录影响')
  } finally { await engine.stop(); fixture.cleanup() }
}

async function testSettingsDuringProbe() {
  for (const reopen of [false, true]) {
    const entered = deferred(), release = deferred()
    const { engine, fixture, calls, tick } = build({
      inspectAnalyseAudience: async () => { entered.resolve(); await release.promise; return 0 },
    })
    try {
      fixture.write('analyseToDoList.json', ['batch'])
      const checking = tick()
      await entered.promise
      await engine.setEnabled(7, false)
      if (reopen) await engine.setEnabled(7, true)
      release.resolve()
      await checking
      const latest = await engine.describe(7)
      assert.equal(latest.enabled, reopen)
      assert.equal(latest.phase, reopen ? 'idle' : 'paused', '旧探测不能覆盖最新设置')
      assert.equal(calls.enqueued.length, 0, '设置改变后必须丢弃旧探测结果')
      if (reopen) {
        assert.notEqual(latest.nextCheckAt, null, '最新开启不能被旧探测永久暂停')
        await tick()
        assert.deepEqual(calls.enqueued, ['analyse'])
      }
    } finally { await engine.stop(); fixture.cleanup() }
  }
}

async function testOldProbeErrorDoesNotOverwriteSetting() {
  const entered = deferred(), release = deferred()
  const { engine, fixture, tick } = build({
    inspectAnalyseAudience: async () => { entered.resolve(); await release.promise; throw new Error('检查失败') },
  })
  try {
    fixture.write('analyseToDoList.json', ['batch'])
    const checking = tick()
    await entered.promise
    await engine.setEnabled(7, false)
    await engine.setEnabled(7, true)
    release.resolve()
    await checking
    const latest = await engine.describe(7)
    assert.equal(latest.phase, 'idle')
    assert.equal(latest.error, null)
  } finally { await engine.stop(); fixture.cleanup() }
}

async function testToggleBeforeProbeStarts() {
  const entered = deferred(), release = deferred()
  const { engine, fixture, calls, tick } = build({
    loadUserState: async () => { entered.resolve(); await release.promise; return { state: {} } },
  })
  try {
    fixture.write('analyseToDoList.json', ['batch'])
    const checking = tick()
    await entered.promise
    await engine.setEnabled(7, false)
    await engine.setEnabled(7, true)
    release.resolve()
    await checking
    assert.equal(calls.probes.length, 0, '检查开始即捕获版本，早期 await 中切换也应丢弃检查')
    assert.equal(calls.enqueued.length, 0)
    assert.equal((await engine.describe(7)).phase, 'idle')
  } finally { await engine.stop(); fixture.cleanup() }
}

async function testSubmissionAndSettingsAreSerialized() {
  const entered = deferred(), release = deferred()
  const events = []
  let env
  env = build({
    enqueue: async () => {
      entered.resolve()
      await release.promise
      events.push('insert')
      return { ok: true, jobId: 'queued' }
    },
    setEnabled: async (_id, value) => { env.state.enabled = value; events.push(`setting:${value}`) },
  })
  const { engine, fixture, tick } = env
  try {
    fixture.write('analyseToDoList.json', ['batch'])
    const checking = tick()
    await entered.promise
    let returned = false
    const closing = engine.setEnabled(7, false).then(() => { returned = true; events.push('close-return') })
    await Promise.resolve()
    assert.equal(returned, false, '实际提交持锁期间，关闭必须等待，不能先返回后又新增任务')
    release.resolve()
    await Promise.all([checking, closing])
    assert.deepEqual(events, ['insert', 'setting:false', 'close-return'])
    assert.equal((await engine.describe(7)).phase, 'paused')
    engine.wake(7)
    await tick(INTERVAL)
    assert.equal(events.filter((event) => event === 'insert').length, 1)
  } finally { await engine.stop(); fixture.cleanup() }
}

async function testConcurrentSettingsPersistInOrder() {
  const entered = deferred(), release = deferred()
  const writes = []
  let env
  env = build({ setEnabled: async (_id, value) => {
    writes.push(value)
    if (!value) { entered.resolve(); await release.promise }
    env.state.enabled = value
  } })
  try {
    const first = env.engine.setEnabled(7, false)
    await entered.promise
    const second = env.engine.setEnabled(7, true)
    await Promise.resolve()
    assert.deepEqual(writes, [false], '后写设置等待前写完成，不能后发先至')
    release.resolve()
    await Promise.all([first, second])
    assert.deepEqual(writes, [false, true])
    assert.equal((await env.engine.describe(7)).enabled, true)
  } finally { await env.engine.stop(); env.fixture.cleanup() }
}

async function testAuditFailureAfterEnqueue() {
  const { engine, fixture, calls, tick } = build({ writeLog: async () => { throw new Error('日志服务失败') } })
  try {
    fixture.write('analyseToDoList.json', ['batch'])
    await tick()
    const status = await engine.describe(7)
    assert.equal(status.phase, 'readyAnalyse')
    assert.equal(status.error, null)
    assert.equal(status.lastJobId, 'job-analyse')
    engine.wake(7)
    await tick()
    assert.deepEqual(calls.enqueued, ['analyse'])
  } finally { await engine.stop(); fixture.cleanup() }
}

async function testStageActivityTypes() {
  let recentTypes = []
  const { engine, fixture, tick } = build({ hasRecentJob: async (_id, hours, types) => {
    assert.equal(hours, 12)
    recentTypes.push(types)
    return false
  } })
  try {
    seedCreateTodo(fixture)
    await tick()
    fixture.write('createGroupToDoList.json', [])
    fixture.write('analyseToDoList.json', ['batch'])
    engine.wake(7)
    await tick()
    fixture.write('analyseToDoList.json', [])
    fixture.write('done.json', ['batch'])
    engine.wake(7)
    await tick()
    assert.deepEqual(recentTypes, [['upload', 'create'], ['create', 'analyse'], ['analyse', 'download']])
  } finally { await engine.stop(); fixture.cleanup() }
}

// 定时检查与唤醒检查都会探测平台；不同用户之间也不能并发启动多个浏览器。
async function testTicksAreGloballySerial() {
  const entered = deferred(), release = deferred()
  let inFlight = 0, maxInFlight = 0, probed = 0, scans = 0
  const users = { alice: 7, bob: 8 }
  const { engine, fixture, tick } = build({
    listWorkspaceNames: () => { scans += 1; return Object.keys(users) },
    findByUsername: async (username) => ({ id: users[username], username, status: 'active' }),
    inspectAnalyseAudience: async () => {
      inFlight += 1; probed += 1
      maxInFlight = Math.max(maxInFlight, inFlight)
      entered.resolve()
      await release.promise
      inFlight -= 1
      return 1
    },
  })
  try {
    fixture.write('analyseToDoList.json', ['batch'])
    const first = tick()
    await entered.promise
    // 模拟唤醒检查在定时检查仍在探测时到来：必须排队，而不是另起一轮。
    const second = tick()
    await new Promise((resolve) => setTimeout(resolve, 30))
    assert.equal(scans, 1, '前一轮未结束时，后一轮不能开始扫描用户')
    assert.equal(probed, 1, '前一轮未结束时，不能为其他用户启动探测')
    release.resolve()
    await Promise.all([first, second])
    assert.equal(maxInFlight, 1, '任意时刻只允许一个平台探测在运行')
    assert.equal(scans, 2, '排队的一轮在前一轮结束后仍需执行')
    assert.equal((await engine.describe(7)).phase, 'waitingAudience')
    assert.equal((await engine.describe(8)).phase, 'waitingAudience')
  } finally { await engine.stop(); fixture.cleanup() }
}

// stop() 必须等待正在进行的探测结束，并且之后不能再提交任何任务。
async function testStopWaitsForProbeAndBlocksSubmission() {
  const entered = deferred(), release = deferred()
  let finished = false
  const { engine, fixture, calls, tick } = build({
    inspectAnalyseAudience: async () => { entered.resolve(); await release.promise; return 0 },
  })
  try {
    fixture.write('analyseToDoList.json', ['batch'])
    const checking = tick().then(() => { finished = true })
    await entered.promise
    const stopping = engine.stop().then(() => 'stopped')
    await new Promise((resolve) => setTimeout(resolve, 20))
    assert.equal(finished, false, '探测未结束时 stop 不能假装已停止')
    release.resolve()
    assert.equal(await stopping, 'stopped')
    await checking
    assert.equal(calls.enqueued.length, 0, '停止过程中探测返回后不得提交任务')
    const probes = calls.probes.length
    // 停止后的唤醒与手动检查都必须是空操作。
    engine.wake(7)
    await engine.tick()
    assert.equal(calls.probes.length, probes, '停止后不得再启动探测')
    assert.equal(calls.enqueued.length, 0)
  } finally { fixture.cleanup() }
}

async function main() {
  await testDecide()
  await testTicksAreGloballySerial()
  await testStopWaitsForProbeAndBlocksSubmission()
  await testWaitingThenAdvance()
  await testAwaitAudienceThenAnalyse()
  await testCompletedAnalyseItemsAreNotReportedAsPending()
  await testAnalyseProbeIgnoresCompletedItems()
  await testStopsAtResultsReady()
  await testNoProbeWhileJobActive()
  await testDisabledAndNoRecentActivity()
  await testIdleWhenNothingPending()
  await testLoginRequired()
  await testNoRepeatedAttempts()
  await testNotReadyRetriesAreLimited()
  await testStalledDetection()
  await testToggle()
  await testMissingTable()
  await testProbeErrorRetries()
  await testProbesNotStartedTwice()
  await testRoutesRegistered()
  await testNewBatchAndWakeGuard()
  await testSettingsDuringProbe()
  await testOldProbeErrorDoesNotOverwriteSetting()
  await testToggleBeforeProbeStarts()
  await testSubmissionAndSettingsAreSerialized()
  await testConcurrentSettingsPersistInOrder()
  await testAuditFailureAfterEnqueue()
  await testStageActivityTypes()
  console.log('自动推进引擎的阶段推导、停止条件、防重复提交与开关测试通过')
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
