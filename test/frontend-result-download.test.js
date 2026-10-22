const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

async function main() {
  const source = fs.readFileSync(path.join(__dirname, '../apps/web/src/result-download.js'), 'utf8')
    .replace(/^import .*$/gm, '').replace(/^export /gm, '')
  let calls = 0, clicks = 0, fail = false, gate
  const links = []
  const api = vm.runInNewContext(`${source}\n;({observeResultJob, downloadJobResults, resetResultDownloads})`, {
    async requestJson(url) { calls++; if (gate) await gate; if (fail) throw new Error('归档不可用'); assert.match(url, /\/api\/jobs\/[^/]+\/results$/); return { ok: true } },
    document: {
      createElement(type) { assert.equal(type, 'a'); const link = { click() { clicks++ }, remove() {} }; links.push(link); return link },
      body: { appendChild() {} },
    }, encodeURIComponent,
  })
  const job = { id: 'test-job', task: 'download', status: 'succeeded' }
  await api.observeResultJob(job)
  assert.equal(calls, 0, '初次加载历史任务不能自动下载')
  await api.observeResultJob({ ...job, status: 'queued' })
  await api.observeResultJob({ ...job, status: 'running' })
  const responses = await Promise.all([api.observeResultJob(job), api.observeResultJob(job)])
  assert.equal(clicks, 1, '操作面板和任务列表共享一次自动下载机会')
  assert.match(responses[0], /已发起/)
  assert.equal(links[0].href, '/api/jobs/test-job/results.zip')
  await api.observeResultJob({ ...job, status: 'running' })
  await api.observeResultJob(job)
  assert.equal(clicks, 1, '过期轮询不能重复下载')
  await api.downloadJobResults(job)
  assert.equal(clicks, 2, '手动重新下载可重复使用')
  await api.observeResultJob({ ...job, id: 'failed', status: 'running' })
  await api.observeResultJob({ ...job, id: 'failed', status: 'failed' })
  await api.observeResultJob({ ...job, task: 'upload' })
  assert.equal(clicks, 2)
  fail = true
  await api.observeResultJob({ ...job, id: 'retry', status: 'running' })
  await assert.rejects(api.observeResultJob({ ...job, id: 'retry' }), /归档不可用/)
  fail = false
  await api.downloadJobResults({ ...job, id: 'retry' })
  assert.equal(clicks, 3)
  gate = new Promise((resolve) => { setTimeout(resolve, 10) })
  const download = api.downloadJobResults(job)
  api.resetResultDownloads()
  await download
  assert.equal(clicks, 3, '退出登录后不能继续发起下载')
  await api.observeResultJob(job)
  assert.equal(clicks, 3)
  console.log('ZIP 自动下载、历史任务、跨页去重、重新下载和退出登录测试通过。')
}
main().catch((error) => { console.error(error); process.exitCode = 1 })
