import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import express from 'express'
import multer from 'multer'
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'

const projectRoot = path.resolve(__dirname, '..')
const uploadRoot = process.env.RUYI_UPLOAD_DIR || path.join(projectRoot, 'upload')
const jobs = new Map()
const uploadMiddleware = multer({ storage: multer.memoryStorage() })
const require = createRequire(import.meta.url)
const { launchBrowser } = require('../lib/browser.js')

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
  const rawDir = path.join(uploadRoot, 'raw')
  const rawCount = fs.existsSync(rawDir)
    ? fs.readdirSync(rawDir).filter((name) => !name.startsWith('.') && fs.statSync(path.join(rawDir, name)).isFile()).length
    : 0
  const createNames = readTaskItems(['createGroupToDoList.json', 'creategrouptodolist.json'])
  const createCount = readFirstTaskCount(['createGroupToDoList.json', 'creategrouptodolist.json'])
  const analyseCount = readTaskCount('analysetodolist.json')
  const doneCount = readTaskCount('done.json')
  const workspaceStatus = createCount > 0 ? '等待创建人群包' : analyseCount > 0 ? '等待洞悉人群包' : doneCount > 0 ? '等待下载' : '等待操作'
  return { workspaceStatus, rawCount, createCount, createNames, analyseCount, doneCount }
}

function withoutExtension(name) { return path.basename(name).replace(/\.[^.]+$/, '') }

async function inspectPlatformFiles(type, names) {
  const url = type === 'idfa'
    ? 'https://ruyi.qq.com/audience/dnUpload?idType=MD5_IFA'
    : 'https://ruyi.qq.com/audience/dnUpload?idType=MD5_OAID'
  const context = await launchBrowser()
  try {
    const page = context.pages()[0] || await context.newPage()
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 })
    await page.waitForTimeout(1500)
    if (!page.url().includes('/audience/dnUpload')) throw new Error(`${type.toUpperCase()} 页面需要登录或未打开成功`)
    const search = page.locator('input[placeholder="搜索文件ID/名称"]').first()
    const cells = page.locator('.file-select-wrap-left-table tr.spaui-table-tr-data td[data-index="2"]')
    await search.waitFor({ state: 'visible', timeout: 30000 })
    let missingCount = 0
    for (const name of names) {
      const requested = String(name).replace(/\s+/g, ' ').trim()
      const stem = withoutExtension(requested)
      await search.fill(stem)
      await page.waitForTimeout(800)
      let found = false
      for (let index = 0; index < await cells.count(); index += 1) {
        const value = (await cells.nth(index).innerText()).replace(/\s+/g, ' ').trim()
        if (value === requested || value === stem) { found = true; break }
      }
      if (!found) missingCount += 1
    }
    await search.fill('')
    return { missingCount, platformCount: names.length - missingCount }
  } finally {
    await context.close()
    console.log(`${type.toUpperCase()} 平台文件检查页面已关闭。`)
  }
}

async function inspectAnalyseAudience(names) {
  const context = await launchBrowser()
  try {
    const page = context.pages()[0] || await context.newPage()
    await page.goto('https://ruyi.qq.com/audience', { waitUntil: 'domcontentloaded', timeout: 60000 })
    if (!page.url().startsWith('https://ruyi.qq.com/audience')) throw new Error('人群列表页面需要登录或未打开成功')
    const targets = new Set(names.map((name) => withoutExtension(name).replace(/\s+/g, ' ').trim()))
    const foundUnavailable = new Set()
    let emptyPages = 0
    for (let pageNumber = 1; pageNumber <= 200 && emptyPages < 3; pageNumber += 1) {
      const payload = await page.evaluate(async (pageNumber) => {
        const response = await fetch('/api/audience/list', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ page: pageNumber, pageSize: 20 }),
        })
        return response.json()
      }, pageNumber)
      const items = payload?.data?.listing?.items || []
      if (!items.length) break
      let matchedOnPage = 0
      for (const item of items) {
        const name = String(item.name || '').replace(/\s+/g, ' ').trim()
        const matched = [...targets].find((target) => name === target || name.includes(target))
        if (matched) {
          matchedOnPage += 1
          if (item.status === 'PROCESSING' || item.frontStatus === 'PROCESSING') foundUnavailable.add(matched)
        }
      }
      emptyPages = matchedOnPage === 0 ? emptyPages + 1 : 0
    }
    return foundUnavailable.size
  } finally {
    await context.close()
    console.log('人群列表检查页面已关闭。')
  }
}

