const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { randomUUID } = require('node:crypto')
const { pipeline } = require('node:stream/promises')
const { Writable } = require('node:stream')
const { execFileSync } = require('node:child_process')
const { beginResults, recordResult, finishResults, resultEntries, zipStream } = require('@ruyi/shared/runtime/job-results')

async function main() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-result-test-'))
  const root = path.join(base, 'data')
  const workspace = path.join(root, 'users', 'alice')
  fs.mkdirSync(workspace, { recursive: true })
  const id = randomUUID(), next = randomUUID(), empty = randomUUID()
  try {
    beginResults(workspace, id)
    assert.throws(() => resultEntries(workspace, id), /没有可下载/)
    const first = path.join(workspace, '中文结果.xlsx')
    const second = path.join(workspace, 'empty.csv')
    fs.writeFileSync(first, Buffer.from([0, 1, 255, 128, 66]))
    fs.writeFileSync(second, '')
    recordResult(workspace, id, first)
    recordResult(workspace, id, second)
    assert.throws(() => recordResult(workspace, id, first), /重名/)
    finishResults(workspace, id)
    fs.writeFileSync(first, '后续改变不影响旧任务')
    beginResults(workspace, next)
    recordResult(workspace, next, first)
    finishResults(workspace, next)
    beginResults(workspace, empty); finishResults(workspace, empty)
    assert.throws(() => resultEntries(workspace, empty), /没有可下载/)
    assert.throws(() => recordResult(workspace, id, first), /封存/)
    assert.throws(() => resultEntries(workspace, randomUUID()), /ENOENT/)
    assert.throws(() => beginResults(workspace, '../bad'), /编号/)
    const entries = resultEntries(workspace, id)
    const output = path.join(base, 'results.zip')
    await pipeline(zipStream(workspace, id, entries), fs.createWriteStream(output))
    assert.equal(fs.statSync(output).size, entries.size)
    // 由独立标准 ZIP 实现校验结构、CRC、中文文件名、空文件和精确内容。
    execFileSync('python3', ['-c', 'import zipfile,sys\nz=zipfile.ZipFile(sys.argv[1])\nassert z.namelist()==["中文结果.xlsx","empty.csv"]\nassert z.read("中文结果.xlsx")==bytes([0,1,255,128,66])\nassert z.read("empty.csv")==b""\nassert z.testzip() is None', output])
    const other = path.join(root, 'users', 'bob')
    fs.mkdirSync(other)
    assert.throws(() => resultEntries(other, id), /ENOENT/)

    const dir = path.join(workspace, 'job-results', id)
    const manifest = path.join(dir, 'manifest.json')
    const original = fs.readFileSync(manifest, 'utf8')
    assert.equal(JSON.parse(original).version, 2)
    assert.deepEqual(fs.readdirSync(dir).sort(), ['files', 'manifest.json'])
    for (const mutate of [
      (value) => { value.version = 1 },
      (value) => { value.files[0].name = '../escape' },
      (value) => { value.files[0].stored = '../escape' },
      (value) => { value.files[0].size = 0xffffffff },
      (value) => { value.files[0].size = 300 },
      (value) => { value.files[1].name = value.files[0].name },
    ]) {
      const value = JSON.parse(original); mutate(value)
      fs.writeFileSync(manifest, JSON.stringify(value))
      assert.throws(() => resultEntries(workspace, id))
    }
    fs.writeFileSync(manifest, original)
    for (const target of [manifest, path.join(dir, 'files', '中文结果.xlsx'), path.join(dir, 'files'), dir, path.dirname(dir), workspace, path.dirname(workspace), root]) {
      const moved = `${target}.test-saved`
      fs.renameSync(target, moved)
      fs.symlinkSync(moved, target)
      try { assert.throws(() => resultEntries(workspace, id), /路径不安全/) }
      finally { fs.unlinkSync(target); fs.renameSync(moved, target) }
    }

    // 中途取消时，生成器必须关闭已打开的归档文件。
    const originalOpen = fs.promises.open
    let opened = 0, closed = 0
    fs.promises.open = async (...args) => {
      const handle = await originalOpen(...args)
      opened++
      const close = handle.close.bind(handle)
      handle.close = async () => { closed++; return close() }
      return handle
    }
    try {
      const stream = zipStream(workspace, id, entries)
      for await (const _chunk of stream) break
      await new Promise((resolve) => setTimeout(resolve, 30))
      assert.ok(opened > 0)
      assert.equal(closed, opened)
    } finally { fs.promises.open = originalOpen }
    const rollback = randomUUID()
    beginResults(workspace, rollback)
    const rollbackDir = path.join(workspace, 'job-results', rollback)
    const rename = fs.renameSync
    fs.renameSync = () => { throw new Error('模拟清单失败') }
    try { assert.throws(() => recordResult(workspace, rollback, first), /模拟清单失败/) }
    finally { fs.renameSync = rename }
    assert.deepEqual(fs.readdirSync(path.join(rollbackDir, 'files')), [])
    assert.equal(fs.existsSync(path.join(rollbackDir, 'manifest.tmp')), false)
    recordResult(workspace, rollback, first)
    const existing = path.join(rollbackDir, 'files', '已有.csv')
    fs.writeFileSync(existing, '必须保留')
    assert.throws(() => recordResult(workspace, rollback, second, '已有.csv'), /已存在/)
    assert.equal(fs.readFileSync(existing, 'utf8'), '必须保留')
    assert.throws(() => recordResult(workspace, rollback, first, '../逃逸.xlsx'), /文件名无效/)
    assert.throws(() => recordResult(workspace, rollback, path.join(rollbackDir, 'files')), /普通文件/)
    const linked = path.join(base, 'source-link')
    fs.symlinkSync(first, linked)
    assert.throws(() => recordResult(workspace, rollback, linked), /普通文件/)
    const largeId = randomUUID()
    const large = path.join(workspace, '大文件.dat')
    const largeFd = fs.openSync(large, 'wx')
    const block = Buffer.alloc(256 * 1024, 42)
    try { for (let i = 0; i < 64; i++) fs.writeSync(largeFd, block) }
    finally { fs.closeSync(largeFd) }
    beginResults(workspace, largeId); recordResult(workspace, largeId, large); finishResults(workspace, largeId)
    const largeEntries = resultEntries(workspace, largeId)
    let bytes = 0, chunks = 0
    await pipeline(zipStream(workspace, largeId, largeEntries), new Writable({
      highWaterMark: 1024,
      write(chunk, _encoding, done) {
        assert.ok(chunk.length <= 64 * 1024, '结果必须分块读取')
        bytes += chunk.length; chunks++
        setImmediate(done)
      },
    }))
    assert.equal(bytes, largeEntries.size)
    assert.ok(chunks > 250, '慢速接收端也应分块处理大文件')
    console.log('任务结果隔离、归档、标准 ZIP 解压、路径安全和取消清理测试通过。')
  } finally { fs.rmSync(base, { recursive: true, force: true }) }
}
main().catch((error) => { console.error(error); process.exitCode = 1 })
