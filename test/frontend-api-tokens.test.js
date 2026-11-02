const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const webRequire = createRequire(require.resolve('@ruyi/web/package.json'));
const vue = webRequire('vue');
const { parse, compileScript, compileTemplate } = webRequire('@vue/compiler-sfc');

function mount() {
  const filename = path.resolve(__dirname, '../apps/web/src/views/ApiTokensView.vue');
  const { descriptor } = parse(fs.readFileSync(filename, 'utf8'), { filename });
  compileScript(descriptor, { id: 'api-tokens-test' });
  const template = compileTemplate({ filename, id: 'api-tokens-test', source: descriptor.template.content, compilerOptions: { mode: 'function' } });
  assert.deepEqual(template.errors, []);
  const mounted = [], unmounted = [], calls = [], copied = [];
  let confirm = true;
  const item = { id: 12, name: '我的 AI 工具', displayPrefix: 'ruyi_pat_abcd', status: 'active', createdAt: '2026-10-30T00:00:00Z', expiresAt: '2027-01-28T00:00:00Z' };
  const sandbox = {
    ...vue,
    onMounted(fn) { mounted.push(fn); }, onBeforeUnmount(fn) { unmounted.push(fn); },
    window: { location: { origin: 'https://ruyi.example.test:8443' }, confirm() { return confirm; } }, navigator: { clipboard: { async writeText(value) { copied.push(value); } } },
    formatTime(value) { return value || '—'; },
    async requestJson(url, options = {}) {
      calls.push({ url, ...options });
      if (options.method === 'POST' && url.endsWith('/revoke')) { item.status = 'revoked'; return { ok: true }; }
      if (options.method === 'POST') return { ok: true, token: 'ruyi_pat_just-created-secret', item: { ...item } };
      return { ok: true, items: [{ ...item }] };
    },
  };
  const source = descriptor.scriptSetup.content.replace(/^import[^\n]+\n/gm, '');
  const view = vm.runInNewContext(`${source}\n;({ items, form, secret, error, notice, loading, busy, statusLabels, formatTime, createToken, copyToken, revokeToken, connectionCommand, copyConnection })`, sandbox, { filename });
  const render = new Function('Vue', template.code)({ ...vue, withDirectives: (node) => node });
  return { view, calls, copied, async start() { await Promise.all(mounted.map((fn) => fn())); }, unmount() { unmounted.forEach((fn) => fn()); }, confirm(value) { confirm = value; }, render() { return render(vue.proxyRefs(view), []); } };
}

async function main() {
  const page = mount();
  await page.start();
  assert.equal(page.view.items.value[0].name, '我的 AI 工具');
  assert.equal(page.view.secret.value, '');
  assert.equal(page.view.form.expiresInDays, 90);
  const initial = JSON.stringify(page.render());
  assert.match(initial, /我的 AI 工具/);
  assert.match(initial, /ruyi_pat_abcd/);
  assert.match(initial, /有效/);
  for (const client of ['claude', 'codex']) {
    assert.ok(page.view.connectionCommand(client).includes('https://ruyi.example.test:8443/mcp'));
    assert.ok(page.view.connectionCommand(client).includes('<令牌>'));
  }
  assert.match(initial, /api\/skill\/ruyi-audience.zip/);
  page.view.form.name = '  Codex  ';
  await page.view.createToken();
  const create = page.calls.find((call) => call.method === 'POST');
  assert.equal(create.url, '/api/api-tokens');
  assert.equal(create.body.name, 'Codex');
  assert.equal(create.body.expiresInDays, 90);
  assert.equal(page.view.secret.value, 'ruyi_pat_just-created-secret');
  assert.match(JSON.stringify(page.render()), /ruyi_pat_just-created-secret/);
  await page.view.copyToken();
  assert.deepEqual(page.copied, ['ruyi_pat_just-created-secret']);
  for (const client of ['claude', 'codex']) {
    await page.view.copyConnection(client);
    assert.ok(page.copied.at(-1).includes('ruyi_pat_just-created-secret'));
    assert.ok(page.copied.at(-1).includes('https://ruyi.example.test:8443/mcp'));
  }
  assert.ok(!page.view.connectionCommand('claude').includes('ruyi_pat_just-created-secret'));
  page.confirm(false);
  await page.view.revokeToken(page.view.items.value[0]);
  assert.equal(page.calls.some((call) => call.url.endsWith('/revoke')), false);
  page.confirm(true);
  await page.view.revokeToken(page.view.items.value[0]);
  assert.equal(page.calls.at(-2).url, '/api/api-tokens/12/revoke');
  assert.equal(page.calls.at(-2).method, 'POST');
  assert.equal(page.view.items.value[0].status, 'revoked');
  assert.equal(page.view.secret.value, '');
  page.view.secret.value = 'temporary';
  page.unmount();
  assert.equal(page.view.secret.value, '');
  const refreshed = mount();
  await refreshed.start();
  assert.equal(refreshed.view.secret.value, '', '刷新后不再显示明文');
  refreshed.view.form.name = '   ';
  await refreshed.view.createToken();
  assert.match(refreshed.view.error.value, /名称/);
  assert.equal(refreshed.calls.length, 1);
  refreshed.unmount();
  console.log('API 令牌前端创建、显示、复制、列表与吊销测试通过。');
}
module.exports = main;
if (require.main === module) main().catch((error) => { console.error('API 令牌前端测试失败：', error); process.exitCode = 1; });
