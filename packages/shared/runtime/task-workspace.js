const fs = require('node:fs/promises');
const path = require('node:path');
const { constants } = require('node:fs');
const { resolveWorkspace } = require('./workspace');

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;

async function secureDirectory(folder) {
  try { await fs.mkdir(folder, { mode: 0o700 }); } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
  const stat = await fs.lstat(folder);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('任务工作区目录不安全，请联系管理员');
}

async function taskDirectories(user, root, id) {
  if (!UUID.test(id)) throw new Error('任务编号无效');
  const workspace = resolveWorkspace(user, root);
  const base = path.resolve(root);
  await secureDirectory(base);
  await secureDirectory(path.join(base, 'users'));
  await secureDirectory(workspace);
  const tasks = path.join(workspace, 'tasks');
  await secureDirectory(tasks);
  return { tasks, user, root, incoming: path.join(tasks, `.incoming-${id}`), target: path.join(tasks, id) };
}

async function createIncomingWorkspace(user, root, id) {
  const dirs = await taskDirectories(user, root, id);
  await fs.mkdir(dirs.incoming, { mode: 0o700 });
  await fs.mkdir(path.join(dirs.incoming, 'raw'), { mode: 0o700 });
  return dirs;
}

async function createIncomingFile(dirs, sequence, fileId, extension) {
  if (!UUID.test(fileId) || !Number.isSafeInteger(sequence) || sequence < 1 || !/^\.(txt|csv)$/i.test(extension)) {
    throw new Error('任务文件路径无效');
  }
  await assertParents(dirs);
  await assertDirectory(dirs.incoming);
  await assertDirectory(path.join(dirs.incoming, 'raw'));
  const folder = path.join(dirs.incoming, 'raw', String(sequence));
  await fs.mkdir(folder, { mode: 0o700 });
  const relative = `raw/${sequence}/${fileId}${extension.toLowerCase()}`;
  const handle = await fs.open(path.join(dirs.incoming, relative), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  return { handle, relative };
}

async function assertDirectory(folder) {
  const stat = await fs.lstat(folder);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('任务工作区目录不安全，请联系管理员');
}

async function assertParents(dirs) {
  const base = path.resolve(dirs.root);
  const userWorkspace = resolveWorkspace(dirs.user, dirs.root);
  for (const folder of [base, path.join(base, 'users'), userWorkspace, dirs.tasks]) await assertDirectory(folder);
}

async function publishWorkspace(dirs) {
  await assertParents(dirs);
  await assertDirectory(dirs.incoming);
  // UUID 目录不得被已有数据覆盖，失败目录留在隔离区，不参与任何调度。
  try { await fs.lstat(dirs.target); } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    await fs.rename(dirs.incoming, dirs.target);
    return;
  }
  throw new Error('任务工作区已存在，请重新创建任务');
}

module.exports = { UUID, createIncomingWorkspace, createIncomingFile, publishWorkspace };
