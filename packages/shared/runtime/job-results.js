const fs = require('node:fs')
const path = require('node:path')
const { Readable } = require('node:stream')

const MAX32 = 0xffffffff
function safePath(workspace, ...parts) {
  const root = path.resolve(workspace)
  const target = path.resolve(root, ...parts)
  if (target !== root && !target.startsWith(`${root}${path.sep}`)) throw new Error('结果文件路径不安全')
  const base = path.dirname(path.dirname(root))
  let current = base
  for (const part of ['', ...path.relative(base, target).split(path.sep)]) {
    current = path.join(current, part)
    try {
      const stat = fs.lstatSync(current)
      if (stat.isSymbolicLink() || (current !== target && !stat.isDirectory())) throw new Error('结果文件路径不安全')
    } catch (error) { if (error.code !== 'ENOENT') throw error }
  }
  return target
}
function jobDirectory(workspace, id) {
  if (typeof id !== 'string' || !/^[a-f0-9-]{36}$/.test(id)) throw new Error('结果任务编号无效')
  return safePath(workspace, 'job-results', id)
}
function readManifest(workspace, id) {
  const file = safePath(workspace, jobDirectory(workspace, id), 'manifest.json')
  if (!fs.lstatSync(file).isFile()) throw new Error('结果清单无效')
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
  try {
    const stat = fs.fstatSync(fd)
    if (!stat.isFile() || stat.size > 16 * 1024 * 1024) throw new Error('结果清单无效')
    const value = JSON.parse(fs.readFileSync(fd, 'utf8'))
    if (value.version !== 2 || value.jobId !== id || !Array.isArray(value.files)) throw new Error('结果清单无效')
    return value
  } finally { fs.closeSync(fd) }
}
function writeManifest(workspace, id, value) {
  const dir = jobDirectory(workspace, id)
  const temp = safePath(workspace, dir, 'manifest.tmp')
  let created = false
  try {
    fs.writeFileSync(temp, JSON.stringify(value), { flag: 'wx', mode: 0o600 })
    created = true
    fs.renameSync(temp, safePath(workspace, dir, 'manifest.json'))
  } catch (error) {
    if (created) fs.unlinkSync(temp)
    throw error
  }
}
function beginResults(workspace, id) {
  const parent = safePath(workspace, 'job-results')
  fs.mkdirSync(parent, { recursive: true, mode: 0o700 })
  const dir = jobDirectory(workspace, id)
  fs.mkdirSync(dir, { mode: 0o700 })
  writeManifest(workspace, id, { version: 2, jobId: id, ready: false, files: [] })
}
function checkName(name) {
  if (typeof name !== 'string' || !name || name === '.' || name === '..' || /[\\/\x00-\x1f\x7f]/.test(name)
    || Buffer.byteLength(name) > 65535) throw new Error('结果文件名无效')
}
function resolveResultTarget(workspace, id, name) {
  checkName(name)
  const manifest = readManifest(workspace, id)
  if (manifest.ready) throw new Error('任务结果已封存')
  if (manifest.files.some((file) => file.name.normalize('NFC') === name.normalize('NFC'))) throw new Error('任务结果文件重名')
  const target = safePath(workspace, jobDirectory(workspace, id), 'files', name)
  if (fs.existsSync(target)) throw new Error('下载结果已存在，不会覆盖')
  return target
}
function recordResult(workspace, id, source, name = path.basename(source)) {
  const target = resolveResultTarget(workspace, id, name)
  const manifest = readManifest(workspace, id)
  // Playwright 下载源位于临时目录，最终文件只复制一次。
  const stat = fs.lstatSync(source)
  if (!stat.isFile() || stat.size >= MAX32) throw new Error('结果文件过大或不是普通文件，无法生成 ZIP')
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 })
  safePath(workspace, target)
  let created = false
  try {
    fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL)
    created = true
    fs.chmodSync(target, 0o600)
    const saved = fs.lstatSync(target)
    if (!saved.isFile() || saved.size !== stat.size) throw new Error('结果文件不完整')
    manifest.files.push({ name, stored: `files/${name}`, size: stat.size })
    writeManifest(workspace, id, manifest)
  } catch (error) {
    if (created) fs.unlinkSync(target)
    throw error
  }
  return target
}
function finishResults(workspace, id) {
  const value = readManifest(workspace, id)
  value.ready = true
  writeManifest(workspace, id, value)
}
function resultEntries(workspace, id) {
  const value = readManifest(workspace, id)
  if (!value.ready || !value.files.length) throw new Error('本次任务没有可下载的结果文件')
  if (value.files.length >= 65535) throw new Error('结果文件过多，超出 ZIP 格式限制')
  const seen = new Set()
  let total = 22
  const files = value.files.map((file, index) => {
    checkName(file.name)
    const key = file.name.normalize('NFC')
    if (seen.has(key) || file.stored !== `files/${file.name}` || !Number.isSafeInteger(file.size) || file.size < 0 || file.size >= MAX32) throw new Error('结果清单无效')
    seen.add(key)
    const target = safePath(workspace, jobDirectory(workspace, id), file.stored)
    const stat = fs.lstatSync(target)
    if (!stat.isFile() || stat.size !== file.size) throw new Error('结果文件不完整')
    total += file.size + 30 + 16 + 46 + Buffer.byteLength(file.name) * 2
    if (total >= MAX32) throw new Error('结果包超过 4GB，无法使用当前 ZIP 格式')
    return { ...file, path: target }
  })
  return { files, size: total }
}

