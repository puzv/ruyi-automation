const { browserHeadless } = require('@ruyi/shared/config')
const { launchBrowser, closeBrowserContext } = require('@ruyi/automation/lib/browser.js')
const { withoutExtension } = require('@ruyi/shared/runtime/workspace')
const state = require('../../state')

function launchPlatformBrowser(storageState, options = {}) {
  const headless = browserHeadless
  return launchBrowser({ headless, ...(storageState ? { storageState } : {}) })
}

function trackContext(context) {
  state.activeContexts.add(context)
  context.on('close', () => {
    state.activeContexts.delete(context)
  })
  return context
}

// 人群列表里还没出现的目标必须算未就绪。刚提交的人群包有一段延迟才进列表，
// 如果只统计 PROCESSING 会得到 0，导致过早提交人群洞悉。
function normalizeAudienceName(value) {
  return String(value || '').replace(/\s+/g, ' ').trim()
}

function normalizeAudienceStatus(value) {
  return String(value || '').trim().toUpperCase()
}

function isAudienceNameMatch(itemName, target) {
  if (itemName === target) return true
  const index = itemName.indexOf(target)
  if (index < 0) return false
  const before = itemName[index - 1]
  const after = itemName[index + target.length]
  // 仅允许目标位于名称边界，避免 `_1` 命中 `_10` 或 `_11`。
  // 下划线是平台常用的前后缀分隔符，不能阻断兼容匹配。
  return (!before || !/[A-Za-z0-9]/.test(before))
    && (!after || !/[A-Za-z0-9]/.test(after))
}

function countPendingAudiences(targets, items, found, foundUnavailable) {
  let matchedOnPage = 0
  for (const item of items) {
    const name = normalizeAudienceName(item.name)
    // 精确名称优先；兼容平台追加前后缀时取最长候选，避免短编号抢占长编号。
    const matched = targets.find((target) => name === target)
      || targets.filter((target) => isAudienceNameMatch(name, target))
        .sort((left, right) => right.length - left.length)[0]
    if (!matched) continue
    matchedOnPage += 1
    found.add(matched)
    const frontStatus = normalizeAudienceStatus(item.frontStatus)
    const status = normalizeAudienceStatus(item.status)
    if (status === 'PROCESSING' || frontStatus === 'PROCESSING') foundUnavailable.add(matched)
  }
  return matchedOnPage
}

function countPendingAudiencesTotal(targets, found, foundUnavailable) {
  const missing = targets.filter((target) => !found.has(target))
  return { pending: foundUnavailable.size + missing.length, missing }
}

// 洞悉结果同理：列表里查不到记录时 latest 是 undefined，
// 既不能算完成，也不能因为 status 为空就跳过。
function pendingInsightResult(latest) {
  if (!latest) return true
  const status = String(latest.status || '').toUpperCase()
  if (!status) return true
  return status !== 'SUCCESS'
}

async function inspectPlatformFiles(type, names, storageState, options = {}) {
  const url = type === 'pn'
    ? (process.env.RUYI_URL_PN_UPLOAD || 'https://ruyi.qq.com/audience/dnUpload?idType=MD5_MOBILE_PHONE')
    : type === 'idfa'
    ? 'https://ruyi.qq.com/audience/dnUpload?idType=MD5_IFA'
    : 'https://ruyi.qq.com/audience/dnUpload?idType=MD5_OAID'
  const context = trackContext(await launchPlatformBrowser(storageState, options))
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

// 该函数由 Playwright 序列化到页面执行，不能依赖模块闭包。
async function requestPlatformListing({ url, payload, label }, requestFetch = fetch) {
  const response = await requestFetch(url, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
  })
  if (!response.ok) throw new Error(`${label}接口返回 HTTP ${response.status}`)
  let body
  try { body = await response.json() } catch (_) { throw new Error(`${label}接口返回的 JSON 无效`) }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error(`${label}接口响应格式无效`)
  if (body.success === false || (body.code != null && body.code !== 0)) {
    throw new Error(`${label}接口失败：${body.message || `code=${body.code}`}`)
  }
  if (body.success !== true && body.code !== 0) throw new Error(`${label}接口缺少成功标记`)
  const listing = body.data?.listing
  if (!listing || !Array.isArray(listing.items)
    || listing.items.some((item) => !item || typeof item !== 'object' || Array.isArray(item))) {
    throw new Error(`${label}接口列表格式无效`)
  }
  return listing
}

