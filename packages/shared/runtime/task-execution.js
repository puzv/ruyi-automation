const fs = require('node:fs')
const path = require('node:path')
const { randomUUID } = require('node:crypto')

function checkedFile(root, relative) {
  if (typeof relative !== 'string' || path.isAbsolute(relative) || relative.includes('\\')
    || relative.split('/').some((part) => !part || part === '.' || part === '..')) throw new Error('任务文件路径无效')
  let current = root
  for (const part of relative.split('/')) {
    current = path.join(current, part)
    if (fs.lstatSync(current).isSymbolicLink()) throw new Error('任务文件路径不安全')
  }
  if (!fs.lstatSync(current).isFile()) throw new Error('任务文件不是普通文件')
  return current
}

// 原件始终保留在任务根目录；只有执行副本交给会移动、重命名文件的自动化脚本。
function prepareTaskExecution(originalWorkspace, workspace, rows) {
  const workspaceStat = fs.lstatSync(workspace)
  if (!workspaceStat.isDirectory() || workspaceStat.isSymbolicLink()) throw new Error('任务执行目录不安全')
  for (const row of rows) {
    if (path.basename(row.original_name) !== row.original_name || /[\\\x00-\x1f]/.test(row.original_name)) throw new Error('任务文件名无效')
    // 无映射时只处理首次上传；持久化映射后路径完全由数据库决定。
    const relative = row.platform_name ? row.current_path?.replace(/^execution\//, '') : `raw/${row.original_name}`
    if (!relative || (row.platform_name && !row.current_path.startsWith('execution/'))) throw new Error('任务执行文件路径无效')
    if (path.isAbsolute(relative) || relative.includes('\\') || relative.split('/').some((p) => !p || p === '.' || p === '..')) throw new Error('任务执行文件路径无效')
    const target = path.join(workspace, relative)
    if (row.excluded_at) {
      if (fs.existsSync(target)) {
        const source = checkedFile(workspace, relative)
        const quarantine = path.join(workspace, '.excluded')
        fs.mkdirSync(quarantine, { recursive: true })
        if (fs.lstatSync(quarantine).isSymbolicLink()) throw new Error('任务排除目录不安全')
        const excludedTarget = path.join(quarantine, path.basename(target))
        if (fs.existsSync(excludedTarget)) throw new Error('任务排除文件已存在')
        fs.renameSync(source, excludedTarget)
      }
      continue
    }
    if (fs.existsSync(target)) {
      checkedFile(workspace, relative)
      if (row.size_bytes !== undefined && ['pending', 'uploading', 'empty'].includes(row.stage)
        && fs.statSync(target).size !== Number(row.size_bytes)) throw new Error('任务执行副本大小不完整，已停止上传，请联系管理员核对')
      continue
    }
    // 已上传后不再需要输入副本，不能从原件恢复并重新提交。
    if (row.stage && !['pending', 'uploading', 'empty'].includes(row.stage)) continue
    const source = checkedFile(originalWorkspace, row.original_path)
    // 检查目标所有父目录，禁止通过符号链接写出任务隔离区。
    let parent = workspace
    for (const part of relative.split('/').slice(0, -1)) {
      parent = path.join(parent, part)
      try { fs.mkdirSync(parent) } catch (error) { if (error.code !== 'EEXIST') throw error }
      const stat = fs.lstatSync(parent)
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('执行文件目录不安全')
    }
    const temporary = path.join(path.dirname(target), `.prepare-${randomUUID()}`)
    fs.copyFileSync(source, temporary, fs.constants.COPYFILE_EXCL)
    if (row.size_bytes !== undefined && fs.statSync(temporary).size !== Number(row.size_bytes)) throw new Error('原始文件大小与数据库记录不一致，已停止上传')
    // 在同一目录发布完整副本，崩溃只会留下不参与上传的临时文件。
    fs.linkSync(temporary, target)
    fs.unlinkSync(temporary)
  }
}

async function carryTaskResults(workspace, jobId, previous, context) {
  return require('./db-job-results').carryResults(workspace, jobId,
    previous.slice().reverse().filter((prior) => prior.id !== jobId && prior.task === 'download').map((prior) => prior.id), context)
}

module.exports = { prepareTaskExecution, carryTaskResults }
