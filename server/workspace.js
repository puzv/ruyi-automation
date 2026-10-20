const fs = require('node:fs')
const path = require('node:path')
const { uploadRoot } = require('../config')

// multipart 的文件名在不同浏览器/版本中可能按 latin1 传入，
// 例如 UTF-8 的“测试”会先变成“æµ‹è¯•”。写入磁盘前统一还原为 UTF-8。
function decodeUploadedFileName(value) {
  let name = String(value || '')
  try {
    if (/%[0-9a-f]{2}/i.test(name)) name = decodeURIComponent(name)
  } catch (_) {
    // 文件名不是合法的百分号编码时，继续按原值处理。
  }

  // 优先保留浏览器传来的原始 Unicode 文件名。只有确认存在典型的
  // Latin-1 -> UTF-8 乱码特征时才尝试修复，避免误伤合法的 é、æ 等字符。
  const hasMojibakeMarker = (text) => (
    text.includes('\ufffd')
    || /[\u0080-\u009f]/.test(text)
    || /(?:Ã|Â|Ð|Ñ|â|ð|æ|å|è|ç)[\u0080-\u00bf]/.test(text)
  )

  if (hasMojibakeMarker(name)) {
    try {
      const decoded = Buffer.from(name, 'latin1').toString('utf8')
      // 仅接受有效 UTF-8 解码结果，且结果确实减少了乱码特征。
      if (decoded && !decoded.includes('\ufffd') && hasMojibakeMarker(name) && !hasMojibakeMarker(decoded)) {
        name = decoded
      }
    } catch (_) {
      // 无法转换时保留原文件名，避免导入失败。
    }
  }

  // macOS 常见 NFD，平台和 Node 字符串通常使用 NFC；统一后再落盘和比较。
  return name.normalize('NFC')
}

function statEntry(filePath) {
  try { return fs.lstatSync(filePath) } catch (error) {
    if (error.code === 'ENOENT') return null
    if (error.code) throw new Error('无法读取工作区，请联系管理员')
    throw error
  }
}

function checkDirectory(folder) {
  const entry = statEntry(folder)
  if (entry && (!entry.isDirectory() || entry.isSymbolicLink())) throw new Error('工作区目录不安全，请联系管理员')
}

function resolveWorkspace(user, root = uploadRoot) {
  const base = path.resolve(root)
  checkDirectory(base)
  if (!user) return base
  if (typeof user.username !== 'string' || !/^[a-z0-9_]{3,32}$/.test(user.username)) throw new Error('用户工作区无效')
  const users = path.join(base, 'users')
  const workspace = path.join(users, user.username)
  checkDirectory(users)
  checkDirectory(workspace)
  return workspace
}

function ensureWorkspace(workspace) {
  try {
    checkDirectory(workspace)
    fs.mkdirSync(workspace, { recursive: true })
    for (const folder of ['raw', 'idfa', 'oaid', 'pn', 'result']) {
      const target = path.join(workspace, folder)
      checkDirectory(target)
      fs.mkdirSync(target, { recursive: true })
    }
  } catch (error) {
    if (error.code) throw new Error('无法创建工作区目录，请联系管理员')
    throw error
  }
  return workspace
}

function isTaskFile(workspace, fileName) {
  const entry = statEntry(path.join(workspace, fileName))
  return entry?.isFile() && !entry.isSymbolicLink()
}

function readTaskCount(fileName, workspace = uploadRoot) {
  const filePath = path.join(workspace, fileName)
  if (!isTaskFile(workspace, fileName)) return 0
  try {
    const value = JSON.parse(fs.readFileSync(filePath, 'utf8') || '[]')
    return Array.isArray(value) ? value.filter((item) => typeof item === 'string').length : 0
  } catch (_) { return 0 }
}

function readTaskItems(fileNames, workspace = uploadRoot) {
  const existing = fileNames.find((fileName) => isTaskFile(workspace, fileName))
  if (!existing) return []
  try {
    const value = JSON.parse(fs.readFileSync(path.join(workspace, existing), 'utf8') || '[]')
    return Array.isArray(value) ? value.filter((item) => typeof item === 'string') : []
  } catch (_) { return [] }
}

function readFirstTaskCount(fileNames, workspace = uploadRoot) {
  const existing = fileNames.find((fileName) => isTaskFile(workspace, fileName))
  return existing ? readTaskCount(existing, workspace) : 0
}

function countPendingFiles(folder, type, recursive) {
  const entry = statEntry(folder)
  if (!entry?.isDirectory() || entry.isSymbolicLink()) return 0
  let count = 0
  let names
  try { names = fs.readdirSync(folder) } catch (error) {
    if (error.code) throw new Error('无法读取工作区，请联系管理员')
    throw error
  }
  for (const name of names) {
    if (name.startsWith('.') || name === 'done') continue
    const file = path.join(folder, name)
    const info = statEntry(file)
    if (!info || info.isSymbolicLink()) continue
    if (recursive && info.isDirectory()) count += countPendingFiles(file, type, true)
    else if (info.isFile() && (type !== 'raw' || /(?:idfa|oaid|pn)/i.test(name))) count += 1
  }
  return count
}

function getWorkspaceStatus(workspace = uploadRoot) {
  // Uploads move from raw/ into idfa/, oaid/ or pn/ before the browser step. Count
  // both locations so the queue reflects files that are still uploadable;
  // files under */done are already complete and must not be included.
  const pendingUploadCount = ['raw', 'idfa', 'oaid', 'pn'].reduce((count, folderName) => {
    return count + countPendingFiles(path.join(workspace, folderName), folderName, folderName === 'raw')
  }, 0)
  const createNames = readTaskItems(['createGroupToDoList.json', 'creategrouptodolist.json'], workspace)
  const createCount = readFirstTaskCount(['createGroupToDoList.json', 'creategrouptodolist.json'], workspace)
  const analyseCount = readTaskCount('analyseToDoList.json', workspace)
  const doneCount = readTaskCount('done.json', workspace)
  const workspaceStatus = createCount > 0 ? '等待创建人群包' : analyseCount > 0 ? '等待洞悉人群包' : doneCount > 0 ? '等待下载' : '等待操作'
  return { workspaceStatus, rawCount: pendingUploadCount, createCount, createNames, analyseCount, doneCount }
}

function withoutExtension(name) { return path.basename(name).replace(/\.[^.]+$/, '') }

module.exports = { decodeUploadedFileName, resolveWorkspace, ensureWorkspace, readTaskCount, readTaskItems, readFirstTaskCount, getWorkspaceStatus, withoutExtension }
