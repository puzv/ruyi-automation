const { spawn } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { createHash } = require('node:crypto')
const { projectRoot, jobWrapper, automationRoot } = require('@ruyi/shared/paths')
const { storeRefreshedState } = require('@ruyi/shared/runtime/platform-state/index')
const { markExpired } = require('@ruyi/shared/runtime/repos/platform-states')
const { TASK_OUTCOME } = require('@ruyi/shared/runtime/task-outcome')

const stateDirs = new Set()
const completions = new Set()
const digest = (content) => createHash('sha256').update(content).digest('hex')

function removeStateDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true })
  stateDirs.delete(dir)
}

async function cleanupJobStates() {
  await Promise.allSettled([...completions])
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
  try {
    process.kill(-pid, signal)
    return true
  } catch (error) {
    if (error.code === 'ESRCH') return false
    // macOS 沙箱对已消失的进程组也可能返回 EPERM，先确认包装器是否已退出。
    if (error.code === 'EPERM') {
      try { process.kill(pid, 0) } catch (probe) {
        if (probe.code === 'ESRCH') return false
      }
    }
    throw error
  }
}

// 内存测试路径与数据库 Worker 共用进程及登录态生命周期。
function executeTask({ id, script, user, uploadDir, headless, platformState, db, keys, log,
  signal, onOutput = () => {}, spawnImpl = spawn, env: extraEnv }) {
  const env = { ...process.env, ...extraEnv, RUYI_JOB_ID: id, RUYI_HEADLESS: headless ? '1' : '0' }
  if (user) env.RUYI_USER = user.username
  if (uploadDir) env.RUYI_UPLOAD_DIR = path.resolve(uploadDir)
  let dir, file, initialHash, child
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
    child = spawnImpl(process.execPath, [jobWrapper, path.resolve(automationRoot, script)], {
      cwd: projectRoot, env, detached: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    })
  } catch (_) {
    if (dir) removeStateDir(dir)
    throw new Error('任务进程启动失败，请联系管理员')
  }
  let cancelled = false, killTimer, finished = false
  const cancel = () => {
    if (finished || cancelled) return
    cancelled = true
    signalJobProcess({ child }, 'SIGTERM')
    killTimer = setTimeout(() => {
      try { signalJobProcess({ child }, 'SIGKILL') } catch (_) {
        log?.error('发送任务强制终止信号失败，等待包装器清理')
      }
    }, 5000)
  }
  // 脚本用非零退出码表达失败，但 stderr 不一定有内容（例如下载“未就绪”
  // 只是把原因打到 stdout 后以 2 退出）。保留最近几行，供失败时兜底说明原因。
  let recentOutput = ''
  const collect = (data) => {
    recentOutput = (recentOutput + data.toString('utf8')).slice(-2000)
    onOutput(data)
  }
  child.stdout.on('data', collect)
  child.stderr.on('data', collect)
  const lastLines = () => recentOutput.split('\n').map((line) => line.trim()).filter(Boolean).slice(-3).join('；')
  const completion = new Promise((resolve) => {
    async function finish(code, exitSignal, errorMessage = null) {
      if (finished) return
      finished = true
      clearTimeout(killTimer)
      signal?.removeEventListener('abort', cancel)
      if (code !== 0 && !errorMessage && !cancelled) {
        // 退出码 2 是脚本约定的“任务未就绪，可稍后重试”。
        const detail = lastLines()
        errorMessage = code === 2
          ? `任务未就绪，稍后可重试${detail ? `：${detail}` : ''}`
          : `任务执行失败${detail ? `：${detail}` : '，请联系管理员'}`
      }
      let stateRefreshed = false, stateExpired = false
      try {
        if (dir) {
          if (fs.existsSync(`${file}.logged-out`)) {
            stateExpired = await markExpired(db, { userId: user.id, expectedVersion: platformState.version })
            if (!stateExpired) log?.info('任务登录态版本已变化，跳过过期标记')
          } else {
            const content = fs.readFileSync(file)
            if (digest(content) !== initialHash) {
              stateRefreshed = await storeRefreshedState(db, user.id, platformState.version, JSON.parse(content.toString('utf8')), keys)
              if (!stateRefreshed) log?.info('任务登录态版本已变化，跳过回写')
            }
          }
        }
      } catch (_) {
        log?.error('处理任务登录态失败，任务结束流程继续')
      } finally {
        try { if (dir) removeStateDir(dir) } catch (_) { log?.error('清理任务登录态临时目录失败') }
      }
      const outcome = cancelled ? null : code === TASK_OUTCOME.SUCCESS ? 'success'
        : code === TASK_OUTCOME.NOT_READY ? 'not_ready' : 'failure'
      resolve({ status: cancelled ? 'cancelled' : code === TASK_OUTCOME.SUCCESS ? 'succeeded' : 'failed',
        outcome, exitCode: code ?? null, exitSignal: exitSignal ?? null, errorMessage, stateRefreshed, stateExpired })
    }
    child.on('close', finish)
    child.on('error', () => {
      onOutput(Buffer.from('任务进程启动失败，请联系管理员。\n'))
      finish(1, null, '任务进程启动失败，请联系管理员')
    })
  })
  signal?.addEventListener('abort', cancel, { once: true })
  if (signal?.aborted) cancel()
  return { child, completion, cancel }
}

function trackCompletion(completion, log) {
  completions.add(completion)
  completion.catch(() => log?.error('记录任务结束信息失败')).finally(() => completions.delete(completion))
}

module.exports = { executeTask, signalJobProcess, cleanupJobStates, trackCompletion }