async function inspectInsightResults(names) {
  const context = await launchBrowser()
  try {
    const page = context.pages()[0] || await context.newPage()
    const initialListResponse = page.waitForResponse(
      (response) => response.url().includes('/api/insight/list'),
      { timeout: 60000 },
    )
    await page.goto('https://ruyi.qq.com/audience-profile/result/', { waitUntil: 'domcontentloaded', timeout: 60000 })
    if (!page.url().startsWith('https://ruyi.qq.com/audience-profile/result')) throw new Error('洞悉结果页面需要登录或未打开成功')
    // domcontentloaded 时任务接口和列表 DOM 可能尚未完成，直接读取会把“尚未加载”误判成 0 条。
    await initialListResponse
    const foundComputing = new Set()
    const inspectedNames = new Set()
    const normalizedNames = [...new Set(names.map((name) => withoutExtension(name).replace(/\s+/g, ' ').trim()))]
    console.log(`开始查找洞悉结果：${normalizedNames.join('、')}`)
    const items = page.locator('.listItem--G0aPY')
    await items.first().waitFor({ state: 'visible', timeout: 30000 })
    let pageNumber = 1
    while (true) {
      console.log(`正在检查结果页第 ${pageNumber} 页，共 ${await items.count()} 条。`)
      for (let index = 0; index < await items.count(); index += 1) {
        const item = items.nth(index)
        const text = (await item.innerText()).replace(/\s+/g, ' ').trim()
        const title = (await item.locator('.title--cpoFh').first().innerText().catch(() => '')).replace(/\s+/g, ' ').trim()
        const matched = normalizedNames.find((name) => !inspectedNames.has(name) && (title === name || title === withoutExtension(name)))
        if (!matched) continue
        console.log(`找到匹配结果：${matched}，正在点击读取状态...`)
        const isActive = (await item.getAttribute('class').catch(() => '')).includes('active--')
        const detailResponse = isActive ? null : page.waitForResponse(
          (response) => response.url().includes('/api/insight/getDetail'),
          { timeout: 10000 },
        ).catch(() => null)
        await item.click()
        if (detailResponse) await detailResponse
        await page.waitForTimeout(200)
        const status = page.locator('.infoTag--O5jqs:visible, .successTag--BFKBJ:visible').last()
        let statusText = ''
        const statusDeadline = Date.now() + 10000
        while (!statusText && Date.now() < statusDeadline) {
          statusText = (await status.innerText().catch(() => '')).replace(/\s+/g, ' ').trim()
          if (!statusText) await page.waitForTimeout(250)
        }
        console.log(`洞悉任务 ${matched} 当前状态：${statusText || '未读取到状态'}`)
        if (statusText) {
          inspectedNames.add(matched)
          if (statusText.includes('计算中')) foundComputing.add(matched)
        }
      }
      if (inspectedNames.size === normalizedNames.length) {
        console.log(`已读取全部 ${normalizedNames.length} 个洞悉任务的状态，停止继续翻页。`)
        break
      }
      const next = page.locator('ul.pagination li.page-roll.backward:not(.disabled) a').first()
      if (!(await next.count()) || !(await next.isVisible().catch(() => false))) break
      const previous = await items.first().innerText().catch(() => '')
      await next.click()
      await page.waitForFunction((oldText) => {
        const first = document.querySelector('.listItem--G0aPY')
        return first && first.innerText !== oldText
      }, previous, { timeout: 30000 }).catch(() => {})
      pageNumber += 1
    }
    console.log(`洞悉结果检查完成：计算中 ${foundComputing.size} 个。`)
    return foundComputing.size
  } finally {
    await context.close()
    console.log('洞悉结果检查页面已关闭。')
  }
}