async function inspectAudiencePages(names, loadPage) {
  const targets = [...new Set(names.map((name) => withoutExtension(name).replace(/\s+/g, ' ').trim()).filter(Boolean))]
  const found = new Set()
  const unavailable = new Set()
  for (let pageNumber = 1; targets.length && pageNumber <= 200; pageNumber += 1) {
    const listing = await loadPage(pageNumber)
    if (!listing.items.length) break
    countPendingAudiences(targets, listing.items, found, unavailable)
    if (found.size === targets.length) break
    const total = Number(listing.total)
    if (listing.total != null && Number.isFinite(total) && total >= 0 && pageNumber * 20 >= total) break
  }
  return countPendingAudiencesTotal(targets, found, unavailable)
}

async function inspectAnalyseAudience(names, storageState, options = {}) {
  const context = trackContext(await launchPlatformBrowser(storageState, options))
  try {
    const page = context.pages()[0] || await context.newPage()
    await page.goto('https://ruyi.qq.com/audience', { waitUntil: 'domcontentloaded', timeout: 60000 })
    if (!page.url().startsWith('https://ruyi.qq.com/audience')) throw new Error('人群列表页面需要登录或未打开成功')
    const { pending, missing } = await inspectAudiencePages(names, (pageNumber) => page.evaluate(requestPlatformListing, {
      url: '/api/audience/list', label: '人群列表', payload: { page: pageNumber, pageSize: 20 },
    }))
    for (const target of missing) console.log(`人群包 ${target} 尚未出现在列表中，继续等待。`)
    return pending
  } finally {
    await closeBrowserContext(context)
    console.log('人群列表检查页面已关闭。')
  }
}

async function inspectInsightResults(names, storageState, options = {}) {
  const context = trackContext(await launchPlatformBrowser(storageState, options))
  try {
    const page = context.pages()[0] || await context.newPage()
    await page.goto('https://ruyi.qq.com/audience-profile/result/', { waitUntil: 'domcontentloaded', timeout: 60000 })
    if (!page.url().startsWith('https://ruyi.qq.com/audience-profile/result')) throw new Error('洞悉结果页面需要登录或未打开成功')
    // 列表接口支持按关键字过滤。直接查询接口比逐页读取 DOM 稳定，且
    // 能处理同名记录：平台可能同时保留旧的 LOCKING 记录和新的 SUCCESS
    // 记录，后续按更新时间选出与下载页一致的最新记录。
    // 不按状态过滤，否则未知的新状态会被隐藏，误取到历史 SUCCESS。
    const normalizedNames = [...new Set(names.map((name) => withoutExtension(name).replace(/\s+/g, ' ').trim()).filter(Boolean))]
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
        ],
      }
      const listing = await page.evaluate(requestPlatformListing, {
        url: '/api/insight/list', label: '洞悉列表', payload,
      })
      const items = listing.items
      const matched = items.filter((item) => {
        const itemName = String(item.name || '').replace(/\s+/g, ' ').trim()
        return itemName === target || itemName === withoutExtension(target)
      })
      // API 已按 lastModifiedTime 倒序返回。同名洞悉可能有多条历史记录，
      // 下载页同样默认选中第一条，因此只采用最新记录，不能因为历史
      // SUCCESS 记录存在就把当前最新的 LOCKING/PROCESSING 误判为完成。
      const latest = matched[0]
      const latestStatus = String(latest?.status || '').toUpperCase()
      // 记录还没出现在列表里时 latest 是 undefined，此时不能算完成，
      // 否则提交洞悉后立刻就会被判定为“结果已就绪”。
      if (pendingInsightResult(latest)) pendingCount += 1
      console.log(`洞悉任务 ${target} 当前状态：${latestStatus || '未找到'}${matched.length > 1 ? `（同名 ${matched.length} 条，按最新记录判断）` : ''}`)
    }
    console.log(`洞悉结果检查完成：未就绪 ${pendingCount} 个。`)
    return pendingCount
  } finally {
    await closeBrowserContext(context)
    console.log('洞悉结果检查页面已关闭。')
  }
}

module.exports = {
  inspectPlatformFiles, inspectAnalyseAudience, inspectInsightResults, trackContext, launchPlatformBrowser,
  countPendingAudiences, countPendingAudiencesTotal, pendingInsightResult, requestPlatformListing, inspectAudiencePages,
}
