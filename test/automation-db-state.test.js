const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const vm = require('node:vm')
const { createRequire } = require('node:module')

async function main() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-db-automation-'))
  const environment = { RUYI_TASK_ID: 'task', RUYI_USER_ID: '1', RUYI_EXECUTION_JOB_ID: 'job',
    RUYI_JOB_CLAIM_TOKEN: 'claim', RUYI_TASK_CLAIM_TOKEN: 'task-claim' }
  let rows = [{ id: 'f1', task_id: 'task', original_name: '初始oaid.txt', platform_name: 'alice_oaid_task_1',
    file_type: 'oaid', current_path: 'execution/oaid/alice_oaid_task_1.txt', stage: 'uploaded', sequence: 1 }]
  const calls = []
  let closed = false
  const repo = {
    listFiles: async (_db, ctx) => { assert.equal(ctx.jobId, 'job'); return rows },
    pendingFiles: async (_db, _ctx, step) => rows.filter((row) => ({ create: ['uploaded'], analyse: ['created'], upload: ['pending'], download: ['analysed'] })[step].includes(row.stage)),
    assertLease: async () => true,
    transitionFile: async (_db, ctx, value) => { calls.push(value); rows[0].stage = value.toStage; return rows[0] },
    beginOperation: async (_db, ctx, value) => { calls.push(value); return rows[0] },
  }
  const sandbox = { module: { exports: {} }, process: { env: environment, execPath: process.execPath }, __dirname: path.resolve(__dirname, '../packages/shared/runtime'),
    require(name) {
      if (name.endsWith('/repos/task-execution')) return repo
      if (name === './task-outcome') return require('@ruyi/shared/runtime/task-outcome')
      if (name === '../../../db') return { createDb: () => ({ destroy: async () => { closed = true } }) }
      return require(name)
    } }
  vm.runInNewContext(fs.readFileSync(path.join(sandbox.__dirname, 'task-file-store.js'), 'utf8'), sandbox)
  const store = sandbox.module.exports
  const createScript = require.resolve('@ruyi/automation/createGroup.js')
  const uploadScript = require.resolve('@ruyi/automation/upload.js')
  delete environment.RUYI_TASK_ID
  assert.equal(store.enabled(), true, '部分租约缺失时仍进入数据库路径，不可退回 JSON')
  environment.RUYI_TASK_ID = 'task'
  assert.equal((await store.requireMapping(directory, 'alice_oaid_task_1')).originalName, '初始oaid.txt')
  await store.beginOperation(directory, 'alice_oaid_task_1', 'create')
  await store.updateStage(directory, 'alice_oaid_task_1', 'created')
  assert.equal(calls[0].fileId, 'f1')
  assert.equal(calls[1].fromStages[0], 'uploaded')
  rows[0].stage = 'uploaded'
  const visits = []
  const success = await store.runAll('create', createScript, (_executable, scripts, options) => {
    assert.equal(scripts[0], createScript)
    visits.push(options.env.RUYI_TASK_FILE_ID); rows[0].stage = 'created'; return { status: 0 }
  })
  assert.equal(success, 0)
  assert.deepEqual(visits, ['f1'])
  rows[0].stage = 'uploaded'
  assert.equal(await store.runAll('create', createScript, () => ({ status: 2 })), 2)
  await assert.rejects(store.runAll('create', createScript, () => ({ status: 0 })), /阶段未推进/)
  await assert.rejects(store.runAll('create', 'createGroup.js'), /绝对路径/)
  rows[0].stage = 'pending'
  assert.equal(await store.runAll('upload', uploadScript, (_exe, scripts, options) => {
    assert.equal(scripts[0], uploadScript)
    assert.equal(options.env.RUYI_TASK_FILE_ID, undefined, '上传保持批量，不限制成单文件')
    rows[0].stage = 'uploaded'
    return { status: 0 }
  }), 0)
  rows[0].current_path = 'execution/oaid/../../escape'
  await assert.rejects(store.requireMapping(directory, 'alice_oaid_task_1'), /路径无效/)
  rows[0].current_path = 'execution/oaid/alice_oaid_task_1.txt'
  rows[0].stage = 'pending'
  fs.mkdirSync(path.join(directory, 'actual'))
  fs.writeFileSync(path.join(directory, 'actual/alice_oaid_task_1.txt'), 'fake')
  fs.symlinkSync(path.join(directory, 'actual'), path.join(directory, 'oaid'))
  await assert.rejects(store.candidates(directory), /符号链接/)
  repo.pendingFiles = async () => { throw Object.assign(new Error('数据库不可用'), { code: 'TASK_DATABASE_ERROR' }) }
  await assert.rejects(store.runAll('create', createScript, () => assert.fail('数据库失效不得启动脚本')), /数据库不可用/)
  await store.close()
  assert.equal(closed, true)
  for (const [filename, step] of [['uploadAll.js', 'upload'], ['createAllGroup.js', 'create'], ['analyseAll.js', 'analyse'], ['downloadAll.js', 'download']]) {
    const run = []
    const taskStore = { enabled: () => true, pending: async () => [], runAll: async (kind, script) => { run.push([kind, script]); return 0 } }
    const entry = { module: { exports: {} }, __dirname: path.resolve(__dirname, '../packages/automation'), process, console,
      require(name) {
        if (name === '@ruyi/shared/runtime/task-file-store') return taskStore
        if (name === './lib/preflight') return { checkPreflight() {} }
        if (name === './lib/files') return { readJsonArray() { assert.fail('整任务不能读取 JSON 清单') } }
        if (name === './lib/file-manifest') return { planUpload() { assert.fail('整任务不能调用旧映射') } }
        if (name === 'fs') return new Proxy(fs, { get(target, key) {
          if (['readFileSync', 'writeFileSync'].includes(key)) return () => assert.fail('整任务不能访问 JSON 清单')
          return target[key]
        } })
        if (name.startsWith('./lib/')) return require(path.join(entry.__dirname, name))
        return require(name)
      } }
    entry.require.resolve = (name) => require.resolve(path.join(entry.__dirname, name))
    vm.runInNewContext(fs.readFileSync(path.join(entry.__dirname, filename), 'utf8'), entry)
    await entry.module.exports.main()
    assert.equal(run[0][0], step)
    assert.equal(path.isAbsolute(run[0][1]), true)
  }
  async function exerciseScript(filename, step, failWrite = false) {
    const stages = []
    const intents = []
    const row = { id: 'file', platform_name: 'alice_oaid_task_1', file_type: 'oaid', stage: ({ create: 'uploaded', analyse: 'created', download: 'analysed' })[step] }
    const taskStore = { enabled: () => true, pending: async () => [row],
      beginOperation: async (_root, name, kind) => { intents.push(kind) }, close: async () => {} }
    const fakePage = { on() {}, pages: () => [fakePage], bringToFront: async () => {}, goto: async () => {}, waitForTimeout: async () => {}, url: () => 'https://test/' }
    const realName = require.resolve(`@ruyi/automation/${filename}`)
    const realRequire = createRequire(realName)
    const manifest = { requireMapping: async () => ({ id: row.id, type: 'oaid' }), resolveFileType: async () => 'oaid',
      updateStage: async (_root, _name, stage) => {
        if (failWrite) throw Object.assign(new Error('数据库写入失败'), { code: 'TASK_DATABASE_ERROR' })
        stages.push(stage)
      }, saveDownloadedFile: async () => { stages.push('downloaded'); return 'result.xlsx' } }
    const context = { console, process, module: { exports: {} }, __dirname: path.dirname(realName),
      require(name) {
        if (name === '@ruyi/shared/runtime/task-file-store') return taskStore
        if (name === './lib/paths') return { requireUploadRoot: () => directory }
        if (name === './lib/preflight') return { checkPreflight() {} }
        if (name === './lib/browser') return { launchBrowser: async () => ({ pages: () => [fakePage] }), closeBrowserContext: async () => {} }
        if (name === './lib/login') return { navigateWithLogin: async () => fakePage }
        if (name === './lib/file-manifest') return manifest
        if (name === './lib/files') return { readJsonArray() { assert.fail('业务流程不能读JSON') }, writeJsonArray() { assert.fail('业务流程不能写JSON') } }
        return realRequire(name)
      } }
    const source = fs.readFileSync(realName, 'utf8').split(filename === 'analyse.js' ? '\nmain().catch' : '\nif (')[0]
    const substitutes = step === 'create'
      ? 'selectAudienceFile = async () => {}; fillGroupInfo = async () => {}; submitGroup = async () => {};'
      : step === 'analyse'
        ? 'monitorPage = () => {}; selectAudience = async () => {}; fillTaskName = async () => {}; selectInsightFilters = async () => {}; submitInsight = async () => {};'
        : 'selectTask = async () => "alice_oaid_task_1"; ensureTaskReady = async () => {}; clickDownload = async () => { await saveDownloadedFile("root", "alice_oaid_task_1", "result.xlsx", "source"); return true; };'
    vm.runInNewContext(`${source}\n${substitutes}\nmodule.exports = { main };`, context)
    if (failWrite) await assert.rejects(context.module.exports.main(), { code: 'TASK_DATABASE_ERROR' })
    else await context.module.exports.main()
    assert.deepEqual(stages, failWrite ? [] : [({ create: 'created', analyse: 'analysed', download: 'downloaded' })[step]])
    if (step !== 'download') assert.deepEqual(intents, [step])
  }
  await exerciseScript('createGroup.js', 'create')
  await exerciseScript('analyse.js', 'analyse')
  await exerciseScript('download.js', 'download')
  await exerciseScript('createGroup.js', 'create', true)
  await exerciseScript('analyse.js', 'analyse', true)
  const savedCalls = []
  const manifestPath = require.resolve('@ruyi/automation/lib/file-manifest')
  const manifestRequire = createRequire(manifestPath)
  const manifestVm = { module: { exports: {} }, process, require(name) {
    if (name === '@ruyi/shared/runtime/task-file-store') return {
      enabled: () => true, requireMapping: async () => ({ id: 'file', originalName: '初始oaid.txt' }),
      db: () => 'fake-db', context: () => ({ jobId: 'job' }),
      updateStage: () => assert.fail('结果登记已原子推进，禁止重复更新文件阶段'),
    }
    if (name === '@ruyi/shared/runtime/db-job-results') return { recordResult: async (...args) => { savedCalls.push(args); return 'saved.xlsx' } }
    return manifestRequire(name)
  } }
  vm.runInNewContext(fs.readFileSync(manifestPath, 'utf8'), manifestVm)
  assert.equal(await manifestVm.module.exports.saveDownloadedFile(directory, 'platform', 'platform.xlsx', 'source'), 'saved.xlsx')
  assert.equal(savedCalls.length, 1)
  assert.equal(savedCalls[0][3], '初始oaid.xlsx')
  assert.equal(savedCalls[0][4].fileId, 'file')
  console.log('自动化数据库状态、逐文件轮询、无进度保护、路径安全与故障闭合测试通过')
}
module.exports = main()
module.exports.catch((error) => { console.error(error); process.exitCode = 1 })
