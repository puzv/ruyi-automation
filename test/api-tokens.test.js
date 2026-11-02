const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { sql } = require('kysely');
const { createDb, readDbConfig } = require('../db');
const users = require('@ruyi/shared/runtime/repos/users');
const tokens = require('@ruyi/server/src/modules/api-tokens/repository');
const { hashPassword } = require('@ruyi/server/src/modules/auth/password');
const { loadKeys } = require('@ruyi/shared/runtime/platform-state/crypto');
const { resolveWorkspace, ensureWorkspace } = require('@ruyi/shared/runtime/workspace');
const { auditFromRequest } = require('@ruyi/shared/runtime/audit');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-api-tokens-'));
const previousUploadDir = process.env.RUYI_UPLOAD_DIR;
process.env.RUYI_UPLOAD_DIR = tempDir;
// 鉴权和审计测试不得触发真实浏览器或自动化脚本。
const browser = require('@ruyi/automation/lib/browser');
const childProcess = require('node:child_process');
const originalBrowser = browser.launchBrowser;
const processMethods = ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork'];
const originalMethods = Object.fromEntries(processMethods.map((name) => [name, childProcess[name]]));
const unexpected = () => { throw new Error('测试不得启动浏览器或脚本'); };
browser.launchBrowser = unexpected;
for (const name of processMethods) childProcess[name] = unexpected;
const { buildApp } = require('@ruyi/server/src/app');
const usernames = ['pat_user_a', 'pat_user_b', 'pat_admin'];
const password = 'TokenTest123';
const hash = (value) => crypto.createHash('sha256').update(value).digest('hex');
const detailOf = (row) => typeof row.detail === 'string' ? JSON.parse(row.detail) : row.detail;

async function clean(db) {
  const rows = await db.selectFrom('ruyi_users').select('id').where('username', 'in', usernames).execute();
  if (!rows.length) return;
  const ids = rows.map((row) => row.id);
  for (const table of ['ruyi_api_tokens', 'ruyi_jobs', 'ruyi_auto_advance', 'ruyi_user_sessions', 'ruyi_platform_states', 'ruyi_operation_logs']) {
    await db.deleteFrom(table).where('user_id', 'in', ids).execute();
  }
  await db.deleteFrom('ruyi_users').where('id', 'in', ids).execute();
}

