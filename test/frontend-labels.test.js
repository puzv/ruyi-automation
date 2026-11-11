const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

async function main() {
  const { actionLabels, isLoginWaitLog, isPlatformWaitLog, logDescription, logTarget } = await import('../apps/web/src/labels.js');
  const actions = new Set();
  function scan(dir) {
    for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, item.name);
      if (item.isDirectory()) { if (item.name !== 'node_modules') scan(file); continue; }
      if (!item.name.endsWith('.js') || item.name.endsWith('.state.json')) continue;
      const source = fs.readFileSync(file, 'utf8');
      for (const match of source.matchAll(/\baction\s*(?::|=)\s*['"]([a-z_]+\.[a-z_]+)['"]/g)) actions.add(match[1]);
      // 管理员动作通过路由到动作的映射赋值，也必须纳入检查。
      for (const match of source.matchAll(/\baction\s*=\s*\{([^}]+)\}/g)) {
        for (const value of match[1].matchAll(/:\s*['"]([a-z_]+\.[a-z_]+)['"]/g)) actions.add(value[1]);
      }
    }
  }
  for (const root of ['apps/server/src', 'apps/worker/src', 'packages', 'scripts']) scan(path.resolve(__dirname, '..', root));
  assert.ok(actions.size >= 20, '应扫描到服务端审计动作');
  for (const action of actions) assert.match(actionLabels[action] || '', /[\u4e00-\u9fff]/u, `${action} 缺少中文标签`);
  assert.equal(actionLabels['token.create'], '生成 API 令牌');
  assert.equal(actionLabels['token.revoke'], '吊销 API 令牌');
  assert.equal(actionLabels['job.results_download'], '下载任务结果');
  assert.equal(logTarget({ targetType: 'api_token', targetId: 7 }), 'API 令牌 · 7');
  assert.equal(logDescription({ action: 'token.create', detail: { name: '我的工具', expiresInDays: 90 } }), '名称：我的工具，有效期 90 天');
  assert.ok(logDescription({ action: 'job.finish', result: 'success', detail: { task: 'analyse', status: 'waiting_platform', outcome: 'not_ready', code: 2 } }).includes('等待平台处理'));
  assert.equal(logDescription({ action: 'job.finish', result: 'failure', errorMessage: '真实失败', detail: { task: 'analyse', code: 1 } }), '真实失败');
  assert.equal(isLoginWaitLog({ action: 'job.finish', detail: { status: 'waiting_login', outcome: 'login_required' } }), true);
  assert.ok(logDescription({ action: 'job.finish', result: 'failure', detail: { status: 'waiting_login', outcome: 'login_required', task: 'create' } }).includes('等待重新登录'));
  assert.equal(isPlatformWaitLog({ action: 'job.finish', detail: { status: 'waiting_platform', outcome: 'not_ready', code: 2 } }), true);
  for (const override of [{ code: 1 }, { signal: 'SIGTERM' }, { stateExpired: true }]) {
    assert.equal(isPlatformWaitLog({ action: 'job.finish', detail: { status: 'waiting_platform', outcome: 'not_ready', code: 2, ...override } }), false);
  }
  for (const [via, suffix] of [[undefined, ''], ['api_token', '（AI 工具）'], ['transfer_ticket', '（AI 工具 · 一次性链接）']]) {
    assert.equal(logDescription({ action: 'job.start', detail: { task: 'upload', via } }), `上传文件${suffix}`);
    assert.equal(logDescription({ action: 'file.import', detail: { count: 1, skipped: 0, via } }), `导入 1 个，跳过 0 个${suffix}`);
    assert.equal(logDescription({ action: 'job.results_download', detail: { via } }), `下载结果 ZIP${suffix}`);
    assert.equal(logDescription({ action: 'job.start', result: 'failure', errorMessage: '启动失败', detail: { via } }), `启动失败${suffix}`);
  }
  for (const relative of ['components/LogTable.vue', 'views/MyLogsView.vue', 'views/AdminLogsView.vue']) {
    const source = fs.readFileSync(path.resolve(__dirname, '../apps/web/src', relative), 'utf8');
    assert.match(source, /import \{[^}]*actionLabels[^}]*\} from '..\/labels.js'/);
    assert.match(source, relative.includes('LogTable') ? /actionLabels\[item.action\]/ : /in actionLabels/);
  }
  console.log('操作记录中文标签、全部服务端动作与来源说明测试通过。');
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
