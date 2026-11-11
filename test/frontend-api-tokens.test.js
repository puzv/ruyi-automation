const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const webRequire = createRequire(require.resolve('@ruyi/web/package.json'));
const vue = webRequire('vue');
const { parse, compileScript, compileTemplate } = webRequire('@vue/compiler-sfc');

async function checkMcpDevProxy() {
  const http = require('node:http');
  const { pathToFileURL } = require('node:url');
  const { createServer } = await import(pathToFileURL(webRequire.resolve('vite')).href);
  const backend = http.createServer((req, res) => {
    assert.equal(req.url, '/mcp');
    assert.equal(req.method, 'POST');
    assert.equal(req.headers.authorization, 'Bearer fixture-only');
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      assert.deepEqual(JSON.parse(body), { jsonrpc: '2.0', method: 'tools/list', id: 1 });
      res.writeHead(401, { 'content-type': 'application/json', 'www-authenticate': 'Bearer realm="ruyi"' });
      res.end(JSON.stringify({ code: 'UNAUTHENTICATED', message: '需要有效的 API 令牌' }));
    });
  });
  await new Promise((resolve) => backend.listen(0, '127.0.0.1', resolve));
  const oldPort = process.env.RUYI_SERVER_PORT;
  let vite;
  try {
    process.env.RUYI_SERVER_PORT = String(backend.address().port);
    vite = await createServer({ configFile: path.resolve(__dirname, '../apps/web/vite.config.js'),
      root: path.resolve(__dirname, '../apps/web'), logLevel: 'silent',
      server: { host: '127.0.0.1', port: 0, watch: null } });
    await vite.listen();
    const response = await fetch(`http://127.0.0.1:${vite.httpServer.address().port}/mcp`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer fixture-only' },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'tools/list', id: 1 }),
    });
    assert.equal(response.status, 401, 'Vite 同源 /mcp 必须转发后端鉴权响应，不能返回 404 或页面');
    assert.equal(response.headers.get('www-authenticate'), 'Bearer realm="ruyi"');
    assert.equal((await response.json()).code, 'UNAUTHENTICATED');
  } finally {
    if (vite) await vite.close();
    await new Promise((resolve) => backend.close(resolve));
    if (oldPort === undefined) delete process.env.RUYI_SERVER_PORT;
    else process.env.RUYI_SERVER_PORT = oldPort;
  }
}

function mount({ secure = true, clipboard = true, fallback = true, clipboardFails = false } = {}) {
  const filename = path.resolve(__dirname, '../apps/web/src/views/ApiTokensView.vue');
  const { descriptor } = parse(fs.readFileSync(filename, 'utf8'), { filename });
  compileScript(descriptor, { id: 'api-tokens-test' });
  const template = compileTemplate({ filename, id: 'api-tokens-test', source: descriptor.template.content, compilerOptions: { mode: 'function' } });
  assert.deepEqual(template.errors, []);
  const mounted = [], unmounted = [], calls = [], copied = [];
  let confirm = true;
  const temporary = [];
  const document = {
    body: { appendChild(node) { temporary.push(node); } },
    createElement() { return { style: {}, select() { this.selected = true; }, remove() { temporary.splice(temporary.indexOf(this), 1); } }; },
    execCommand(command) { assert.equal(command, 'copy'); assert.equal(temporary[0].selected, true); assert.equal(temporary[0].readOnly, true); copied.push(temporary[0].value); return fallback; },
  };
  const item = { id: 12, name: '我的 AI 工具', displayPrefix: 'ruyi_pat_abcd', status: 'active', createdAt: '2026-10-30T00:00:00Z', expiresAt: '2027-01-28T00:00:00Z' };
  const sandbox = {
    ...vue,
    onMounted(fn) { mounted.push(fn); }, onBeforeUnmount(fn) { unmounted.push(fn); },
    document,
    window: { isSecureContext: secure, location: { origin: 'https://ruyi.example.test:8443' }, confirm() { return confirm; } }, navigator: { clipboard: clipboard ? { async writeText(value) { if (clipboardFails) throw new Error('拒绝复制'); copied.push(value); } } : undefined },
    formatTime(value) { return value || '—'; },
    async requestJson(url, options = {}) {
      calls.push({ url, ...options });
      if (options.method === 'POST' && url.endsWith('/revoke')) { item.status = 'revoked'; return { ok: true }; }
      if (options.method === 'POST') return { ok: true, token: 'ruyi_pat_just-created-secret', item: { ...item } };
      return { ok: true, items: [{ ...item }] };
    },
  };
  const source = descriptor.scriptSetup.content.replace(/^import[^\n]+\n/gm, '');
  const view = vm.runInNewContext(`${source}\n;({ items, form, secret, error, notice, loading, busy, statusLabels, formatTime, createToken, copyToken, revokeToken, connectionCommand, copyConnection, copyText, copySkill, skillCommand, textFields })`, sandbox, { filename });
  const render = new Function('Vue', template.code)({ ...vue, withDirectives: (node) => node });
  return { view, calls, copied, temporary, async start() { await Promise.all(mounted.map((fn) => fn())); }, unmount() { unmounted.forEach((fn) => fn()); }, confirm(value) { confirm = value; }, render() { return render(vue.proxyRefs(view), []); } };
}

