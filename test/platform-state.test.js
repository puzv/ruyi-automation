const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const { createDb, readDbConfig } = require("../db");
const users = require("@ruyi/shared/runtime/repos/users");
const sessions = require("@ruyi/server/src/modules/auth/repository");
const { hashToken } = require("@ruyi/server/src/modules/auth/session");
const { loadKeys, encryptState, decryptState, estimateExpiry } = require("@ruyi/shared/runtime/platform-state/crypto");
const states = require("@ruyi/shared/runtime/repos/platform-states");
const { loadUserState, storeCapturedState, storeRefreshedState, getStatusSummary } = require("@ruyi/shared/runtime/platform-state/index");

const marker = "PLAINTEXT_MARKER_123";
const expiry = Math.floor(Date.now() / 1000) + 86400;
const state = {
  cookies: [{ name: "dn_token", value: marker, domain: ".datanexus.qq.com", path: "/", expires: expiry,
    httpOnly: true, secure: true, sameSite: "Lax" }],
  origins: [],
};
const keyEnv = { RUYI_STATE_KEY: crypto.randomBytes(32).toString("base64") };
const keys = loadKeys(keyEnv);

function testCrypto() {
  assert.equal(keys.current.version, 1);
  assert.equal(keys.current.key.length, 32);
  assert.equal(keys.previous, undefined);
  const encrypted = encryptState(state, 123, keys);
  assert.equal(encrypted.keyVersion, 1);
  assert.equal(encrypted.ciphertext.length, 28 + Buffer.byteLength(JSON.stringify(state)));
  assert.deepEqual(decryptState(encrypted.ciphertext, 1, 123, keys), state);
  assert.notDeepEqual(encryptState(state, 123, keys).ciphertext, encrypted.ciphertext);
  // IV、标签和密文的每个字节都必须受认证保护。
  for (let index = 0; index < encrypted.ciphertext.length; index++) {
    const tampered = Buffer.from(encrypted.ciphertext);
    tampered[index] ^= 1;
    assert.throws(() => decryptState(tampered, 1, 123, keys), { message: "登录态解密失败" });
  }
  const wrongKeys = loadKeys({ RUYI_STATE_KEY: crypto.randomBytes(32).toString("base64") });
  for (const [ciphertext, version, userId, selectedKeys] of [
    [encrypted.ciphertext, 1, 124, keys], [encrypted.ciphertext, 1, 123, wrongKeys],
    [encrypted.ciphertext, 99, 123, keys], [Buffer.alloc(10), 1, 123, keys],
  ]) assert.throws(() => decryptState(ciphertext, version, userId, selectedKeys), { message: "登录态解密失败" });
  const rotated = loadKeys({
    RUYI_STATE_KEY: crypto.randomBytes(32).toString("base64"), RUYI_STATE_KEY_VERSION: "2",
    RUYI_STATE_KEY_PREVIOUS: keyEnv.RUYI_STATE_KEY,
  });
  assert.equal(rotated.previous.version, 1);
  assert.deepEqual(decryptState(encrypted.ciphertext, 1, 123, rotated), state);
  assert.equal(encryptState(state, 123, rotated).keyVersion, 2);
  assert.equal(loadKeys({ ...keyEnv, RUYI_STATE_KEY_PREVIOUS: keyEnv.RUYI_STATE_KEY }).previous.version, 0);
  assert.equal(loadKeys({ ...keyEnv, RUYI_STATE_KEY_VERSION: "5", RUYI_STATE_KEY_PREVIOUS: keyEnv.RUYI_STATE_KEY,
    RUYI_STATE_KEY_PREVIOUS_VERSION: "3" }).previous.version, 3);

  assert.throws(() => loadKeys({}), /缺少登录态加密密钥/);
  for (const name of ["RUYI_STATE_KEY", "RUYI_STATE_KEY_PREVIOUS"]) {
    for (const value of ["NOT_A_BASE64_SECRET!", crypto.randomBytes(31).toString("base64"),
      crypto.randomBytes(33).toString("base64"), `${keyEnv.RUYI_STATE_KEY}\n`]) {
      assert.throws(() => loadKeys({ ...keyEnv, [name]: value }), (error) => {
        assert.match(error.message, /登录态加密密钥/);
        assert.equal(error.message.includes(value), false);
        assert.equal(error.message.includes(keyEnv.RUYI_STATE_KEY), false);
        return true;
      });
    }
  }
  for (const version of ["", "abc", "1.5", "-1", "65536"]) {
    assert.throws(() => loadKeys({ ...keyEnv, RUYI_STATE_KEY_VERSION: version }), /登录态密钥版本/);
  }
  assert.throws(() => loadKeys({ ...keyEnv, RUYI_STATE_KEY_PREVIOUS: keyEnv.RUYI_STATE_KEY,
    RUYI_STATE_KEY_PREVIOUS_VERSION: "1" }), /新旧密钥版本不能相同/);

  assert.equal(estimateExpiry({ cookies: [
    { name: "dn_token", expires: 900 }, { name: "gdt_token", domain: "any.example", expires: 700 },
    { name: "ndmp_token", expires: 800 }, { name: "SSO_SESSION_ID", expires: 600 },
    { name: "dn_token", expires: -1 }, { name: "gdt_token" }, { name: "unrelated", expires: 1 },
  ] }).getTime(), 600000);
  for (const name of ["dn_token", "gdt_token", "ndmp_token", "SSO_SESSION_ID"]) {
    assert.equal(estimateExpiry({ cookies: [{ name, expires: 123 }] }).getTime(), 123000);
  }
  assert.equal(estimateExpiry({ cookies: [{ name: "dn_token", expires: -1 }, { name: "gdt_token" }] }), null);
  assert.equal(estimateExpiry({ cookies: [], origins: [] }), null);
  assert.equal(estimateExpiry({}), null);
}

