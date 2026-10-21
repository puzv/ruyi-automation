const path = require('node:path')
const { projectRoot } = require('@ruyi/shared/paths')
const { loadDotEnv } = require('../../../db/env')

if (!['RUYI_DB_HOST', 'RUYI_DB_USER', 'RUYI_DB_NAME', 'RUYI_STATE_KEY'].every((key) => process.env[key])) {
  loadDotEnv(path.join(projectRoot, '.env'))
}

const { createDb } = require('../../../db')
const { uploadRoot } = require('@ruyi/shared/config')
const { loadKeys } = require('@ruyi/shared/runtime/platform-state/crypto')
const { createWorker } = require('./index')

let db, worker, closing
async function stop() {
  if (closing) return closing
  closing = (async () => {
    try { await worker?.stop() } finally { await db?.destroy() }
  })()
  return closing
}

async function main() {
  const keys = loadKeys()
  db = createDb()
  worker = createWorker({ db, keys, dataRoot: uploadRoot, log: console })
  const shutdown = () => stop().catch(() => {
    console.error('Worker 停止失败')
    process.exitCode = 1
  })
  process.on('SIGTERM', shutdown)
  process.on('SIGINT', shutdown)
  await worker.start()
  console.info('Worker 已启动')
}

main().catch(async () => {
  console.error('Worker 启动失败，请检查数据库和登录态密钥配置')
  await stop()
  process.exitCode = 1
})
