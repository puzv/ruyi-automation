const { randomUUID } = require('node:crypto')
const state = require('./state')
const { executeTask, signalJobProcess, cleanupJobStates, trackCompletion } = require('./worker/execution')

function jobBelongsToUser(job, user) {
  return !user || (job.userId === user.id && job.username === user.username)
}

function startJob(task, script, { user, uploadDir, onFinish, platformState, db, keys, log } = {}) {
  const startedAt = Date.now()
  const id = randomUUID()
  const job = { id, task, running: true, output: '' }
  const execution = executeTask({ id, script, user, uploadDir, headless: state.headlessMode,
    platformState, db, keys, log, onOutput(data) { job.output += data.toString() } })
  Object.defineProperties(job, {
    userId: { value: user?.id ?? null, enumerable: false },
    username: { value: user?.username ?? null, enumerable: false },
    child: { value: execution.child, enumerable: false, configurable: true },
    expectedVersion: { value: platformState?.version ?? null, enumerable: false },
  })
  state.jobs.set(id, job)
  execution.completion.then((result) => trackCompletion((async () => {
    job.code = result.exitCode
    job.running = false
    if (onFinish) await onFinish({ id, task, code: result.exitCode, signal: result.exitSignal,
      durationMs: Date.now() - startedAt, stateRefreshed: result.stateRefreshed, stateExpired: result.stateExpired })
  })(), log))
  return id
}

module.exports = { signalJobProcess, startJob, jobBelongsToUser, cleanupJobStates }
