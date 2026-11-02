const fs = require('node:fs')
const path = require('node:path')
const { randomUUID } = require('node:crypto')
const { decodeUploadedFileName, ensureWorkspace } = require('@ruyi/shared/runtime/workspace')

async function importMultipartFiles(req, res, { workspace: workspaceDir, userHasRunningJob, includeFiles = false }) {
  req.auditImport = { count: 0, skipped: 0, files: [] }
  if (req.user && await userHasRunningJob(req)) return res.code(409).send({ ok: false, message: includeFiles ? '当前用户有任务正在运行，请完成后重新获取链接再导入文件' : '当前用户有任务正在运行，请完成后再导入文件' })
  let files
  try {
    files = []
    if (req.isMultipart()) {
      for await (const part of req.parts()) {
        if (!part.file) continue
        if (part.fieldname !== 'files') throw new Error('非预期的文件字段')
        files.push({ originalname: part.filename, buffer: await part.toBuffer() })
      }
    }
  } catch (error) {
    return res.code(400).send({ ok: false, message: includeFiles ? `${error.message}，请重新获取链接后重试` : error.message })
  }
  if (req.user && await userHasRunningJob(req)) return res.code(409).send({ ok: false, message: includeFiles ? '当前用户有任务正在运行，请完成后重新获取链接再导入文件' : '当前用户有任务正在运行，请完成后再导入文件' })
  try {
    const workspace = ensureWorkspace(workspaceDir)
    const rawDir = path.join(workspace, 'raw')
    const importId = req.user ? randomUUID() : null
    let count = 0
    let skipped = 0
    for (const file of files) {
      const relative = decodeUploadedFileName(file.originalname || file.filename).replace(/^[/\\]+/, '')
      const fileName = path.basename(relative.replace(/\\/g, '/'))
      if (fileName.startsWith('.') || !/(?:idfa|oaid|pn)/i.test(fileName) || !/\.(?:txt|csv)$/i.test(fileName)) {
        skipped += 1
        req.auditImport.skipped = skipped
        continue
      }
      const targetDir = req.user ? path.join(rawDir, importId, String(count + 1)) : rawDir
      fs.mkdirSync(targetDir, { recursive: true })
      const target = path.resolve(targetDir, fileName)
      if (!target.startsWith(`${rawDir}${path.sep}`)) throw new Error('非法文件路径')
      if (fs.existsSync(target)) throw new Error(`文件已存在，不会覆盖：${path.basename(target)}`)
      fs.writeFileSync(target, file.buffer, { flag: 'wx' })
      count += 1
      req.auditImport.count = count
      if (req.auditImport.files.length < 100) req.auditImport.files.push(fileName)
    }
    return res.send({ ok: true, count, skipped, ...(includeFiles ? { files: req.auditImport.files } : {}) })
  } catch (error) {
    return res.code(400).send({ ok: false, message: includeFiles ? '文件导入失败，请重新获取链接后重试' : error.code ? '文件导入失败，请联系管理员' : error.message })
  }
}

module.exports = { importMultipartFiles }
