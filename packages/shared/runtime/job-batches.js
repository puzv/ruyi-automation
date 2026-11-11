const { createHash } = require('node:crypto');

const TASKS = ['upload', 'create', 'analyse', 'download'];

function batchStatus(steps) {
  const states = steps.map((step) => step.status);
  for (const status of ['running', 'queued', 'failed', 'interrupted', 'cancelled']) {
    if (states.includes(status)) return status;
  }
  return states.every((status) => status === 'succeeded') ? 'succeeded' : 'waiting';
}

function summarizeBatch(id, records) {
  // 仓库按入队时间和 ID 升序返回；同一流程重试后以最新记录为准，但保留全部日志。
  const steps = TASKS.map((task) => {
    const latest = records.filter((job) => job.task === task).at(-1);
    return { task, ...latest, status: latest?.status || 'pending' };
  });
  const first = records[0];
  return {
    id, shortId: createHash('sha256').update(id).digest('hex').slice(0, 8),
    username: first.username, queuedAt: first.queuedAt, updatedAt: records.at(-1).queuedAt,
    status: records.some((job) => job.status === 'running') ? 'running'
      : records.some((job) => job.status === 'queued') ? 'queued' : batchStatus(steps),
    completedSteps: steps.filter((step) => step.status === 'succeeded').length,
    steps, records, legacy: !records.some((job) => job.id === id && job.task === 'upload'),
  };
}

module.exports = { TASKS, batchStatus, summarizeBatch };
