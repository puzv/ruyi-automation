const fs = require('node:fs')
const path = require('node:path')
const users = require('@ruyi/shared/runtime/repos/users')
const jobs = require('@ruyi/shared/runtime/repos/jobs')
const { loadUserState } = require('@ruyi/shared/runtime/platform-state/index')
const { ensureWorkspace, resolveWorkspace } = require('@ruyi/shared/runtime/workspace')
const { executeTask } = require('./execution')

const { scripts } = require('@ruyi/shared/tasks')
const failed = (errorMessage) => ({ status: 'failed', exitCode: null, exitSignal: null,
  errorMessage, stateRefreshed: false, stateExpired: false })

async function runJob({ job, db, keys, log, dataRoot, signal, scriptPaths = scripts, spawnImpl, env }) {
  let fd
  try {
    const user = await users.findById(db, job.user_id)
    if (!user || user.status !== 'active') return failed('用户不存在或已停用')
    let platformState
    try { platformState = await loadUserState(db, user.id, keys) } catch (_) { /* 对外统一提示重新登录。 */ }
    if (!platformState) return failed('请先完成平台登录')
    if (signal?.aborted) return { ...failed(null), status: 'cancelled' }
    const workspace = ensureWorkspace(resolveWorkspace(user, dataRoot))
    const logDir = path.join(workspace, 'logs')
    fs.mkdirSync(logDir, { recursive: true })
    if (fs.lstatSync(logDir).isSymbolicLink()) throw new Error('日志目录不安全')
    const logPath = `logs/${job.id}.log`
    fd = fs.openSync(path.join(workspace, logPath), 'wx', 0o600)
    fs.fchmodSync(fd, 0o600)
    if (!await jobs.setLogPath(db, { id: job.id, claimToken: job.claim_token, logPath })) {
      return failed('任务已被回收')
    }
    const execution = executeTask({ id: job.id, script: scriptPaths[job.task], user, uploadDir: workspace,
      headless: Boolean(job.headless), platformState, db, keys, log, signal, spawnImpl, env,
      onOutput(data) { fs.writeSync(fd, data) },
    })
    return await execution.completion
  } catch (_) {
    log?.error('任务执行失败，请查看任务状态')
    return failed('任务执行失败，请联系管理员')
  } finally {
    if (fd !== undefined) fs.closeSync(fd)
  }
}

module.exports = { runJob, scripts }
