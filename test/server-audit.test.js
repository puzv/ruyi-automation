const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { sql } = require('kysely');
const { createDb, readDbConfig } = require('../db');
const users = require('../server/repos/users');
const { hashPassword } = require('../server/auth/password');
const { loadKeys } = require('../server/platform-state/crypto');
const { storeCapturedState } = require('../server/platform-state');
const { sanitizeDetail, writeLog, auditFromRequest } = require('../server/audit');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-audit-'));
process.env.RUYI_UPLOAD_DIR = tempDir;
const childProcess = require('node:child_process');
const originalSpawn = childProcess.spawn;
let child;
childProcess.spawn = () => {
  child = new EventEmitter();
  child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.pid = 999999;
  return child;
};
const { buildApp } = require('../server/app');
const { createWorker } = require('../server/worker');
const state = require('../server/state');
const password = 'AuditPassword123';
const nextPassword = 'AuditChanged123';
const cookieOf = (r) => [].concat(r.headers['set-cookie'])[0].split(';')[0];
const parseDetail = (row) => typeof row.detail === 'string' ? JSON.parse(row.detail) : row.detail;

async function main() {
  const config = readDbConfig();
  assert.equal(config.database, 'ruyi_test');
  assert.equal(config.host, '127.0.0.1'); assert.equal(config.port, 3306);
  assert.equal(config.user, 'ruyi'); assert.equal(config.password, 'ruyi');
  assert.deepEqual(sanitizeDetail({ password, nested: { apiToken: 'x', Cookie: 'x', secret: 'x', state: 'x', text: 'a'.repeat(600) }, list: Array(110).fill('ok') }), {
    nested: { text: 'a'.repeat(500) }, list: Array(100).fill('ok'),
  });
  let errors = 0;
  await writeLog({ insertInto() { throw new Error('模拟数据库失败'); } }, {}, { error() { errors++; } });
  assert.equal(errors, 1);
  await writeLog(undefined, {});
  const req = { user: { id: 1, username: 'test' }, ip: '127.0.0.1', headers: {} };
  assert.equal(auditFromRequest(req, {}).requestId, auditFromRequest(req, {}).requestId);
  const db = createDb(config);
  let app;
  const clean = async () => {
    const rows = await db.selectFrom('ruyi_users').select('id').where('username', 'in', ['audit_admin', 'audit_user', 'audit_create']).execute();
    if (rows.length) {
      const ids = rows.map((row) => row.id);
      for (const table of ['ruyi_jobs', 'ruyi_user_sessions', 'ruyi_platform_states', 'ruyi_operation_logs']) {
        await db.deleteFrom(table).where('user_id', 'in', ids).execute();
      }
      await db.deleteFrom('ruyi_users').where('id', 'in', ids).execute();
    }
    await db.deleteFrom('ruyi_operation_logs').where('username', 'in', ['audit_missing', 'audit_user', '']).execute();
    await db.deleteFrom('ruyi_operation_logs').where('action', '=', 'test.truncate').execute();
  };
  try {
    await clean();
    const passwordHash = await hashPassword(password);
    const adminId = await users.createUser(db, { username: 'audit_admin', displayName: '管理员', passwordHash, role: 'admin', mustChangePassword: false });
    const userId = await users.createUser(db, { username: 'audit_user', displayName: '用户', passwordHash, mustChangePassword: false });
    const stateKeys = loadKeys({ RUYI_STATE_KEY: crypto.randomBytes(32).toString('base64') });
    app = buildApp({ db, stateKeys, logger: false, webDist: path.join(tempDir, 'dist') });
    const request = (method, url, cookie, payload) => app.inject({ method, url, headers: { ...(cookie ? { cookie } : {}), 'user-agent': 'audit-test' }, ...(payload === undefined ? {} : { payload }) });
    const login = (username, suppliedPassword = password) => request('POST', '/api/auth/login', null, { username, password: suppliedPassword });
    const logs = (action) => db.selectFrom('ruyi_operation_logs').selectAll().where('action', '=', action).orderBy('id').execute();
    const latest = async (action) => (await logs(action)).at(-1);
    const userCookie = cookieOf(await login('audit_user'));
    assert.equal((await latest('auth.login')).result, 'success');
    for (const [name, supplied, status, reason] of [
      ['audit_missing', password, 401, 'unknown_user'], ['audit_user', 'AuditWrong123', 401, 'wrong_password'],
      ['', password, 400, 'invalid_request'],
    ]) {
      const before = (await logs('auth.login')).length;
      assert.equal((await login(name, supplied)).statusCode, status);
      assert.equal((await logs('auth.login')).length, before + 1);
      assert.equal(parseDetail(await latest('auth.login')).reason, reason);
    }
    await db.updateTable('ruyi_users').set({ locked_until: sql`DATE_ADD(NOW(), INTERVAL 15 MINUTE)` }).where('id', '=', userId).execute();
    assert.equal((await login('audit_user')).statusCode, 429);
    assert.equal(parseDetail(await latest('auth.login')).reason, 'locked');
    await db.updateTable('ruyi_users').set({ locked_until: null, status: 'disabled' }).where('id', '=', userId).execute();
    assert.equal((await login('audit_user')).statusCode, 403);
    assert.equal(parseDetail(await latest('auth.login')).reason, 'disabled');
    await users.setStatus(db, userId, 'active');
    assert.equal((await request('POST', '/api/auth/login', null, { username: 'audit_user' })).statusCode, 400);
    assert.equal((await latest('auth.login')).user_id, userId);
    const adminCookie = cookieOf(await login('audit_admin'));
    const admin = (method, url, payload) => request(method, url, adminCookie, payload);
    for (const [currentPassword, expected] of [['AuditWrong123', 400], [password, 200]]) {
      assert.equal((await request('POST', '/api/auth/change-password', userCookie, { currentPassword, newPassword: nextPassword })).statusCode, expected);
      assert.equal((await latest('auth.password_change')).result, expected === 200 ? 'success' : 'failure');
    }
    const created = await admin('POST', '/api/admin/users', { username: 'audit_create', displayName: '新增用户', password, role: 'user' });
    assert.equal(created.statusCode, 200);
    const createdId = created.json().user.id;
    for (const [route, action] of [['disable', 'user_disable'], ['enable', 'user_enable'], ['reset-password', 'password_reset']]) {
      assert.equal((await admin('POST', `/api/admin/users/${createdId}/${route}`, route === 'reset-password' ? { password: nextPassword } : undefined)).statusCode, 200);
      assert.equal((await latest(`admin.${action}`)).target_id, 'audit_create');
      assert.equal((await latest(`admin.${action}`)).result, 'success');
    }
    assert.equal((await latest('admin.user_create')).target_id, 'audit_create');
    assert.deepEqual(parseDetail(await latest('admin.user_create')), { role: 'user' });
    assert.equal((await admin('POST', '/api/admin/users', { username: 'audit_create', displayName: '重复', password, role: 'user' })).statusCode, 409);
    assert.equal((await latest('admin.user_create')).result, 'failure');

    const boundary = 'audit-boundary';
    const payload = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="sample_oaid.txt"\r\nContent-Type: text/plain\r\n\r\nPRIVATE_FILE_CONTENT\r\n--${boundary}--\r\n`);
    const imported = await app.inject({ method: 'POST', url: '/api/import-folder', headers: { cookie: userCookie, 'content-type': `multipart/form-data; boundary=${boundary}` }, payload });
    assert.equal(imported.statusCode, 200);
    assert.deepEqual(parseDetail(await latest('file.import')), { count: 1, skipped: 0, files: ['sample_oaid.txt'] });
    const missingState = await request('POST', '/api/run/upload', userCookie);
    assert.equal(missingState.statusCode, 409);
    assert.equal(missingState.json().code, 'PLATFORM_LOGIN_REQUIRED');
    assert.equal((await latest('job.start')).result, 'failure');
    await storeCapturedState(db, userId, { cookies: [], origins: [] }, stateKeys);
    assert.equal((await request('POST', '/api/run/unknown', userCookie)).statusCode, 404);
    const started = await request('POST', '/api/run/upload', userCookie);
    assert.equal(started.statusCode, 200, '已有有效登录态时可以启动认证任务');
    const start = await latest('job.start');
    assert.equal(start.result, 'success'); assert.equal(start.target_id, started.json().id);
    assert.match(start.request_id, /^[a-f0-9-]{36}$/);
    assert.equal(started.json().status, 'queued');
    assert.deepEqual(parseDetail(start), { task: 'upload', queued: true });
    app.worker = createWorker({ db, keys: stateKeys, dataRoot: tempDir, pollMs: 10 });
    await app.worker.start();
    for (let i = 0; i < 200 && !child; i++) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.ok(child);
    child.emit('close', 2, 'SIGTERM');
    // 回调异步入库，等待其完成而不依赖固定的数据库响应时间。
    let finish;
    for (let i = 0; i < 100 && !finish; i++) {
      finish = await latest('job.finish');
      if (!finish) await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.ok(finish); assert.equal(finish.result, 'failure');
    assert.equal(start.request_id, finish.request_id); assert.equal(finish.user_id, userId);
    assert.equal(finish.target_id, started.json().id);
    assert.equal(parseDetail(finish).code, 2); assert.equal(parseDetail(finish).signal, 'SIGTERM');
    assert.ok(parseDetail(finish).durationMs >= 0);
    assert.equal((await request('POST', '/api/runtime-mode', userCookie, { headless: true })).statusCode, 200);
    assert.deepEqual(parseDetail(await latest('runtime.mode_change')), { headless: true });
    for (const url of ['/api/login-open', '/api/profile-release']) {
      assert.equal((await request('POST', url, userCookie)).statusCode, 404);
    }
    assert.equal(await latest('platform.login_open'), undefined);
    assert.equal(await latest('profile.release'), undefined);

    const mine = (await request('GET', '/api/logs/mine?pageSize=100', userCookie)).json();
    assert.equal(mine.ok, true); assert.ok(mine.total > 0);
    assert.ok(mine.items.every((row) => row.userId === userId && !Object.hasOwn(row, 'userAgent')));
    assert.equal((await request('GET', '/api/admin/logs', userCookie)).statusCode, 403);
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
    const beforeViews = (await logs('admin.logs_view')).length;
    const query = `/api/admin/logs?username=audit_user&action=auth.login&result=failure&from=${today}&to=${today}&pageSize=1`;
    const filtered = (await admin('GET', query)).json();
    assert.equal(filtered.ok, true); assert.equal(filtered.total, 4); assert.equal(filtered.items.length, 1);
    assert.equal(filtered.items[0].username, 'audit_user'); assert.equal(filtered.items[0].userAgent, 'audit-test');
    assert.equal((await logs('admin.logs_view')).length, beforeViews + 1);
    assert.equal((await admin('GET', `${query}&page=2`)).json().total, 4);
    assert.equal((await logs('admin.logs_view')).length, beforeViews + 1);
    for (const suffix of ['from=2025-02-30', 'to=bad', 'page=0', 'pageSize=0']) assert.equal((await admin('GET', `/api/admin/logs?${suffix}`)).statusCode, 400);
    const empty = (await admin('GET', '/api/admin/logs?from=2000-01-01&to=2000-01-02')).json();
    assert.equal(empty.total, 0);
    for (const time of ['2020-01-01 23:59:59.999', '2020-01-02 00:00:00.000', '2020-01-02 23:59:59.999', '2020-01-03 00:00:00.000']) {
      await db.insertInto('ruyi_operation_logs').values({ user_id: userId, username: 'audit_user', action: 'test.date_boundary', result: 'success', created_at: time }).execute();
    }
    const bounded = (await admin('GET', '/api/admin/logs?action=test.date_boundary&from=2020-01-02&to=2020-01-02')).json();
    assert.equal(bounded.total, 2);
    assert.equal((await request('GET', '/api/logs/mine?action=test.date_boundary&pageSize=999', userCookie)).json().pageSize, 100);
    const noViewBefore = (await logs('admin.logs_view')).length;
    for (const url of ['/api/auth/me', '/api/runtime-mode', '/api/admin/users']) await admin('GET', url);
    assert.equal((await logs('admin.logs_view')).length, noViewBefore);
    assert.equal((await request('POST', '/api/auth/logout', userCookie)).statusCode, 200);
    assert.equal((await latest('auth.logout')).result, 'success');
    const all = JSON.stringify(await db.selectFrom('ruyi_operation_logs').selectAll().execute());
    for (const secret of [password, nextPassword, 'AuditWrong123', 'PRIVATE_FILE_CONTENT']) assert.equal(all.includes(secret), false);
    await writeLog(db, { action: 'test.truncate', result: 'success', targetId: 'x'.repeat(300), errorMessage: 'e'.repeat(1100), userAgent: 'u'.repeat(300) }, app.log);
    const truncated = await latest('test.truncate');
    assert.equal(truncated.target_id.length, 255); assert.equal(truncated.error_message.length, 1000); assert.equal(truncated.user_agent.length, 255);
    function check(dir) {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const file = path.join(dir, entry.name);
        if (entry.isDirectory()) check(file);
        else if (entry.name.endsWith('.js')) assert.doesNotMatch(fs.readFileSync(file, 'utf8'), /(?:updateTable|deleteFrom)\s*\(\s*['"]ruyi_operation_logs['"]/);
      }
    }
    check(path.join(__dirname, '../server'));
    assert.equal(typeof adminId, 'number');
    console.log('操作记录写入、脱敏、任务关联和查询权限测试通过。');
  } finally {
    state.jobs.clear();
    try { if (app) await app.close(); } finally { try { await clean(); } finally { await db.destroy(); } }
    childProcess.spawn = originalSpawn;
  }
}
main().catch((error) => { console.error('操作记录测试失败：', error); process.exitCode = 1; });
