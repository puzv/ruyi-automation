const { sql } = require('kysely');

async function create(db, { userId, name, displayPrefix, secretHash, expiresInDays }) {
  const result = await db.insertInto('ruyi_api_tokens').values({
    user_id: userId, name, display_prefix: displayPrefix, secret_hash: secretHash,
    expires_at: sql`DATE_ADD(NOW(), INTERVAL ${expiresInDays} DAY)`,
  }).executeTakeFirstOrThrow();
  return Number(result.insertId);
}

function listForUser(db, userId) {
  return db.selectFrom('ruyi_api_tokens').select([
    'id', 'name', 'display_prefix', 'created_at', 'last_used_at', 'expires_at', 'revoked_at',
    sql`CASE WHEN revoked_at IS NOT NULL THEN 'revoked' WHEN expires_at <= NOW() THEN 'expired' ELSE 'active' END`.as('status'),
  ]).where('user_id', '=', userId).orderBy('id', 'desc').execute();
}

async function findActiveByHash(db, secretHash) {
  const row = await db.selectFrom('ruyi_api_tokens as t')
    .innerJoin('ruyi_users as u', 'u.id', 't.user_id')
    .selectAll('t').select([
      'u.username', 'u.display_name', 'u.role', 'u.status', 'u.must_change_password',
    ])
    .where('t.secret_hash', '=', secretHash).where('t.revoked_at', 'is', null)
    .where('t.expires_at', '>', sql`NOW()`).where('u.status', '=', 'active')
    .executeTakeFirst();
  if (!row) return undefined;
  const { username, display_name, role, status, must_change_password, ...token } = row;
  return { ...token, user: { id: row.user_id, username, display_name, role, status, must_change_password } };
}

function touch(db, id) {
  return db.updateTable('ruyi_api_tokens').set({ last_used_at: sql`NOW()` })
    .where('id', '=', id)
    .where((eb) => eb.or([
      eb('last_used_at', 'is', null),
      eb('last_used_at', '<', sql`DATE_SUB(NOW(), INTERVAL 1 MINUTE)`),
    ])).executeTakeFirst();
}

async function revoke(db, id, userId) {
  const item = await db.selectFrom('ruyi_api_tokens').select('id')
    .where('id', '=', id).where('user_id', '=', userId).executeTakeFirst();
  if (!item) return false;
  await db.updateTable('ruyi_api_tokens').set({ revoked_at: sql`NOW()` })
    .where('id', '=', id).where('user_id', '=', userId)
    .where('revoked_at', 'is', null).executeTakeFirst();
  return true;
}

async function countActiveForUser(db, userId) {
  const row = await db.selectFrom('ruyi_api_tokens').select(sql`COUNT(*)`.as('count'))
    .where('user_id', '=', userId).where('revoked_at', 'is', null)
    .where('expires_at', '>', sql`NOW()`).executeTakeFirstOrThrow();
  return Number(row.count);
}

module.exports = { create, listForUser, findActiveByHash, touch, revoke, countActiveForUser };
