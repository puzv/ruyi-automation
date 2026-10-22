const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const file = process.env.RUYI_STATE_FILE
assert.equal(fs.statSync(file).mode & 0o777, 0o600)
assert.equal(fs.statSync(path.dirname(file)).mode & 0o777, 0o700)
assert.ok(process.env.RUYI_JOB_ID)
assert.ok(process.env.RUYI_USER)
console.log(`假任务开始 PID=${process.pid}`)
console.log(`运行模式=${process.env.RUYI_HEADLESS}`)
console.error('假任务标准错误')

const mode = process.env.FAKE_JOB_MODE || 'ok'
if (mode === 'result' || mode === 'result-fail') {
  const workspace = process.env.RUYI_UPLOAD_DIR
  const { saveDownloadedFile } = require('@ruyi/automation/lib/file-manifest')
  const source = path.join(workspace, `source-${process.env.RUYI_JOB_ID}.tmp`)
  fs.writeFileSync(source, '测试结果内容')
  saveDownloadedFile(workspace, 'legacy', `结果-${process.env.RUYI_JOB_ID}.xlsx`, source)
  fs.unlinkSync(source)
}
if (mode === 'rewrite-state') fs.writeFileSync(file, JSON.stringify({ cookies: [], origins: [] }))
if (mode === 'logout') {
  fs.writeFileSync(`${file}.logged-out`, '', { mode: 0o600 })
  fs.writeFileSync(file, JSON.stringify({ cookies: [], origins: [] }))
}
if (process.env.FAKE_JOB_IGNORE_TERM === '1') process.on('SIGTERM', () => {})
setTimeout(() => {
  console.log('假任务结束')
  process.exit(mode === 'fail' || mode === 'result-fail' ? 2 : 0)
}, mode === 'sleep' ? 60000 : Number(process.env.FAKE_JOB_DELAY || 20))
