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
  // 失败的下载任务若已有归档文件，同样允许手动取回；自动下载只针对成功的任务。
  if (job.task !== 'download' || !['succeeded', 'failed'].includes(job.status)) return ''
  if (pending.has(job.id)) return ''
  // 服务端返回了归档文件数：0 表示这次任务其实没有产出文件（早期版本会把
  // 未就绪的下载记成成功）。此时不发起请求，直接给出可理解的提示。
  if (job.resultFiles === 0) return ''
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
