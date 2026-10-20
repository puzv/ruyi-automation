const { launchBrowser, closeBrowserContext } = require('../lib/browser.js')
const { withoutExtension } = require('./workspace')
const state = require('./state')

function launchPlatformBrowser(storageState) { return launchBrowser({ headless: state.headlessMode, ...(storageState ? { storageState } : {}) }) }

function trackContext(context) {
  state.activeContexts.add(context)
  context.on('close', () => {
    state.activeContexts.delete(context)
  })
  return context
}

async function inspectPlatformFiles(type, names, storageState) {
  const url = type === 'pn'
    ? (process.env.RUYI_URL_PN_UPLOAD || 'https://ruyi.qq.com/audience/dnUpload?idType=MD5_MOBILE_PHONE')
    : type === 'idfa'
    ? 'https://ruyi.qq.com/audience/dnUpload?idType=MD5_IFA'
    : 'https://ruyi.qq.com/audience/dnUpload?idType=MD5_OAID'
  const context = trackContext(await launchPlatformBrowser(storageState))
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
    await closeBrowserContext(context)
    console.log(`${type.toUpperCase()} 平台文件检查页面已关闭。`)
  }
}

async function inspectAnalyseAudience(names, storageState) {
  const context = trackContext(await launchPlatformBrowser(storageState))
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
        const matched = [...targets].find((target) => name === target)
        if (matched) {
          matchedOnPage += 1
          if (item.status === 'PROCESSING' || item.frontStatus === 'PROCESSING') foundUnavailable.add(matched)
        }
      }
      emptyPages = matchedOnPage === 0 ? emptyPages + 1 : 0
    }
    return foundUnavailable.size
  } finally {
    await closeBrowserContext(context)
    console.log('人群列表检查页面已关闭。')
  }
}

async function inspectInsightResults(names, storageState) {
  const context = trackContext(await launchPlatformBrowser(storageState))
  try {
    const page = context.pages()[0] || await context.newPage()
    await page.goto('https://ruyi.qq.com/audience-profile/result/', { waitUntil: 'domcontentloaded', timeout: 60000 })
    if (!page.url().startsWith('https://ruyi.qq.com/audience-profile/result')) throw new Error('洞悉结果页面需要登录或未打开成功')
    // 列表接口支持按关键字过滤。直接查询接口比逐页读取 DOM 稳定，且
    // 能处理同名记录：平台可能同时保留旧的 LOCKING 记录和新的 SUCCESS
    // 记录，后续按更新时间选出与下载页一致的最新记录。
    const normalizedNames = [...new Set(names.map((name) => withoutExtension(name).replace(/\s+/g, ' ').trim()).filter(Boolean))]
    // 这些状态都不能安全下载：LOCKING 对应页面的“排队中” waitTag，
    // PROCESSING 对应“计算中”，ERROR/FROZEN 代表失败或被冻结的结果。
    const activeStatuses = new Set([
      'PROCESSING', 'LOCKING', 'FROZEN', 'ERROR', 'PENDING', 'WAITING', 'GENERATING', 'FAILED',
    ])
    let pendingCount = 0
    console.log(`开始检查洞悉结果：${normalizedNames.join('、')}`)
    for (const target of normalizedNames) {
      const payload = {
        page: 1,
        pageSize: 100,
        sortField: 'lastModifiedTime',
        sortType: 'DESC',
        filtering: [
          { field: 'keyword', operator: 'CONTAINS', values: [target] },
          { field: 'type', operator: 'IN', values: ['TAG'] },
          { field: 'status', operator: 'IN', values: ['SUCCESS', 'PROCESSING', 'ERROR', 'FROZEN', 'LOCKING'] },
        ],
      }
      const response = await page.evaluate(async (request) => {
        const result = await fetch('/api/insight/list', {
          method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(request),
        })
        if (!result.ok) throw new Error(`洞悉列表接口返回 HTTP ${result.status}`)
        return result.json()
      }, payload)
      if (response?.success === false || (response?.code != null && response.code !== 0)) {
        throw new Error(`洞悉列表接口失败：${response?.message || `code=${response?.code}`}`)
      }
      const items = response?.data?.listing?.items || []
      const matched = items.filter((item) => {
        const itemName = String(item.name || '').replace(/\s+/g, ' ').trim()
        return itemName === target || itemName === withoutExtension(target)
      })
      // API 已按 lastModifiedTime 倒序返回。同名洞悉可能有多条历史记录，
      // 下载页同样默认选中第一条，因此只采用最新记录，不能因为历史
      // SUCCESS 记录存在就把当前最新的 LOCKING/PROCESSING 误判为完成。
      const latest = matched[0]
      const latestStatus = String(latest?.status || '').toUpperCase()
      const pending = activeStatuses.has(latestStatus)
      if (pending) pendingCount += 1
      console.log(`洞悉任务 ${target} 当前状态：${latestStatus || '未找到'}${matched.length > 1 ? `（同名 ${matched.length} 条，按最新记录判断）` : ''}`)
    }
    console.log(`洞悉结果检查完成：未就绪 ${pendingCount} 个。`)
    return pendingCount
  } finally {
    await closeBrowserContext(context)
    console.log('洞悉结果检查页面已关闭。')
  }
}

module.exports = { inspectPlatformFiles, inspectAnalyseAudience, inspectInsightResults, trackContext, launchPlatformBrowser }
