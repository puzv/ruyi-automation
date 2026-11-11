const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const { Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { decodeUploadedFileName } = require('@ruyi/shared/runtime/workspace');
const workspace = require('@ruyi/shared/runtime/task-workspace');
const tasks = require('@ruyi/shared/runtime/repos/tasks');

const LIMITS = { fileSize: 1024 * 1024 * 1024, files: 1000, fields: 1, parts: 1001, fieldSize: 1024 };

function invalid(message) { const error = new Error(message); error.taskInput = true; return error; }

function taskName(value, id) {
  if (typeof value !== 'string') throw invalid('任务名称必须是文本');
  const name = value.trim() || id;
  if (Array.from(name).length > 128 || /[\u0000-\u001f\u007f]/.test(name)) throw invalid('任务名称不得超过 128 个字符，且不能含控制字符');
  return name;
}

async function createFromMultipart(req, { db, root, canImportFiles, io = workspace, maxTotalBytes = 1024 * 1024 * 1024 }) {
  const requireLogin = async () => {
    if (!await canImportFiles(req)) {
      const error = new Error('请先完成平台登录，再创建任务');
      error.statusCode = 409; error.code = 'PLATFORM_LOGIN_REQUIRED'; throw error;
    }
  };
  await requireLogin();
  if (!req.isMultipart()) throw invalid('请选择要上传的任务文件');
  const id = randomUUID();
  let name = id, named = false, dirs, skipped = 0, totalBytes = 0;
  const countBytes = (chunk) => {
    totalBytes += chunk.length;
    if (totalBytes > maxTotalBytes) throw invalid('单个任务接收总大小不得超过 1GB（含跳过文件）');
  };
  const files = [], names = new Set(), resultStems = new Set();
  for await (const part of req.parts({ limits: LIMITS })) {
    if (!part.file) {
      if (part.fieldname !== 'name' || named || part.valueTruncated) throw invalid('任务名称字段无效或重复');
      named = true;
      name = taskName(part.value, id);
      continue;
    }
    if (part.fieldname !== 'files') throw invalid('非预期的文件字段');
    const originalName = decodeUploadedFileName(part.filename);
    if (/[\\/\u0000-\u001f\u007f]/.test(originalName) || originalName === '.' || originalName === '..') throw invalid('文件名称包含非法路径');
    // 保持旧导入类型优先级，避免包含多种关键字的名称在新旧入口分类不同。
    const type = ['pn', 'idfa', 'oaid'].find((value) => originalName.toLowerCase().includes(value));
    if (originalName.startsWith('.') || !type || !/\.(txt|csv)$/i.test(originalName)) {
      for await (const chunk of part.file) countBytes(chunk);
      if (part.file.truncated) throw invalid('单个文件大小不得超过 1GB');
      skipped++; continue;
    }
    if (Array.from(originalName).length > 255) throw invalid('文件名称不得超过 255 个字符');
    if (names.has(originalName)) throw invalid(`同一任务内存在重名文件：${originalName}`);
    const resultStem = path.basename(originalName, path.extname(originalName)).normalize('NFC');
    if (resultStems.has(resultStem)) throw invalid(`同一任务内文件主名称重复，下载结果会重名：${originalName}`);
    names.add(originalName);
    resultStems.add(resultStem);
    if (!dirs) dirs = await io.createIncomingWorkspace(req.user, root, id);
    const fileId = randomUUID(), sequence = files.length + 1;
    const { handle, relative } = await io.createIncomingFile(dirs, sequence, fileId, path.extname(originalName));
    let sizeBytes = 0;
    const hash = createHash('sha256');
    try {
      const meter = new Transform({ transform(chunk, _encoding, callback) {
        sizeBytes += chunk.length;
        try { countBytes(chunk); } catch (error) { return callback(error); }
        hash.update(chunk); callback(null, chunk);
      } });
      await pipeline(part.file, meter, handle.createWriteStream());
      if (part.file.truncated) throw invalid('单个文件大小不得超过 1GB');
    } finally { await handle.close(); }
    files.push({ id: fileId, sequence, originalName, fileType: type, sizeBytes, sha256: hash.digest('hex'), relative });
  }
  if (!files.length) throw invalid('没有可导入的文件，请选择名称包含 idfa、oaid 或 pn 的 txt/csv 文件');
  await requireLogin();
  await io.publishWorkspace(dirs);
  await tasks.createTask(db, { id, userId: req.user.id, name, files });
  req.auditTask = { id, name, count: files.length, skipped, files: files.slice(0, 100).map((file) => file.originalName) };
  // 不在提交后再次读库，避免读失败让客户端误以为创建失败而重复提交。
  return { id, name, status: 'queued', currentStep: 'upload', version: 1, fileCount: files.length, skipped };
}

module.exports = { createFromMultipart, taskName, LIMITS };
