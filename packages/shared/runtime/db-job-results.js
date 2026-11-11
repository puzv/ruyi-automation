const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const repo = require('./repos/job-results');
const { filesZipStream } = require('./job-results');
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const MAX32 = 0xffffffff;

function contextFor(id, context, writing = false) {
  if (!UUID.test(id) || !context?.db || !UUID.test(context.taskId) || !context.userId
    || (writing && (!UUID.test(context.claimToken) || !UUID.test(context.taskClaimToken)))) throw new Error('结果任务上下文无效');
  return context;
}
function safePath(workspace, ...parts) {
  const root = path.resolve(workspace);
  const target = path.resolve(root, ...parts);
  if (!target.startsWith(`${root}${path.sep}`)) throw new Error('结果文件路径不安全');
  const base = path.dirname(path.dirname(root));
  let current = base;
  for (const part of ['', ...path.relative(base, target).split(path.sep)]) {
    current = path.join(current, part);
    try {
      const stat = fs.lstatSync(current);
      if (stat.isSymbolicLink() || (current !== target && !stat.isDirectory())) throw new Error('结果文件路径不安全');
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return target;
}
function checkName(name) {
  if (typeof name !== 'string' || !name || name === '.' || name === '..' || /[\\/\x00-\x1f\x7f]/.test(name)
    || [...name].length > 255 || Buffer.byteLength(name) > 1020) throw new Error('结果文件名无效');
}
function targetPath(workspace, id, name) {
  checkName(name);
  return safePath(workspace, 'job-results', id, 'files', name);
}
async function beginResults(workspace, id, context) {
  contextFor(id, context, true);
  const dir = safePath(workspace, 'job-results', id, 'files');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  safePath(workspace, 'job-results', id, 'files');
  await repo.createSet(context.db, id, context);
}
async function resolveResultTarget(workspace, id, name, context) {
  contextFor(id, context, true);
  const target = targetPath(workspace, id, name);
  await repo.withWriter(context.db, id, context, async (trx) => {
    await repo.writableSet(trx, id, context);
    const files = await repo.listFiles(trx, id);
    if (files.some((file) => file.name.normalize('NFC') === name.normalize('NFC'))) throw Object.assign(new Error('任务结果文件重名'), { code: 'RESULT_STATE_ERROR' });
  });
  if (fs.existsSync(target)) throw new Error('下载结果已存在，不会覆盖');
  return target;
}
async function recordResult(workspace, id, source, name = path.basename(source), context) {
  contextFor(id, context, true);
  if (!UUID.test(context.fileId)) throw new Error('结果文件编号无效');
  const target = targetPath(workspace, id, name);
  const stat = fs.lstatSync(source);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size >= MAX32) throw new Error('结果文件过大或不是普通文件，无法生成 ZIP');
  let created = false;
  try {
    await repo.addFile(context.db, id, context, { id: randomUUID(), file_id: context.fileId, name,
      name_key: Buffer.from(name.normalize('NFC')), stored_path: `files/${name}`, size_bytes: stat.size }, async () => {
      fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
      safePath(workspace, 'job-results', id, 'files', name);
      const input = fs.openSync(source, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      let output;
      try {
        const opened = fs.fstatSync(input);
        if (!opened.isFile() || opened.size !== stat.size || opened.ino !== stat.ino || opened.dev !== stat.dev) throw new Error('结果文件已变化');
        output = fs.openSync(target, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
        created = true;
        const buffer = Buffer.allocUnsafe(64 * 1024);
        let bytes, copied = 0;
        while ((bytes = fs.readSync(input, buffer, 0, buffer.length, null)) > 0) {
          copied += bytes;
          if (copied > stat.size) throw new Error('结果文件已变化');
          let written = 0;
          while (written < bytes) written += fs.writeSync(output, buffer, written, bytes - written);
        }
        if (copied !== stat.size || fs.fstatSync(input).size !== stat.size) throw new Error('结果文件不完整');
      } finally {
        fs.closeSync(input);
        if (output !== undefined) fs.closeSync(output);
      }
    });
  } catch (error) {
    // 提交回包丢失时不能假定事务回滚并删除已登记成果。
    // 仅在确认索引不存在时清理；数据库不可用则保留孤立文件供恢复核对。
    if (created) {
      try {
        const set = await repo.readSet(context.db, id, context);
        if (!set.files.some((file) => file.stored_path === `files/${name}`)) fs.unlinkSync(target);
      } catch (_) { /* 保留可能已提交的结果。 */ }
    }
    throw error;
  }
  return target;
}
async function finishResults(workspace, id, context) {
  contextFor(id, context, true);
  return repo.sealSet(context.db, id, context, true);
}
async function sealResults(workspace, id, context) {
  contextFor(id, context, true);
  return repo.sealSet(context.db, id, context, false);
}
async function resultEntries(workspace, id, context, allowUnsealed = false) {
  contextFor(id, context);
  const value = await repo.readSet(context.db, id, context);
  if ((!value.sealed_at && !allowUnsealed) || !value.files.length) throw new Error('本次任务没有可下载的结果文件');
  if (value.files.length >= 65535) throw new Error('结果文件过多，超出 ZIP 格式限制');
  const names = new Set();
  let size = 22;
  const files = value.files.map((file) => {
    checkName(file.name);
    const bytes = Number(file.size_bytes);
    const key = file.name.normalize('NFC');
    if (names.has(key) || file.stored_path !== `files/${file.name}` || !Number.isSafeInteger(bytes) || bytes < 0 || bytes >= MAX32) throw new Error('结果清单无效');
    names.add(key);
    const target = targetPath(workspace, id, file.name);
    const stat = fs.lstatSync(target);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== bytes) throw new Error('结果文件不完整');
    size += bytes + 30 + 16 + 46 + Buffer.byteLength(file.name) * 2;
    if (size >= MAX32) throw new Error('结果包超过 4GB，无法使用当前 ZIP 格式');
    return { name: file.name, stored: file.stored_path, size: bytes, path: target, fileId: file.file_id };
  });
  return { files, size };
}
async function carryResults(workspace, id, previousIds, context) {
  contextFor(id, context, true);
  const active = await repo.guarded(() => context.db.selectFrom('ruyi_task_files').select('id').where('task_id', '=', context.taskId)
    .where('user_id', '=', context.userId).where('excluded_at', 'is', null).execute());
  const activeIds = new Set(active.map((file) => file.id));
  const seen = new Set();
  for (const previousId of previousIds) {
    if (previousId === id) continue;
    let set;
    try { set = await repo.readSet(context.db, previousId, context); } catch (error) {
      if (error.code === 'RESULT_SET_NOT_FOUND') continue;
      throw error;
    }
    if (!set.files.length) continue;
    // 崩溃前已提交的记录同样可靠；旧租约不能再写，因此可在新轮次校验并复制。
    const prior = await repo.guarded(() => context.db.selectFrom('ruyi_jobs').selectAll().where('id', '=', previousId)
      .where('task_id', '=', context.taskId).where('user_id', '=', context.userId).executeTakeFirst());
    if (!prior || prior.status === 'running' || prior.status === 'queued') throw new Error('结果归档仍在执行，不能恢复');
    const entries = await resultEntries(workspace, previousId, context, true);
    for (const file of entries.files) {
      if (!activeIds.has(file.fileId) || seen.has(file.fileId)) continue;
      await recordResult(workspace, id, file.path, file.name, { ...context, fileId: file.fileId });
      seen.add(file.fileId);
    }
  }
  return seen.size;
}
function zipStream(workspace, id, entries) {
  return filesZipStream(entries.files, (file) => targetPath(workspace, id, file.name));
}
module.exports = { beginResults, resolveResultTarget, recordResult, finishResults, sealResults, resultEntries, carryResults, zipStream };
