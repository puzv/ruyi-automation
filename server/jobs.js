const { spawn } = require('node:child_process')
const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')
const { randomUUID, createHash } = require('node:crypto')
const { projectRoot } = require('../config')
const state = require('./state')
const { storeRefreshedState } = require('./platform-state')
const { markExpired } = require('./repos/platform-states')

// 临时路径和明文只保留在闭包中，不能随任务接口序列化。
const stateDirs = new Set()
const finishingJobs = new Set()
const digest = (content) => createHash('sha256').update(content).digest('hex')

function removeStateDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true })
  stateDirs.delete(dir)
}

async function cleanupJobStates() {
  await Promise.allSettled([...finishingJobs])
  for (const dir of [...stateDirs]) removeStateDir(dir)
}

function signalJobProcess(job, signal) {
  const pid = job?.child?.pid
  if (!pid || pid === process.pid) return false
  if (process.platform === 'win32') {
    const args = ['/PID', String(pid), '/T']
    if (signal === 'SIGKILL') args.push('/F')
    spawn('taskkill', args, { detached: true, stdio: 'ignore' }).unref()
    return true
  }
  process.kill(-pid, signal)
  return true
}

function jobBelongsToUser(job, user) {
  return !user || (job.userId === user.id && job.username === user.username)
}

function startJob(task, script, { user, uploadDir, onFinish, platformState, db, keys, log } = {}) {
  const startedAt = Date.now()
  const id = randomUUID()
  const env = { ...process.env, RUYI_HEADLESS: state.headlessMode ? '1' : '0', RUYI_JOB_ID: id }
  if (user) env.RUYI_USER = user.username
  if (uploadDir) env.RUYI_UPLOAD_DIR = path.resolve(uploadDir)
  let dir, file, initialHash
  let child
  try {
    if (platformState) {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-state-'))
      stateDirs.add(dir)
      fs.chmodSync(dir, 0o700)
      file = path.join(dir, 'state.json')
      const content = JSON.stringify(platformState.state)
      fs.writeFileSync(file, content, { mode: 0o600, flag: 'wx' })
      initialHash = digest(content)
      env.RUYI_STATE_FILE = file
    }
    child = spawn(process.execPath, [path.join(projectRoot, script)], {
      cwd: projectRoot,
      env,
      // Put the workflow and its spawnSync descendants in a dedicated
      // process group so force release can terminate the whole tree.
      detached: true,
    })
  } catch (_) {
    if (dir) removeStateDir(dir)
    throw new Error('任务进程启动失败，请联系管理员')
  }
  const job = { id, task, running: true, output: '' }
  Object.defineProperties(job, {
    userId: { value: user?.id ?? null, enumerable: false },
    username: { value: user?.username ?? null, enumerable: false },
    child: { value: child, enumerable: false, configurable: true },
    expectedVersion: { value: platformState?.version ?? null, enumerable: false },
  })
  state.jobs.set(id, job)
  child.stdout.on('data', (data) => { job.output += data.toString() })
  child.stderr.on('data', (data) => { job.output += data.toString() })
  let finished = false
  function finish(code, signal) {
    if (finished) return
    finished = true
    job.code = code
    if (!dir) job.running = false
    const completion = (async () => {
      let stateRefreshed = false, stateExpired = false
      try {
        if (dir) {
          if (fs.existsSync(`${file}.logged-out`)) {
            stateExpired = await markExpired(db, { userId: user.id, expectedVersion: job.expectedVersion })
            if (!stateExpired) log?.info('任务登录态版本已变化，跳过过期标记')
          } else {
            const content = fs.readFileSync(file)
            if (digest(content) !== initialHash) {
              stateRefreshed = await storeRefreshedState(db, user.id, job.expectedVersion, JSON.parse(content.toString('utf8')), keys)
              if (!stateRefreshed) log?.info('任务登录态版本已变化，跳过回写')
            }
          }
        }
      } catch (_) {
        // 不输出解析异常，异常信息可能带有登录态明文或临时路径。
        log?.error('处理任务登录态失败，任务结束流程继续')
      } finally {
        try { if (dir) removeStateDir(dir) } catch (_) { log?.error('清理任务登录态临时目录失败') }
        job.running = false
      }
      if (onFinish) await onFinish({
        id, task, code, signal: signal ?? null, durationMs: Date.now() - startedAt, stateRefreshed, stateExpired,
      })
    })()
    finishingJobs.add(completion)
    completion.catch(() => { log?.error('记录任务结束信息失败') }).finally(() => finishingJobs.delete(completion))
  }
  child.on('close', finish)
  child.on('error', () => {
    job.output += '任务进程启动失败，请联系管理员。\n'
    finish(1, null)
  })
  return id
}

module.exports = { signalJobProcess, startJob, jobBelongsToUser, cleanupJobStates }