async function testStartup() {
  // 在隔离上下文中验证入口，不读取 .env，也不启动服务或连接数据库。
  const source = fs.readFileSync(path.join(__dirname, "../apps/server/src/main.js"), "utf8");
  async function run(env) {
    const result = { errors: [], dbCreated: false, events: [], handlers: {} };
    const exited = new Error("模拟退出");
    const app = { addHook() {}, listen() { result.events.push('listen'); return Promise.resolve(); },
      async close() { result.events.push('app.close'); await Promise.resolve(); } };
    try {
      vm.runInNewContext(source, {
        __dirname: path.dirname(require.resolve("@ruyi/server/src/main.js")),
        require(name) {
          if (name === "path") return path;
          if (name === "@ruyi/shared/paths") return require("@ruyi/shared/paths");
          if (name === "../../../db/env") return { loadDotEnv() { result.dotEnvLoaded = true; } };
          if (name === "@ruyi/shared/runtime/platform-state/crypto") return { loadKeys: () => loadKeys(env) };
          if (name === "../../../db") return { createDb() { result.dbCreated = true; return {}; } };
          if (name === "./app") return { buildApp(options) {
            result.options = options; Object.assign(app, { db: options.db, stateKeys: options.stateKeys }); return app;
          } };
          if (name === "@ruyi/shared/config") return { uploadRoot: '/tmp/测试工作区' };
          if (name === "@ruyi/worker/src/index") return { createWorker(options) {
            result.events.push('worker.create'); result.workerOptions = options;
            return { async start() { result.events.push('worker.start'); }, async stop() {} };
          } };
          throw new Error("入口出现未预期的依赖");
        },
        process: { env, on(signal, handler) { result.handlers[signal] = handler; },
          exit(code) { result.exitCode = code; if (code) throw exited; } },
        console: { error(message) { result.errors.push(message); } },
      });
    } catch (error) { if (error !== exited) throw error; }
    await Promise.resolve(); await Promise.resolve();
    return result;
  }
  for (const env of [{}, { RUYI_STATE_KEY: "INVALID_PRIVATE_KEY!" }]) {
    const failed = await run(env);
    assert.equal(failed.exitCode, 1);
    assert.equal(failed.dbCreated, false);
    assert.match(failed.errors[0], /^服务启动失败：/);
    assert.equal(failed.errors[0].includes("INVALID_PRIVATE_KEY!"), false);
  }
  const started = await run(keyEnv);
  assert.equal(started.dbCreated, true);
  assert.deepEqual(started.options.stateKeys, keys);
  assert.deepEqual(started.errors, []);
  assert.deepEqual(started.events, ['listen', 'worker.create', 'worker.start']);
  assert.equal(started.workerOptions.db, started.options.db);
  assert.equal(typeof started.handlers.SIGTERM, 'function');
  await Promise.all([started.handlers.SIGINT(), started.handlers.SIGINT(), started.handlers.SIGTERM()]);
  assert.equal(started.events.filter((event) => event === 'app.close').length, 1, '重复信号只能关闭一次');
  assert.equal(started.exitCode, 0);
  const off = await run({ ...keyEnv, RUYI_WORKER: 'off', RUYI_DB_HOST: '127.0.0.1', RUYI_DB_USER: 'ruyi', RUYI_DB_NAME: 'ruyi_test' });
  assert.deepEqual(off.events, ['listen']);
  assert.equal(off.dotEnvLoaded, undefined, '完整环境变量配置不读取 .env');
}

