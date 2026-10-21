const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createDb, readDbConfig } = require('../db');
const users = require('@ruyi/shared/runtime/repos/users');
const { verifyPassword } = require('@ruyi/server/src/modules/auth/password');
const { loadKeys } = require('@ruyi/shared/runtime/platform-state/crypto');

// 在加载路由前封住真实操作，测试始终使用隔离的临时工作区。
const browser = require('@ruyi/automation/lib/browser');
const childProcess = require('node:child_process');
const originals = { ...browser };
const processMethods = ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork'];
const originalProcessMethods = Object.fromEntries(processMethods.map((name) => [name, childProcess[name]]));
const unexpectedOperation = () => { throw new Error('注册测试不得启动浏览器或运行脚本'); };
browser.launchBrowser = unexpectedOperation;
for (const name of processMethods) childProcess[name] = unexpectedOperation;
const { buildApp } = require('@ruyi/server/src/app');

async function main() {
  if (process.env.RUYI_DB_NAME !== 'ruyi_test') throw new Error('数据库测试只允许使用显式指定的 ruyi_test 库');
  const config = readDbConfig();
  assert.equal(config.host, '127.0.0.1');
  assert.equal(config.port, 3306);
  assert.equal(config.user, 'ruyi');
  assert.equal(config.password, 'ruyi');
  const db = createDb(config);
  const marker = `registration-test-${crypto.randomUUID()}`;
  const prefix = `r${crypto.randomBytes(3).toString('hex')}`;
  const usernames = ['user', 'race', 'edge'].map((suffix) => `${prefix}${suffix}`);
  const password = 'RegistrationTest123';
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-registration-'));
  let app;
  const clean = async () => {
    const rows = await db.selectFrom('ruyi_users').select('id').where('username', 'in', usernames).execute();
    if (rows.length) {
      const ids = rows.map((row) => row.id);
      await db.deleteFrom('ruyi_user_sessions').where('user_id', 'in', ids).execute();
      await db.deleteFrom('ruyi_users').where('id', 'in', ids).execute();
    }
    // 只清理本次测试写入的记录；业务代码仍只追加操作记录。
    await db.deleteFrom('ruyi_operation_logs').where('user_agent', '=', marker).execute();
  };
  try {
    await clean();
    const logged = [];
    app = buildApp({ db, uploadRoot: tempDir, stateKeys: loadKeys({ RUYI_STATE_KEY: crypto.randomBytes(32).toString('base64') }),
      logger: { level: 'info', stream: { write(line) { logged.push(line); } } }, webDist: path.join(tempDir, 'missing-dist') });
    const request = (method, url, payload, cookie) => app.inject({ method, url, headers: { 'user-agent': marker, ...(cookie ? { cookie } : {}) }, ...(payload === undefined ? {} : { payload }) });
    const registration = { username: usernames[0], displayName: '注册用户', password };
    const register = (body) => request('POST', '/api/auth/register', body);
    const auditRows = () => db.selectFrom('ruyi_operation_logs').selectAll().where('user_agent', '=', marker).where('action', '=', 'auth.register').orderBy('id').execute();
    for (const body of [
      {}, { ...registration, username: 'ab' }, { ...registration, username: 'a'.repeat(13) },
      { ...registration, username: 'ABC' }, { ...registration, username: 123 },
      { ...registration, password: 'short' }, { ...registration, password: 12345678 },
      { ...registration, password: '中'.repeat(25) }, { ...registration, password: 'a'.repeat(73) },
      { ...registration, displayName: '' }, { ...registration, displayName: '  ' },
      { ...registration, displayName: '名'.repeat(65) }, { ...registration, displayName: 123 },
    ]) {
      const response = await register(body);
      assert.equal(response.statusCode, 400);
      assert.equal(response.headers['set-cookie'], undefined);
    }
    assert.equal(await users.findByUsername(db, usernames[0]), undefined);
    for (const method of ['GET', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']) {
      assert.equal((await request(method, '/api/auth/register')).statusCode, 401, '只允许 POST 公开注册');
    }
    for (const [method, url] of [['GET', '/api/auth/me'], ['GET', '/api/admin/users'], ['POST', '/api/auth/logout'], ['POST', '/api/auth/register/extra']]) {
      assert.equal((await request(method, url)).statusCode, 401);
    }
    const response = await register({ ...registration, role: 'admin', status: 'disabled', createdBy: 123,
      mustChangePassword: true, must_change_password: true, password_hash: 'INJECTED_HASH' });
    assert.equal(response.statusCode, 201);
    assert.deepEqual(response.json(), { ok: true, message: '注册成功，请返回登录' });
    assert.equal(response.headers['set-cookie'], undefined);
    const user = await users.findByUsername(db, usernames[0]);
    assert.equal(user.role, 'user');
    assert.equal(user.status, 'active');
    assert.equal(user.must_change_password, 0);
    assert.equal(user.created_by, null);
    assert.equal(await verifyPassword(password, user.password_hash), true);
    assert.equal((await db.selectFrom('ruyi_user_sessions').select('id').where('user_id', '=', user.id).execute()).length, 0);
    const successAudit = (await auditRows()).at(-1);
    assert.equal(successAudit.user_id, user.id);
    assert.equal(successAudit.username, usernames[0]);
    assert.equal(successAudit.result, 'success');
    assert.equal((await request('GET', '/api/auth/me')).statusCode, 401);
    const duplicate = await register(registration);
    assert.equal(duplicate.statusCode, 409);
    assert.equal(duplicate.json().message, '用户名已存在');
    assert.equal((await auditRows()).at(-1).user_id, null);
    const concurrent = await Promise.all([register({ ...registration, username: usernames[1] }), register({ ...registration, username: usernames[1] })]);
    assert.deepEqual(concurrent.map((item) => item.statusCode).sort(), [201, 409]);
    assert.equal((await db.selectFrom('ruyi_users').select('id').where('username', '=', usernames[1]).execute()).length, 1);
    const boundaryPassword = '中'.repeat(24);
    assert.equal((await register({ username: usernames[2], displayName: '名'.repeat(64), password: boundaryPassword })).statusCode, 201);
    assert.equal(await verifyPassword(boundaryPassword, (await users.findByUsername(db, usernames[2])).password_hash), true);
    const login = await request('POST', '/api/auth/login', { username: usernames[0], password });
    assert.equal(login.statusCode, 200);
    const cookie = [].concat(login.headers['set-cookie'])[0].split(';')[0];
    assert.equal(login.json().user.role, 'user');
    assert.equal(login.json().user.mustChangePassword, false);
    assert.equal((await request('GET', '/api/auth/me', undefined, cookie)).statusCode, 200);
    assert.equal((await request('GET', '/api/admin/users', undefined, cookie)).statusCode, 403);
    assert.equal((await request('GET', '/api/runtime-mode', undefined, cookie)).statusCode, 200);
    assert.equal((await request('POST', '/api/auth/register', registration, cookie)).statusCode, 409);
    const audits = await auditRows();
    assert.ok(audits.filter((row) => row.result === 'failure').every((row) => row.user_id === null));
    const originalCreate = users.createUser;
    let failed;
    try {
      users.createUser = async () => { throw new Error(`SQL 包含 ${password} ${user.password_hash}`); };
      failed = await register(registration);
      assert.equal(failed.statusCode, 500);
      assert.deepEqual(failed.json(), { ok: false, message: '注册失败，请稍后重试' });
      assert.equal((await auditRows()).at(-1).user_id, null);
    } finally { users.createUser = originalCreate; }
    const serialized = JSON.stringify({ audits: await auditRows(), logged, response: response.json(), failed: failed.json() });
    for (const secret of [password, boundaryPassword, user.password_hash, 'INJECTED_HASH']) assert.equal(serialized.includes(secret), false);
    assert.ok(audits.every((row) => row.detail === null));
    console.log('公开注册接口校验、并发重复、权限隔离、无会话和审计脱敏测试通过。');
  } finally {
    try { if (app) await app.close(); } finally {
      try { await clean(); } finally {
        try { await db.destroy(); } finally { fs.rmSync(tempDir, { recursive: true, force: true }); }
      }
    }
  }
}
main().catch((error) => { console.error('注册接口数据库测试失败：', error); process.exitCode = 1; }).finally(() => {
  browser.launchBrowser = originals.launchBrowser;
  for (const name of processMethods) childProcess[name] = originalProcessMethods[name];
});
