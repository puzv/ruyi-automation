// 仅为本地历史整任务补建结果索引，不读取 JSON 或文件正文。
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { createDb, readDbConfig } = require('../db');
const { projectRoot } = require('../packages/shared/paths');
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const TERMINAL = ['succeeded', 'failed', 'cancelled', 'interrupted'];

function assertLocal(config) {
  if (config.host !== '127.0.0.1' || Number(config.port) !== 3306 || config.database !== 'ruyi_dev'
    || config.user !== 'ruyi') throw new Error('仅允许本机 127.0.0.1:3306 的 ruyi_dev 开发数据库');
}
function directory(root, ...parts) {
  const base = path.resolve(root), target = path.resolve(base, ...parts);
  if (target !== base && !target.startsWith(`${base}${path.sep}`)) throw new Error('历史结果路径不安全');
  let current = base;
  for (const part of ['', ...path.relative(base, target).split(path.sep)].filter((part, index) => part || index === 0)) {
    current = path.join(current, part);
    const stat = fs.lstatSync(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('历史结果目录不安全');
  }
  return target;
}
function inspectFiles(folder, files) {
  const mappings = new Map();
  for (const file of files) {
    const name = file.original_name;
    if (typeof name !== 'string' || path.basename(name) !== name || /[\\\x00-\x1f\x7f]/.test(name)) throw new Error('历史文件映射无效');
    const stem = path.basename(name, path.extname(name)).normalize('NFC');
    if (mappings.has(stem)) throw new Error('初始文件名存在同名主干，不能自动关联');
    mappings.set(stem, file);
  }
  const result = [], seen = new Set();
  for (const name of fs.readdirSync(folder)) {
    if (/[\\/\x00-\x1f\x7f]/.test(name) || [...name].length > 255 || !/\.(xlsx|xls|csv)$/i.test(name)) throw new Error('历史结果包含未知文件格式');
    const stat = fs.lstatSync(path.join(folder, name));
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0 || stat.size >= 0xffffffff) throw new Error('历史结果文件为空、过大或路径不安全');
    const file = mappings.get(path.basename(name, path.extname(name)).normalize('NFC'));
    if (!file || file.excluded_at || seen.has(file.id)) throw new Error('历史结果无法唯一关联有效任务文件');
    seen.add(file.id);
    result.push({ id: randomUUID(), file_id: file.id, name, name_key: Buffer.from(name.normalize('NFC')), stored_path: `files/${name}`, size_bytes: stat.size });
  }
  if (!result.length) throw new Error('历史结果目录为空');
  return result;
}
async function backfillTaskResults({ db, config, taskId, root, apply = false }) {
  assertLocal(config);
  if (!UUID.test(taskId)) throw new Error('必须显式提供有效的 --task-id');
  return db.transaction().execute(async (trx) => {
    const task = await trx.selectFrom('ruyi_tasks as t').innerJoin('ruyi_users as u', 'u.id', 't.user_id')
      .selectAll('t').select('u.username').where('t.id', '=', taskId).where('t.deleted_at', 'is', null).forUpdate().executeTakeFirst();
    if (!task || !TERMINAL.includes(task.status) || task.claim_token) throw new Error('只允许补建未删除、无执行租约的终态整任务');
    if (!/^[a-z0-9_]{3,32}$/.test(task.username)) throw new Error('用户工作区无效');
    const jobs = await trx.selectFrom('ruyi_jobs').selectAll().where('task_id', '=', taskId)
      .where('user_id', '=', task.user_id).where('task', '=', 'download').orderBy('queued_at').orderBy('id').forUpdate().execute();
    const files = await trx.selectFrom('ruyi_task_files').selectAll().where('task_id', '=', taskId).where('user_id', '=', task.user_id).execute();
    const plans = [];
    for (const job of jobs) {
      // 已结束的 job 保留 claim_token 用于审计；运行状态才表示持有可写租约。
      if (!TERMINAL.includes(job.status) || !UUID.test(job.id)) throw new Error('历史下载轮次仍在执行或状态无效');
      const existing = await trx.selectFrom('ruyi_task_result_sets').selectAll().where('job_id', '=', job.id).forUpdate().executeTakeFirst();
      if (existing) { plans.push({ jobId: job.id, skipped: true, reason: '数据库已有结果索引，保持原样' }); continue; }
      let folder;
      try { folder = directory(root, 'users', task.username, 'tasks', taskId, 'execution', 'job-results', job.id, 'files'); } catch (error) {
        if (error.code === 'ENOENT' && job.status !== 'succeeded') { plans.push({ jobId: job.id, skipped: true, reason: '非成功轮次无结果目录' }); continue; }
        throw error;
      }
      const entries = inspectFiles(folder, files);
      plans.push({ jobId: job.id, files: entries });
    }
    if (apply) {
      for (const plan of plans.filter((plan) => !plan.skipped)) {
        await trx.insertInto('ruyi_task_result_sets').values({ job_id: plan.jobId, task_id: taskId, user_id: task.user_id, sealed_at: new Date() }).execute();
        await trx.insertInto('ruyi_task_results').values(plan.files.map((file) => ({ ...file, job_id: plan.jobId }))).execute();
      }
    }
    return { taskId, mode: apply ? 'apply' : 'dry-run', jobs: plans.map((plan) => plan.skipped ? plan : { jobId: plan.jobId, fileCount: plan.files.length, totalBytes: plan.files.reduce((sum, file) => sum + file.size_bytes, 0) }) };
  });
}
async function main(args = process.argv.slice(2)) {
  const allowed = new Set(['--task-id', '--apply']);
  let taskId, apply = false;
  for (let index = 0; index < args.length; index++) {
    if (!allowed.has(args[index])) throw new Error('仅支持 --task-id <编号> 和可选的 --apply');
    if (args[index] === '--apply') apply = true;
    else { if (taskId) throw new Error('不能重复指定 --task-id'); taskId = args[++index]; }
  }
  if (!UUID.test(taskId)) throw new Error('必须显式提供有效的 --task-id');
  const config = readDbConfig();
  assertLocal(config);
  const db = createDb(config);
  try { console.log(JSON.stringify(await backfillTaskResults({ db, config, taskId, root: path.join(projectRoot, 'upload'), apply }), null, 2)); }
  finally { await db.destroy(); }
}
if (require.main === module) main().catch(() => { console.error('历史结果索引补建失败，未读取文件正文；请检查任务状态、目录安全和数据库迁移'); process.exitCode = 1; });
module.exports = { backfillTaskResults, assertLocal, inspectFiles, main };
