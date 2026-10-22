import { requestJson } from './api.js'

const active = new Set()
const attempted = new Set()
const pending = new Set()
let generation = 0

export function resetResultDownloads() {
  generation++
  active.clear(); attempted.clear(); pending.clear()
}

export async function downloadJobResults(job) {
  if (job.task !== 'download' || job.status !== 'succeeded') return ''
  if (pending.has(job.id)) return ''
  const version = generation
  pending.add(job.id)
  try {
    await requestJson(`/api/jobs/${encodeURIComponent(job.id)}/results`)
    if (version !== generation) return ''
    // 交给浏览器直接接收附件，避免 fetch Blob 将整个 ZIP 留在页面内存中。
    const link = document.createElement('a')
    link.href = `/api/jobs/${encodeURIComponent(job.id)}/results.zip`
    link.download = `ruyi-results-${job.id}.zip`
    document.body.appendChild(link)
    link.click()
    link.remove()
    return '已发起 ZIP 下载；若浏览器拦截，请在“我的任务”中点击“重新下载”'
  } finally { if (version === generation) pending.delete(job.id) }
}

export async function observeResultJob(job) {
  if (job.task !== 'download') return ''
  if (['queued', 'running'].includes(job.status)) { active.add(job.id); return '' }
  const wasActive = active.delete(job.id)
  if (job.status !== 'succeeded' || !wasActive || attempted.has(job.id)) return ''
  attempted.add(job.id)
  return downloadJobResults(job)
}
