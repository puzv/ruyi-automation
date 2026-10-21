const os = require('node:os')
const { randomUUID } = require('node:crypto')
const jobs = require('@ruyi/shared/runtime/repos/jobs')
const { writeLog } = require('@ruyi/shared/runtime/audit')
const { runJob } = require('./runner')

function createWorker({ db, keys, log, dataRoot, workerId = `${os.hostname()}:${process.pid}`,
  maxConcurrent = Number(process.env.RUYI_MAX_CONCURRENT_JOBS), pollMs = 1000,
  runner = runJob, runnerOptions = {}, staleSeconds = 60 }) {
  const limit = Number.isSafeInteger(maxConcurrent) && maxConcurrent > 0 ? maxConcurrent : 2
  const running = new Map()
  const timers = new Set()
  const maintenance = new Set()
  let started = false, stopping = false, starting, pumping, pollTimer, stopPromise, wakePending = false
  const origin = (job) => ({ userId: job.user_id ?? job.userId, username: job.username,
    requestId: job.request_id ?? job.requestId ?? null })

  async function auditFinish(job, result) {
    if (result.stateExpired) await writeLog(db, { ...origin(job), action: 'platform.state_expired',
      result: 'success', detail: { jobId: job.id } }, log)
    await writeLog(db, { ...origin(job), action: 'job.finish', targetType: 'job', targetId: job.id,
      result: result.status === 'succeeded' ? 'success' : 'failure', errorMessage: result.errorMessage,
      detail: { task: job.task, status: result.status, code: result.exitCode ?? null, signal: result.exitSignal ?? null,
        durationMs: job.started_at ? Math.max(0, Date.now() - new Date(job.started_at).getTime()) : 0,
        queuedMs: job.started_at ? Math.max(0, new Date(job.started_at) - new Date(job.queued_at)) : 0,
        stateRefreshed: Boolean(result.stateRefreshed), stateExpired: Boolean(result.stateExpired) },
    }, log)
  }

  async function recover() {
    const rows = await jobs.recoverStaleJobs(db, { staleSeconds })
    for (const recovered of rows) {
      const job = await jobs.getJob(db, recovered.id)
      await auditFinish(job ?? recovered, { status: 'interrupted',
        errorMessage: '服务重启或异常退出，任务已中断' })
    }
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

  function launch(job) {
    const controller = new AbortController()
    const entry = { job, controller, interrupted: stopping }
    running.set(job.id, entry)
    if (stopping) controller.abort()
    entry.finish = (result) => {
      if (entry.finishing) return entry.finishing
      entry.finishing = (async () => {
        if (entry.interrupted) result = { ...result, status: 'interrupted', errorMessage: '服务停止，任务已中断' }
        const updated = await jobs.finishJob(db, { id: job.id, claimToken: job.claim_token, ...result })
        if (updated) await auditFinish(job, result)
        else log?.info('任务已被其他 Worker 回收，跳过结束操作记录')
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
      .finally(() => { running.delete(job.id); wake() })
  }

  function wake() {
    if (!started || stopping) return
    clearTimeout(pollTimer)
    if (pumping) { wakePending = true; return }
    pumping = (async () => {
      while (!stopping && running.size < limit) {
        const job = await jobs.claimNextJob(db, { workerId, claimToken: randomUUID() })
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
      periodic(() => jobs.heartbeat(db, { workerId, jobIds: [...running.keys()] }), 15000)
      periodic(async () => {
        for (const job of await jobs.listCancelRequested(db, { workerId })) running.get(job.id)?.controller.abort()
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
          await Promise.allSettled([...running.values()].map((entry) => entry.promise))
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
