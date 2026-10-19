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

function readTaskCount(fileName) {
  const filePath = path.join(uploadRoot, fileName)
  if (!fs.existsSync(filePath)) return 0
  try {
    const value = JSON.parse(fs.readFileSync(filePath, 'utf8') || '[]')
    return Array.isArray(value) ? value.filter((item) => typeof item === 'string').length : 0
  } catch (_) { return 0 }
}

function readTaskItems(fileNames) {
  const existing = fileNames.find((fileName) => fs.existsSync(path.join(uploadRoot, fileName)))
  if (!existing) return []
  try {
    const value = JSON.parse(fs.readFileSync(path.join(uploadRoot, existing), 'utf8') || '[]')
    return Array.isArray(value) ? value.filter((item) => typeof item === 'string') : []
  } catch (_) { return [] }
}

function readFirstTaskCount(fileNames) {
  const existing = fileNames.find((fileName) => fs.existsSync(path.join(uploadRoot, fileName)))
  return existing ? readTaskCount(existing) : 0
}

function getWorkspaceStatus() {
  // Uploads move from raw/ into idfa/, oaid/ or pn/ before the browser step. Count
  // both locations so the queue reflects files that are still uploadable;
  // files under */done are already complete and must not be included.
  const pendingUploadCount = ['raw', 'idfa', 'oaid', 'pn'].reduce((count, folderName) => {
    const folder = path.join(uploadRoot, folderName)
    if (!fs.existsSync(folder)) return count
    return count + fs.readdirSync(folder)
      .filter((name) => !name.startsWith('.') && name !== 'done')
      .filter((name) => {
        const file = path.join(folder, name)
        if (!fs.statSync(file).isFile()) return false
        if (folderName === 'raw') return /(?:idfa|oaid|pn)/i.test(name)
        return new RegExp(folderName, 'i').test(name)
      })
      .length
  }, 0)
  const createNames = readTaskItems(['createGroupToDoList.json', 'creategrouptodolist.json'])
  const createCount = readFirstTaskCount(['createGroupToDoList.json', 'creategrouptodolist.json'])
  const analyseCount = readTaskCount('analyseToDoList.json')
  const doneCount = readTaskCount('done.json')
  const workspaceStatus = createCount > 0 ? '等待创建人群包' : analyseCount > 0 ? '等待洞悉人群包' : doneCount > 0 ? '等待下载' : '等待操作'
  return { workspaceStatus, rawCount: pendingUploadCount, createCount, createNames, analyseCount, doneCount }
}

function withoutExtension(name) { return path.basename(name).replace(/\.[^.]+$/, '') }

module.exports = { decodeUploadedFileName, readTaskCount, readTaskItems, readFirstTaskCount, getWorkspaceStatus, withoutExtension }