const crcTable = Array.from({ length: 256 }, (_, index) => {
  let value = index
  for (let bit = 0; bit < 8; bit++) value = (value & 1) ? 0xedb88320 ^ (value >>> 1) : value >>> 1
  return value >>> 0
})
function crcUpdate(crc, data) {
  for (const byte of data) crc = crcTable[(crc ^ byte) & 255] ^ (crc >>> 8)
  return crc >>> 0
}
// STORE + data descriptor 可边读边写，无需缓存整包或预先读两遍文件；UTF-8 标志保留中文名。
function zipStream(workspace, id, entries) {
  async function* generate() {
    let offset = 0
    const central = []
    for (const entry of entries.files) {
      const target = safePath(workspace, jobDirectory(workspace, id), entry.stored)
      const fd = await fs.promises.open(target, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
      let stream
      try {
        const stat = await fd.stat()
        if (!stat.isFile() || stat.size !== entry.size) throw new Error('结果文件不完整')
        const name = Buffer.from(entry.name)
        const header = Buffer.alloc(30)
        header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4); header.writeUInt16LE(0x808, 6)
        header.writeUInt16LE(33, 12); header.writeUInt16LE(name.length, 26)
        const start = offset
        yield header; yield name
        offset += 30 + name.length
        let crc = MAX32, size = 0
        stream = fd.createReadStream({ autoClose: false })
        for await (const chunk of stream) {
          size += chunk.length
          if (size > entry.size) throw new Error('结果文件大小已变化')
          crc = crcUpdate(crc, chunk)
          yield chunk
        }
        if (size !== entry.size) throw new Error('结果文件大小已变化')
        crc = (crc ^ MAX32) >>> 0
        const descriptor = Buffer.alloc(16)
        descriptor.writeUInt32LE(0x08074b50); descriptor.writeUInt32LE(crc, 4)
        descriptor.writeUInt32LE(size, 8); descriptor.writeUInt32LE(size, 12)
        yield descriptor
        offset += size + 16
        const record = Buffer.alloc(46)
        record.writeUInt32LE(0x02014b50); record.writeUInt16LE(20, 4); record.writeUInt16LE(20, 6)
        record.writeUInt16LE(0x808, 8); record.writeUInt16LE(33, 14)
        record.writeUInt32LE(crc, 16); record.writeUInt32LE(size, 20); record.writeUInt32LE(size, 24)
        record.writeUInt16LE(name.length, 28); record.writeUInt32LE(start, 42)
        central.push(record, name)
      } finally {
        stream?.destroy()
        await fd.close()
      }
    }
    const start = offset
    for (const buffer of central) { yield buffer; offset += buffer.length }
    const end = Buffer.alloc(22)
    end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.files.length, 8); end.writeUInt16LE(entries.files.length, 10)
    end.writeUInt32LE(offset - start, 12); end.writeUInt32LE(start, 16)
    yield end
  }
  return Readable.from(generate())
}

module.exports = { beginResults, resolveResultTarget, recordResult, finishResults, resultEntries, zipStream }
