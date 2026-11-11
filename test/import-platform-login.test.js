const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { createRequire } = require('node:module');
const serverRequire = createRequire(require.resolve('@ruyi/server/package.json'));
const Fastify = serverRequire('fastify');
const { registerRoutes } = require('@ruyi/server/src/modules/files/routes');
const { importMultipartFiles } = require('@ruyi/server/src/modules/files/import');
const { loadKeys, encryptState } = require('@ruyi/shared/runtime/platform-state/crypto');

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-import-login-'));
  const keys = loadKeys({ RUYI_STATE_KEY: crypto.randomBytes(32).toString('base64') });
  let stateRow, stateReads = 0;
  const db = {
    transaction() { return { execute: async (fn) => fn(db) }; },
    insertInto() { return { values() { return this; }, async execute() {} }; },
    selectFrom(table) {
      return { selectAll() { return this; }, select() { return this; }, innerJoin() { return this; }, where() { return this; },
        async executeTakeFirst() {
          if (table === 'ruyi_platform_states') { stateReads++; return stateRow; }
          if (table === 'ruyi_jobs') return undefined;
          return { id: 7, username: 'alice', role: 'user', job_id: null };
        } };
    },
    updateTable() { return { set() { return this; }, where() { return this; }, async executeTakeFirst() { return { numUpdatedRows: 1n }; } }; },
  };
  const app = Fastify({ logger: false });
  app.decorate('db', db);
  app.decorate('stateKeys', keys);
  app.decorateRequest('user', null);
  app.addHook('onRequest', async (req) => { req.user = { id: 7, username: 'alice', role: 'user' }; });
  app.register(registerRoutes, { auth: true, uploadRoot: root });
  const multipart = () => ({
    headers: { 'content-type': 'multipart/form-data; boundary=login-test' },
    payload: '--login-test\r\nContent-Disposition: form-data; name="files"; filename="sample_oaid.txt"\r\nContent-Type: text/plain\r\n\r\nfake-data\r\n--login-test--\r\n',
  });
  const encrypted = encryptState({ cookies: [], origins: [] }, 7, keys);
  const valid = { status: 'valid', state_ciphertext: encrypted.ciphertext, key_version: encrypted.keyVersion, version: 1 };
  try {
    for (const row of [undefined, { ...valid, status: 'expired' }, { ...valid, state_ciphertext: Buffer.alloc(0) },
      { ...valid, state_ciphertext: Buffer.from('invalid-ciphertext') }]) {
      stateRow = row;
      for (const url of ['/api/import-folder', `/api/transfer/upload/${'a'.repeat(43)}`]) {
        const result = await app.inject({ method: 'POST', url, ...multipart() });
        assert.equal(result.statusCode, 409);
        assert.equal(result.json().code, 'PLATFORM_LOGIN_REQUIRED');
        assert.ok(!JSON.stringify(result.json()).includes('state_ciphertext'));
        assert.deepEqual(fs.readdirSync(root), [], '拒绝导入不得创建工作区或遗留文件');
      }
    }
    stateRow = valid;
    for (const url of ['/api/import-folder', `/api/transfer/upload/${'b'.repeat(43)}`]) {
      const before = stateReads;
      const result = await app.inject({ method: 'POST', url, ...multipart() });
      assert.equal(result.statusCode, url.includes('/transfer/') ? 201 : 200);
      assert.equal(url.includes('/transfer/') ? result.json().item.fileCount : result.json().count, 1);
      assert.equal(stateReads - before, 2, '接收前及落盘前均校验登录态');
    }
    const raw = path.join(root, 'users/alice/raw');
    assert.equal(fs.readdirSync(raw).length, 1, '传输入口文件按新任务隔离，不再写入旧 raw');

    // 直接调用公共导入器验证：初次拒绝时甚至不读取 multipart 文件流。
    const reply = { code(value) { this.statusCode = value; return this; }, send(value) { return value; } };
    const rejected = { user: { id: 7 }, isMultipart() { throw new Error('未登录不得读取文件流'); } };
    await importMultipartFiles(rejected, reply, { workspace: path.join(root, 'unread'), canImportFiles: async () => false });
    assert.equal(reply.statusCode, 409);
    assert.deepEqual(rejected.auditImport, { count: 0, skipped: 0, files: [] });

    let checks = 0;
    const changed = { user: { id: 7 }, isMultipart: () => true,
      async *parts() { yield { file: true, fieldname: 'files', filename: 'fake_pn.txt', toBuffer: async () => Buffer.from('fake') }; } };
    const result = await importMultipartFiles(changed, reply, {
      workspace: path.join(root, 'changed'), userHasRunningJob: async () => false,
      canImportFiles: async () => ++checks === 1,
    });
    assert.equal(result.code, 'PLATFORM_LOGIN_REQUIRED');
    assert.equal(fs.existsSync(path.join(root, 'changed')), false, '接收期间失效也不得落盘');
  } finally { await app.close(); }
  console.log('导入平台登录校验测试通过：网页/传输入口、无登录态、已失效、解密失败、有效登录及落盘前复查。');
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
