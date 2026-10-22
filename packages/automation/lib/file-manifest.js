const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')

const TYPES = new Set(['idfa', 'oaid', 'pn'])
const STAGES = new Set(['planned', 'pending', 'uploading', 'uploaded', 'created', 'analysed', 'downloaded', 'empty'])
const MANIFEST_FILE = 'file-manifest.json'
const ARRAY_FILES = ['createGroupToDoList.json', 'creategrouptodolist.json', 'analyseToDoList.json', 'done.json']
const NEW_NAME = /^([A-Za-z0-9_]+)_(idfa|oaid|pn)_([a-f0-9]{8})_([1-9][0-9]*)$/

function unicodeLength(value) { return Array.from(String(value)).length }
function assertSafeName(name, label = '文件名') {
  if (typeof name !== 'string' || !name || name === '.' || name === '..'
    || path.basename(name) !== name || /[\\/\x00-\x1f\x7f]/.test(name)) {
    throw new Error(`${label}不安全：${String(name)}`)
  }
  return name
}
function lstat(file) {
  try { return fs.lstatSync(file) } catch (error) { if (error.code === 'ENOENT') return null; throw error }
}
function assertWorkspacePath(uploadRoot, target = uploadRoot) {
  const root = path.resolve(uploadRoot)
  const resolved = path.resolve(target)
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) throw new Error('文件路径超出用户工作区')
  // Also check the workspace's containing directories (data/users). System
  // aliases above the data root, such as macOS /var, are outside our boundary.
  for (const directory of [path.dirname(path.dirname(root)), path.dirname(root), root]) {
    const info = lstat(directory)
    if (info && (info.isSymbolicLink() || !info.isDirectory())) throw new Error(`工作区目录不安全：${directory}`)
  }
  let current = root
  for (const part of path.relative(root, resolved).split(path.sep).filter(Boolean)) {
    current = path.join(current, part)
    const info = lstat(current)
    if (info?.isSymbolicLink()) throw new Error(`文件路径包含符号链接，已停止：${current}`)
    if (current !== resolved && info && !info.isDirectory()) throw new Error(`工作区目录不安全：${current}`)
  }
  return resolved
}
function relativePath(uploadRoot, file) {
  return path.relative(path.resolve(uploadRoot), assertWorkspacePath(uploadRoot, file)).split(path.sep).join('/')
}
function safeRelative(uploadRoot, value) {
  if (typeof value !== 'string' || !value || path.isAbsolute(value) || value.includes('\\')
    || value.split('/').some((part) => !part || part === '.' || part === '..')) throw new Error(`映射中的文件路径不安全：${value}`)
  return assertWorkspacePath(uploadRoot, path.join(uploadRoot, value))
}
function manifestPath(uploadRoot) { return assertWorkspacePath(uploadRoot, path.join(uploadRoot, MANIFEST_FILE)) }
function jobKey(jobId) {
  if (typeof jobId !== 'string' || !jobId) return ''
  return crypto.createHash('sha256').update(jobId).digest('hex').slice(0, 8)
}
function createPlatformName({ username, type, jobId, sequence, existing = [] }) {
  const user = assertSafeName(username, '用户名')
  if (!/^[A-Za-z0-9_]+$/.test(user)) throw new Error(`用户名包含平台名称不支持的字符：${user}`)
  if (!TYPES.has(type)) throw new Error(`未知文件类型：${type}`)
  if (!Number.isSafeInteger(sequence) || sequence < 1) throw new Error(`文件序号必须是正整数：${sequence}`)
  const key = jobKey(jobId)
  if (!key) throw new Error('已启用多人任务命名，但缺少 RUYI_JOB_ID')
  const name = `${user}_${type}_${key}_${sequence}`
  if (unicodeLength(name) > 30) throw new Error(`平台名称超过 30 个字符（用户名“${user}”过长或单次任务文件过多），请缩短用户名或分批上传`)
  if (existing.some((item) => (typeof item === 'string' ? item : item?.platformName) === name)) throw new Error(`平台名称重复或任务短串碰撞，任务无法继续：${name}`)
  return name
}
function validateManifest(uploadRoot, files) {
  const names = new Set()
  const sequences = new Set()
  for (const item of files) {
    if (!item || typeof item !== 'object') throw new Error('文件映射记录格式错误')
    const { platformName, originalName, type, jobId, sequence, stage } = item
    assertSafeName(platformName, '平台名称')
    assertSafeName(originalName, '初始文件名')
    const match = platformName.match(NEW_NAME)
    if (!match || !TYPES.has(type) || match[2] !== type || match[3] !== jobKey(jobId)
      || !Number.isSafeInteger(sequence) || sequence < 1 || match[4] !== String(sequence)
      || unicodeLength(platformName) > 30 || !STAGES.has(stage)) throw new Error(`文件映射记录字段无效：${platformName}`)
    const seqKey = `${jobId}\0${sequence}`
    if (names.has(platformName) || sequences.has(seqKey)) throw new Error(`文件映射记录重复：${platformName}`)
    names.add(platformName); sequences.add(seqKey)
    safeRelative(uploadRoot, item.originalPath)
    const current = safeRelative(uploadRoot, item.currentPath)
    if (!item.currentPath.startsWith(`${type}/`) || path.basename(current) !== `${platformName}${path.extname(originalName)}`) throw new Error(`文件映射当前位置无效：${platformName}`)
  }
}
function readManifest(uploadRoot) {
  const file = manifestPath(uploadRoot)
  if (!lstat(file)) return { version: 1, files: [] }
  let value
  try { value = JSON.parse(fs.readFileSync(file, 'utf8')) } catch (error) { throw new Error(`文件映射清单格式错误（${error.message}）`) }
  const files = Array.isArray(value) ? value : value?.version === 1 ? value.files : null
  if (!Array.isArray(files)) throw new Error('文件映射清单必须包含 version: 1 和 files 数组')
  validateManifest(uploadRoot, files)
  return { version: 1, files }
}
function writeManifest(uploadRoot, manifest) {
  validateManifest(uploadRoot, manifest.files)
  const target = manifestPath(uploadRoot)
  const temporary = assertWorkspacePath(uploadRoot, `${target}.tmp-${process.pid}-${crypto.randomBytes(6).toString("hex")}`)
  fs.writeFileSync(temporary, `${JSON.stringify({ version: 1, files: manifest.files }, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' })
  fs.renameSync(temporary, target)
  return target
}
function inferType(name, folderType = null) {
  if (TYPES.has(folderType)) return folderType
  const stem = String(name || '').toLowerCase()
  // Only legacy input names use substring inference. Platform names must use
  // their manifest's type so a username such as pnalice cannot change routing.
  return ['pn', 'idfa', 'oaid'].find((type) => stem.includes(type)) || null
}
function platformStem(name) { return assertSafeName(path.basename(name)).replace(/\.(?:txt|csv)$/i, '') }
function requireMapping(uploadRoot, name, { allowLegacy = true } = {}) {
  const requested = assertSafeName(name, '平台名称')
  const stem = platformStem(requested)
  const found = readManifest(uploadRoot).files.find((item) => item.platformName === stem)
  if (found) return found
  if (NEW_NAME.test(stem) || !allowLegacy) throw new Error(`文件映射清单中找不到平台名称：${stem}`)
  return { platformName: stem, originalName: requested, type: inferType(requested), legacy: true }
}
function findByPlatformName(uploadRoot, name) {
  return readManifest(uploadRoot).files.find((item) => item.platformName === platformStem(name)) || null
}
function resolveFileType(uploadRoot, name) { return requireMapping(uploadRoot, name).type }
function groupPlatformNames(uploadRoot, names, options) {
  const groups = { idfa: [], oaid: [], pn: [] }
  for (const name of names) {
    const item = requireMapping(uploadRoot, name, options)
    if (!TYPES.has(item.type)) throw new Error(`平台名称缺少明确文件类型映射：${name}`)
    groups[item.type].push(item.platformName)
  }
  return groups
}
function walkFiles(root, { uploadRoot = root, recursive = true } = {}) {
  assertWorkspacePath(uploadRoot, root)
  if (!lstat(root)) return []
  const output = []
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      // Historical archives are never traversed, even if an old archive has
      // a broken symlink or duplicate original filename.
      if (entry.name === 'done' || entry.name.startsWith('.')) continue
      const full = assertWorkspacePath(uploadRoot, path.join(directory, entry.name))
      if (entry.isDirectory() && recursive) visit(full)
      else if (entry.isFile()) output.push(full)
    }
  }
  visit(root)
  return output
}
function pendingCandidates(uploadRoot) {
  const manifest = readManifest(uploadRoot)
  const result = []
  for (const folder of ['raw', 'idfa', 'oaid', 'pn']) {
    for (const file of walkFiles(path.join(uploadRoot, folder), { uploadRoot, recursive: folder === 'raw' })) {
      const relative = relativePath(uploadRoot, file)
      const stem = platformStem(path.basename(file))
      const record = manifest.files.find((item) => item.currentPath === relative
        || (item.stage === 'planned' && item.originalPath === relative))
      if (!record && NEW_NAME.test(stem)) throw new Error(`待上传文件缺少映射，不能将平台名称当作初始文件名：${stem}`)
      const type = record ? record.type : inferType(path.basename(file), folder === 'raw' ? null : folder)
      if (!type) continue
      if (record && folder !== 'raw' && folder !== type) throw new Error(`待上传文件类型与映射不一致：${stem}`)
      result.push({ path: file, originalName: record?.originalName || path.basename(file), type, record })
    }
  }
  return result
}
function preflightDuplicateOriginalNames(uploadRoot, candidates = pendingCandidates(uploadRoot)) {
  const groups = new Map()
  for (const item of candidates) {
    const name = assertSafeName(item.originalName).normalize('NFC')
    if (!groups.has(name)) groups.set(name, [])
    groups.get(name).push(relativePath(uploadRoot, item.path))
  }
  const duplicates = [...groups.entries()].filter(([, paths]) => paths.length > 1)
  if (duplicates.length) throw new Error(`本次任务发现重复原始文件名：${duplicates.map(([name, paths]) => `${name}（${paths.join('、')}）`).join('；')}`)
  return candidates
}
function namedMode({ username = process.env.RUYI_USER, jobId = process.env.RUYI_JOB_ID } = {}) {
  if (Boolean(username) !== Boolean(jobId)) throw new Error('多人任务必须同时设置 RUYI_USER 和 RUYI_JOB_ID')
  return Boolean(username && jobId)
}
function readTaskArray(uploadRoot, name) {
  const file = assertWorkspacePath(uploadRoot, path.join(uploadRoot, name))
  if (!lstat(file)) return []
  const value = JSON.parse(fs.readFileSync(file, 'utf8') || '[]')
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) throw new Error(`任务清单必须是文件名字符串数组：${name}`)
  value.forEach((item) => assertSafeName(item))
  return value
}
function planUpload(uploadRoot, options = {}) {
  const username = options.username ?? process.env.RUYI_USER
  const jobId = options.jobId ?? process.env.RUYI_JOB_ID
  const manifest = readManifest(uploadRoot)
  const candidates = preflightDuplicateOriginalNames(uploadRoot)
  const lists = ARRAY_FILES.flatMap((name) => readTaskArray(uploadRoot, name))
  if (!namedMode({ username, jobId })) return { manifest, candidates, moves: [], named: false }
  let sequence = Math.max(0, ...manifest.files.filter((item) => item.jobId === jobId).map((item) => item.sequence))
  const moves = []
  const seenRecords = new Set()
  for (const candidate of candidates) {
    if (!/\.(?:txt|csv)$/i.test(candidate.originalName)) throw new Error(`待上传文件仅支持 txt 或 csv 格式：${candidate.originalName}`)
    let record = candidate.record && manifest.files.find((item) => item.platformName === candidate.record.platformName)
    if (!record) {
      // An old queue may already refer to this unrenamed input. Guessing
      // whether it was submitted can select a shared-account legacy object.
      if (lists.some((name) => platformStem(name) === platformStem(path.basename(candidate.path)))) throw new Error(`旧任务清单仍引用待上传文件，请先处理旧任务后重试：${candidate.originalName}`)
      record = {
        platformName: createPlatformName({ username, type: candidate.type, jobId, sequence: ++sequence, existing: [...manifest.files, ...lists] }),
        originalName: candidate.originalName, type: candidate.type, jobId, sequence,
        originalPath: relativePath(uploadRoot, candidate.path), stage: 'planned',
      }
      const empty = fs.statSync(candidate.path).size === 0
      record.currentPath = `${record.type}/${empty ? 'done/' : ''}${record.platformName}${path.extname(record.originalName)}`
      manifest.files.push(record)
    }
    if (seenRecords.has(record.platformName)) throw new Error(`同一映射存在多个待上传文件：${record.platformName}`)
    seenRecords.add(record.platformName)
    const target = safeRelative(uploadRoot, record.currentPath)
    if (path.resolve(candidate.path) !== target && lstat(target)) throw new Error(`文件准备目标已存在，不会覆盖：${record.platformName}`)
    moves.push({ source: candidate.path, target, record })
  }
  // Validate every entry and destination before the first persistent change.
  validateManifest(uploadRoot, manifest.files)
  return { manifest, candidates, moves, named: true }
}
function prepareUpload(uploadRoot, options) {
  const plan = planUpload(uploadRoot, options)
  if (!plan.named) return plan
  // Persist destination paths first so retries recover a crash on either side
  // of rename without allocating another name or losing the original name.
  writeManifest(uploadRoot, plan.manifest)
  for (const move of plan.moves) {
    fs.mkdirSync(path.dirname(move.target), { recursive: true })
    if (path.resolve(move.source) !== move.target) fs.renameSync(move.source, move.target)
    if (move.record.stage === 'planned') move.record.stage = fs.statSync(move.target).size ? 'pending' : 'empty'
  }
  // A crash after moving an empty file into done can leave it outside the
  // pending enumeration. Recover its stage from the persisted destination.
  for (const record of plan.manifest.files) {
    if (record.stage !== 'planned') continue
    const target = safeRelative(uploadRoot, record.currentPath)
    if (lstat(target)?.isFile()) record.stage = fs.statSync(target).size ? 'pending' : 'empty'
  }
  writeManifest(uploadRoot, plan.manifest)
  return plan
}
function updateStage(uploadRoot, platformName, stage, currentPath) {
  if (!STAGES.has(stage)) throw new Error(`未知文件阶段：${stage}`)
  const manifest = readManifest(uploadRoot)
  const record = manifest.files.find((item) => item.platformName === platformStem(platformName))
  if (!record) { requireMapping(uploadRoot, platformStem(platformName)); return }
  record.stage = stage
  if (currentPath) record.currentPath = relativePath(uploadRoot, currentPath)
  writeManifest(uploadRoot, manifest)
}
function resolveDownloadTarget(uploadRoot, platformName, suggestedName) {
  const mapping = requireMapping(uploadRoot, platformName)
  assertSafeName(suggestedName, '下载文件名')
  const extension = path.extname(suggestedName)
  if (!extension || !/^\.[A-Za-z0-9]+$/.test(extension)) throw new Error('下载结果缺少安全的实际格式扩展名')
  const original = assertSafeName(mapping.originalName, '初始文件名')
  const stem = path.basename(original, path.extname(original))
  assertSafeName(stem, '结果主文件名')
  const resultName = mapping.legacy ? suggestedName : `${stem}${extension}`
  if (process.env.RUYI_RESULT_JOB_ID) {
    return require('@ruyi/shared/runtime/job-results').resolveResultTarget(uploadRoot, process.env.RUYI_RESULT_JOB_ID, resultName)
  }
  const target = assertWorkspacePath(uploadRoot, path.join(uploadRoot, 'result', resultName))
  if (lstat(target)) throw new Error(`下载结果已存在，不会覆盖：${path.basename(target)}`)
  return target
}
function saveDownloadedFile(uploadRoot, platformName, suggestedName, source) {
  const target = resolveDownloadTarget(uploadRoot, platformName, suggestedName)
  if (process.env.RUYI_RESULT_JOB_ID) {
    require('@ruyi/shared/runtime/job-results').recordResult(uploadRoot, process.env.RUYI_RESULT_JOB_ID, source, path.basename(target))
  } else {
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL)
  }
  updateStage(uploadRoot, platformName, 'downloaded')
  return target
}
module.exports = {
  TYPES, MANIFEST_FILE, manifestPath, readManifest, writeManifest,
  jobKey, createPlatformName, inferType, walkFiles, pendingCandidates,
  preflightDuplicateOriginalNames, findByPlatformName, requireMapping, requireTaskMapping: requireMapping,
  resolveFileType, groupPlatformNames, assertSafeName, assertWorkspacePath, unicodeLength,
  namedMode, readTaskArray, planUpload, prepareUpload, updateStage, platformStem,
  resolveDownloadTarget, saveDownloadedFile,
}
