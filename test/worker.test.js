const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')
const { spawn, fork } = require('node:child_process')
const { once } = require('node:events')
const vm = require('node:vm')
const { sql } = require('kysely')
const { createDb, readDbConfig } = require('../db')
const users = require('@ruyi/shared/runtime/repos/users')
const sessions = require('@ruyi/server/src/modules/auth/repository')
const states = require('@ruyi/shared/runtime/repos/platform-states')
const jobs = require('@ruyi/shared/runtime/repos/jobs')
const { hashToken } = require('@ruyi/server/src/modules/auth/session')
const { loadKeys } = require('@ruyi/shared/runtime/platform-state/crypto')
const { storeCapturedState } = require('@ruyi/shared/runtime/platform-state/index')
const { buildApp } = require('@ruyi/server/src/app')
const { createWorker } = require('@ruyi/worker/src/index')
const { runJob } = require('@ruyi/worker/src/runner')
const { signalJobProcess } = require('@ruyi/worker/src/execution')
const { resolveWorkspace } = require('@ruyi/shared/runtime/workspace')

const names = ['worker_a', 'worker_b', 'worker_c', 'worker_admin']
const marker = 'FAKE_WORKER_COOKIE_DO_NOT_LEAK'
const storageState = { cookies: [{ name: 'fake', value: marker, domain: 'example.test', path: '/', expires: -1,
  httpOnly: true, secure: true, sameSite: 'Lax' }], origins: [] }
const keyValue = crypto.randomBytes(32).toString('base64')
const keys = loadKeys({ RUYI_STATE_KEY: keyValue })
const fixture = path.join(__dirname, 'fixtures/fake-job.js')
const detail = (row) => typeof row.detail === 'string' ? JSON.parse(row.detail) : row.detail
const sleep = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms))
async function until(fn, message = '等待任务状态超时', timeout = 10000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const result = await fn()
    if (result) return result
    await sleep()
  }
  assert.fail(message)
}
function alive(pid) {
  try { process.kill(pid, 0); return true } catch (error) { if (error.code === 'ESRCH') return false; throw error }
}
function testExitedProcessGroup() {
  const originalKill = process.kill
  const calls = []
  try {
    process.kill = (pid, signal) => {
      calls.push([pid, signal])
      throw Object.assign(new Error('模拟已退出进程组'), { code: pid < 0 ? 'EPERM' : 'ESRCH' })
    }
    assert.equal(signalJobProcess({ child: { pid: 987654 } }, 'SIGKILL'), false)
    assert.deepEqual(calls, [[-987654, 'SIGKILL'], [987654, 0]])
    process.kill = (pid) => {
      if (pid < 0) throw Object.assign(new Error('模拟权限不足'), { code: 'EPERM' })
      return true
    }
    assert.throws(() => signalJobProcess({ child: { pid: 987654 } }, 'SIGKILL'), { code: 'EPERM' }, '活着的进程不能误判为已退出')
  } finally { process.kill = originalKill }
}
async function clean(db) {
  const rows = await db.selectFrom('ruyi_users').select('id').where('username', 'in', names).execute()
  if (!rows.length) return
  const ids = rows.map((row) => row.id)
  for (const table of ['ruyi_jobs', 'ruyi_user_sessions', 'ruyi_platform_states', 'ruyi_operation_logs']) {
    await db.deleteFrom(table).where('user_id', 'in', ids).execute()
  }
  await db.deleteFrom('ruyi_users').where('id', 'in', ids).execute()
}