async function main() {
  await checkMcpDevProxy();
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
  assert.match(page.copied.at(-2), /^claude mcp remove ruyi --scope user/);
  assert.match(page.copied.at(-1), /http_headers = \{ Authorization = "Bearer %s" \}/);
  const format = page.copied.at(-1).match(/printf '([^']+)'/)[1];
  const config = require('node:child_process').spawnSync('printf', [format, 'https://ruyi.example.test:8443/mcp', page.view.secret.value], { encoding: 'utf8' });
  assert.equal(config.status, 0);
  assert.ok(config.stdout.includes('http_headers = { Authorization = "Bearer ruyi_pat_just-created-secret" }'));
  assert.match(page.copied.at(-1), /chmod 600/);
  assert.ok(!page.copied.at(-1).includes('RUYI_TOKEN'));
  for (const client of ['claude', 'codex']) {
    await page.view.copySkill(client);
    assert.equal(page.copied.at(-1), page.view.skillCommand(client));
    assert.match(page.copied.at(-1), /unzip -o/);
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
  const http = mount({ secure: false, clipboard: false });
  assert.equal(await http.view.copyText('HTTP 复制'), true);
  assert.deepEqual(http.copied, ['HTTP 复制']);
  assert.equal(http.temporary.length, 0);
  const denied = mount({ secure: false, clipboard: false, fallback: false });
  assert.equal(await denied.view.copyText('失败'), false);
  for (const field of ['token', 'claude', 'codex', 'claudeSkill', 'codexSkill']) {
    let focused = false, selected = false;
    denied.view.textFields[field] = { focus() { focused = true; }, select() { selected = true; } };
    if (field === 'token') await denied.view.copyToken();
    else if (field.endsWith('Skill')) await denied.view.copySkill(field.replace('Skill', ''));
    else await denied.view.copyConnection(field);
    assert.equal(focused && selected, true);
    assert.match(JSON.stringify(denied.render()), /浏览器不允许自动复制，请选中下方文字后按 ⌘C \/ Ctrl\+C 复制/);
  }
  assert.equal(denied.temporary.length, 0);
  const rejected = mount({ clipboardFails: true });
  assert.equal(await rejected.view.copyText('回退'), true);
  assert.equal(rejected.temporary.length, 0);
  console.log('API 令牌前端创建、显示、复制、列表与吊销测试通过。');
}
module.exports = main;
if (require.main === module) main().catch((error) => { console.error('API 令牌前端测试失败：', error); process.exitCode = 1; });
