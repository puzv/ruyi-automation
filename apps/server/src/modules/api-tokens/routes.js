const crypto = require('crypto');
const { hashToken } = require('../auth/session');
const repository = require('./repository');

function publicItem(row) {
  return {
    id: row.id, name: row.name, displayPrefix: row.display_prefix,
    createdAt: row.created_at, lastUsedAt: row.last_used_at,
    expiresAt: row.expires_at, revokedAt: row.revoked_at, status: row.status,
  };
}

async function registerApiTokenRoutes(app) {
  app.get('/api/api-tokens', async (request) => ({
    ok: true, items: (await repository.listForUser(app.db, request.user.id)).map(publicItem),
  }));

  app.post('/api/api-tokens', async (request, reply) => {
    const { name, expiresInDays } = request.body || {};
    if (typeof name !== 'string' || !name.trim() || Array.from(name.trim()).length > 64) {
      return reply.code(400).send({ ok: false, message: '名称需为 1 至 64 个字符' });
    }
    if (![30, 90, 365].includes(expiresInDays)) {
      return reply.code(400).send({ ok: false, message: '有效期只能为 30、90 或 365 天' });
    }
    const token = `ruyi_pat_${crypto.randomBytes(32).toString('base64url')}`;
    const result = await app.db.transaction().execute(async (trx) => {
      // 同一用户的创建请求串行计数，避免并发突破十个有效令牌的上限。
      await trx.selectFrom('ruyi_users').select('id').where('id', '=', request.user.id).forUpdate().executeTakeFirstOrThrow();
      if (await repository.countActiveForUser(trx, request.user.id) >= 10) return null;
      const id = await repository.create(trx, {
        userId: request.user.id, name: name.trim(), expiresInDays,
        displayPrefix: token.slice(0, 13), secretHash: hashToken(token),
      });
      const items = await repository.listForUser(trx, request.user.id);
      return publicItem(items.find((item) => Number(item.id) === id));
    }).catch(() => {
      // 数据库错误可能包含哈希参数，不交给通用错误处理器输出原始异常。
      throw new Error('创建令牌失败，请稍后重试');
    });
    if (!result) return reply.code(409).send({ ok: false, message: '有效令牌最多 10 个，请先吊销不再使用的令牌' });
    return { ok: true, token, item: result };
  });

  app.post('/api/api-tokens/:id/revoke', async (request, reply) => {
    const id = request.params.id;
    if (!/^[1-9]\d*$/.test(id) || !await repository.revoke(app.db, id, request.user.id)) {
      return reply.code(404).send({ ok: false, message: '令牌不存在' });
    }
    return { ok: true };
  });
}

module.exports = { registerApiTokenRoutes };
