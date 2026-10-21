const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { projectRoot, automationRoot, webDist, jobWrapper } = require('@ruyi/shared/paths');
const { scripts } = require('@ruyi/shared/tasks');

function checkRootFromOtherDirectory() {
  const env = { ...process.env };
  for (const key of ['RUYI_UPLOAD_DIR', 'RUYI_PROFILE_DIR', 'RUYI_STATE_FILE', 'PLAYWRIGHT_BROWSERS_PATH']) delete env[key];
  const result = spawnSync(process.execPath, ['-e', `
    const config = require(${JSON.stringify(require.resolve('@ruyi/shared/config'))});
    const { bundledBrowsersPath } = require(${JSON.stringify(require.resolve('@ruyi/shared/playwright-env'))});
    process.stdout.write(JSON.stringify({ projectRoot: config.projectRoot, uploadRoot: config.uploadRoot,
      profileDir: config.profileDir, resultDir: config.resultDir, bundledBrowsersPath }));
  `], { cwd: os.tmpdir(), env, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    projectRoot, uploadRoot: path.join(projectRoot, 'upload'), profileDir: path.join(projectRoot, 'ruyi-profile'),
    resultDir: path.join(projectRoot, 'upload', 'result'), bundledBrowsersPath: path.join(projectRoot, '.playwright-browsers'),
  });
}

async function checkTaskPaths() {
  const { executeTask } = require('@ruyi/worker/src/execution');
  for (const [task, script] of Object.entries(scripts)) {
    assert.equal(path.dirname(script), automationRoot);
    assert.equal(require.resolve(`@ruyi/automation/${path.basename(script)}`), script);
    const execution = executeTask({ id: `layout-${task}`, script, headless: true,
      spawnImpl(command, args, options) {
        assert.equal(command, process.execPath);
        assert.deepEqual(args, [jobWrapper, script]);
        assert.equal(options.cwd, projectRoot);
        assert.equal(options.detached, true);
        assert.equal(options.stdio[3], 'ipc');
        const child = new EventEmitter();
        child.stdout = new PassThrough();
        child.stderr = new PassThrough();
        queueMicrotask(() => child.emit('close', 0, null));
        return child;
      },
    });
    assert.equal((await execution.completion).status, 'succeeded');
  }
  assert.equal(fs.existsSync(jobWrapper), true);
}

async function checkDefaultStaticPath() {
  const { buildApp } = require('@ruyi/server/src/app');
  const expected = path.join(webDist, 'index.html');
  const original = fs.existsSync;
  let checked = false;
  let app;
  try {
    fs.existsSync = (file) => {
      if (file === expected) { checked = true; return false; }
      return original(file);
    };
    app = buildApp({ auth: false, logger: false });
  } finally { fs.existsSync = original; }
  try {
    assert.equal(checked, true, '默认静态目录必须是 apps/web/dist');
    assert.equal((await app.inject({ method: 'GET', url: '/api/health' })).statusCode, 200);
    assert.equal((await app.inject({ method: 'GET', url: '/' })).statusCode, 503);
  } finally { await app.close(); }
}

function checkDependencyDirections() {
  const workspaces = [
    ['packages/shared', '@ruyi/shared', new Set()],
    ['packages/automation', '@ruyi/automation', new Set(['@ruyi/shared'])],
    ['apps/worker', '@ruyi/worker', new Set(['@ruyi/shared', '@ruyi/automation'])],
    ['apps/server', '@ruyi/server', new Set(['@ruyi/shared', '@ruyi/automation', '@ruyi/worker'])],
  ];
  for (const [directory, name, allowed] of workspaces) {
    const root = path.join(projectRoot, directory);
    const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    assert.equal(manifest.name, name);
    assert.equal(manifest.private, true);
    for (const dependency of Object.keys(manifest.dependencies || {})) {
      if (dependency.startsWith('@ruyi/')) assert(allowed.has(dependency), `${name} 依赖方向错误：${dependency}`);
    }
    const visit = (folder) => {
      for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
        if (entry.name === 'node_modules') continue;
        const filename = path.join(folder, entry.name);
        if (entry.isDirectory()) visit(filename);
        else if (entry.name.endsWith('.js')) {
          const source = fs.readFileSync(filename, 'utf8');
          for (const match of source.matchAll(/require\(['"]([^'"]+)['"]\)/g)) {
            const dependency = match[1];
            if (dependency.startsWith('@ruyi/')) {
              const packageName = dependency.split('/').slice(0, 2).join('/');
              assert(allowed.has(packageName), `${filename} 反向依赖 ${packageName}`);
              assert(packageName in manifest.dependencies, `${filename} 未声明依赖 ${packageName}`);
            } else if (dependency.startsWith('.')) {
              const target = path.resolve(path.dirname(filename), dependency);
              assert(target.startsWith(`${root}${path.sep}`) || target === path.join(projectRoot, 'db')
                || target.startsWith(`${path.join(projectRoot, 'db')}${path.sep}`), `${filename} 越过包边界：${dependency}`);
            }
          }
        }
      }
    };
    visit(root);
  }
}

async function main() {
  checkRootFromOtherDirectory();
  checkDependencyDirections();
  await checkTaskPaths();
  await checkDefaultStaticPath();
  console.log('Workspace 结构回归通过：根路径、任务包装器、静态目录和依赖方向');
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
