const os = require('node:os')
const { randomUUID } = require('node:crypto')
const jobs = require('@ruyi/shared/runtime/repos/jobs')
const taskRepo = require('@ruyi/shared/runtime/repos/tasks')
const { writeLog } = require('@ruyi/shared/runtime/audit')
const { isWaitingPlatform, isWaitingLogin } = require('@ruyi/shared/runtime/task-job-presentation')
const { runJob } = require('./runner')

function createWorker({ db, keys, log, dataRoot, workerId = `${os.hostname()}:${process.pid}`,
  maxConcurrent = Number(process.env.RUYI_MAX_CONCURRENT_JOBS), pollMs = 1000,
  runner = runJob, runnerOptions = {}, staleSeconds = 60, retryMs = 120000, onFinished,
  taskRepository = taskRepo, jobRepository = jobs, auditWriter = writeLog }) {
  const limit = Number.isSafeInteger(maxConcurrent) && maxConcurrent > 0 ? maxConcurrent : 2
  const tasks = taskRepository, jobRepo = jobRepository
  const taskRuns = new Map()
  const running = new Map()
  const timers = new Set()
  const maintenance = new Set()
  let started = false, stopping = false, starting, pumping, pollTimer, stopPromise, wakePending = false
  const origin = (job) => ({ userId: job.user_id ?? job.userId, username: job.username,
    requestId: job.request_id ?? job.requestId ?? null })

  async function auditFinish(job, result) {
    const waiting = isWaitingPlatform({ taskId: job.task_id, ...result })
    const login = isWaitingLogin({ taskId: job.task_id, ...result })
    if (result.stateExpired) await auditWriter(db, { ...origin(job), action: 'platform.state_expired',
      result: 'success', detail: { jobId: job.id } }, log)
    await auditWriter(db, { ...origin(job), action: 'job.finish', targetType: 'job', targetId: job.id,
      result: waiting || login || result.status === 'succeeded' ? 'success' : 'failure', errorMessage: waiting || login ? null : result.errorMessage,
      detail: { task: job.task, taskId: job.task_id ?? null, status: login ? 'waiting_login' : waiting ? 'waiting_platform' : result.status,
        ...(waiting ? { outcome: 'not_ready' } : {}), ...(login ? { outcome: 'login_required' } : {}), code: result.exitCode ?? null, signal: result.exitSignal ?? null,
        durationMs: job.started_at ? Math.max(0, Date.now() - new Date(job.started_at).getTime()) : 0,
        queuedMs: job.started_at ? Math.max(0, new Date(job.started_at) - new Date(job.queued_at)) : 0,
        stateRefreshed: Boolean(result.stateRefreshed), stateExpired: Boolean(result.stateExpired), loginRequired: Boolean(result.loginRequired) },
    }, log)
  }

  async function recover() {
    const rows = await jobRepo.recoverStaleJobs(db, { staleSeconds })
    for (const recovered of rows) {
      const job = await jobRepo.getJob(db, recovered.id)
      await auditFinish(job ?? recovered, { status: 'interrupted',
        errorMessage: '服务重启或异常退出，任务已中断' })
    }
    await tasks.recoverStaleTasks(db, { staleSeconds })
  }

  function periodic(fn, ms) {
    let busy = false
    const timer = setInterval(() => {
      if (busy || stopping) return
      busy = true
      const task = Promise.resolve().then(fn).catch(() => log?.error('Worker 定期检查失败，将在下次重试'))
        .finally(() => { busy = false; maintenance.delete(task) })
      maintenance.add(task)
    }, ms)
    timers.add(timer)
  }

  function launch(job, afterFinish) {
    const controller = new AbortController()
    const entry = { job, controller, interrupted: stopping }
    running.set(job.id, entry)
    if (stopping) controller.abort()
    entry.finish = (result) => {
      if (entry.finishing) return entry.finishing
      entry.finishing = (async () => {
        if (entry.interrupted) result = { ...result, status: 'interrupted', errorMessage: '服务停止，任务已中断' }
        const updated = await jobRepo.finishJob(db, { id: job.id, claimToken: job.claim_token, ...result })
        if (updated) await auditFinish(job, result)
        else log?.info('任务已被其他 Worker 回收，跳过结束操作记录')
        if (updated) await afterFinish?.(result)
      })()
      return entry.finishing
    }
    entry.promise = (async () => {
      let result
      try {
        result = await runner({ ...runnerOptions, job, db, keys, log, dataRoot, signal: controller.signal })
      } catch (_) {
        log?.error('Worker 执行任务失败')
        result = { status: 'failed', errorMessage: '任务执行失败，请联系管理员' }
      }
      await entry.finish(result)
    })().catch(() => log?.error('Worker 保存任务结束信息失败，将由心跳回收'))
      .finally(() => {
        running.delete(job.id)
        // 任务刚结束时平台状态最可能发生变化，让自动推进立即检查一次。
        try { if (!job.task_id) onFinished?.(job) } catch (_) { log?.error('任务结束通知失败') }
        wake()
      })
    return entry.promise
  }

  function launchTask(task) {
    const controller = new AbortController()
    const entry = { task, controller }
    taskRuns.set(task.id, entry)
    const finish = (status, errorMessage) => tasks.finishTask(db, {
      id: task.id, claimToken: task.claim_token, status, errorMessage,
    })
    entry.promise = (async () => {
      while (true) {
        const current = await tasks.getTaskForUser(db, task.id, task.user_id)
        if (!current || current.status !== 'running' || current.claim_token !== task.claim_token) return
        if (stopping) { await finish('interrupted', '服务停止，任务已中断'); return }
        if (current.cancel_requested) { await finish('interrupted', '用户停止，任务已中断，可继续任务'); return }
        const job = await jobRepo.enqueueTaskJob(db, { id: randomUUID(), taskId: task.id,
          userId: task.user_id, username: task.username, task: current.current_step,
          headless: true, workerId, claimToken: randomUUID(), taskClaimToken: task.claim_token })
        if (!job) {
          const latest = await tasks.getTaskForUser(db, task.id, task.user_id)
          if (latest?.claim_token === task.claim_token && latest.status === 'running') {
            await finish(latest.cancel_requested ? 'interrupted' : 'failed', latest.cancel_requested
              ? '用户停止，任务已中断，可继续任务' : '流程认领失败，任务已停止')
          }
          return
        }
        // 子进程读写逐文件状态时必须同时证明整任务和子流程的当前租约。
        job.task_claim_token = task.claim_token
        let parked = false, advance = false
        await launch(job, async (result) => {
          const latest = await tasks.getTaskForUser(db, task.id, task.user_id)
          if (latest?.cancel_requested && result.status !== 'interrupted') {
            await finish('interrupted', '用户停止，任务已中断，可继续任务')
          } else if (['cancelled', 'interrupted'].includes(result.status)) {
            await finish(result.status, result.errorMessage)
          } else if (result.loginRequired || result.stateExpired) {
            const frozen = await tasks.markUserWaitingLogin(db, { id: task.id, userId: task.user_id, claimToken: task.claim_token })
            if (!frozen) {
              const latest = await tasks.getTaskForUser(db, task.id, task.user_id)
              if (latest?.status === 'running' && latest.claim_token === task.claim_token && latest.cancel_requested) {
                await finish('interrupted', '用户停止，任务已中断，可继续任务')
              }
            }
          } else if (result.outcome === 'not_ready') {
            parked = await tasks.releaseTaskForPlatformWait(db, { id: task.id, claimToken: task.claim_token, nextCheckAt: new Date(Date.now() + retryMs) })
          } else if (result.status === 'succeeded') {
            const next = { upload: 'create', create: 'analyse', analyse: 'download', download: null }[current.current_step]
            if (next) advance = await tasks.updateTaskStep(db, { id: task.id, claimToken: task.claim_token, currentStep: next })
            else await finish('succeeded')
          } else await finish('failed', result.errorMessage)
        })
        // 等待是数据库中的持久状态，不再占据 Worker 执行集合或保持浏览器。
        if (parked) return
        if (!advance) {
          const latest = await tasks.getTaskForUser(db, task.id, task.user_id)
          if (latest?.status === 'running' && latest.claim_token === task.claim_token) {
            await finish('failed', '流程执行记录保存失败，任务已停止')
          }
          return
        }
      }
    })().catch(async () => {
      log?.error('Worker 推进整任务失败')
      await finish(stopping ? 'interrupted' : 'failed', '任务推进失败，请联系管理员')
    }).catch(() => log?.error('Worker 保存整任务状态失败，将由心跳回收'))
      .finally(() => { taskRuns.delete(task.id); wake() })
  }

  function wake() {
    if (!started || stopping) return
    clearTimeout(pollTimer)
    if (pumping) { wakePending = true; return }
    pumping = (async () => {
      while (!stopping && taskRuns.size + [...running.values()].filter((entry) => !entry.job.task_id).length < limit) {
        const task = await tasks.claimNextTask(db, { workerId, claimToken: randomUUID(), maxConcurrent: limit })
        if (task) { launchTask(task); continue }
        const job = await jobRepo.claimNextJob(db, { workerId, claimToken: randomUUID(), maxConcurrent: limit })
        if (!job) break
        launch(job)
      }
    })().catch(() => log?.error('Worker 认领任务失败，将稍后重试')).finally(() => {
      pumping = null
      if (!stopping) {
        if (wakePending) { wakePending = false; Promise.resolve().then(wake) }
        else pollTimer = setTimeout(wake, pollMs)
      }
    })
  }

  function start() {
    if (stopping) return Promise.reject(new Error('已停止的 Worker 不能再次启动'))
    if (starting) return starting
    starting = (async () => {
      await recover()
      if (stopping) return
      started = true
      // 结束写库失败的任务已离开执行集合，停止续租后可由回收流程中断。
      periodic(() => jobRepo.heartbeat(db, { workerId, jobIds: [...running.keys()] }), 15000)
      periodic(() => tasks.heartbeatTasks(db, { workerId, taskIds: [...taskRuns.keys()] }), 15000)
      periodic(async () => {
        for (const job of await jobRepo.listCancelRequested(db, { workerId })) running.get(job.id)?.controller.abort()
      }, 2000)
      periodic(async () => {
        const rows = await db.selectFrom('ruyi_tasks').selectAll().where('worker_id', '=', workerId).where('status', '=', 'running').where('cancel_requested', '=', 1).execute()
        for (const task of rows) {
          taskRuns.get(task.id)?.controller.abort()
          for (const entry of running.values()) if (entry.job.task_id === task.id) entry.controller.abort()
        }
      }, 2000)
      periodic(recover, 30000)
      wake()
    })()
    return starting
  }

  function stop() {
    if (stopPromise) return stopPromise
    stopping = true
    clearTimeout(pollTimer)
    for (const timer of timers) clearInterval(timer)
    const abortAll = () => {
      for (const entry of taskRuns.values()) entry.controller.abort()
      for (const entry of running.values()) {
        entry.interrupted = true
        entry.controller.abort()
      }
    }
    abortAll()
    stopPromise = (async () => {
      let deadline
      await Promise.race([
        (async () => {
          await starting?.catch(() => {})
          await pumping
          abortAll()
          await Promise.allSettled([...running.values(), ...taskRuns.values()].map((entry) => entry.promise))
          await Promise.allSettled([...maintenance])
        })(),
        new Promise((resolve) => { deadline = setTimeout(resolve, 10000) }),
      ])
      clearTimeout(deadline)
      await Promise.allSettled([...running.values()].map((entry) => entry.finish({ status: 'interrupted' })))
      started = false
    })()
    return stopPromise
  }

  return { start, stop, wake }
}

module.exports = { createWorker }