function apiPlugin() {
  return {
    name: 'ruyi-local-api',
    configureServer(server) {
      const api = express()
      api.use(express.json({ limit: '2mb' }))
      api.get('/api/status', (_req, res) => res.json({ ok: true, ...getWorkspaceStatus() }))
      api.get('/api/platform-status', async (_req, res) => {
        const names = readTaskItems(['createGroupToDoList.json', 'creategrouptodolist.json'])
        const analyseNames = readTaskItems(['analysetodolist.json'])
        const doneNames = readTaskItems(['done.json'])
        const groups = { idfa: names.filter((name) => /idfa/i.test(name)), oaid: names.filter((name) => /oaid/i.test(name)) }
        const result = { idfaPending: 0, oaidPending: 0, insightPending: 0, resultPending: 0 }
        const errors = []
        // 按工作流顺序逐个访问平台地址；单个阶段失败不阻断后续阶段。
        const checks = [
          ['IDFA 文件列表', async () => { if (groups.idfa.length) result.idfaPending = (await inspectPlatformFiles('idfa', groups.idfa)).missingCount }],
          ['OAID 文件列表', async () => { if (groups.oaid.length) result.oaidPending = (await inspectPlatformFiles('oaid', groups.oaid)).missingCount }],
          ['人群列表', async () => { if (analyseNames.length) result.insightPending = await inspectAnalyseAudience(analyseNames) }],
          ['洞悉结果列表', async () => { if (doneNames.length) result.resultPending = await inspectInsightResults(doneNames) }],
        ]
        for (const [label, check] of checks) {
          try { await check() } catch (error) { errors.push(`${label}：${error.message}`) }
        }
        res.json({ ok: true, ...result, errors })
      })
      api.post('/api/import-folder', uploadMiddleware.array('files'), (req, res) => {
        try {
          const rawDir = path.resolve(uploadRoot, 'raw')
          fs.mkdirSync(rawDir, { recursive: true })
          for (const file of req.files || []) {
            const relative = decodeUploadedFileName(file.originalname || file.filename).replace(/^[/\\]+/, '')
            if (path.basename(relative).startsWith('.')) continue
            const target = path.resolve(rawDir, path.basename(relative))
            if (!target.startsWith(`${rawDir}${path.sep}`)) throw new Error('非法文件路径')
            if (fs.existsSync(target)) throw new Error(`文件已存在，不会覆盖：${path.basename(target)}`)
            fs.writeFileSync(target, file.buffer)
          }
          res.json({ ok: true, count: (req.files || []).length })
        } catch (error) { res.status(400).json({ ok: false, message: error.message }) }
      })
      api.post('/api/run/:task', (req, res) => {
        const scripts = { upload: 'uploadAll.js', create: 'createAllGroup.js', analyse: 'analyseAll.js', download: 'downloadAll.js' }
        const script = scripts[req.params.task]
        if (!script) return res.status(404).json({ ok: false, message: '未知操作' })
        if ([...jobs.values()].some((job) => job.running)) return res.status(409).json({ ok: false, message: '已有脚本正在运行，请等待完成' })
        const id = `${Date.now()}-${req.params.task}`
        const child = spawn(process.execPath, [path.join(projectRoot, script)], { cwd: projectRoot })
        const job = { id, task: req.params.task, running: true, output: '' }
        jobs.set(id, job)
        child.stdout.on('data', (data) => { job.output += data.toString() })
        child.stderr.on('data', (data) => { job.output += data.toString() })
        child.on('close', (code) => { job.running = false; job.code = code })
        res.json({ ok: true, id })
      })
      api.get('/api/jobs/:id', (req, res) => {
        const job = jobs.get(req.params.id)
        if (!job) return res.status(404).json({ ok: false, message: '任务不存在' })
        res.json(job)
      })
      server.middlewares.use(api)
    },
  }
}

export default defineConfig({
  plugins: [vue(), apiPlugin()],
})
