const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawn } = require('child_process');

function fail(message) { throw new Error(message); }
function parse(args) {
  if (args.length < 3) fail('用法: build-image.sh <应用仓库> <Git引用|--worktree> <镜像名> [--platform linux/amd64] [--dry-run] [--push]');
  const [repo, source, image, ...rest] = args;
  const options = { repo: path.resolve(repo), source, image, platform: 'linux/amd64', dry: false, push: false };
  if (!/^(?:[a-z0-9]+(?:[._-][a-z0-9]+)*(?::[0-9]+)?\/)*(?:[a-z0-9]+(?:[._-][a-z0-9]+)*)(?::[A-Za-z0-9_][A-Za-z0-9_.-]{0,127})?$/.test(image)) fail('镜像名称无效');
  if (!source || (source.startsWith('-') && source !== '--worktree')) fail('源码模式无效');
  const seen = new Set();
  for (let i = 0; i < rest.length; i++) {
    const flag = rest[i];
    if (seen.has(flag)) fail('不能重复指定参数');
    seen.add(flag);
    if (flag === '--dry-run') options.dry = true;
    else if (flag === '--push') options.push = true;
    else if (flag === '--platform') {
      options.platform = rest[++i];
      if (!['linux/amd64', 'linux/arm64'].includes(options.platform)) fail('架构仅支持 linux/amd64 或 linux/arm64');
    } else fail('存在未知参数');
  }
  return options;
}

