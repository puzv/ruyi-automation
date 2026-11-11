const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const vm = require('node:vm')
const { createRequire } = require('node:module')
const { randomUUID } = require('node:crypto')
const { EventEmitter } = require('node:events')

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-runner-adapter-'))
  const taskId = randomUUID(), user = { id: 7, username: 'runner_test', status: 'active' }
  const taskRoot = path.join(root, 'users', user.username, 'tasks', taskId)
  fs.mkdirSync(path.join(taskRoot, 'raw', '1'), { recursive: true })
  const file = { id: randomUUID(), original_name: 'oaid_原始.txt', original_path: 'raw/1/immutable.txt', platform_name: 'runner_test_oaid_12345678_1', current_path: 'execution/oaid/runner_test_oaid_12345678_1.txt', stage: 'pending' }
  fs.writeFileSync(path.join(taskRoot, file.original_path), 'fabricated-test-data')
  const captures = []
  const sourceFile = path.resolve(__dirname, '../apps/worker/src/runner.js'), originalRequire = createRequire(sourceFile)
  const sandbox = { module: { exports: {} }, Buffer, require(name) {
    if (name === '@ruyi/shared/runtime/repos/users') return { async findById() { return user } }
    if (name === '@ruyi/shared/runtime/repos/jobs') return { async setLogPath() { return true } }
    if (name === '@ruyi/shared/runtime/platform-state/index') return { async loadUserState() { return { state: { cookies: [], origins: [] }, version: 1 } } }
    if (name === '@ruyi/shared/runtime/repos/tasks') return {
      async listTaskFiles() { return [file, { original_name: 'pn_删除.txt', excluded_at: new Date() }] },
    }
    if (name === '@ruyi/shared/runtime/repos/task-execution') return {
      async prepareMappings() { return [file] },
      async pendingFiles(_db, ctx, step) {
        assert.equal(ctx.taskClaimToken, 'whole-lease')
        return ({ upload: ['pending', 'uploading'], create: ['uploaded'], analyse: ['created'], download: ['analysed'] })[step].includes(file.stage) ? [file] : []
      },
    }
    return originalRequire(name)
  } }
  vm.runInNewContext(fs.readFileSync(sourceFile, 'utf8'), sandbox, { filename: sourceFile })
  const { runJob } = sandbox.module.exports
  let scriptStep, notReady = false
  const run = (step) => {
    scriptStep = step
    return runJob({ job: { id: randomUUID(), task_id: taskId, task: step, user_id: user.id, headless: true, claim_token: 'fake-lease', task_claim_token: 'whole-lease' }, dataRoot: root,
      spawnImpl(_command, _args, options) {
        captures.push(options.env)
        const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter()
        setImmediate(() => {
          const workspace = options.env.RUYI_UPLOAD_DIR
          assert.equal(workspace, path.join(taskRoot, 'execution'))
          assert.equal(options.env.RUYI_JOB_ID, taskId)
          assert.equal(options.env.RUYI_TASK_ID, taskId)
          assert.equal(options.env.RUYI_USER_ID, String(user.id))
          assert.equal(options.env.RUYI_JOB_CLAIM_TOKEN, 'fake-lease')
          assert.equal(options.env.RUYI_TASK_CLAIM_TOKEN, 'whole-lease')
          if (scriptStep === 'upload') {
            assert.deepEqual(fs.readdirSync(path.join(workspace, 'raw')), [])
            fs.mkdirSync(path.join(workspace, 'oaid', 'done'), { recursive: true })
            const destination = `oaid/done/${file.platform_name}.txt`
            fs.renameSync(path.join(taskRoot, file.current_path), path.join(workspace, destination))
            Object.assign(file, { current_path: `execution/${destination}`, stage: 'uploaded' })
          } else if (!notReady) {
            file.stage = 'created'
          }
          child.emit('close', notReady ? 2 : 0, null)
        })
        return child
      },
    })
  }
  assert.equal((await run('upload')).status, 'succeeded')
  notReady = true
  const wait = await run('create')
  assert.equal(wait.outcome, 'not_ready'); assert.equal(wait.exitCode, 2)
  notReady = false
  assert.equal((await run('create')).status, 'succeeded')
  assert.ok(captures.every((env) => env.RUYI_JOB_ID === taskId))
  assert.equal(fs.readFileSync(path.join(taskRoot, file.original_path), 'utf8'), 'fabricated-test-data')
  assert.deepEqual(fs.readdirSync(path.join(taskRoot, 'execution', 'raw')), [], '重试不能从原件再次生成上传副本')
  assert.equal(file.stage, 'created')
  assert.equal(file.current_path, `execution/oaid/done/${file.platform_name}.txt`)
  assert.equal(fs.readdirSync(path.join(taskRoot, 'execution')).some((name) => name.endsWith('.json')), false, '整任务不生成JSON状态文件')
  assert.equal(fs.readdirSync(path.join(taskRoot, 'execution', 'logs')).length, 3)
  console.log('真实runner与fake spawn适配测试通过：任务执行目录、稳定任务命名、NOT_READY、重试无重复上传、文件进度与日志落盘')
}
main().catch((error) => { console.error(error); process.exitCode = 1 })
