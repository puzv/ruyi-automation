const { spawn } = require('node:child_process')
const { launchBrowser, closeBrowserContext } = require('../lib/browser.js')
const { withoutExtension } = require('./workspace')
const state = require('./state')

function launchPlatformBrowser() { return launchBrowser({ headless: state.headlessMode }) }

function trackContext(context) {
  state.activeContexts.add(context)
  context.on('close', () => {
    state.activeContexts.delete(context)
    state.loginContexts.delete(context)
  })
  return context
}

function openExternalUrl(url) {
  if (process.platform === 'darwin') spawn('open', ['-a', 'Google Chrome', url], { detached: true, stdio: 'ignore' }).unref()
  else if (process.platform === 'win32') spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref()
  else spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref()
}

function sleep(milliseconds) { return new Promise((resolve) => setTimeout(resolve, milliseconds)) }

/**
 * Fallback for the case where an existing Chrome process already owns the
 * persistent profile. We cannot observe its tab close event, so poll until
 * the profile is released, verify the just-finished site, then open exactly
 * one next login URL. This replaces the old missing.forEach(openUrl) behavior
 * that opened both login pages at once.
 */
async function advanceExternalLoginFlow(flow) {
  if (!flow || flow.cancelled || state.loginFlow !== flow || flow.transitioning) return
  flow.transitioning = true
  try {
    while (!flow.cancelled && state.loginFlow === flow) {
      // The external Chrome must release the profile before Playwright can
      // inspect cookies. A short grace period avoids racing window startup.
      await sleep(1500)
      if (!waitForProfileRelease({ timeoutMs: 0 })) continue
      let sites
      try { sites = await inspectLoginStatus() } catch (_) { continue }
      const current = flow.currentKey
      if (current && !sites[current]) {
        // The user closed the page before authentication completed. Reopen
        // only that page; never advance to the second site prematurely.
        openExternalUrl(loginTargets[current].url)
        continue
      }
      const next = flow.pending.shift()
      if (!next) {
        state.loginFlow = null
        return
      }
      flow.currentKey = next
      openExternalUrl(loginTargets[next].url)
      // Give Chrome time to acquire the lock before the next poll cycle.
      await sleep(1000)
    }
  } finally {
    flow.transitioning = false
  }
}

/**
 * Open missing login pages one at a time. A persistent context keeps the
 * profile locked until it is closed, so a page-close event must advance the
 * flow explicitly; waiting only for context.close() leaves the first page's
 * profile lock in place when the user closes a tab/window.
 */
async function advanceLoginFlow(flow) {
  if (!flow || flow.cancelled || flow.transitioning || state.loginFlow !== flow) return
  if (state.profileReleaseRunning) {
    flow.cancelled = true
    if (flow.closeWatch) clearInterval(flow.closeWatch)
    flow.closeWatch = null
    state.loginFlow = null
    return
  }
  flow.transitioning = true
  const currentContext = flow.context
  try {
    if (flow.closeWatch) {
      clearInterval(flow.closeWatch)
      flow.closeWatch = null
    }
    // Closing the current context releases Singleton* files before launching
    // the next one. This also handles a browser window close, where the
    // context has already begun shutting down by the time this runs.
    await closeBrowserContext(currentContext).catch(() => {})
    state.loginContexts.delete(currentContext)
    if (flow.cancelled || state.loginFlow !== flow || state.profileReleaseRunning) {
      flow.cancelled = true
      if (state.loginFlow === flow) state.loginFlow = null
      return
    }

    // Closing the login window flushes cookies to the persistent profile.
    // Verify the site that was just handled before advancing; if login was
    // incomplete, reopen the same site instead of silently moving on.
    let completed = true
    if (flow.currentKey) {
      try {
        const sites = await inspectLoginStatus()
        completed = Boolean(sites[flow.currentKey])
      } catch (_) {
        completed = false
      }
    }
    const nextKey = completed ? flow.pending.shift() : flow.currentKey
    if (!nextKey) {
      state.loginFlow = null
      return
    }

    const nextContext = trackContext(await launchBrowser({ headless: false }))
    flow.context = nextContext
    flow.currentKey = nextKey
    state.loginContexts.add(nextContext)
    const page = nextContext.pages()[0] || await nextContext.newPage()
    flow.page = page
    page.once('close', () => { advanceLoginFlow(flow).catch(() => {}) })
    nextContext.once('close', () => {
      state.loginContexts.delete(nextContext)
      advanceLoginFlow(flow).catch(() => {})
    })
    // page/context close events are normally sufficient. Keep a lightweight
    // watchdog as a compatibility fallback for Chrome builds that close the
    // native window without forwarding the page close event promptly.
    flow.closeWatch = setInterval(() => {
      if (state.loginFlow !== flow || flow.cancelled) {
        clearInterval(flow.closeWatch)
        flow.closeWatch = null
        return
      }
      if (page.isClosed() || nextContext.pages().every((item) => item.isClosed())) {
        clearInterval(flow.closeWatch)
        flow.closeWatch = null
        advanceLoginFlow(flow).catch(() => {})
      }
    }, 500)
    await page.goto(loginTargets[nextKey].url, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {})
  } catch (error) {
    if (flow.closeWatch) clearInterval(flow.closeWatch)
    flow.closeWatch = null
    await closeBrowserContext(flow.context).catch(() => {})
    state.loginContexts.delete(flow.context)
    state.loginFlow = null
    if (!flow.cancelled) flow.error = error
  } finally {
    flow.transitioning = false
  }
}

