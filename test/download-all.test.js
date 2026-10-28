// 批量下载的结束判定：不在“全部下载完成”时必须以非零退出，
// 否则 Worker 会把任务记成 succeeded，“我的任务”里会出现成功但无文件的记录。
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { main } = require('@ruyi/automation/downloadAll')

function fixture(names) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-download-all-'))
  const donePath = path.join(root, 'done.json')
  fs.writeFileSync(donePath, `${JSON.stringify(names, null, 2)}\n`)
  return {
    root, donePath,
    read: () => JSON.parse(fs.readFileSync(donePath, 'utf8')),
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  }
}

function testAllCompleted() {
  const item = fixture(['a'])
  try {
    const logs = []
    const result = main({
      root: item.root, donePath: item.donePath, log: (line) => logs.push(line), preflight: false,
      // 成功下载会把名字从 done.json 移除。
      spawnDownload: () => { fs.writeFileSync(item.donePath, '[]\n'); return true },
    })
    assert.deepEqual(result, { ok: true, pending: 0 })
    assert.match(logs.join('\n'), /全部下载完成/)
  } finally { item.cleanup() }
}

function testStillProcessing() {
  // 平台仍在 PROCESSING：download.js 以 2 退出，done.json 不变。
  const item = fixture(['a'])
  try {
    const logs = []
    const result = main({
      root: item.root, donePath: item.donePath, log: (line) => logs.push(line), preflight: false,
      spawnDownload: () => false,
    })
    assert.deepEqual(result, { ok: false, pending: 1 },
      '未就绪时必须报告失败，调用方据此设置非零退出码')
    assert.match(logs.join('\n'), /本轮下载已暂停/)
    assert.deepEqual(item.read(), ['a'], '未就绪的任务必须保留在 done.json')
  } finally { item.cleanup() }
}

function testSuccessfulDownloadMustReduceQueue() {
  const item = fixture(['a'])
  try {
    const logs = []
    const result = main({
      root: item.root, donePath: item.donePath, log: (line) => logs.push(line), preflight: false,
      spawnDownload: () => true,
    })
    assert.deepEqual(result, { ok: false, pending: 1 })
    assert.match(logs.join('\n'), /清单没有减少/)
  } finally { item.cleanup() }
}

function testPartialCompletion() {
  // 两个任务，一个成功一个未就绪：仍算未完成。
  const item = fixture(['a', 'b'])
  try {
    let call = 0
    const result = main({
      root: item.root, donePath: item.donePath, log: () => {}, preflight: false,
      spawnDownload: () => {
        call += 1
        if (call === 1) { fs.writeFileSync(item.donePath, '["b"]\n'); return true }
        return false
      },
    })
    assert.deepEqual(result, { ok: false, pending: 1 })
    assert.deepEqual(item.read(), ['b'])
  } finally { item.cleanup() }
}

function testEmptyDone() {
  const item = fixture([])
  try {
    let calls = 0
    const result = main({
      root: item.root, donePath: item.donePath, log: () => {}, preflight: false,
      spawnDownload: () => { calls += 1; return true },
    })
    assert.deepEqual(result, { ok: true, pending: 0 })
    assert.equal(calls, 0, '没有待下载文件时不应启动浏览器')
  } finally { item.cleanup() }
}

function testRotatesAndEventuallyStops() {
  // 全部未就绪时轮转 done.json，遍历一轮后停止，不无限循环。
  const item = fixture(['a', 'b'])
  try {
    const order = []
    const result = main({
      root: item.root, donePath: item.donePath, log: () => {}, preflight: false,
      spawnDownload: () => { order.push(item.read()[0]); return false },
    })
    assert.deepEqual(result, { ok: false, pending: 2 })
    assert.deepEqual(order, ['a', 'b'], '每个任务在一轮内各尝试一次')
    assert.deepEqual([...item.read()].sort(), ['a', 'b'], '内容不变，只轮转顺序')
  } finally { item.cleanup() }
}

function main_() {
  testAllCompleted()
  testStillProcessing()
  testSuccessfulDownloadMustReduceQueue()
  testPartialCompletion()
  testEmptyDone()
  testRotatesAndEventuallyStops()
  console.log('批量下载结束判定测试通过：未全部完成时报告失败并保留 done.json')
}

main_()