async function clearTestData(db) {
  const rows = await db.selectFrom("ruyi_users").select("id").where("username", "in", ["ps_state_a", "ps_state_b"]).execute();
  if (!rows.length) return;
  const ids = rows.map((row) => row.id);
  for (const table of ["ruyi_user_sessions", "ruyi_platform_states", "ruyi_operation_logs"]) {
    await db.deleteFrom(table).where("user_id", "in", ids).execute();
  }
  await db.deleteFrom("ruyi_users").where("id", "in", ids).execute();
}

async function main() {
  const config = readDbConfig();
  if (config.database !== "ruyi_test" || config.host !== "127.0.0.1" || config.port !== 3306 ||
    config.user !== "ruyi" || config.password !== "ruyi") {
    throw new Error("数据库测试只允许连接本机 Docker 的 ruyi_test 测试数据库。");
  }
  testCrypto();
  await testStartup();
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ruyi-platform-state-test-"));
  const previousUploadDir = process.env.RUYI_UPLOAD_DIR;
  process.env.RUYI_UPLOAD_DIR = tempDir;
  const { buildApp } = require("@ruyi/server/src/app");
  const db = createDb(config);
  let app;
  try {
    await clearTestData(db);
    const userId = await users.createUser(db, { username: "ps_state_a", displayName: "登录态测试用户", passwordHash: "伪造密码摘要", mustChangePassword: false });
    const otherId = await users.createUser(db, { username: "ps_state_b", displayName: "另一测试用户", passwordHash: "伪造密码摘要", mustChangePassword: false });
    assert.throws(() => buildApp({ db, logger: false }), /必须提供登录态加密密钥/);
    app = buildApp({ db, stateKeys: keys, logger: false, webDist: path.join(tempDir, "missing") });
    assert.equal(app.stateKeys, keys);
    const token = crypto.randomBytes(32).toString("base64url");
    await sessions.createSession(db, { tokenHash: hashToken(token), userId, expiresAt: new Date(Date.now() + 3600000) });
    const get = (authenticated = true) => app.inject({ method: "GET", url: "/api/platform-state",
      ...(authenticated ? { headers: { cookie: `ruyi_session=${token}` } } : {}) });
    const read = () => states.getStateRow(db, userId);
    const none = { status: "none", capturedAt: null, refreshedAt: null, lastVerifiedAt: null, expiresHintAt: null };
    const assertSafeResponse = (response) => {
      assert.equal(response.statusCode, 200);
      assert.deepEqual(Object.keys(response.json()).sort(), ["ok", "status", "capturedAt", "refreshedAt", "lastVerifiedAt", "expiresHintAt"].sort());
      for (const forbidden of ["cookies", "ciphertext", marker, "platformAccount"]) assert.equal(response.body.includes(forbidden), false);
    };
    assert.equal((await get(false)).statusCode, 401);
    assert.equal(await read(), undefined);
    assert.equal(await loadUserState(db, userId, keys), null);
    assert.deepEqual(await getStatusSummary(db, userId), none);
    assert.deepEqual((await get()).json(), { ok: true, ...none });

    const save = (value = state) => storeCapturedState(db, userId, value, keys, { platformAccount: "测试平台账号" });
    await save();
    let row = await read();
    assert.equal(row.version, 1);
    assert.equal(row.status, "valid");
    assert.equal(row.key_version, 1);
    assert.equal(row.platform_account, "测试平台账号");
    assert.ok(Buffer.isBuffer(row.state_ciphertext));
    assert.equal(row.state_ciphertext.includes(Buffer.from(marker)), false);
    assert.ok(row.captured_at instanceof Date);
    assert.ok(row.last_verified_at instanceof Date);
    assert.equal(row.refreshed_at, null);
    assert.equal(row.expires_hint_at.getTime(), expiry * 1000);
    assert.deepEqual(await loadUserState(db, userId, keys), { state, version: 1,
      capturedAt: row.captured_at, refreshedAt: null, lastVerifiedAt: row.last_verified_at, expiresHintAt: row.expires_hint_at });
    assert.equal(await loadUserState(db, otherId, keys), null);
    assert.deepEqual(await getStatusSummary(db, otherId), none);
    assertSafeResponse(await get());
    assert.equal((await get()).json().status, "valid");

    await save();
    row = await read();
    assert.equal(row.version, 2);
    const refreshed = { cookies: [], origins: [] };
    assert.equal(await states.refreshState(db, { userId, expectedVersion: 1,
      ...encryptState(refreshed, userId, keys), expiresHintAt: null }), false);
    assert.deepEqual(await read(), row);
    assert.equal(await storeRefreshedState(db, userId, 2, refreshed, keys), true);
    row = await read();
    assert.equal(row.version, 3);
    assert.ok(row.refreshed_at instanceof Date);
    assert.ok(row.last_verified_at instanceof Date);
    assert.equal(row.expires_hint_at, null);
    assert.deepEqual((await loadUserState(db, userId, keys)).state, refreshed);
    const concurrent = await Promise.all([storeRefreshedState(db, userId, 3, state, keys), storeRefreshedState(db, userId, 3, state, keys)]);
    assert.deepEqual(concurrent.sort(), [false, true]);
    row = await read();
    assert.equal(row.version, 4);
    assert.equal(await states.markExpired(db, { userId, expectedVersion: 3 }), false);
    assert.deepEqual(await read(), row);
    assert.equal(await states.markExpired(db, { userId, expectedVersion: 4 }), true);
    row = await read();
    assert.equal(row.version, 5);
    assert.equal(await loadUserState(db, userId, keys), null);
    assert.equal(await storeRefreshedState(db, userId, 5, state, keys), false);
    assert.deepEqual(await read(), row);
    assert.equal((await get()).json().status, "expired");

    await save();
    row = await read();
    assert.equal(row.version, 6);
    assert.equal(row.status, "valid");
    assert.equal(await storeRefreshedState(db, userId, 4, refreshed, keys), false);
    assert.deepEqual(await read(), row);
    await states.clearState(db, userId);
    row = await read();
    assert.ok(row);
    assert.equal(row.state_ciphertext, null);
    assert.equal(row.status, "expired");
    assert.equal(row.version, 7);
    assert.equal(await loadUserState(db, userId, keys), null);
    assertSafeResponse(await get());
    assert.equal((await get()).json().status, "expired");

    const expiredState = { ...state, cookies: [{ ...state.cookies[0], expires: Math.floor(Date.now() / 1000) - 60 }] };
    await save(expiredState);
    row = await read();
    assert.equal(row.status, "valid");
    assert.equal((await getStatusSummary(db, userId)).status, "expired");
    assert.deepEqual((await loadUserState(db, userId, keys)).state, expiredState, "估算时间仅用于摘要提醒，实际过期由持久化状态判断");
    assert.equal((await get()).json().status, "expired");
    assert.deepEqual(await read(), row, "只读查询不得回写状态");

    const rotated = loadKeys({ RUYI_STATE_KEY: crypto.randomBytes(32).toString("base64"), RUYI_STATE_KEY_VERSION: "2",
      RUYI_STATE_KEY_PREVIOUS: keyEnv.RUYI_STATE_KEY });
    await save();
    assert.deepEqual((await loadUserState(db, userId, rotated)).state, state);
    assert.equal(await storeRefreshedState(db, userId, (await read()).version, state, rotated), true);
    assert.equal((await read()).key_version, 2);
    assert.deepEqual((await loadUserState(db, userId, rotated)).state, state);
    await assert.rejects(loadUserState(db, userId, keys), { message: "登录态解密失败" });
    assertSafeResponse(await get());
    // 摘要不需要解密，密文损坏时也不能把内容带入响应或操作记录。
    await db.updateTable("ruyi_platform_states").set({ state_ciphertext: Buffer.alloc(10) }).where("user_id", "=", userId).execute();
    assertSafeResponse(await get());
    const logs = await db.selectFrom("ruyi_operation_logs").selectAll().where("user_id", "in", [userId, otherId]).execute();
    assert.deepEqual(logs, [], "只读状态接口不写操作记录");
    console.log("登录态加密、密钥轮换、版本控制和状态接口数据库测试通过。");
  } finally {
    try {
      if (app) await app.close();
    } finally {
      try { await clearTestData(db); } finally {
        await db.destroy();
        if (previousUploadDir === undefined) delete process.env.RUYI_UPLOAD_DIR;
        else process.env.RUYI_UPLOAD_DIR = previousUploadDir;
      }
    }
  }
}

main().catch((error) => { console.error("登录态数据库测试失败：", error); process.exitCode = 1; });
