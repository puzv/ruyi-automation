const taskStore = require('@ruyi/shared/runtime/task-file-store')
const { launchBrowser, closeBrowserContext } = require('./browser')

// 清理是洞悉之后的附属操作，失败不能回退洞悉阶段或阻断结果下载。
async function cleanupTaskAudiences({ context, fileId, log = console.log,
  store = taskStore, removeAudience, openBrowser = launchBrowser, closeBrowser = closeBrowserContext } = {}) {
  if (!store.enabled()) return { deleted: 0, failed: 0 }
  let candidates
  try {
    candidates = await store.cleanupCandidates()
    if (fileId) candidates = candidates.filter((row) => row.id === fileId)
  } catch (_) {
    log('平台人群自动清理暂不可用，已保留洞悉进度，不影响后续下载。')
    return { deleted: 0, failed: 1 }
  }
  if (!candidates.length) return { deleted: 0, failed: 0 }
  let ownedContext = false, deleted = 0, failed = 0
  try {
    if (!context) { context = await openBrowser(); ownedContext = true }
    const remove = removeAudience || require('./audience-cleanup').deleteAudience
    for (const row of candidates) {
      try {
        const current = await store.assertCleanupEligible(row.id)
        if (current.platform_name !== row.platform_name) throw new Error('任务人群映射已变化')
        const result = await remove(context, row.platform_name, { beforeDelete: async () => {
          const latest = await store.assertCleanupEligible(row.id)
          if (latest.platform_name !== row.platform_name) throw new Error('任务人群映射已变化')
        } })
        if (result?.deleted !== true && result?.absent !== true) throw new Error('平台人群清理结果未确认')
        await store.markAudienceDeleted(row.id)
        deleted += 1
        log(`已自动清理平台人群：${row.platform_name}`)
      } catch (_) {
        failed += 1
        // 不输出浏览器/数据库原始错误，避免异常响应带出敏感信息。
        log(`平台人群自动清理未完成：${row.platform_name}，已保留洞悉进度，后续流程将再次尝试。`)
      }
    }
  } catch (_) {
    failed += candidates.length
    log('平台人群自动清理暂不可用，已保留洞悉进度，不影响后续下载。')
  } finally {
    if (ownedContext) await closeBrowser(context).catch(() => {})
  }
  return { deleted, failed }
}
module.exports = { cleanupTaskAudiences }
