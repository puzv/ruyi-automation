const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawn, spawnSync } = require('child_process');
const { allowed, prepare } = require('../scripts/build-context');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-offline-test-'));
const deploy = path.resolve(__dirname, '..');
const repo = path.join(root, 'app');
const bin = path.join(root, 'bin');
const stages = path.join(root, 'stages');
const capture = path.join(root, 'capture.json');
const log = path.join(root, 'services.log');
const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, TMPDIR: stages, TEST_CAPTURE: capture, TEST_LOG: log };
const write = (file, content, mode) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, content, mode ? { mode } : undefined); };
const git = args => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
function snapshot(ref, parent) {
  const tree = git(['write-tree']).trim();
  const revision = git(['-c', 'user.name=离线测试', '-c', 'user.email=offline@example.invalid', 'commit-tree', tree, ...(parent ? ['-p', parent] : []), '-m', '离线人工样本']).trim();
  git(['update-ref', ref, revision]);
  return revision;
}
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, message) {
  for (let i = 0; i < 200; i++) { if (check()) return; await pause(50); }
  throw new Error(message);
}
function build(source = '--worktree', extra = [], customEnv = {}) {
  return spawnSync('bash', [path.join(deploy, 'scripts/build-image.sh'), repo, source, 'harbor.ge.cn/b2d/common/ruyi-upload:offline', ...extra], { env: { ...env, ...customEnv }, encoding: 'utf8' });
}
function cleanStage() { assert.deepStrictEqual(fs.readdirSync(stages), [], '构建临时目录未清理'); }
function services() { return fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : ''; }
function aptNetworkConfiguration(filename) {
  const dockerfile = fs.readFileSync(path.join(deploy, filename), 'utf8');
  const block = dockerfile.match(/^RUN set -eu;[\s\S]*?(?=^COPY )/m);
  assert(block, '缺少受控 apt 配置');
  assert(!/trusted=yes|AllowUnauthenticated|Verify-Peer=false|Verify-Host=false|allow-insecure/i.test(dockerfile));
  const aptRoot = path.join(root, 'apt-fixture');
  const aptBin = path.join(root, 'apt-bin');
  const aptLog = path.join(root, 'apt.jsonl');
  fs.writeFileSync(aptLog, '');
  const source = path.join(aptRoot, 'sources.list.d/ubuntu.sources');
  write(source, 'Types: deb\nURIs: http://azure.archive.ubuntu.com/ubuntu/ http://security.ubuntu.com/ubuntu/\nSuites: noble noble-updates\nComponents: main universe\nSigned-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg\n');
  const legacy = path.join(aptRoot, 'sources.list');
  write(legacy, 'deb https://azure.archive.ubuntu.com/ubuntu noble main\ndeb http://archive.ubuntu.com/ubuntu noble main\ndeb http://ports.ubuntu.com/ubuntu-ports noble main\n');
  write(path.join(aptBin, 'apt-get'), `#!/usr/bin/env node\nconst fs=require('fs'); const args=process.argv.slice(2);fs.appendFileSync(process.env.TEST_APT_LOG,JSON.stringify(args)+'\\n');if(process.env.TEST_APT_FAIL && args.includes('update'))process.exit(100);\n`, 0o755);
  // macOS sed 的 -i 与镜像内 GNU sed 不同；仍用系统 sed 验证原始替换表达式。
  const realSed = execFileSync('which', ['sed'], { encoding: 'utf8' }).trim();
  write(path.join(aptBin, 'sed'), `#!/usr/bin/env node\nconst fs=require('fs'),{spawnSync}=require('child_process');const args=process.argv.slice(2).filter(arg=>arg!=='-i');const result=spawnSync(${JSON.stringify(realSed)},args,{encoding:'utf8'});if(result.status!==0){process.stderr.write(result.stderr);process.exit(result.status??1);}fs.writeFileSync(args[args.length-1],result.stdout);\n`, 0o755);
  const quote = value => "'" + value.replace(/'/g, "'\\''") + "'";
  const command = block[0].replace(/^RUN /, '').replace(/\\\n/g, ' ')
    .replaceAll('/etc/apt', quote(aptRoot)).replace('/var/lib/apt/lists/*', `${quote(path.join(aptRoot, 'cache'))}/*`);
  const run = fail => spawnSync('/bin/sh', ['-c', command], { env: { ...process.env, PATH: `${aptBin}:${process.env.PATH}`, TEST_APT_LOG: aptLog, TEST_APT_FAIL: fail ? '1' : '' }, encoding: 'utf8' });
  let result = run(false);
  assert.strictEqual(result.status, 0, result.stderr);
  const converted = fs.readFileSync(source, 'utf8');
  assert(converted.includes('URIs: https://archive.ubuntu.com/ubuntu/ https://security.ubuntu.com/ubuntu/'));
  assert(converted.includes('Signed-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg'));
  assert(converted.includes('Components: main universe'));
  const legacyConverted = fs.readFileSync(legacy, 'utf8');
  assert(!legacyConverted.includes('azure.archive'));
  assert(!legacyConverted.includes('http://'));
  assert(legacyConverted.includes('https://ports.ubuntu.com/ubuntu-ports/'));
  const calls = fs.readFileSync(aptLog, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.strictEqual(calls.length, 2);
  assert(calls[0].includes('APT::Update::Error-Mode=any'));
  assert(calls[1].includes('install'));
  for (const args of calls) for (const setting of ['Acquire::http::Timeout=30', 'Acquire::https::Timeout=30', 'Acquire::Retries=2']) assert(args.includes(setting));
  fs.writeFileSync(aptLog, '');
  result = run(true);
  assert.strictEqual(result.status, 100, 'apt update 失败应使构建立刻失败');
  assert.strictEqual(fs.readFileSync(aptLog, 'utf8').trim().split('\n').length, 1, '索引失败后不能继续安装');
}
function layoutConfiguration() {
  const legacy = fs.readFileSync(path.join(deploy, 'Dockerfile'), 'utf8');
  const workspace = fs.readFileSync(path.join(deploy, 'Dockerfile.workspace'), 'utf8');
  assert(legacy.includes('RUN npm --prefix web ci --include=dev'));
  assert.strictEqual((workspace.match(/\bnpm ci\b/g) || []).length, 1, '工作区必须统一根目录安装');
  assert(workspace.includes('RUN npm ci --include=dev'));
  assert(!workspace.includes('web/package-lock.json'));
  for (const name of ['apps/web', 'apps/server', 'apps/worker', 'packages/automation', 'packages/shared']) {
    const copy = `COPY ${name}/package.json ./${name}/`;
    assert(workspace.includes(copy));
    assert(workspace.indexOf(copy) < workspace.indexOf('RUN npm ci'));
  }
  assert(workspace.indexOf('RUN npm ci') < workspace.indexOf('COPY . .'));
  assert(workspace.indexOf('COPY . .') < workspace.indexOf('RUN npm run build:web'));
  for (const file of [legacy, workspace]) for (const expected of [
    'FROM mcr.microsoft.com/playwright:v1.62.1-noble', 'PLAYWRIGHT_BROWSERS_PATH=/ms-playwright',
    'RUYI_LOGIN_DISPLAY=vnc', 'DISPLAY=:99', 'RUYI_UPLOAD_DIR=/data/upload', 'USER pwuser',
    'EXPOSE 5173', 'ENTRYPOINT ["/app/scripts/start-desktop.sh"]',
  ]) assert(file.includes(expected), expected);
  for (const name of [
    '../apps/server/src/main.js', '/apps/server/src/main.js', 'apps//server/src/main.js',
    'apps/server/src/../../main.js', 'apps/server/src/evil\\main.js', 'apps/unknown/package.json',
    'packages/unknown/lib/index.js', 'apps/server/src/.env.js', 'apps/web/src/data/user.js',
    'packages/shared/runtime/cache/tokens.js', 'packages/automation/lib/ruyi-profile/user.js',
    'apps/web/node_modules/package.js', 'apps/web/dist/app.js', 'apps/web/package-lock.json',
    'packages/automation/test/fixture.js', 'apps/server/src/state-test.json.js',
    'packages/shared/runtime/user.state.json.js', 'apps/worker/src/logs/fake.js',
  ]) assert(!allowed(name), `路径应被排除：${name}`);
  for (const name of ['apps/web/src/main.js', 'apps/web/src/view.vue', 'apps/server/src/main.js',
    'apps/worker/src/main.js', 'packages/shared/config.js', 'packages/shared/runtime/repos/jobs.js',
    'packages/automation/upload.js', 'packages/automation/lib/browser.js']) assert(allowed(name), name);
  assert(!allowed('server/index.js', 'workspace'));
  assert(!allowed('apps/server/src/main.js', 'legacy'));
  assert.throws(() => prepare({ files: [{ name: 'apps/server/src/main.js' }] }), /缺少必要的构建源码/);
}
async function desktop(failure, signal) {
  fs.writeFileSync(log, '');
  const child = spawn('bash', [path.join(deploy, 'scripts/start-desktop.sh')], { cwd: root, env: { ...env, RUYI_UPLOAD_DIR: path.join(root, 'workspace'), RUYI_SHUTDOWN_TIMEOUT_SECONDS: '2', TEST_FAIL: failure || '' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let error = '';
  child.stderr.on('data', chunk => { error += chunk; });
  let outcome;
  const exited = new Promise(resolve => child.once('exit', (code, sig) => { outcome = { code, sig }; resolve(outcome); }));
  if (signal) {
    try {
      await until(() => services().includes('node-start') || outcome, '假 Node 未启动');
      assert(!outcome, `假 Node 启动前桌面已退出：${JSON.stringify(outcome)}；${error}`);
    } catch (startupError) {
      child.kill('SIGTERM');
      await exited;
      throw new Error(`${startupError.message}；${error}`);
    }
    child.kill(signal);
  }
  let timer;
  const timeout = new Promise((resolve, reject) => { timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`桌面监督未及时退出: ${error}`)); }, 10000); });
  const result = await Promise.race([exited, timeout]).finally(() => clearTimeout(timer));
  assert.strictEqual(result.code, signal === 'SIGINT' ? 130 : signal ? 143 : failure === 'x-ready' ? 1 : failure === 'npm-zero' ? 1 : 7, error);
  const records = services();
  if (signal || failure === 'openbox') assert(records.includes('node-stopped'), 'Node 未完成优雅退出');
  for (const line of records.split('\n').filter(line => line.includes('-start '))) {
    const pid = Number(line.split(' ')[1]);
    let running = true;
    try { process.kill(pid, 0); } catch { running = false; }
    assert(!running, `遗留假服务进程 ${pid}`);
  }
}

async function main() {
  layoutConfiguration();
  aptNetworkConfiguration('Dockerfile');
  aptNetworkConfiguration('Dockerfile.workspace');
  fs.mkdirSync(repo); fs.mkdirSync(bin); fs.mkdirSync(stages);
  git(['init', '-q']);
  const source = {
    'package.json': '{}', 'package-lock.json': '{}', 'web/package.json': '{}', 'web/package-lock.json': '{}',
    'web/index.html': '<html></html>', 'server/index.js': 'original', 'server/routes/auth.js': 'original-auth',
    'web/src/views/RegisterView.vue': 'committed-register', 'scripts/job-wrapper.js': 'wrapper',
    'lib/safe.js': 'safe', '.env': 'FAKE_SECRET', 'server/.env.local': 'FAKE_SECRET',
    'state-test.json': 'FAKE_SECRET', 'lib/test.state.json.tmp': 'FAKE_SECRET', 'upload/data.js': 'FAKE_SECRET',
    'server/logs/error.js': 'FAKE_SECRET', 'web/dist/data.js': 'FAKE_SECRET', 'node_modules/fake.js': 'FAKE_SECRET',
    'web/src/debug.log.js': 'FAKE_SECRET', 'artifacts/data.js': 'FAKE_SECRET',
  };
  for (const [name, content] of Object.entries(source)) write(path.join(repo, name), content);
  fs.symlinkSync(path.join(root, 'outside.js'), path.join(repo, 'lib/linked.js'));
  write(path.join(root, 'outside.js'), 'FAKE_SECRET');
  git(['add', '.']);
  const legacyRevision = snapshot('HEAD');
  write(path.join(repo, 'server/routes/auth.js'), 'uncommitted-registration');
  write(path.join(repo, 'web/src/views/UncommittedRegister.vue'), 'untracked-registration');
  fs.symlinkSync(path.join(root, 'outside.js'), path.join(repo, 'server/linked.js'));
  write(path.join(repo, 'server/registration.state.json.backup'), 'FAKE_SECRET');
  const blocked = Object.keys(source).filter(name => !allowed(name));
  const forbiddenOids = blocked.map(name => git(['rev-parse', `HEAD:${name}`]).trim());
  const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
  write(path.join(bin, 'git'), `#!/usr/bin/env node\nconst {spawnSync}=require('child_process'); const a=process.argv.slice(2); if(a.includes('cat-file') && ${JSON.stringify(forbiddenOids)}.includes(a[a.length-1])) process.exit(91); const r=spawnSync(${JSON.stringify(realGit)},a,{stdio:'inherit'});process.exit(r.status ?? 1);\n`, 0o755);
  write(path.join(bin, 'docker'), `#!/usr/bin/env node
const fs=require('fs'),path=require('path'); const a=process.argv.slice(2);
if(process.env.TEST_DOCKER_HANG){ if(process.env.TEST_DOCKER_IGNORE_TERM)process.on('SIGTERM',()=>{});fs.writeFileSync(process.env.TEST_CAPTURE,'hanging'); setInterval(()=>{},1000); }
else if(a[0]==='build') { const context=a[a.length-1], files={}; function walk(dir,prefix=''){ for(const n of fs.readdirSync(dir)){ const p=path.join(dir,n); if(fs.statSync(p).isDirectory())walk(p,prefix+n+'/'); else files[prefix+n]=fs.readFileSync(p,'utf8'); }} walk(context); fs.writeFileSync(process.env.TEST_CAPTURE,JSON.stringify({args:a,files})); process.exit(process.env.TEST_DOCKER_FAIL ? 9 : 0); }
else { fs.appendFileSync(process.env.TEST_CAPTURE,'\\npush'); }
`, 0o755);
  // 对人工敏感文件加读取卫兵：若过滤发生在内容读取之后，构建会直接失败。
  const guard = path.join(root, 'read-guard.js');
  write(guard, `const fs=require('fs'); const forbidden=${JSON.stringify(blocked.map(name => path.join(repo, name)).concat(path.join(root, 'outside.js')))}; for(const method of ['readFileSync','openSync']) { const original=fs[method]; fs[method]=function(file,...args){if(typeof file==='string' && forbidden.includes(file))throw new Error('人工敏感文件被读取');return original.call(this,file,...args);}; }`);
  const guarded = { NODE_OPTIONS: `--require=${guard}` };
  const dry = build('--worktree', ['--dry-run'], guarded);
  assert.strictEqual(dry.status, 0, dry.stderr);
  assert(dry.stdout.includes('不完全对应某一提交'));
  assert(!fs.existsSync(capture)); cleanStage();
  let result = build('--worktree', [], guarded);
  assert.strictEqual(result.status, 0, result.stderr);
  let data = JSON.parse(fs.readFileSync(capture));
  assert(data.files.Dockerfile.includes('RUN npm --prefix web ci --include=dev'));
  assert.strictEqual(data.files['server/routes/auth.js'], 'uncommitted-registration');
  assert.strictEqual(data.files['web/src/views/UncommittedRegister.vue'], 'untracked-registration');
  assert(data.args.includes('linux/amd64')); assert(data.args.includes('io.ruyi.source=worktree'));
  assert(data.files['.dockerignore'].includes('**/.env*'));
  for (const [name, content] of Object.entries(data.files)) assert(!content.includes('FAKE_SECRET'), name);
  assert(!data.files['lib/linked.js']); assert(!data.files['server/linked.js']); cleanStage();
  result = build('HEAD', ['--platform', 'linux/arm64'], guarded);
  assert.strictEqual(result.status, 0, result.stderr);
  data = JSON.parse(fs.readFileSync(capture));
  assert.strictEqual(data.files['server/routes/auth.js'], 'original-auth');
  assert(!data.files['web/src/views/UncommittedRegister.vue']);
  assert(!data.files['lib/linked.js']);
  for (const content of Object.values(data.files)) assert(!content.includes('FAKE_SECRET'));
  assert(data.args.includes('linux/arm64')); cleanStage();
  result = build('HEAD', ['--push']); assert.strictEqual(result.status, 0, result.stderr);
  assert(fs.readFileSync(capture, 'utf8').endsWith('\npush')); cleanStage();
  result = build('--worktree', [], { TEST_DOCKER_FAIL: '1' }); assert.notStrictEqual(result.status, 0); cleanStage();
  for (const extra of [['--wat'], ['--platform'], ['--platform', 'linux/x64'], ['--dry-run', '--dry-run'], ['--push', '--push']]) {
    assert.notStrictEqual(build('--worktree', extra).status, 0); cleanStage();
  }
  assert.notStrictEqual(build('--invalid').status, 0);
  const invalidImage = spawnSync('bash', [path.join(deploy, 'scripts/build-image.sh'), repo, 'HEAD', '-t'], { env });
  assert.notStrictEqual(invalidImage.status, 0);
  const replacing = path.join(root, 'replace-parent.js');
  write(replacing, `const fs=require('fs');const original=fs.mkdtempSync;fs.mkdtempSync=function(...args){const result=original.apply(this,args);fs.renameSync(${JSON.stringify(path.join(repo, 'lib'))},${JSON.stringify(path.join(repo, 'saved-lib'))});fs.symlinkSync(${JSON.stringify(root)},${JSON.stringify(path.join(repo, 'lib'))});return result;};`);
  result = build('--worktree', [], { NODE_OPTIONS: `--require=${replacing}` });
  assert.notStrictEqual(result.status, 0); cleanStage();
  fs.unlinkSync(path.join(repo, 'lib')); fs.renameSync(path.join(repo, 'saved-lib'), path.join(repo, 'lib'));
  fs.writeFileSync(capture, '');
  const interrupted = spawn('bash', [path.join(deploy, 'scripts/build-image.sh'), repo, '--worktree', 'ruyi-upload:offline'], { env: { ...env, TEST_DOCKER_HANG: '1' }, stdio: 'ignore' });
  const interruptedExit = new Promise(resolve => interrupted.once('exit', resolve));
  await until(() => fs.readFileSync(capture, 'utf8') === 'hanging', '假 Docker 未启动');
  interrupted.kill('SIGTERM'); assert.strictEqual(await interruptedExit, 143); cleanStage();
  fs.writeFileSync(capture, '');
  const stubborn = spawn('bash', [path.join(deploy, 'scripts/build-image.sh'), repo, '--worktree', 'ruyi-upload:offline'], { env: { ...env, TEST_DOCKER_HANG: '1', TEST_DOCKER_IGNORE_TERM: '1' }, stdio: 'ignore' });
  const stubbornExit = new Promise(resolve => stubborn.once('exit', resolve));
  await until(() => fs.readFileSync(capture, 'utf8') === 'hanging', '假 Docker 未启动');
  stubborn.kill('SIGTERM'); assert.strictEqual(await stubbornExit, 143); cleanStage();

  for (const name of ['package.json', 'package-lock.json', 'web/package.json', 'web/package-lock.json', 'web/index.html', 'server/index.js']) {
    const file = path.join(repo, name), saved = path.join(root, 'missing-legacy-source');
    fs.renameSync(file, saved);
    result = build('--worktree', ['--dry-run'], guarded);
    assert.notStrictEqual(result.status, 0, `旧布局缺少 ${name} 时应失败`);
    assert(result.stderr.includes(name), result.stderr); cleanStage();
    fs.renameSync(saved, file);
    git(['update-index', '--force-remove', name]);
    const incomplete = snapshot('refs/heads/incomplete-legacy-fixture', legacyRevision);
    result = build(incomplete, ['--dry-run'], guarded);
    assert.notStrictEqual(result.status, 0, `旧 ref 缺少 ${name} 时应失败`);
    assert(result.stderr.includes(name), result.stderr); cleanStage();
    git(['add', name]);
  }

  const workspaceSource = {
    'apps/web/package.json': '{"name":"@ruyi/web"}',
    'apps/server/package.json': '{"name":"@ruyi/server"}',
    'apps/worker/package.json': '{"name":"@ruyi/worker"}',
    'packages/automation/package.json': '{"name":"@ruyi/automation"}',
    'packages/shared/package.json': '{"name":"@ruyi/shared"}',
    'apps/web/index.html': '<html>workspace</html>', 'apps/web/vite.config.js': 'workspace-vite',
    'apps/web/src/main.js': 'workspace-web', 'apps/server/src/main.js': 'workspace-server',
    'apps/worker/src/main.js': 'workspace-worker', 'apps/server/src/modules/auth/routes.js': 'workspace-auth',
    'packages/automation/upload.js': 'workspace-automation', 'packages/automation/lib/browser.js': 'workspace-browser',
    'packages/shared/config.js': 'workspace-config', 'packages/shared/paths.js': 'workspace-paths',
    'packages/shared/runtime/repos/jobs.js': 'workspace-jobs', 'db/index.js': 'workspace-db',
    'apps/web/.env.local': 'FAKE_SECRET', 'apps/web/dist/app.js': 'FAKE_SECRET',
    'apps/web/package-lock.json': 'FAKE_SECRET', 'apps/worker/node_modules/module.js': 'FAKE_SECRET',
    'apps/server/src/.env.js': 'FAKE_SECRET', 'apps/server/src/user.state.json.js': 'FAKE_SECRET',
    'packages/shared/runtime/data/users.js': 'FAKE_SECRET', 'packages/shared/runtime/cache/session.js': 'FAKE_SECRET',
    'packages/automation/lib/ruyi-profile/session.js': 'FAKE_SECRET', 'packages/automation/lib/upload/data.js': 'FAKE_SECRET',
    'packages/automation/lib/state-test.json.js': 'FAKE_SECRET', 'packages/unknown/lib/app.js': 'FAKE_SECRET',
    'apps/unknown/package.json': 'FAKE_SECRET', 'packages/automation/test/fixture.js': 'FAKE_SECRET',
  };
  for (const [name, content] of Object.entries(workspaceSource)) write(path.join(repo, name), content);
  fs.symlinkSync(path.join(root, 'outside.js'), path.join(repo, 'apps/server/src/linked.js'));
  write(path.join(root, 'external/safe.js'), 'FAKE_SECRET');
  fs.symlinkSync(path.join(root, 'external'), path.join(repo, 'packages/automation/lib/external'));
  git(['add', '.']);
  const workspaceRevision = snapshot('refs/heads/workspace-fixture', legacyRevision);
  const workspaceBlocked = Object.keys(workspaceSource).filter(name => !allowed(name));
  write(guard, `const fs=require('fs'); const forbidden=${JSON.stringify(blocked.concat(workspaceBlocked).map(name => path.join(repo, name)).concat(path.join(root, 'outside.js'), path.join(root, 'external/safe.js')))}; for(const method of ['readFileSync','openSync']) { const original=fs[method]; fs[method]=function(file,...args){if(typeof file==='string' && forbidden.includes(file))throw new Error('人工敏感文件被读取');return original.call(this,file,...args);}; }`);
  write(path.join(repo, 'apps/server/src/modules/auth/routes.js'), 'workspace-uncommitted-auth');
  write(path.join(repo, 'apps/web/src/NewView.vue'), 'workspace-untracked-view');
  result = build('--worktree', ['--dry-run'], guarded);
  assert.strictEqual(result.status, 0, result.stderr);
  assert(result.stdout.includes('源码布局：workspace'));
  assert(result.stdout.includes('Dockerfile.workspace')); cleanStage();
  result = build('--worktree', [], guarded);
  assert.strictEqual(result.status, 0, result.stderr);
  data = JSON.parse(fs.readFileSync(capture));
  assert.strictEqual(data.files['apps/server/src/modules/auth/routes.js'], 'workspace-uncommitted-auth');
  assert.strictEqual(data.files['apps/web/src/NewView.vue'], 'workspace-untracked-view');
  assert(data.files.Dockerfile.includes('COPY apps/web/package.json ./apps/web/'));
  assert(!data.files.Dockerfile.includes('web/package-lock.json'));
  assert(data.files['.dockerignore'].includes('**/dist'));
  for (const name of ['server/index.js', 'web/package.json', 'lib/safe.js', 'apps/server/src/linked.js', 'packages/automation/lib/external/safe.js', ...workspaceBlocked]) assert(!data.files[name], name);
  for (const [name, content] of Object.entries(data.files)) assert(!content.includes('FAKE_SECRET'), name);
  cleanStage();
  result = build(workspaceRevision, [], guarded);
  assert.strictEqual(result.status, 0, result.stderr);
  data = JSON.parse(fs.readFileSync(capture));
  assert.strictEqual(data.files['apps/server/src/modules/auth/routes.js'], 'workspace-auth');
  assert(!data.files['apps/web/src/NewView.vue']);
  assert(!data.files['apps/server/src/linked.js']);
  assert(!data.files['packages/automation/lib/external']);
  for (const content of Object.values(data.files)) assert(!content.includes('FAKE_SECRET'));
  cleanStage();
  // 当前工作区已是新布局，仍应按旧 ref 的清单选择 legacy Dockerfile。
  result = build(legacyRevision, [], guarded);
  assert.strictEqual(result.status, 0, result.stderr);
  assert(result.stdout.includes('源码布局：legacy'));
  data = JSON.parse(fs.readFileSync(capture));
  assert(data.files.Dockerfile.includes('RUN npm --prefix web ci --include=dev'));
  assert(!data.files['apps/server/src/main.js']); cleanStage();
  for (const name of ['package.json', 'package-lock.json', 'apps/web/package.json', 'apps/server/package.json',
    'apps/worker/package.json', 'packages/automation/package.json', 'packages/shared/package.json',
    'apps/server/src/main.js', 'apps/worker/src/main.js', 'apps/web/src/main.js', 'apps/web/index.html', 'apps/web/vite.config.js',
    'packages/automation/lib/browser.js', 'packages/shared/config.js']) {
    const file = path.join(repo, name), saved = path.join(root, 'missing-source');
    fs.renameSync(file, saved);
    result = build('--worktree', ['--dry-run'], guarded);
    assert.notStrictEqual(result.status, 0, `缺少 ${name} 时应失败`);
    assert(result.stderr.includes(name), result.stderr); cleanStage();
    fs.renameSync(saved, file);
    git(['update-index', '--force-remove', name]);
    const incomplete = snapshot('refs/heads/incomplete-fixture', workspaceRevision);
    result = build(incomplete, ['--dry-run'], guarded);
    assert.notStrictEqual(result.status, 0, `ref 缺少 ${name} 时应失败`);
    assert(result.stderr.includes(name), result.stderr); cleanStage();
    git(['add', name]);
  }
  const browser = path.join(repo, 'packages/automation/lib/browser.js');
  fs.renameSync(browser, path.join(root, 'browser-source'));
  fs.symlinkSync(path.join(root, 'outside.js'), browser);
  result = build('--worktree', ['--dry-run'], guarded);
  assert.notStrictEqual(result.status, 0, '不能用符号链接满足必需源码'); cleanStage();
  fs.unlinkSync(browser); fs.renameSync(path.join(root, 'browser-source'), browser);
  const replaceWorkspace = path.join(root, 'replace-workspace-parent.js');
  write(replaceWorkspace, `const fs=require('fs');const original=fs.mkdtempSync;fs.mkdtempSync=function(...args){const result=original.apply(this,args);fs.renameSync(${JSON.stringify(path.join(repo, 'packages/shared/runtime'))},${JSON.stringify(path.join(repo, 'saved-runtime'))});fs.symlinkSync(${JSON.stringify(root)},${JSON.stringify(path.join(repo, 'packages/shared/runtime'))});return result;};`);
  result = build('--worktree', [], { NODE_OPTIONS: `--require=${replaceWorkspace}` });
  assert.notStrictEqual(result.status, 0); cleanStage();
  fs.unlinkSync(path.join(repo, 'packages/shared/runtime')); fs.renameSync(path.join(repo, 'saved-runtime'), path.join(repo, 'packages/shared/runtime'));

  write(path.join(bin, 'setsid'), '#!/usr/bin/env python3\nimport os,sys\nos.setsid()\nos.execvp(sys.argv[1],sys.argv[1:])\n', 0o755);
  write(path.join(bin, 'xdpyinfo'), '#!/usr/bin/env bash\n[[ ${TEST_FAIL:-} != x-ready ]]\n', 0o755);
  const service = `#!/usr/bin/env node
const fs=require('fs'),path=require('path'),{spawn}=require('child_process'); const name=path.basename(process.argv[1]); const log=s=>fs.appendFileSync(process.env.TEST_LOG,s+'\\n'); log(name+'-start '+process.pid);
if(name==='npm'){ const child=spawn(process.execPath,[path.join(path.dirname(process.argv[1]),'fake-node')],{stdio:'inherit'}); process.on('SIGTERM',()=>process.exit(0));process.on('SIGINT',()=>process.exit(0)); child.on('exit',()=>process.exit(0)); }
else {process.on('SIGTERM',()=>setTimeout(()=>{log(name+'-stopped');process.exit(0);},name==='fake-node'?350:0));process.on('SIGINT',()=>process.emit('SIGTERM'));}
if(name==='fake-node')log('node-start');
if(process.env.TEST_FAIL===name)setTimeout(()=>process.exit(7),500);
if(process.env.TEST_FAIL==='npm-zero' && name==='npm')setTimeout(()=>process.exit(0),500);
setInterval(()=>{},1000);
`;
  for (const name of ['Xvfb', 'openbox', 'x11vnc', 'npm', 'fake-node']) write(path.join(bin, name), service, 0o755);
  // 日志名称保持 node-stopped，便于核验 npm 先退出后 Node 仍有优雅关闭机会。
  write(path.join(bin, 'fake-node'), service.replace("log(name+'-stopped')", "log('node-stopped')"), 0o755);
  await desktop(null, 'SIGTERM');
  await desktop(null, 'SIGINT');
  await desktop('openbox');
  await desktop('Xvfb');
  await desktop('x11vnc');
  await desktop('npm');
  await desktop('npm-zero');
  await desktop('x-ready');
  console.log('离线容器准备测试通过：新旧布局及工作区/ref、必需源码、路径和敏感数据过滤、参数、清理、信号与必需服务失败');
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => fs.rmSync(root, { recursive: true, force: true }));
