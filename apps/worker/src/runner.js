const fs = require('node:fs')
const path = require('node:path')
const users = require('@ruyi/shared/runtime/repos/users')
const jobs = require('@ruyi/shared/runtime/repos/jobs')
const { loadUserState } = require('@ruyi/shared/runtime/platform-state/index')
const { ensureWorkspace, resolveWorkspace, getWorkspaceStatus } = require('@ruyi/shared/runtime/workspace')
const { UUID } = require('@ruyi/shared/runtime/task-workspace')
const { prepareTaskExecution, carryTaskResults } = require('@ruyi/shared/runtime/task-execution')
const { executeTask } = require('./execution')
const { beginResults, finishResults, sealResults } = require('@ruyi/shared/runtime/job-results')
const databaseResults = require('@ruyi/shared/runtime/db-job-results')
const taskRepo = require('@ruyi/shared/runtime/repos/tasks')
const executionRepo = require('@ruyi/shared/runtime/repos/task-execution')

const { scripts } = require('@ruyi/shared/tasks')
const failed = (errorMessage) => ({ status: 'failed', outcome: 'failure', exitCode: null, exitSignal: null,
  errorMessage, stateRefreshed: false, stateExpired: false })

async function runJob({ job, db, keys, log, dataRoot, signal, scriptPaths = scripts, spawnImpl, env }) {
  let fd
  const executionContext = job.task_id ? { taskId: job.task_id, userId: job.user_id, jobId: job.id,
    claimToken: job.claim_token, taskClaimToken: job.task_claim_token } : null
  try {
    const user = await users.findById(db, job.user_id)
    if (!user || user.status !== 'active') return failed('用户不存在或已停用')
    let platformState
    try { platformState = await loadUserState(db, user.id, keys) } catch (_) { /* 对外统一提示重新登录。 */ }
    // 没有可用登录态时由 Worker 将整用户队列置为 waiting_login，不能继续创建后续 job。
    if (!platformState) return { ...failed('请先完成平台登录'), loginRequired: true, stateExpired: false }
    if (signal?.aborted) return { ...failed(null), status: 'cancelled' }
    let workspace = resolveWorkspace(user, dataRoot), originalWorkspace
    if (job.task_id) {
      if (!UUID.test(job.task_id)) throw new Error('任务编号无效')
      workspace = path.join(workspace, 'tasks', job.task_id)
      const parent = fs.lstatSync(path.dirname(workspace))
      if (!parent.isDirectory() || parent.isSymbolicLink()) throw new Error('任务目录不安全')
      const stat = fs.lstatSync(workspace)
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('任务工作区目录不安全')
      originalWorkspace = workspace
      workspace = path.join(workspace, 'execution')
      ensureWorkspace(workspace)
    } else {
      workspace = ensureWorkspace(workspace)
    }
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
    if (job.task_id) {
      const rows = await executionRepo.prepareMappings(db, executionContext, { username: user.username })
      prepareTaskExecution(originalWorkspace, workspace, rows)
      if (!rows.some((row) => !row.excluded_at)) return { ...failed(null), status: 'cancelled' }
    }
    if (job.task_id) {
      const pending = await executionRepo.pendingFiles(db, executionContext, job.task)
      if (!pending.length && job.task !== 'download') {
        fs.writeSync(fd, Buffer.from(`任务流程已完成：${job.task} 没有待处理项目\n`))
        return { status: 'succeeded', outcome: 'success', exitCode: 0, exitSignal: null, errorMessage: null, stateRefreshed: false, stateExpired: false }
      }
    } else {
      const initialStatus = getWorkspaceStatus(workspace)
      const pendingBefore = job.task === 'create' ? initialStatus.createCount : job.task === 'analyse' ? initialStatus.analyseCount : null
      if (pendingBefore !== null && pendingBefore <= 0) {
        fs.writeSync(fd, Buffer.from(`任务未执行：${job.task} 没有待处理项目\n`))
        return failed(`${job.task}任务没有待处理项目`)
      }
    }
    if (resultJob) {
      if (job.task_id) await databaseResults.beginResults(workspace, job.id, { db, ...executionContext })
      else beginResults(workspace, job.id)
      if (job.task_id) {
        // 先前 NOT_READY 轮次可能已下载部分文件；最终成功包需包含这些已完成结果。
        const previous = await taskRepo.listTaskJobs(db, job.task_id, job.user_id)
        await carryTaskResults(workspace, job.id, previous, { db, ...executionContext })
      }
    }
    fs.writeSync(fd, Buffer.from(`任务开始：${job.task}\n`))
    let outcome
    try {
      const execution = executeTask({ id: job.id, businessTaskId: job.task_id, script: scriptPaths[job.task], user, uploadDir: workspace,
        headless: Boolean(job.headless), platformState, db, keys, log, signal, spawnImpl,
        env: { ...env, RUYI_RESULT_JOB_ID: resultJob ? job.id : '', ...(executionContext ? {
          RUYI_TASK_ID: executionContext.taskId, RUYI_USER_ID: String(executionContext.userId),
          RUYI_EXECUTION_JOB_ID: executionContext.jobId, RUYI_JOB_CLAIM_TOKEN: executionContext.claimToken,
          RUYI_TASK_CLAIM_TOKEN: executionContext.taskClaimToken,
        } : {}) },
        onOutput(data) { fs.writeSync(fd, data) },
      })
      outcome = await execution.completion
    } finally {
      // 无论成功、失败、取消还是执行异常，子进程结束后都封存清单，之后不会再被追加或覆盖。
      // 但取回接口只对成功和失败的任务开放，取消的任务即使已封存也返回 409（见 jobs/routes.js）。
      // 封存失败只记日志，不能掩盖原始结果。
      if (resultJob) {
        try {
          if (job.task_id) await databaseResults.sealResults(workspace, job.id, { db, ...executionContext })
          else sealResults(workspace, job.id)
        } catch (error) {
          log?.warn?.(`下载结果封存失败：${error.message}`)
        }
      }
    }
    // 退出码 0 只能说明脚本进程正常退出；阶段清单必须同步反映完成，
    // 否则自动推进会把“未执行/未完成”误报成成功并重复消耗平台额度。
    if (outcome.status === 'succeeded') {
      let pending
      if (job.task_id) pending = (await executionRepo.pendingFiles(db, executionContext, job.task)).length
      else {
        const status = getWorkspaceStatus(workspace)
        pending = job.task === 'upload' ? status.rawCount : job.task === 'create' ? status.createCount
          : job.task === 'analyse' ? status.analyseCount : resultJob ? status.doneCount : 0
      }
      if (pending > 0) {
        outcome = { ...outcome, status: 'failed', outcome: 'failure',
          errorMessage: `${job.task}任务结束但仍有 ${pending} 项待处理，未确认完成` }
      }
    }
    if (resultJob && outcome.status === 'succeeded') {
      // 归档为空说明“成功”是假的（例如脚本以 0 退出但没真正下载），
      // 不能成为可下载任务，直接改判为失败。
      try {
        if (job.task_id) await databaseResults.finishResults(workspace, job.id, { db, ...executionContext })
        else finishResults(workspace, job.id)
      } catch (error) {
        log?.warn?.(`下载结果归档失败：${error.message}`)
        outcome = { ...outcome, status: 'failed', outcome: 'failure', errorMessage: error.message }
      }
    }
    fs.writeSync(fd, Buffer.from(`任务结束：${outcome.status}，退出码 ${outcome.exitCode ?? '无'}${outcome.errorMessage ? `，${outcome.errorMessage}` : ''}\n`))
    return outcome
  } catch (error) {
    log?.error('任务执行失败，请查看任务状态')
    return failed(['TASK_DATABASE_ERROR', 'UNCERTAIN_PLATFORM_OPERATION'].includes(error.code) ? error.message : '任务执行失败，请联系管理员')
  } finally {
    if (fd !== undefined) fs.closeSync(fd)
  }
}

module.exports = { runJob, scripts }
