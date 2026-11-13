const assert = require('node:assert/strict')
const { cleanupTaskAudiences } = require('../packages/automation/lib/task-audience-cleanup')

async function main() {
  const events = [], messages = []
  let active = true, candidates = [{ id: 'file-1', platform_name: 'alice_oaid_task_1' }]
  const store = {
    enabled: () => active,
    cleanupCandidates: async () => candidates,
    assertCleanupEligible: async (id) => { events.push(`check:${id}`); return candidates.find((r) => r.id === id) },
    markAudienceDeleted: async (id) => { events.push(`saved:${id}`); candidates = candidates.filter((r) => r.id !== id) },
  }
  const options = { store, log: (message) => messages.push(message),
    openBrowser: async () => { events.push('open'); return { fake: true } },
    closeBrowser: async () => { events.push('close') },
    removeAudience: async (_context, name, { beforeDelete }) => {
      assert.equal(name, 'alice_oaid_task_1')
      await beforeDelete()
      events.push(`delete:${name}`)
      return { deleted: true, absent: false }
    } }
  active = false
  assert.deepEqual(await cleanupTaskAudiences(options), { deleted: 0, failed: 0 })
  assert.deepEqual(events, [])
  active = true
  assert.deepEqual(await cleanupTaskAudiences(options), { deleted: 1, failed: 0 })
  assert.deepEqual(events, ['open', 'check:file-1', 'check:file-1', 'delete:alice_oaid_task_1', 'saved:file-1', 'close'])
  events.length = 0
  await cleanupTaskAudiences(options)
  assert.deepEqual(events, [], '空候选不得启动浏览器')
  candidates = [{ id: 'file-1', platform_name: 'alice_oaid_task_1' }]
  events.length = 0
  const externalContext = { fake: true }
  await cleanupTaskAudiences({ ...options, context: externalContext, fileId: 'other' })
  assert.deepEqual(events, [], '单文件清理不得删除其他文件人群')
  const failed = await cleanupTaskAudiences({ ...options, context: externalContext,
    removeAudience: async () => { throw new Error('sensitive cookie') } })
  assert.deepEqual(failed, { deleted: 0, failed: 1 })
  assert.equal(candidates.length, 1, '清理失败仍有待办供下载轮次重试')
  assert.deepEqual(await cleanupTaskAudiences({ ...options, context: externalContext,
    removeAudience: async () => undefined }), { deleted: 0, failed: 1 }, '未确认删除结果不能标记已删除')
  assert.equal(messages.some((message) => message.includes('sensitive')), false)
  assert.equal(events.includes('close'), false, '复用的业务浏览器不能由清理适配器关闭')
  store.assertCleanupEligible = async () => { throw new Error('租约失效') }
  let called = false
  await cleanupTaskAudiences({ ...options, removeAudience: async () => { called = true } })
  assert.equal(called, false, '失效租约禁止平台删除')
  store.assertCleanupEligible = async () => ({ id: 'file-1', platform_name: 'changed_name' })
  await cleanupTaskAudiences({ ...options, removeAudience: async () => { called = true } })
  assert.equal(called, false, '映射变化禁止平台删除')
  store.cleanupCandidates = async () => { throw new Error('数据库故障') }
  assert.deepEqual(await cleanupTaskAudiences(options), { deleted: 0, failed: 1 })
  console.log('自动清理接入测试通过：无上下文不删、数据库候选、精确映射、双租约复核、失败保留待办与浏览器生命周期')
}
module.exports = main()
module.exports.catch((error) => { console.error(error); process.exitCode = 1 })
