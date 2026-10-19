const { spawn } = require('node:child_process')
const path = require('node:path')
const { projectRoot } = require('../config')
const state = require('./state')

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

function startJob(task, script, { onFinish } = {}) {
  const startedAt = Date.now()
  const id = `${Date.now()}-${task}`
  const child = spawn(process.execPath, [path.join(projectRoot, script)], {
    cwd: projectRoot,
    env: { ...process.env, RUYI_HEADLESS: state.headlessMode ? '1' : '0' },
    // Put the workflow and its spawnSync descendants in a dedicated
    // process group so force release can terminate the whole tree.
    detached: true,
  })
  const job = { id, task: task, running: true, output: '' }
  Object.defineProperty(job, 'child', { value: child, enumerable: false, configurable: true })
  state.jobs.set(id, job)
  child.stdout.on('data', (data) => { job.output += data.toString() })
  child.stderr.on('data', (data) => { job.output += data.toString() })
  child.on('close', (code, signal) => {
    job.running = false; job.code = code
    if (onFinish) Promise.resolve().then(() => onFinish({
      id, task, code, signal: signal ?? null, durationMs: Date.now() - startedAt,
    })).catch(() => {})
  })
  return id
}

module.exports = { signalJobProcess, startJob }
