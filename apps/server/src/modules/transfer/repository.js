const { randomBytes, createHash } = require('node:crypto');
const { sql } = require('kysely');

const hash = (secret) => createHash('sha256').update(secret).digest('hex');

async function createTicket(db, { userId, purpose, jobId = null, expiresAt = new Date(Date.now() + 10 * 60 * 1000) }) {
  const secret = randomBytes(32).toString('base64url');
  try {
    await db.insertInto('ruyi_transfer_tickets').values({
      user_id: userId, purpose, job_id: jobId, secret_hash: hash(secret), expires_at: expiresAt,
    }).execute();
  } catch (_) {
    throw new Error('创建传输链接失败，请稍后重试');
  }
  return { secret, expiresAt };
}

async function consumeTicket(db, { secret, purpose }) {
  if (typeof secret !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(secret)) return null;
  try {
    const result = await db.updateTable('ruyi_transfer_tickets').set({ used_at: sql`NOW()` })
      .where('secret_hash', '=', hash(secret)).where('purpose', '=', purpose)
      .where('used_at', 'is', null).where('expires_at', '>', sql`NOW()`).executeTakeFirst();
    if (Number(result.numUpdatedRows) !== 1) return null;
    const row = await db.selectFrom('ruyi_transfer_tickets as t')
      .innerJoin('ruyi_users as u', 'u.id', 't.user_id')
      .select(['t.job_id', 'u.id', 'u.username', 'u.display_name', 'u.role', 'u.status', 'u.must_change_password'])
      .where('t.secret_hash', '=', hash(secret)).where('u.status', '=', 'active').executeTakeFirst();
    if (!row) return null;
    const { job_id, ...user } = row;
    return { user, jobId: job_id };
  } catch (_) {
    throw new Error('验证传输链接失败，请稍后重试');
  }
}

module.exports = { createTicket, consumeTicket };