async function main() {
  if (process.env.RUYI_DB_NAME !== 'ruyi_test') throw new Error('数据库测试只允许使用 ruyi_test 库。');
  const config = readDbConfig();
  if (config.host !== '127.0.0.1' || config.port !== 3306 || config.user !== 'ruyi' || config.password !== 'ruyi') {
    throw new Error('数据库测试只允许连接本机 Docker 的测试数据库。');
  }
  const db = createDb(config);
  let app;
  let connected = false;
  try {
    await sql`SELECT 1`.execute(db);
    connected = true;
    await clean(db);
    const passwordHash = await hashPassword(password);
    const ids = [];
    for (const username of usernames) ids.push(await users.createUser(db, {
      username, displayName: username, passwordHash, role: username === 'pat_admin' ? 'admin' : 'user', mustChangePassword: false,
    }));
    app = buildApp({ db, logger: false, uploadRoot: tempDir,
      stateKeys: loadKeys({ RUYI_STATE_KEY: crypto.randomBytes(32).toString('base64') }),
      webDist: path.join(tempDir, 'missing-dist') });
    const request = (method, url, headers = {}, payload) => app.inject({ method, url, headers, ...(payload === undefined ? {} : { payload }) });
    const cookies = [];
    for (const username of usernames) {
      const response = await request('POST', '/api/auth/login', {}, { username, password });
      assert.equal(response.statusCode, 200);
      cookies.push([].concat(response.headers['set-cookie']).find((value) => value.startsWith('ruyi_session=')).split(';')[0]);
    }
    const create = (index = 0, payload = { name: '  AI 工具  ', expiresInDays: 90 }) => request('POST', '/api/api-tokens', { cookie: cookies[index] }, payload);
    const created = await create();
    assert.equal(created.statusCode, 200);
    const { token, item } = created.json();
    assert.ok(/^ruyi_pat_[A-Za-z0-9_-]{43}$/.test(token), '明文令牌格式应符合要求');
    assert.equal(token.length, 52);
    assert.equal(item.name, 'AI 工具');
    assert.ok(item.displayPrefix === token.slice(0, 13), '展示前缀应正确');
    assert.equal(item.status, 'active');
    const auth = { authorization: `Bearer ${token}` };
    const stored = await db.selectFrom('ruyi_api_tokens').selectAll().where('id', '=', item.id).executeTakeFirstOrThrow();
    assert.ok(stored.secret_hash === hash(token), '数据库只保存明文 SHA-256 哈希');
    assert.ok(Object.values(stored).every((value) => !String(value).includes(token)));
    const listed = await request('GET', '/api/api-tokens', { cookie: cookies[0] });
    assert.equal(listed.statusCode, 200);
    assert.deepEqual(Object.keys(listed.json().items[0]).sort(), ['id', 'name', 'displayPrefix', 'createdAt', 'lastUsedAt', 'expiresAt', 'revokedAt', 'status'].sort());
    assert.ok(!listed.body.includes(token) && !listed.body.includes(stored.secret_hash));
    assert.equal((await request('GET', '/api/api-tokens', { cookie: cookies[1] })).json().items.length, 0);

    const workspace = resolveWorkspace({ id: ids[0], username: usernames[0] }, tempDir);
    ensureWorkspace(workspace);
    fs.writeFileSync(path.join(workspace, 'createGroupToDoList.json'), JSON.stringify(['自己的任务']));
    const status = await request('GET', '/api/status', auth);
    assert.equal(status.statusCode, 200);
    assert.deepEqual(status.json(), (await request('GET', '/api/status', { cookie: cookies[0] })).json());
    assert.notDeepEqual(status.json(), (await request('GET', '/api/status', { cookie: cookies[1] })).json());
    const me = await request('GET', '/api/auth/me', auth);
    assert.equal(me.json().user.id, ids[0]);
    const missing = await request('GET', '/api/not-exist', auth);
    assert.equal(missing.statusCode, 404, '令牌访问不存在的接口应返回 404 而不是无权访问');
    assert.equal((await request('GET', '/api/not-exist', { authorization: 'Bearer bad' })).statusCode, 401);
    const touched = await db.selectFrom('ruyi_api_tokens').selectAll().where('id', '=', item.id).executeTakeFirstOrThrow();
    assert.ok(touched.last_used_at instanceof Date);
    await tokens.touch(db, item.id);
    assert.equal((await db.selectFrom('ruyi_api_tokens').select('last_used_at').where('id', '=', item.id).executeTakeFirstOrThrow()).last_used_at.getTime(), touched.last_used_at.getTime());
    await db.updateTable('ruyi_api_tokens').set({ last_used_at: sql`DATE_SUB(NOW(), INTERVAL 2 MINUTE)` }).where('id', '=', item.id).execute();
    await tokens.touch(db, item.id);
    assert.ok((await db.selectFrom('ruyi_api_tokens').select('last_used_at').where('id', '=', item.id).executeTakeFirstOrThrow()).last_used_at >= touched.last_used_at);

    const admin = (await create(2)).json();
    for (const [method, url] of [
      ['GET', '/api/admin/users'], ['GET', '/api/api-tokens'], ['POST', '/api/api-tokens'],
      ['POST', `/api/api-tokens/${item.id}/revoke`], ['POST', '/api/auth/change-password'],
      ['POST', '/api/runtime-mode'], ['POST', '/api/platform-login'], ['GET', '/api/runtime-mode'],
      ['GET', '/api/%61dmin/users'],
    ]) {
      const response = await request(method, url, { authorization: `Bearer ${admin.token}` }, {});
      assert.equal(response.statusCode, 403);
      assert.equal(response.json().code, 'TOKEN_FORBIDDEN');
    }
    for (const authorization of ['', 'Basic invalid', `bearer ${token}`, 'Bearer ruyi_pat_short', `Bearer ruyi_pat_${'x'.repeat(43)}`, `Bearer ${token} extra`]) {
      const response = await request('GET', '/api/status', { authorization, cookie: cookies[0] });
      assert.equal(response.statusCode, 401);
      assert.deepEqual(response.json(), { ok: false, code: 'UNAUTHENTICATED', message: '令牌无效或已过期' });
    }
    await db.updateTable('ruyi_users').set({ status: 'disabled' }).where('id', '=', ids[0]).execute();
    assert.equal((await request('GET', '/api/status', auth)).statusCode, 401);
    await db.updateTable('ruyi_users').set({ status: 'active', must_change_password: 1 }).where('id', '=', ids[0]).execute();
    const changeRequired = await request('GET', '/api/auth/me', auth);
    assert.equal(changeRequired.statusCode, 403);
    assert.equal(changeRequired.json().code, 'PASSWORD_CHANGE_REQUIRED');
    await db.updateTable('ruyi_users').set({ must_change_password: 0 }).where('id', '=', ids[0]).execute();

    assert.equal((await request('POST', `/api/api-tokens/${item.id}/revoke`, { cookie: cookies[1] })).statusCode, 404);
    assert.equal((await request('POST', '/api/api-tokens/999999999/revoke', { cookie: cookies[0] })).statusCode, 404);
    for (const payload of [{}, { name: ' ', expiresInDays: 90 }, { name: 'x'.repeat(65), expiresInDays: 90 }, { name: 1, expiresInDays: 90 }, { name: 'AI', expiresInDays: 1 }, { name: 'AI', expiresInDays: '90' }]) {
      assert.equal((await create(0, payload)).statusCode, 400);
    }
    const run = await request('POST', '/api/run/upload', auth);
    assert.equal(run.statusCode, 409, '没有平台登录态时不能启动任务');
    const jobLog = await db.selectFrom('ruyi_operation_logs').selectAll().where('user_id', '=', ids[0]).where('action', '=', 'job.start').orderBy('id', 'desc').executeTakeFirstOrThrow();
    assert.equal(detailOf(jobLog).via, 'api_token');
    assert.equal(detailOf(jobLog).credentialId, item.id);
    assert.deepEqual(auditFromRequest({ authMethod: 'token', apiTokenId: item.id, headers: {} }, {}).detail, { via: 'api_token', credentialId: item.id });

    await db.updateTable('ruyi_api_tokens').set({ expires_at: sql`DATE_SUB(NOW(), INTERVAL 1 SECOND)` }).where('id', '=', item.id).execute();
    assert.equal((await request('GET', '/api/status', auth)).statusCode, 401);
    assert.equal((await request('GET', '/api/api-tokens', { cookie: cookies[0] })).json().items[0].status, 'expired');
    for (let i = 0; i < 2; i++) assert.equal((await request('POST', `/api/api-tokens/${item.id}/revoke`, { cookie: cookies[0] })).statusCode, 200);
    assert.equal((await request('GET', '/api/status', auth)).statusCode, 401);
    assert.equal((await request('GET', '/api/api-tokens', { cookie: cookies[0] })).json().items[0].status, 'revoked');
    // 并发请求也必须遵守十个有效令牌的上限，过期或吊销的不计入。
    const parallel = await Promise.all(Array.from({ length: 11 }, () => create(0, { name: '并发工具', expiresInDays: 30 })));
    assert.equal(parallel.filter((response) => response.statusCode === 200).length, 10);
    assert.equal(parallel.filter((response) => response.statusCode === 409).length, 1);
    assert.equal(await tokens.countActiveForUser(db, ids[0]), 10);
    const logs = await db.selectFrom('ruyi_operation_logs').selectAll().where('user_id', '=', ids[0]).where('action', 'in', ['token.create', 'token.revoke']).execute();
    const creation = logs.find((row) => row.action === 'token.create' && row.result === 'success');
    assert.ok(creation);
    assert.equal(creation.target_type, 'api_token');
    assert.equal(creation.target_id, String(item.id));
    assert.deepEqual(detailOf(creation), { name: 'AI 工具', expiresInDays: 90 });
    assert.ok(logs.some((row) => row.action === 'token.revoke' && row.result === 'success'));
    const secrets = [token, admin.token, ...parallel.filter((r) => r.statusCode === 200).map((r) => r.json().token)];
    for (const log of logs) {
      const serialized = JSON.stringify(log);
      for (const secret of secrets) {
        assert.ok(!serialized.includes(secret));
        assert.ok(!serialized.includes(hash(secret)));
        assert.ok(!serialized.includes(secret.slice(0, 13)));
      }
    }
    console.log('API 令牌仓储、鉴权隔离、吊销、并发上限和审计测试通过。');
  } finally {
    try { if (app) await app.close(); }
    finally { try { if (connected) await clean(db); } finally { await db.destroy(); } }
  }
}
main().catch((error) => { console.error('API 令牌数据库测试失败：', error); process.exitCode = 1; }).finally(() => {
  browser.launchBrowser = originalBrowser;
  for (const name of processMethods) childProcess[name] = originalMethods[name];
  if (previousUploadDir === undefined) delete process.env.RUYI_UPLOAD_DIR;
  else process.env.RUYI_UPLOAD_DIR = previousUploadDir;
});
