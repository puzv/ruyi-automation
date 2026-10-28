// 平台检查的判定逻辑：不启动浏览器、不连数据库。
// 这些函数决定“要不要推进下一步”，判错会导致过早提交任务。
const assert = require('node:assert/strict')

const {
  countPendingAudiences, countPendingAudiencesTotal, pendingInsightResult, requestPlatformListing, inspectAudiencePages,
} = require('@ruyi/server/src/modules/files/platform')

const ACTIVE = new Set(['PROCESSING', 'LOCKING', 'FROZEN', 'ERROR', 'PENDING', 'WAITING', 'GENERATING', 'FAILED'])

function testAudienceStillMissing() {
  // 刚提交的人群包还没进列表：旧实现返回 0，会被当成“已就绪”而立刻提交洞悉。
  const targets = ['pzw_oaid_2169e211_1']
  const found = new Set()
  const unavailable = new Set()
  // 列表里只有其他人群，一个都没匹配上。
  const matched = countPendingAudiences(targets, [{ name: '别人的', status: 'SUCCESS' }], found, unavailable)
  assert.equal(matched, 0)
  const { pending, missing } = countPendingAudiencesTotal(targets, found, unavailable)
  assert.equal(pending, 1, '尚未出现在列表中必须算未就绪')
  assert.deepEqual(missing, targets)
}

function testAudienceProcessing() {
  const targets = ['a', 'b']
  const found = new Set()
  const unavailable = new Set()
  countPendingAudiences(targets, [{ name: 'a', status: 'PROCESSING' }], found, unavailable)
  const { pending, missing } = countPendingAudiencesTotal(targets, found, unavailable)
  assert.equal(pending, 2, 'a 计算中、b 未出现，都不能算就绪')
  assert.deepEqual(missing, ['b'])
}

function testAudienceFrontStatus() {
  // 保留两字段任一 PROCESSING 均待处理的规则，并归一化大小写与空白。
  const found = new Set()
  const unavailable = new Set()
  countPendingAudiences(['a'], [{ name: 'a', status: ' PROCESSING ', frontStatus: ' online ' }], found, unavailable)
  assert.deepEqual(countPendingAudiencesTotal(['a'], found, unavailable), { pending: 1, missing: [] })

  const processingFound = new Set()
  const processingUnavailable = new Set()
  countPendingAudiences(['a'], [{ name: 'a', status: 'SUCCESS', frontStatus: ' processing ' }], processingFound, processingUnavailable)
  assert.deepEqual(countPendingAudiencesTotal(['a'], processingFound, processingUnavailable), { pending: 1, missing: [] })
}

function testAudienceReady() {
  const targets = ['a', 'b']
  const found = new Set()
  const unavailable = new Set()
  countPendingAudiences(targets, [
    { name: 'a', status: 'SUCCESS' },
    { name: 'b', status: 'SUCCESS' },
  ], found, unavailable)
  const { pending, missing } = countPendingAudiencesTotal(targets, found, unavailable)
  assert.equal(pending, 0, '非 PROCESSING 状态不计入处理中')
  assert.deepEqual(missing, [])
}

function testAudienceNameWhitespace() {
  // 平台返回的名称可能带多余空白，比较前要归一化；平台名称包含目标名称也算匹配。
  const found = new Set()
  const unavailable = new Set()
  countPendingAudiences(['a b'], [{ name: '  prefix   a   b   suffix ', status: 'ONLINE' }], found, unavailable)
  assert.deepEqual(countPendingAudiencesTotal(['a b'], found, unavailable), { pending: 0, missing: [] })
}

function testAudienceNameBoundaries() {
  const targets = ['pzw_oaid_batch_1', 'pzw_oaid_batch_10']
  const found = new Set()
  const unavailable = new Set()
  countPendingAudiences(targets, [
    { name: 'pzw_oaid_batch_10', status: 'SUCCESS' },
    { name: 'prefix pzw_oaid_batch_1 suffix', status: 'PROCESSING' },
  ], found, unavailable)
  assert.deepEqual([...found].sort(), targets)
  assert.deepEqual([...unavailable], ['pzw_oaid_batch_1'])
  assert.deepEqual(countPendingAudiencesTotal(targets, found, unavailable), { pending: 1, missing: [] })

  const shortOnly = new Set()
  const shortUnavailable = new Set()
  countPendingAudiences(['pzw_oaid_batch_1'], [
    { name: 'pzw_oaid_batch_10', status: 'PROCESSING' },
  ], shortOnly, shortUnavailable)
  assert.deepEqual(countPendingAudiencesTotal(['pzw_oaid_batch_1'], shortOnly, shortUnavailable), {
    pending: 1, missing: ['pzw_oaid_batch_1'],
  })
}

function testInsightMissingRecord() {
  // 记录还没生成时 latest 是 undefined：旧实现 status 为 ''，不在 activeStatuses 里，
  // 于是被判为“结果已就绪”，自动推进立刻停机。
  assert.equal(pendingInsightResult(undefined, ACTIVE), true)
  assert.equal(pendingInsightResult(null, ACTIVE), true)
  assert.equal(pendingInsightResult({}, ACTIVE), true)
  assert.equal(pendingInsightResult({ status: '' }, ACTIVE), true)
}

function testInsightStatuses() {
  for (const status of ACTIVE) {
    assert.equal(pendingInsightResult({ status }, ACTIVE), true, `${status} 不能视为就绪`)
  }
  assert.equal(pendingInsightResult({ status: 'SUCCESS' }, ACTIVE), false)
  // 平台返回小写时也要正确判断。
  assert.equal(pendingInsightResult({ status: 'processing' }, ACTIVE), true)
  assert.equal(pendingInsightResult({ status: 'success' }, ACTIVE), false)
}

