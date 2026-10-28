const fs = require('node:fs')
const path = require('node:path')
const users = require('@ruyi/shared/runtime/repos/users')
const jobs = require('@ruyi/shared/runtime/repos/jobs')
const { loadUserState } = require('@ruyi/shared/runtime/platform-state/index')
const { ensureWorkspace, resolveWorkspace, getWorkspaceStatus } = require('@ruyi/shared/runtime/workspace')
const { executeTask } = require('./execution')
const { beginResults, finishResults, sealResults } = require('@ruyi/shared/runtime/job-results')

const { scripts } = require('@ruyi/shared/tasks')
const failed = (errorMessage) => ({ status: 'failed', outcome: 'failure', exitCode: null, exitSignal: null,
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
    const resultJob = job.task === 'download'
    const initialStatus = getWorkspaceStatus(workspace)
    const pendingBefore = job.task === 'create' ? initialStatus.createCount
      : job.task === 'analyse' ? initialStatus.analyseCount : null
    if (pendingBefore !== null && pendingBefore <= 0) {
      fs.writeSync(fd, Buffer.from(`任务未执行：${job.task} 没有待处理项目\n`))
      return failed(`${job.task}任务没有待处理项目`)
    }
    if (resultJob) beginResults(workspace, job.id)
    fs.writeSync(fd, Buffer.from(`任务开始：${job.task}\n`))
    let outcome
    try {
      const execution = executeTask({ id: job.id, script: scriptPaths[job.task], user, uploadDir: workspace,
        headless: Boolean(job.headless), platformState, db, keys, log, signal, spawnImpl,
        env: { ...env, RUYI_RESULT_JOB_ID: resultJob ? job.id : '' },
        onOutput(data) { fs.writeSync(fd, data) },
      })
      outcome = await execution.completion
    } finally {
      // 无论成功、失败、取消还是执行异常，子进程结束后都封存清单，之后不会再被追加或覆盖。
      // 但取回接口只对成功和失败的任务开放，取消的任务即使已封存也返回 409（见 jobs/routes.js）。
      // 封存失败只记日志，不能掩盖原始结果。
      if (resultJob) {
        try {
          sealResults(workspace, job.id)
        } catch (error) {
          log?.warn?.(`下载结果封存失败：${error.message}`)
        }
      }
    }
    // 退出码 0 只能说明脚本进程正常退出；阶段清单必须同步反映完成，
    // 否则自动推进会把“未执行/未完成”误报成成功并重复消耗平台额度。
    if (outcome.status === 'succeeded' && !resultJob) {
      const status = getWorkspaceStatus(workspace)
      const pending = job.task === 'upload' ? status.rawCount
        : job.task === 'create' ? status.createCount
          : job.task === 'analyse' ? status.analyseCount : 0
      if (pending > 0) {
        outcome = { ...outcome, status: 'failed', outcome: 'failure',
          errorMessage: `${job.task}任务结束但仍有 ${pending} 项待处理，未确认完成` }
      }
    }
    if (resultJob && outcome.status === 'succeeded') {
      // 归档为空说明“成功”是假的（例如脚本以 0 退出但没真正下载），
      // 不能成为可下载任务，直接改判为失败。
      try {
        finishResults(workspace, job.id)
      } catch (error) {
        log?.warn?.(`下载结果归档失败：${error.message}`)
        outcome = { ...outcome, status: 'failed', outcome: 'failure', errorMessage: error.message }
      }
    }
    fs.writeSync(fd, Buffer.from(`任务结束：${outcome.status}，退出码 ${outcome.exitCode ?? '无'}${outcome.errorMessage ? `，${outcome.errorMessage}` : ''}\n`))
    return outcome
  } catch (_) {
    log?.error('任务执行失败，请查看任务状态')
    return failed('任务执行失败，请联系管理员')
  } finally {
    if (fd !== undefined) fs.closeSync(fd)
  }
}

module.exports = { runJob, scripts }
