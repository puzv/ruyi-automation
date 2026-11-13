const LIST_PATH = '/api/audience/list'
const DELETE_PATH = '/api/audience/delete'
const TIMEOUT = 15000
const SEARCH = '搜索人群名称/ID'

function matches(response, pathname) {
  try { const url = new URL(response.url()); return response.request().method() === 'POST'
    && url.protocol === 'https:' && url.hostname === 'ruyi.qq.com' && url.pathname === pathname }
  catch (_) { return false }
}
function payload(response) {
  try { return response.request().postDataJSON() } catch (_) { return null }
}
async function success(response) {
  if (!response.ok()) throw new Error('平台响应失败')
  const body = await response.json()
  if (body.success !== true || body.code !== 0) throw new Error('平台操作未确认成功')
  return body
}
async function ready(page) {
  const input = page.getByPlaceholder(SEARCH, { exact: true })
  await input.waitFor({ state: 'visible', timeout: TIMEOUT })
  // 登录后才出现的列表搜索框须持续可用，避免登录跳转瞬间被误认为就绪。
  const until = Date.now() + 3000
  while (Date.now() < until) {
    if (!await input.isVisible() || !await input.isEnabled()) throw new Error('平台尚未就绪')
    await page.waitForTimeout(100)
  }
}
async function search(page, name) {
  const responsePromise = page.waitForResponse((response) => matches(response, LIST_PATH)
    && payload(response)?.searchKey === name, { timeout: TIMEOUT })
  responsePromise.catch(() => {})
  const input = page.getByPlaceholder(SEARCH, { exact: true })
  await input.fill(name)
  await input.press('Enter')
  const body = await success(await responsePromise)
  const total = body.data?.listing?.total
  if (!Number.isSafeInteger(total) || total < 0) throw new Error('无法确认搜索结果总数')
  const items = body.data?.listing?.items
  if (!Array.isArray(items) || items.length !== total || items.some((item) => typeof item.name !== 'string')) throw new Error('搜索结果未完整返回，无法确认人群')
  const exact = items.filter((item) => item.name === name)
  if (exact.length > 1) throw new Error('搜索结果无法唯一定位人群')
  // 网络返回先于框架渲染；必须等列表与本次响应一致，不能以旧列表或加载中的空表判断。
  await page.waitForFunction(({ expected }) => {
    const names = [...document.querySelectorAll('tbody tr .name .txt')].map((el) => el.textContent.trim())
    return names.length === expected
  }, { expected: total, target: name }, { timeout: TIMEOUT })
  await page.waitForTimeout(300)
  const rows = page.locator('tbody tr').filter({ has: page.locator('.name .txt').filter({ hasText: new RegExp(`^${name}$`) }) })
  const allNames = (await page.locator('tbody tr .name .txt').allTextContents()).map((text) => text.trim()).sort()
  const returnedNames = items.map((item) => item.name).sort()
  if (JSON.stringify(allNames) !== JSON.stringify(returnedNames)) throw new Error('搜索结果不一致')
  if (await rows.count() !== exact.length) throw new Error('人群名称无法唯一确认')
  return { total: exact.length, row: rows.first(), platformId: exact.length ? exact[0].id : null }
}
function checked(page) { return page.locator('tbody input[type="checkbox"]:checked') }

async function deleteAudience(context, name, { beforeDelete } = {}) {
  if (typeof name !== 'string' || !/^[a-zA-Z0-9_]{1,30}$/.test(name)
    || (beforeDelete !== undefined && typeof beforeDelete !== 'function')) throw new Error('自动清理人群参数无效')
  let page
  try {
    page = await context.newPage()
    await page.goto('https://ruyi.qq.com/audience', { waitUntil: 'domcontentloaded', timeout: TIMEOUT })
    await ready(page)
    const found = await search(page, name)
    if (!found.total) return { deleted: false, absent: true }
    if (await checked(page).count()) throw new Error('列表包含额外选中人群')
    const checkbox = found.row.locator('input[type="checkbox"]')
    if (await checkbox.count() !== 1) throw new Error('无法确认人群复选框')
    const value = await checkbox.getAttribute('value')
    const audienceId = Number(value)
    if (!/^[1-9]\d*$/.test(value || '') || !Number.isSafeInteger(audienceId)) throw new Error('平台人群编号无效')
    if (String(found.platformId) !== value) throw new Error('搜索结果与选中人群编号不一致')
    await found.row.locator('label.spaui-checkbox').click()
    if (await checked(page).count() !== 1 || await checked(page).getAttribute('value') !== value) throw new Error('选中人群不一致')
    if (beforeDelete) await beforeDelete()
    await page.locator('div.ndmp-batch-operation-bar__btn').filter({ hasText: /^删除$/ }).click()
    const dialog = page.locator('.spaui-dialog.del-audience:visible')
    await dialog.waitFor({ state: 'visible', timeout: TIMEOUT })
    if (await dialog.count() !== 1 || (await dialog.locator('.del-audience__desc').innerText()).trim()
      !== `确认删除人群 “${name}” ？删除后将不可恢复`) throw new Error('删除确认内容不一致')
    if (await checked(page).count() !== 1 || await checked(page).getAttribute('value') !== value) throw new Error('选中人群已变化')
    if (beforeDelete) await beforeDelete()
    let rejectUnsafe
    const unsafeRequest = new Promise((_, reject) => { rejectUnsafe = reject })
    await page.route('**/api/audience/delete*', async (route) => {
      const request = route.request()
      let data
      try { data = request.postDataJSON() } catch (_) {}
      const url = new URL(request.url())
      if (url.protocol !== 'https:' || url.hostname !== 'ruyi.qq.com' || url.pathname !== DELETE_PATH || request.method() !== 'POST'
        || !Array.isArray(data?.audienceIds) || data.audienceIds.length !== 1 || data.audienceIds[0] !== audienceId) {
        rejectUnsafe(new Error('已阻止不匹配的人群删除请求'))
        return route.abort()
      }
      return route.fallback()
    })
    const deletion = Promise.race([page.waitForResponse((response) => matches(response, DELETE_PATH), { timeout: TIMEOUT }), unsafeRequest])
    deletion.catch(() => {})
    await dialog.getByRole('button', { name: '删除', exact: true }).click()
    const response = await deletion
    const ids = payload(response)?.audienceIds
    if (!Array.isArray(ids) || ids.length !== 1 || ids[0] !== audienceId) throw new Error('删除请求人群不一致')
    await success(response)
    // 重载后重新搜索，避免相同关键词不触发查询，也不依赖删除后的乐观更新。
    await page.reload({ waitUntil: 'domcontentloaded', timeout: TIMEOUT })
    const remaining = await search(page, name)
    if (remaining.total) throw new Error('平台尚未确认人群已删除')
    return { deleted: true, absent: false }
  } catch (_) {
    throw Object.assign(new Error('平台人群自动清理未完成，已保留任务进度，请稍后重试'), { code: 'AUDIENCE_CLEANUP_FAILED' })
  } finally {
    if (page) await page.close().catch(() => {})
  }
}
module.exports = { deleteAudience }