function testInsightUnknownStatus() {
  // 未知状态不能乐观当成完成，否则会提前停机让用户看到不存在的下载。
  assert.equal(pendingInsightResult({ status: 'SOMETHING_NEW' }, ACTIVE), true,
    '未知状态不能算就绪')
}

async function testListingResponses() {
  for (const label of ['人群列表', '洞悉列表']) {
    const request = { label, url: '/fake', payload: {} }
    const reply = (body, options = {}) => async () => ({ ok: true, status: 200, json: async () => body, ...options })
    assert.deepEqual(await requestPlatformListing(request, reply({ code: 0, data: { listing: { items: [] } } })), { items: [] })
    assert.deepEqual(await requestPlatformListing(request, reply({ success: true, data: { listing: { items: [] } } })), { items: [] })
    await assert.rejects(requestPlatformListing(request, reply({}, { ok: false, status: 503 })), /HTTP 503/)
    await assert.rejects(requestPlatformListing(request, reply({}, { json: async () => { throw new Error('bad JSON') } })), /JSON 无效/)
    await assert.rejects(requestPlatformListing(request, async () => { throw new Error('网络失败') }), /网络失败/)
    for (const body of [null, [], {}, { success: false }, { code: 9 }, { success: true, code: 9 },
      { success: true }, { code: 0, data: {} }, { code: 0, data: { listing: { items: null } } },
      { success: true, data: { listing: { items: {} } } }, { success: true, data: { listing: { items: [null] } } }]) {
      await assert.rejects(requestPlatformListing(request, reply(body)), /接口/)
    }
  }
}

async function testAudiencePagination() {
  let pages = []
  const found = await inspectAudiencePages(['target'], async (page) => {
    pages.push(page)
    return { items: [{ name: page === 4 ? 'target' : 'other', status: 'SUCCESS' }] }
  })
  assert.deepEqual(pages, [1, 2, 3, 4], '连续三页无匹配后仍须查第四页')
  assert.equal(found.pending, 0)
  assert.deepEqual(await inspectAudiencePages(['missing'], async () => ({ items: [] })), { pending: 1, missing: ['missing'] })
  pages = []
  const capped = await inspectAudiencePages(['missing'], async (page) => {
    pages.push(page)
    return { items: [{ name: 'other', status: 'SUCCESS' }] }
  })
  assert.equal(pages.length, 200)
  assert.equal(capped.pending, 1, '达到安全上限仍未找到的目标不能就绪')
  pages = []
  await inspectAudiencePages(['missing'], async (page) => {
    pages.push(page)
    return { total: 40, items: [{ name: 'other', status: 'SUCCESS' }] }
  })
  assert.deepEqual(pages, [1, 2], '可信总条数可结束分页')
}

async function testAudienceNumberedBatchPagination() {
  const targets = Array.from({ length: 26 }, (_, index) => `puzw_oaid_09149fe5_${index + 1}`).sort()
  const items = targets.map((name) => ({ name, status: 'ONLINE', frontStatus: 'ONLINE' }))
  // 线上同序名称全在线时，旧包含匹配仍只找到 9 个，漏掉的 17 个误计为待处理。
  const legacyFound = new Set(items.map(({ name }) => targets.find((target) => name === target || name.includes(target))))
  assert.equal(legacyFound.size, 9)
  assert.deepEqual(countPendingAudiencesTotal(targets, legacyFound, new Set()).pending, 17)

  const pages = []
  const result = await inspectAudiencePages(targets, async (page) => {
    pages.push(page)
    return { total: items.length, items: items.slice((page - 1) * 20, page * 20) }
  })
  assert.deepEqual(pages, [1, 2])
  assert.deepEqual(result, { pending: 0, missing: [] }, '26 个在线人群均应按自身名称匹配')
}

function testAudienceOnlyProcessingPending() {
  // 在线、成功及其它非 PROCESSING 状态都不能计入处理中。
  for (const item of [{ name: 'a' }, { name: 'a', status: 'ONLINE' }, { name: 'a', status: 'SUCCESS' },
    { name: 'a', status: 'UNKNOWN' }, { name: 'a', status: 'ERROR' }]) {
    const found = new Set()
    const unavailable = new Set()
    countPendingAudiences(['a'], [item], found, unavailable)
    assert.equal(countPendingAudiencesTotal(['a'], found, unavailable).pending, 0)
  }
  const found = new Set()
  const unavailable = new Set()
  countPendingAudiences(['a'], [{ name: 'a', status: 'PROCESSING' }], found, unavailable)
  assert.equal(countPendingAudiencesTotal(['a'], found, unavailable).pending, 1)
  const frontFound = new Set()
  const frontUnavailable = new Set()
  countPendingAudiences(['a'], [{ name: 'a', frontStatus: 'PROCESSING' }], frontFound, frontUnavailable)
  assert.equal(countPendingAudiencesTotal(['a'], frontFound, frontUnavailable).pending, 1)
}

async function main() {

  testAudienceStillMissing()
  testAudienceProcessing()
  testAudienceFrontStatus()
  testAudienceReady()
  testAudienceNameWhitespace()
  testAudienceNameBoundaries()
  testInsightMissingRecord()
  testInsightStatuses()
  testInsightUnknownStatus()
  testAudienceOnlyProcessingPending()
  await testListingResponses()
  await testAudiencePagination()
  await testAudienceNumberedBatchPagination()
  console.log('平台检查判定测试通过：人群未出现、计算中、洞悉记录缺失都不会被误判为就绪')
}

main().catch((error) => { console.error(error); process.exitCode = 1 })
