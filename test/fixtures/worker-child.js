const path = require('node:path')
const { spawn } = require('node:child_process')
const { createDb, readDbConfig } = require('../../db')
const { loadKeys } = require('../../server/platform-state/crypto')
const { createWorker } = require('../../server/worker')

const config = readDbConfig()
if (config.host !== '127.0.0.1' || config.port !== 3306 || config.database !== 'ruyi_test'
  || config.user !== 'ruyi' || config.password !== 'ruyi') throw new Error('只允许本机测试库')
const db = createDb(config)
const worker = createWorker({ db, keys: loadKeys(), dataRoot: process.env.FAKE_DATA_ROOT,
  workerId: `测试子进程:${process.pid}`, pollMs: 20,
  runnerOptions: { scriptPaths: { upload: path.join(__dirname, 'fake-job.js') },
    env: { FAKE_JOB_MODE: 'sleep', FAKE_JOB_IGNORE_TERM: '1' },
    spawnImpl(command, args, options) {
      // 仅通过测试进程 IPC 核验清理；绝不进入日志或业务响应。
      process.send({ stateDir: path.dirname(options.env.RUYI_STATE_FILE) })
      return spawn(command, args, options)
    },
  },
})
const stop = async () => { await worker.stop(); await db.destroy() }
process.once('SIGTERM', () => stop().then(() => process.exit(0)))
worker.start().catch(async () => { await stop(); process.exit(1) })
