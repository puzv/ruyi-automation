const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { buildApp } = require('@ruyi/server/src/app');
const tokens = require('@ruyi/server/src/modules/api-tokens/repository');
const sessions = require('@ruyi/server/src/modules/auth/repository');
const { filesZipStream } = require('@ruyi/shared/runtime/job-results');
const { TOOL_NAMES, createTools } = require('@ruyi/server/src/modules/mcp/tools');

function unzipStored(buffer) {
  const end = buffer.length - 22;
  assert.equal(buffer.readUInt32LE(end), 0x06054b50);
  const result = new Map();
  let cursor = buffer.readUInt32LE(end + 16);
  for (let index = 0; index < buffer.readUInt16LE(end + 10); index++) {
    assert.equal(buffer.readUInt32LE(cursor), 0x02014b50);
    assert.equal(buffer.readUInt16LE(cursor + 10), 0);
    const length = buffer.readUInt16LE(cursor + 28);
    const name = buffer.subarray(cursor + 46, cursor + 46 + length).toString();
    const offset = buffer.readUInt32LE(cursor + 42);
    assert.equal(buffer.readUInt32LE(offset), 0x04034b50);
    const start = offset + 30 + buffer.readUInt16LE(offset + 26) + buffer.readUInt16LE(offset + 28);
    result.set(name, buffer.subarray(start, start + buffer.readUInt32LE(cursor + 24)));
    cursor += 46 + length + buffer.readUInt16LE(cursor + 30) + buffer.readUInt16LE(cursor + 32);
  }
  return result;
}
async function main() {
  for (const name of ['../secret', '/absolute', 'a/../b', 'a\\b']) {
    assert.throws(() => filesZipStream([{ name, path: '/unused', size: 0 }]), /ZIP 文件信息无效/);
  }
  const root = path.resolve(__dirname, '../skills/ruyi-audience');
  const skill = fs.readFileSync(path.join(root, 'SKILL.md'), 'utf8');
  const frontmatter = /^---\n([\s\S]*?)\n---\n/.exec(skill);
  assert.ok(frontmatter);
  assert.match(frontmatter[1], /^name: ruyi-audience$/m);
  assert.match(frontmatter[1], /^description: .+/m);
  assert.ok(skill.split('\n').length <= 150);
  const actual = Object.keys(createTools({}, { headers: {}, protocol: 'https', host: 'example.test' }, { raw: { once() {} } }));
  assert.deepEqual([...TOOL_NAMES].sort(), actual.sort(), '工具常量必须与真实工具一致');
  const mentioned = [...skill.matchAll(/\b[a-z]+(?:_[a-z]+)+\b/g)].map((match) => match[0]);
  assert.ok(mentioned.length);
  for (const name of mentioned) assert.ok(TOOL_NAMES.includes(name), `Skill 提到未知工具 ${name}`);

  const originals = { tokens: { ...tokens }, sessions: { ...sessions } };
  const user = { id: 7, username: 'skill_test', role: 'user', status: 'active', must_change_password: 0 };
  sessions.findActiveSession = async () => ({ id: 'test-session', user });
  sessions.touchSession = async () => {};
  tokens.findActiveByHash = async () => ({ id: 1, user });
  tokens.touch = async () => {};
  const app = buildApp({ db: {}, stateKeys: {}, logger: false });
  try {
    assert.equal((await app.inject('/api/skill/ruyi-audience.zip')).statusCode, 401);
    for (const headers of [{ cookie: `ruyi_session=${'a'.repeat(43)}` }, { authorization: `Bearer ruyi_pat_${'b'.repeat(43)}` }]) {
      const response = await app.inject({ url: '/api/skill/ruyi-audience.zip', headers });
      assert.equal(response.statusCode, 200);
      assert.equal(response.headers['content-type'], 'application/zip');
      assert.match(response.headers['content-disposition'], /attachment/);
      const files = unzipStored(response.rawPayload);
      assert.equal(files.size, 3);
      for (const name of ['SKILL.md', 'references/workflow.md', 'references/examples.md']) {
        assert.deepEqual(files.get(`ruyi-audience/${name}`), fs.readFileSync(path.join(root, name)));
      }
    }
    const missing = path.join(root, 'references/workflow.md');
    const backup = `${missing}.mcp-test-backup`;
    fs.renameSync(missing, backup);
    try {
      const response = await app.inject({ url: '/api/skill/ruyi-audience.zip', headers: { cookie: `ruyi_session=${'a'.repeat(43)}` } });
      assert.equal(response.statusCode, 503);
      assert.deepEqual(response.json(), { ok: false, message: 'Skill 文件不可用，请联系管理员' });
    } finally {
      fs.renameSync(backup, missing);
    }
  } finally {
    await app.close();
    Object.assign(tokens, originals.tokens);
    Object.assign(sessions, originals.sessions);
  }
  console.log('Skill 格式、真实工具名与 ZIP Cookie/令牌鉴权测试通过。');
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
