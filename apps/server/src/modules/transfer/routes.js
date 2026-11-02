const { resolveWorkspace } = require('@ruyi/shared/runtime/workspace');
const { zipStream } = require('@ruyi/shared/runtime/job-results');
const { writeLog, auditFromRequest } = require('@ruyi/shared/runtime/audit');
const { publicUser } = require('../auth/session');
const { importMultipartFiles } = require('../files/import');
const { resultsFor } = require('../jobs/routes');
const { consumeTicket } = require('./repository');

async function registerTransferRoutes(app, { dataRoot, userHasRunningJob }) {
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
      return await importMultipartFiles(req, reply, {
        workspace: resolveWorkspace(req.user, dataRoot), userHasRunningJob, includeFiles: true,
      });
    } catch (_) {
      return reply.code(500).send({ ok: false, message: '文件导入失败，请重新获取链接后重试' });
    }
  });
  app.get('/api/transfer/download/:ticket', {
    onRequest: async (req, reply) => {
      const ticket = await claim(req, reply, 'download');
      if (ticket) req.transferJobId = ticket.jobId;
    },
  }, async (req, reply) => {
    const jobId = req.transferJobId;
    req.params.id = jobId;
    const result = await resultsFor(app, req, reply, dataRoot);
    await writeLog(app.db, auditFromRequest(req, {
      action: 'job.results_download', targetType: 'job', targetId: jobId,
      result: result ? 'success' : 'failure', detail: { via: 'transfer_ticket' },
      ...(!result ? { errorMessage: '任务结果不可下载，请重新获取链接' } : {}),
    }), app.log);
    if (!result) return;
    const stream = zipStream(result.workspace, jobId, result.entries);
    reply.raw.once('close', () => stream.destroy());
    return reply.header('Cache-Control', 'private, no-store')
      .header('X-Content-Type-Options', 'nosniff')
      .header('Content-Disposition', `attachment; filename="ruyi-results-${jobId}.zip"`)
      .header('Content-Length', result.entries.size).type('application/zip').send(stream);
  });
}

module.exports = { registerTransferRoutes };
