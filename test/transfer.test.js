const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { createTicket, consumeTicket } = require('../apps/server/src/modules/transfer/repository');
const { buildApp } = require('../apps/server/src/app');

async function main() {
  let saved;
  const writes = [];
  const memoryDb = {
    insertInto(table) { return { values(value) { if (table === 'ruyi_transfer_tickets') saved = value; return this; }, async execute() {} }; },
    updateTable() {
      const filters = [];
      return { set(value) { writes.push(value); return this; }, where(...args) { filters.push(args); return this; },
        async executeTakeFirst() {
          assert.deepEqual(filters.map((item) => item[0]), ['secret_hash', 'purpose', 'used_at', 'expires_at']);
          assert.equal(filters[2][1], 'is'); assert.equal(filters[3][1], '>');
          const matches = saved && !saved.used_at && saved.expires_at > new Date()
            && saved.secret_hash === filters[0][2] && saved.purpose === filters[1][2];
          if (matches) saved.used_at = new Date();
          return { numUpdatedRows: BigInt(matches ? 1 : 0) };
        } };
    },
    selectFrom() { return { innerJoin() { return this; }, select() { return this; },
      where(key, op, value) { if (key === 'u.status') assert.equal(value, 'active'); return this; },
      async executeTakeFirst() { return { id: 7, username: 'transfer_test', role: 'user', job_id: saved.job_id }; } }; },
  };
  const issued = await createTicket(memoryDb, { userId: 7, purpose: 'upload' });
  assert.match(issued.secret, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(saved.secret_hash, createHash('sha256').update(issued.secret).digest('hex'));
  assert.ok(!JSON.stringify(saved).includes(issued.secret));
  assert.equal(await consumeTicket(memoryDb, { secret: 'invalid', purpose: 'upload' }), null);
  assert.equal(writes.length, 0);
  assert.equal(await consumeTicket(memoryDb, { secret: issued.secret, purpose: 'download' }), null);
  assert.equal((await consumeTicket(memoryDb, { secret: issued.secret, purpose: 'upload' })).user.id, 7);
  assert.equal(await consumeTicket(memoryDb, { secret: issued.secret, purpose: 'upload' }), null);
  const expired = await createTicket(memoryDb, { userId: 7, purpose: 'upload', expiresAt: new Date(0) });
  assert.equal(await consumeTicket(memoryDb, { secret: expired.secret, purpose: 'upload' }), null);
  const malformed = await createTicket(memoryDb, { userId: 7, purpose: 'upload' });
  const parsingApp = buildApp({ db: memoryDb, stateKeys: {}, logger: false });
  try {
    const url = `/api/transfer/upload/${malformed.secret}`;
    const badBody = await parsingApp.inject({ method: 'POST', url, headers: { 'content-type': 'application/json' }, payload: '{invalid' });
    assert.equal(badBody.statusCode, 400);
    assert.ok(saved.used_at, '解析失败前必须已经领用票据');
    assert.equal((await parsingApp.inject({ method: 'POST', url })).statusCode, 404);
  } finally { await parsingApp.close(); }
  const lines = [];
  const secret = 'A'.repeat(43);
  const app = buildApp({
    db: { updateTable() { throw new Error(`数据库异常：${secret}`); } },
    stateKeys: {},
    logger: { level: 'info', stream: { write(line) { lines.push(line); } } },
  });
  try {
    for (const prefix of ['/api/transfer', '/api/%74ransfer', '/%61pi/transfer']) {
      const invalid = await app.inject({ method: 'POST', url: `${prefix}/upload/invalid-format` });
      assert.equal(invalid.statusCode, 404);
      assert.deepEqual(invalid.json(), { ok: false, message: '链接无效或已过期，请重新获取' });
      const unavailable = await app.inject({ method: 'POST', url: `${prefix}/upload/${secret}` });
      assert.equal(unavailable.statusCode, 500);
      assert.match(unavailable.json().message, /重新获取链接/);
    }
    const output = lines.join('');
    assert.ok(output.includes('/api/transfer/upload/:ticket'));
    assert.ok(!output.includes(secret), '传输链接票据不得出现在正常或错误日志中');
    assert.ok(!output.includes('invalid-format'), '无效票据也不得出现在日志中');
  } finally {
    await app.close();
  }
  console.log('传输路由免鉴权、统一错误与编码路径日志脱敏测试通过。');
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
