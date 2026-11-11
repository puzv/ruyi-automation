const tasks = require('@ruyi/shared/runtime/repos/tasks');
const jobs = require('@ruyi/shared/runtime/repos/jobs');
const { zipStream } = require('@ruyi/shared/runtime/job-results');
const databaseResults = require('@ruyi/shared/runtime/db-job-results');
const { writeLog, auditFromRequest } = require('@ruyi/shared/runtime/audit');
const { publicUser } = require('../auth/session');
const { createFromMultipart } = require('../tasks/import');
const { safeError } = require('../tasks/routes');
const { resultsFor } = require('../jobs/routes');
const { consumeTicket } = require('./repository');

async function registerTransferRoutes(app, { dataRoot, canImportFiles }) {
  const claim = async (req, reply, purpose) => {
    const ticket = await consumeTicket(app.db, { secret: req.params.ticket, purpose });
    if (!ticket) {
      reply.code(404).send({ ok: false, message: '链接无效或已过期，请重新获取' });
      return null;
    }
    req.user = publicUser(ticket.user);
    return ticket;
  };
  app.post('/api/transfer/upload/:ticket', {
    onRequest: async (req, reply) => { await claim(req, reply, 'upload'); },
  }, async (req, reply) => {
    try {
      const item = await createFromMultipart(req, { db: app.db, root: dataRoot, canImportFiles });
      app.worker?.wake();
      return reply.code(201).send({ ok: true, item, taskId: item.id, message: '整任务已创建并加入执行队列，将自动完成上传、创建、洞悉和下载' });
    } catch (error) {
      return safeError(reply, error);
    }
  });
  app.get('/api/transfer/download/:ticket', {
    onRequest: async (req, reply) => {
      const ticket = await claim(req, reply, 'download');
      if (ticket) req.transferJobId = ticket.jobId;
    },
  }, async (req, reply) => {
    const jobId = req.transferJobId;
    const job = await jobs.getJobForUser(app.db, jobId, req.user.id);
    const task = job?.task_id && await tasks.getTaskForUser(app.db, job.task_id, req.user.id);
    if (!task || task.status !== 'succeeded' || job.task !== 'download' || job.status !== 'succeeded') {
      return reply.code(404).send({ ok: false, message: '整任务结果不存在或不可下载，请重新获取链接' });
    }
    req.params.id = jobId;
    const result = await resultsFor(app, req, reply, dataRoot);
    await writeLog(app.db, auditFromRequest(req, {
      action: 'job.results_download', targetType: 'job', targetId: jobId,
      result: result ? 'success' : 'failure', detail: { via: 'transfer_ticket' },
      ...(!result ? { errorMessage: '任务结果不可下载，请重新获取链接' } : {}),
    }), app.log);
    if (!result) return;
    const stream = (result.database ? databaseResults.zipStream : zipStream)(result.workspace, jobId, result.entries);
    reply.raw.once('close', () => stream.destroy());
    return reply.header('Cache-Control', 'private, no-store')
      .header('X-Content-Type-Options', 'nosniff')
      .header('Content-Disposition', `attachment; filename="ruyi-results-${jobId}.zip"`)
      .header('Content-Length', result.entries.size).type('application/zip').send(stream);
  });
}

module.exports = { registerTransferRoutes };