const loginTargets = {
  datanexus: {
    label: 'DataNexus',
    url: 'https://datanexus.qq.com/web/workbench/file/import?from=dmp_MD5_IFA',
    matches: (url) => url.hostname === 'datanexus.qq.com' && !/login|sso/i.test(`${url.pathname}${url.search}`),
  },
  ruyi: {
    label: '如翼',
    url: 'https://ruyi.qq.com/audience',
    matches: (url) => url.hostname === 'ruyi.qq.com' && !/login|sso|\/auth/i.test(`${url.pathname}${url.search}`),
  },
}

async function inspectLoginStatus() {
  // Always use the shared persistent profile so the probe sees exactly the
  // cookies/session that workflow scripts use.  A short retry handles the
  // small window in which Chrome is still releasing Singleton* files after a
  // previous context was closed.
  let context
  let lastError
  for (let attempt = 0; attempt < 3 && !context; attempt += 1) {
    try {
      context = trackContext(await launchBrowser({ headless: true }))
    } catch (error) {
      lastError = error
      if (!/ProcessSingleton|profile directory|already in use|Target page, context or browser has been closed/i.test(error.message || '')) throw error
      await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)))
    }
  }
  if (!context) throw lastError || new Error('无法启动登录状态检查浏览器')
  const sites = {}
  try {
    for (const [key, target] of Object.entries(loginTargets)) {
      // Use a fresh page per platform.  Reusing one page can preserve an
      // intermediate SSO redirect and make the second site look logged out.
      const page = context.pages()[0] && key === 'datanexus'
        ? context.pages()[0]
        : await context.newPage()
      try {
        const response = await page.goto(target.url, { waitUntil: 'domcontentloaded', timeout: 30000 })
        await page.waitForTimeout(1500)
        const currentUrl = new URL(page.url())
        const bodyText = await page.locator('body').innerText().catch(() => '')
        const hasLoginPrompt = /(请先登录|请登录|立即登录|扫码登录|账号登录|统一登录)/i.test(bodyText)
        // URL checks alone are insufficient: some SSO shells keep the
        // original path while rendering a login prompt.  Conversely, a 401
        // response must never be reported as authenticated.
        sites[key] = Boolean(response && response.status() < 400 && target.matches(currentUrl) && !hasLoginPrompt)
      } catch (_) {
        sites[key] = false
      }
      if (key !== 'datanexus') await page.close().catch(() => {})
    }
    return sites
  } finally {
    await closeBrowserContext(context)
  }
}

async function inspectPlatformFiles(type, names) {
  const url = type === 'pn'
    ? (process.env.RUYI_URL_PN_UPLOAD || 'https://ruyi.qq.com/audience/dnUpload?idType=MD5_MOBILE_PHONE')
    : type === 'idfa'
    ? 'https://ruyi.qq.com/audience/dnUpload?idType=MD5_IFA'
    : 'https://ruyi.qq.com/audience/dnUpload?idType=MD5_OAID'
  const context = trackContext(await launchPlatformBrowser())
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

async function inspectAnalyseAudience(names) {
  const context = trackContext(await launchPlatformBrowser())
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
    await closeBrowserContext(context)
    console.log('人群列表检查页面已关闭。')
  }
}

async function inspectInsightResults(names) {
  const context = trackContext(await launchPlatformBrowser())
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

module.exports = { loginTargets, inspectLoginStatus, advanceLoginFlow, advanceExternalLoginFlow, inspectPlatformFiles, inspectAnalyseAudience, inspectInsightResults, trackContext, openExternalUrl }