// 只允许应用源码；先过滤名字，之后才允许 lstat 或读取对应文件/blob。
const commonFiles = new Set(['package.json', 'package-lock.json']);
const legacyFiles = new Set(['config.js', 'move.js', 'upload.js', 'uploadAll.js', 'createGroup.js', 'createAllGroup.js', 'analyse.js', 'analyseAll.js', 'download.js', 'downloadAll.js']);
function allowed(name, layout) {
  const parts = name.split('/');
  if (name.includes('\\') || parts.some(part => !part || part === '.' || part === '..' || part.startsWith('.') || /^(?:upload|ruyi-profile|node_modules|dist|artifacts|logs?|tmp|temp|data|cache|caches)$/i.test(part))) return false;
  if (parts.some(part => /^(?:state-test\.json|.*\.state\.json)/i.test(part) || /(?:\.log(?:\.|$)|\.tmp(?:\.|$)|\.bak(?:\.|$)|~$)/i.test(part))) return false;
  if (commonFiles.has(name) || /^(?:db|scripts)\/.+\.js$/.test(name)) return true;
  if (layout !== 'workspace' && (legacyFiles.has(name) || /^(?:lib|server)\/.+\.js$/.test(name) || /^web\/(?:package(?:-lock)?\.json|index\.html|vite\.config\.js|src\/.+\.(?:js|vue|css|svg|png|jpe?g|webp|woff2?))$/.test(name))) return true;
  if (layout === 'legacy') return false;
  if (/^(?:apps\/(?:web|server|worker)|packages\/(?:automation|shared))\/package\.json$/.test(name)) return true;
  if (/^apps\/(?:server|worker)\/src\/.+\.js$/.test(name)) return true;
  if (/^packages\/automation\/(?:[^/]+\.js|lib\/.+\.js)$/.test(name)) return true;
  if (/^packages\/shared\/(?:[^/]+\.js|runtime\/.+\.js)$/.test(name)) return true;
  return /^apps\/web\/(?:index\.html|vite\.config\.js|src\/.+\.(?:js|vue|css|svg|png|jpe?g|webp|woff2?))$/.test(name);
}
function prepare(selected) {
  // 布局只依据所选 ref/工作区的安全路径判断，不读取当前分支或 manifest 内容。
  const layout = selected.files.some(file => /^(?:apps|packages)\//.test(file.name)) ? 'workspace' : 'legacy';
  const files = selected.files.filter(file => allowed(file.name, layout));
  const names = new Set(files.map(file => file.name));
  const required = ['package.json', 'package-lock.json', ...(layout === 'workspace' ? [
    'apps/web/package.json', 'apps/server/package.json', 'apps/worker/package.json',
    'packages/automation/package.json', 'packages/shared/package.json',
    'apps/server/src/main.js', 'apps/worker/src/main.js', 'apps/web/src/main.js', 'apps/web/index.html', 'apps/web/vite.config.js',
    'packages/automation/lib/browser.js', 'packages/shared/config.js',
  ] : ['web/package.json', 'web/package-lock.json', 'web/index.html', 'server/index.js'])];
  const missing = required.filter(name => !names.has(name));
  if (missing.length) fail(`缺少必要的构建源码：${missing.join('、')}`);
  return { ...selected, files, layout, dockerfile: layout === 'workspace' ? 'Dockerfile.workspace' : 'Dockerfile' };
}
function git(repo, args) {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
}
function select(options) {
  if (fs.lstatSync(options.repo).isSymbolicLink()) fail('应用仓库目录不能是符号链接');
  options.repo = fs.realpathSync(options.repo);
  let revision;
  try { revision = git(options.repo, ['rev-parse', '--verify', `${options.source === '--worktree' ? 'HEAD' : options.source}^{commit}`]).trim(); }
  catch { fail('无法解析应用仓库的 Git 提交'); }
  if (options.source !== '--worktree') {
    const metadata = git(options.repo, ['ls-tree', '-r', '-z', '--full-tree', revision]);
    const files = metadata.split('\0').filter(Boolean).map(record => {
      const tab = record.indexOf('\t');
      const [mode, type, oid] = record.slice(0, tab).split(' ');
      return { name: record.slice(tab + 1), mode, type, oid };
    }).filter(file => allowed(file.name) && file.type === 'blob' && /^100(?:644|755)$/.test(file.mode));
    return { revision, files };
  }
  const names = [...new Set(git(options.repo, ['ls-files', '-z', '--cached', '--others', '--exclude-standard']).split('\0').filter(name => allowed(name)))];
  const files = [];
  for (const name of names) {
    let current = options.repo;
    let stat;
    try {
      for (const part of name.split('/')) {
        current = path.join(current, part);
        stat = fs.lstatSync(current);
        if (stat.isSymbolicLink()) { stat = null; break; }
      }
    } catch (error) {
      if (error.code === 'ENOENT' || error.code === 'ENOTDIR') continue;
      fail('检查源码文件失败');
    }
    if (stat && stat.isFile()) files.push({ name, mode: stat.mode & 0o111 ? '100755' : '100644' });
  }
  return { revision, files };
}

const dockerignore = `**/.env*\n**/state-test.json*\n**/*.state.json*\n**/ruyi-profile\n**/upload\n**/node_modules\n**/dist\n**/data\n**/cache\n**/caches\n**/.git\n**/artifacts\n**/.vscode\n**/*.log*\n**/*.tmp*\n**/*.bak*\n`;
async function main() {
  const options = parse(process.argv.slice(2));
  const selected = prepare(select(options));
  const worktree = options.source === '--worktree';
  console.log(`源码方式：${worktree ? '工作区（包含未提交修改，不完全对应某一提交）' : '固定提交'}`);
  console.log(`版本来源：${selected.revision}${worktree ? ' + 工作区' : ''}`);
  console.log(`源码布局：${selected.layout}；构建配置：${selected.dockerfile}`);
  console.log(`构建架构：${options.platform}；非敏感源文件数：${selected.files.length}`);
  console.log(`执行方式：${options.dry ? '仅预览，不读取源码内容或构建' : '本地构建'}；推送：${options.push ? '显式启用' : '关闭'}`);
  if (options.dry) return;

  const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-build-'));
  let child;
  let interrupted = false;
  const cleanup = () => fs.rmSync(stage, { recursive: true, force: true });
  const onSignal = signal => {
    interrupted = true;
    process.exitCode = signal === 'SIGINT' ? 130 : 143;
    if (child) {
      const running = child;
      running.kill(signal);
      const deadline = setTimeout(() => { if (child === running) running.kill('SIGKILL'); }, 3000);
      deadline.unref();
    }
  };
  const onTerm = () => onSignal('SIGTERM');
  const onInt = () => onSignal('SIGINT');
  process.on('SIGTERM', onTerm);
  process.on('SIGINT', onInt);
  const runDocker = args => new Promise((resolve, reject) => {
    if (interrupted) return reject(new Error('构建已中止'));
    child = spawn('docker', args, { stdio: 'inherit' });
    child.once('error', () => { child = null; reject(new Error('无法执行 Docker 命令')); });
    child.once('exit', code => {
      child = null;
      if (interrupted) reject(new Error('构建已中止'));
      else if (code !== 0) reject(new Error('Docker 命令执行失败'));
      else resolve();
    });
  });
  try {
    for (const file of selected.files) {
      const target = path.join(stage, file.name);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      if (worktree) {
        // 再检查完整父链，拒绝选择之后被替换的路径；末级再由 O_NOFOLLOW 保护。
        let source = options.repo;
        for (const part of file.name.split('/')) {
          source = path.join(source, part);
          if (fs.lstatSync(source).isSymbolicLink()) fail('源码路径已变为符号链接');
        }
        const fd = fs.openSync(source, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
        try {
          if (!fs.fstatSync(fd).isFile()) fail('源码必须是普通文件');
          fs.writeFileSync(target, fs.readFileSync(fd));
        } finally { fs.closeSync(fd); }
      } else {
        const content = execFileSync('git', ['-C', options.repo, 'cat-file', 'blob', file.oid], { maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
        fs.writeFileSync(target, content);
      }
      fs.chmodSync(target, file.mode === '100755' ? 0o755 : 0o644);
    }
    fs.mkdirSync(path.join(stage, 'scripts'), { recursive: true });
    fs.copyFileSync(path.join(__dirname, '..', selected.dockerfile), path.join(stage, 'Dockerfile'));
    fs.copyFileSync(path.join(__dirname, 'start-desktop.sh'), path.join(stage, 'scripts', 'start-desktop.sh'));
    fs.writeFileSync(path.join(stage, '.dockerignore'), dockerignore);
    await runDocker(['build', '--platform', options.platform, '--label', `org.opencontainers.image.revision=${selected.revision}`, '--label', `io.ruyi.source=${worktree ? 'worktree' : 'commit'}`, '-t', options.image, stage]);
    console.log('本地镜像构建完成');
    if (options.push) { await runDocker(['push', options.image]); console.log('镜像推送完成'); }
  } finally {
    cleanup();
    process.removeListener('SIGTERM', onTerm);
    process.removeListener('SIGINT', onInt);
  }
}
if (require.main === module) main().catch(error => { console.error(error.code || error.message.startsWith('Command failed:') ? '构建准备失败' : error.message); process.exitCode = process.exitCode || 1; });
module.exports = { allowed, parse, prepare };