async function main() {
  const config = readDbConfig()
  assert.deepEqual(config, { host: '127.0.0.1', port: 3306, user: 'ruyi', password: 'ruyi', database: 'ruyi_test' })
  testExitedProcessGroup()
  const db = createDb(config)
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-worker-test-'))
  const modes = new Map(), delays = new Map(), stateDirs = [], serviceLogs = []
  const log = { info(message) { serviceLogs.push(message) }, error(message) { serviceLogs.push(message) } }
  let worker, app, child, orphanPid, orphanDir
  const workerOptions = { db, keys, log, dataRoot, pollMs: 25, maxConcurrent: 2,
    runner: (options) => runJob({ ...options, scriptPaths: { upload: fixture, download: fixture },
      env: { FAKE_JOB_MODE: modes.get(options.job.id) || 'ok', FAKE_JOB_DELAY: String(delays.get(options.job.id) || 20) },
      spawnImpl(command, args, options) {
        stateDirs.push(path.dirname(options.env.RUYI_STATE_FILE))
        assert.equal(args[0], path.resolve(__dirname, '../scripts/job-wrapper.js'))
        assert.equal(options.detached, true)
        assert.deepEqual(options.stdio, ['ignore', 'pipe', 'pipe', 'ipc'])
        return spawn(command, args, options)
      },
    }),
  }
  try {
    await clean(db)
    assert.equal((await jobs.listJobs(db)).total, 0, '测试开始前不能有其他任务')
    const identities = []
    for (const username of names) {
      const id = await users.createUser(db, { username, displayName: 'Worker 测试', passwordHash: '伪造摘要',
        role: username === 'worker_admin' ? 'admin' : 'user', mustChangePassword: false })
      const token = crypto.randomBytes(32).toString('base64url')
      await sessions.createSession(db, { tokenHash: hashToken(token), userId: id, expiresAt: new Date(Date.now() + 3600000) })
      await storeCapturedState(db, id, storageState, keys)
      identities.push({ id, username, cookie: `ruyi_session=${token}` })
    }
    const [a, b, c, admin] = identities
    app = buildApp({ db, stateKeys: keys, uploadRoot: dataRoot, logger: false })
    const request = (user, method, url, payload) => app.inject({ method, url, headers: { cookie: user.cookie },
      ...(payload === undefined ? {} : { payload }) })
    const enqueue = async (user = a, mode = 'ok', delay = 20, task = 'upload') => {
      const response = await request(user, 'POST', `/api/run/${task}`)
      assert.equal(response.statusCode, 200, response.body)
      const result = response.json()
      assert.equal(result.status, 'queued'); assert.ok(result.position >= 1)
      modes.set(result.id, mode); delays.set(result.id, delay)
      return result.id
    }
    const row = (id) => jobs.getJob(db, id)
    const waitStatus = (id, status) => until(async () => {
      const job = await row(id)
      return job.status === status && job
    }, `任务未达到 ${status}`)
    const finishLog = (id) => until(() => db.selectFrom('ruyi_operation_logs').selectAll()
      .where('target_id', '=', id).where('action', '=', 'job.finish').executeTakeFirst())
    const readOutput = async (id, user = a) => {
      const response = await request(user, 'GET', `/api/jobs/${id}`)
      assert.equal(response.statusCode, 200, response.body)
      return response.json()
    }
    const startWorker = async (extra = {}) => {
      worker = createWorker({ ...workerOptions, ...extra }); app.worker = worker; await worker.start()
    }
    const stopWorker = async () => { await worker.stop(); worker = null; app.worker = null }
    const reset = async () => {
      if (worker) await stopWorker()
      await db.deleteFrom('ruyi_jobs').where('user_id', 'in', identities.map((user) => user.id)).execute()
    }
    const logPath = (job) => path.join(resolveWorkspace({ username: job.username }, dataRoot), job.log_path)
    const pidOf = (id, user = a) => until(async () => {
      const output = (await readOutput(id, user)).output
      const pid = output.match(/PID=(\d+)/)
      return pid && Number(pid[1])
    })

    assert.equal((await request(a, 'POST', '/api/run/unknown')).statusCode, 404)
    await request(a, 'POST', '/api/runtime-mode', { headless: false })
    const id = await enqueue()
    assert.equal((await row(id)).headless, 0)
    assert.equal((await request(a, 'GET', '/api/jobs/active')).json().job.id, id)
    assert.equal((await request(a, 'POST', '/api/import-folder')).statusCode, 200, '排队不拦截导入')
    await startWorker({ pollMs: 5000 })
    const success = await waitStatus(id, 'succeeded')
    assert.equal(success.exit_code, 0)
    assert.equal(success.log_path, `logs/${id}.log`)
    assert.equal(fs.statSync(logPath(success)).mode & 0o777, 0o600)
    assert.match(fs.readFileSync(logPath(success), 'utf8'), /假任务开始/)
    const response = await readOutput(id)
    assert.equal(response.job.running, false); assert.equal(response.code, 0)
    assert.equal(response.job.output, response.output)
    assert.match(response.output, /假任务标准错误/); assert.match(response.output, /运行模式=0/)
    assert.equal((await request(a, 'GET', `/api/jobs/${id}/log`)).body, response.output)
    const finished = await finishLog(id)
    assert.equal(finished.result, 'success'); assert.ok(detail(finished).queuedMs >= 0)
    const started = await db.selectFrom('ruyi_operation_logs').selectAll().where('target_id', '=', id)
      .where('action', '=', 'job.start').executeTakeFirst()
    assert.deepEqual(detail(started), { task: 'upload', queued: true })
    assert.equal(finished.request_id, started.request_id); assert.equal(finished.user_id, a.id)
    assert.equal((await request(a, 'GET', '/api/jobs/active')).json().job, null)

    // wake 应唤醒一个设置了很长轮询间隔的 Worker。
    const fail = await enqueue(a, 'fail')
    await waitStatus(fail, 'failed'); assert.equal((await row(fail)).exit_code, 2)
    await finishLog(fail)
    assert.ok(stateDirs.every((dir) => !fs.existsSync(dir)))

    // 通过重建 app 验证记录和日志不依赖内存 Map。
    await stopWorker(); await app.close()
    app = buildApp({ db, stateKeys: keys, uploadRoot: dataRoot, logger: false })
    assert.match((await readOutput(id)).output, /假任务开始/)
    const list = (await request(a, 'GET', '/api/jobs?pageSize=1')).json()
    assert.equal(list.total, 2); assert.equal(list.items.length, 1); assert.ok(!('output' in list.items[0]))
    assert.equal((await request(b, 'GET', '/api/jobs')).json().total, 0)
    for (const [method, url] of [['GET', `/api/jobs/${id}`], ['GET', `/api/jobs/${id}/log`],
      ['POST', `/api/jobs/${id}/cancel`]]) assert.equal((await request(b, method, url)).statusCode, 404)
    assert.equal((await request(a, 'GET', '/api/admin/jobs')).statusCode, 403)
    const filtered = (await request(admin, 'GET', '/api/admin/jobs?username=worker_a&status=succeeded')).json()
    assert.equal(filtered.total, 1); assert.equal(filtered.items[0].username, a.username)
    for (const url of ['/api/jobs?page=0', '/api/jobs?pageSize=bad', '/api/admin/jobs?status=bad']) {
      assert.equal((await request(admin, 'GET', url)).statusCode, 400)
    }
    fs.writeFileSync(logPath(success), 'HEAD\n' + 'x'.repeat(5 * 1024 * 1024) + '\nTAIL')
    assert.equal(Buffer.byteLength((await readOutput(id)).output), 64 * 1024)
    const longLog = await request(a, 'GET', `/api/jobs/${id}/log`)
    assert.match(longLog.headers['content-type'], /text\/plain; charset=utf-8/)
    assert.ok(longLog.body.startsWith('（日志过长，仅显示最后 5MB）\n'))
    assert.ok(longLog.body.endsWith('\nTAIL')); assert.equal(longLog.body.includes('HEAD'), false)
    assert.equal((await request(a, 'POST', `/api/jobs/${id}/cancel`)).json().result, 'finished')
    fs.unlinkSync(logPath(success))
    assert.equal((await readOutput(id)).output, '')

    await reset()
    const resultId = await enqueue(a, 'result', 100, 'download')
    assert.equal((await app.inject({ url: `/api/jobs/${resultId}/results.zip` })).statusCode, 401)
    assert.equal((await request(a, 'GET', `/api/jobs/${resultId}/results.zip`)).statusCode, 409)
    await startWorker()
    await waitStatus(resultId, 'succeeded')
    assert.equal((await request(a, 'GET', `/api/jobs/${resultId}/results`)).json().count, 1)
    const zipResult = await request(a, 'GET', `/api/jobs/${resultId}/results.zip`)
    assert.equal(zipResult.statusCode, 200)
    assert.equal(zipResult.rawPayload.readUInt32LE(0), 0x04034b50)
    assert.equal(Number(zipResult.headers['content-length']), zipResult.rawPayload.length)
    assert.match(zipResult.headers['content-disposition'], /attachment/)
    for (const other of [b, admin]) {
      assert.equal((await request(other, 'GET', `/api/jobs/${resultId}/results.zip`)).statusCode, 404)
    }
    const failResult = await enqueue(a, 'result-fail', 20, 'download')
    await waitStatus(failResult, 'failed')
    assert.equal((await request(a, 'GET', `/api/jobs/${failResult}/results.zip`)).statusCode, 409)
    const emptyResult = await enqueue(a, 'ok', 20, 'download')
    await waitStatus(emptyResult, 'succeeded')
    assert.equal((await request(a, 'GET', `/api/jobs/${emptyResult}/results`)).statusCode, 409)
    assert.equal((await request(a, 'GET', `/api/jobs/${resultId}/results`)).json().count, 1, '后续任务不能改变旧归档')
    const archive = path.join(resolveWorkspace(a, dataRoot), 'job-results', resultId)
    fs.renameSync(archive, `${archive}.test-saved`)
    const oldResult = await request(a, 'GET', `/api/jobs/${resultId}/results`)
    assert.equal(oldResult.statusCode, 409)
    assert.match(oldResult.json().message, /旧任务不支持/)
    fs.renameSync(`${archive}.test-saved`, archive)
    await stopWorker()
    const cancelledResult = await enqueue(a, 'ok', 20, 'download')
    await request(a, 'POST', `/api/jobs/${cancelledResult}/cancel`)
    assert.equal((await request(a, 'GET', `/api/jobs/${cancelledResult}/results.zip`)).statusCode, 409)

    await reset()
    const serial = []
    for (let i = 0; i < 3; i++) serial.push(await enqueue(a, 'ok', 180))
    await startWorker()
    const executionOrder = []
    await until(async () => {
      const rows = await Promise.all(serial.map(row))
      assert.ok(rows.filter((job) => job.status === 'running').length <= 1)
      for (const job of rows) if (job.started_at && !executionOrder.includes(job.id)) executionOrder.push(job.id)
      return rows.every((job) => job.status === 'succeeded')
    })
    assert.deepEqual(executionOrder, serial)
    const serialRows = await Promise.all(serial.map(row))
    for (let i = 1; i < 3; i++) assert.ok(serialRows[i].started_at >= serialRows[i - 1].finished_at)

    await reset()
    const parallel = [await enqueue(a, 'ok', 600), await enqueue(b, 'ok', 600), await enqueue(c)]
    await startWorker({ maxConcurrent: NaN })
    await waitStatus(parallel[0], 'running'); await waitStatus(parallel[1], 'running')
    assert.equal((await row(parallel[2])).status, 'queued')
    assert.equal((await readOutput(parallel[2], c)).job.position, 1)
    assert.equal((await request(a, 'POST', '/api/import-folder')).statusCode, 409)
    await Promise.all(parallel.map((id) => waitStatus(id, 'succeeded')))
    const parallelRows = await Promise.all(parallel.map(row))
    assert.ok(parallelRows[2].started_at >= new Date(Math.min(...parallelRows.slice(0, 2).map((job) => +job.finished_at))))

    await reset()
    const queuedCancel = await enqueue()
    assert.equal((await request(a, 'POST', `/api/jobs/${queuedCancel}/cancel`)).json().result, 'cancelled')
    await startWorker(); await sleep(100)
    assert.equal((await row(queuedCancel)).started_at, null)
    assert.equal((await row(queuedCancel)).log_path, null)
    const sleeping = await enqueue(a, 'sleep')
    const pid = await pidOf(sleeping)
    assert.equal((await request(a, 'POST', `/api/jobs/${sleeping}/cancel`)).json().result, 'cancelling')
    await waitStatus(sleeping, 'cancelled')
    await until(() => !alive(pid), '取消后脚本仍然存活')
    assert.equal((await row(sleeping)).cancel_requested, 1)
    assert.equal((await db.selectFrom('ruyi_operation_logs').selectAll().where('target_id', '=', sleeping)
      .where('action', '=', 'job.cancel').executeTakeFirst()).result, 'success')
    assert.ok(stateDirs.every((dir) => !fs.existsSync(dir)))

    await reset()
    const stateVersion = (await states.getStateRow(db, a.id)).version
    const rewrite = await enqueue(a, 'rewrite-state')
    await startWorker(); await waitStatus(rewrite, 'succeeded')
    assert.equal((await states.getStateRow(db, a.id)).version, stateVersion + 1)
    assert.equal((await row(rewrite)).state_refreshed, 1)
    const logout = await enqueue(a, 'logout')
    await waitStatus(logout, 'succeeded')
    assert.equal((await states.getStateRow(db, a.id)).status, 'expired')
    assert.equal((await row(logout)).state_expired, 1); assert.equal((await row(logout)).state_refreshed, 0)
    const expired = await until(() => db.selectFrom('ruyi_operation_logs').selectAll().where('action', '=', 'platform.state_expired')
      .where('user_id', '=', a.id).executeTakeFirst())
    assert.equal(detail(expired).jobId, logout)
    assert.equal((await request(a, 'POST', '/api/run/upload')).json().code, 'PLATFORM_LOGIN_REQUIRED')
    await storeCapturedState(db, a.id, storageState, keys)

    await reset()
    const disabled = await enqueue()
    await users.setStatus(db, a.id, 'disabled')
    await startWorker(); await waitStatus(disabled, 'failed')
    assert.equal((await row(disabled)).error_message, '用户不存在或已停用')
    await users.setStatus(db, a.id, 'active')
    await stopWorker()
    const cleared = await enqueue()
    await states.clearState(db, a.id)
    await startWorker(); await waitStatus(cleared, 'failed')
    assert.equal((await row(cleared)).error_message, '请先完成平台登录')
    await storeCapturedState(db, a.id, storageState, keys)

    await reset()
    const stopping = await enqueue(a, 'sleep')
    const pending = await enqueue(a)
    await startWorker()
    const stoppingPid = await pidOf(stopping)
    const beforeStop = Date.now()
    await stopWorker()
    assert.ok(Date.now() - beforeStop < 10500)
    assert.equal((await row(stopping)).status, 'interrupted')
    assert.equal((await finishLog(stopping)).result, 'failure')
    assert.equal(detail(await finishLog(stopping)).status, 'interrupted')
    assert.equal((await row(pending)).status, 'queued')
    assert.equal(alive(stoppingPid), false)
    assert.ok(stateDirs.every((dir) => !fs.existsSync(dir)))
    await startWorker(); await waitStatus(pending, 'succeeded')

    // 手动推进定时器，验证心跳与周期回收，无需等待 30 秒。
    await reset()
    const reclaimed = await enqueue()
    let releaseRunner, entered
    const enteredPromise = new Promise((resolve) => { entered = resolve })
    const intervals = new Map()
    const moduleStub = { exports: {} }
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../apps/worker/src/index.js'), 'utf8'), {
      module: moduleStub, process, AbortController, setTimeout, clearTimeout,
      setInterval(fn, ms) { intervals.set(ms, fn); return ms },
      clearInterval(ms) { intervals.delete(ms) },
      require(name) {
        if (name === '@ruyi/shared/runtime/repos/jobs') return jobs
        if (name === '@ruyi/shared/runtime/audit') return require('@ruyi/shared/runtime/audit')
        if (name === './runner') return { runJob }
        return require(name)
      },
    })
    worker = moduleStub.exports.createWorker({ ...workerOptions,
      runner: async () => { entered(); return new Promise((resolve) => { releaseRunner = resolve }) } })
    app.worker = worker
    await worker.start(); await enteredPromise
    assert.deepEqual([...intervals.keys()], [15000, 2000, 30000])
    const ageHeartbeat = () => db.updateTable('ruyi_jobs').set({ heartbeat_at: sql`DATE_SUB(NOW(3), INTERVAL 2 MINUTE)` })
      .where('id', '=', reclaimed).execute()
    await ageHeartbeat()
    intervals.get(15000)()
    await until(async () => Date.now() - +(await row(reclaimed)).heartbeat_at < 10000)
    await ageHeartbeat()
    intervals.get(30000)()
    await waitStatus(reclaimed, 'interrupted')
    assert.equal(detail(await finishLog(reclaimed)).status, 'interrupted')
    releaseRunner({ status: 'succeeded', exitCode: 0 })
    await until(() => serviceLogs.some((message) => message.includes('跳过结束操作记录')))
    assert.equal((await db.selectFrom('ruyi_operation_logs').select('id').where('target_id', '=', reclaimed)
      .where('action', '=', 'job.finish').execute()).length, 1)
    await stopWorker()
    assert.equal(intervals.size, 0)

    await reset()
    // 每用户五条上限在 HTTP 层保留；同用户与跨用户请求均可正常排队。
    for (let i = 0; i < 5; i++) await enqueue()
    const limited = await request(a, 'POST', '/api/run/upload')
    assert.equal(limited.statusCode, 409); assert.equal(limited.json().message, '排队任务过多，请等待已有任务完成')
    await enqueue(b)
    await reset()
    await jobs.withClaimLock(db, async () => {
      const busy = await request(a, 'POST', '/api/run/upload')
      assert.equal(busy.statusCode, 503)
      assert.equal(busy.json().message, '服务繁忙，请稍后重试')
    })
    assert.equal((await jobs.listJobs(db)).total, 0)

    // Worker 被 SIGKILL 时，IPC 断开必须清理进程组与明文文件。
    const orphan = await enqueue(a, 'sleep')
    child = fork(path.join(__dirname, 'fixtures/worker-child.js'), [], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      env: { ...process.env, RUYI_STATE_KEY: keyValue, FAKE_DATA_ROOT: dataRoot } })
    let childOutput = ''
    child.stdout.on('data', (data) => { childOutput += data })
    child.stderr.on('data', (data) => { childOutput += data })
    child.on('message', (message) => { orphanDir = message.stateDir })
    orphanPid = await pidOf(orphan)
    await until(() => orphanDir)
    const childExit = once(child, 'exit')
    const killedAt = Date.now()
    child.kill('SIGKILL'); await childExit; child = null
    await until(() => !alive(orphanPid), 'Worker 被强杀后假脚本仍存活', 6000)
    assert.ok(Date.now() - killedAt < 6100)
    assert.equal(fs.existsSync(orphanDir), false)
    assert.equal(childOutput.includes(marker), false)
    await db.updateTable('ruyi_jobs').set({ heartbeat_at: sql`DATE_SUB(NOW(3), INTERVAL 3 SECOND)` }).where('id', '=', orphan).execute()
    await startWorker({ staleSeconds: 1 })
    await waitStatus(orphan, 'interrupted')
    assert.equal(detail(await finishLog(orphan)).status, 'interrupted')
    const allLogs = JSON.stringify(await db.selectFrom('ruyi_operation_logs').selectAll().where('user_id', 'in', identities.map((user) => user.id)).execute())
    const finalResponse = JSON.stringify((await request(a, 'GET', '/api/jobs')).json()) + JSON.stringify(await readOutput(orphan))
    for (const value of [allLogs, finalResponse, JSON.stringify(serviceLogs)]) {
      assert.equal(value.includes(marker), false); assert.equal(value.includes('ruyi-state-'), false)
    }
    assert.ok(stateDirs.every((dir) => !fs.existsSync(dir)))
    for (const user of identities) {
      const dir = path.join(resolveWorkspace(user, dataRoot), 'logs')
      if (!fs.existsSync(dir)) continue
      for (const name of fs.readdirSync(dir)) {
        const content = fs.readFileSync(path.join(dir, name), 'utf8')
        assert.equal(content.includes(marker), false)
        assert.equal(content.includes('ruyi-state-'), false)
      }
    }
    console.log('Worker 入队执行、并发、取消、恢复、登录态、日志与接口隔离测试通过。')
  } finally {
    if (child) { child.kill('SIGKILL'); await once(child, 'exit').catch(() => {}) }
    if (orphanPid && alive(orphanPid)) process.kill(orphanPid, 'SIGKILL')
    if (worker) await worker.stop()
    if (app) await app.close()
    await clean(db)
    await db.destroy()
    fs.rmSync(dataRoot, { recursive: true, force: true })
  }
}
main().catch((error) => { console.error('Worker 测试失败：', error); process.exitCode = 1 })
