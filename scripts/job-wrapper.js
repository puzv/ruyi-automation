const { spawn } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

let terminating = false
let parentGone = false
function terminateGroup() {
  if (terminating) return
  terminating = true
  // 包装器也在组内；保留它直到强杀，覆盖忽略 SIGTERM 的后代。
  setTimeout(() => {
    // Worker 崩溃后无人执行 finally，由包装器清理本次任务的明文。
    const file = process.env.RUYI_STATE_FILE
    if (parentGone && file && path.dirname(path.dirname(file)) === os.tmpdir()
      && path.basename(path.dirname(file)).startsWith('ruyi-state-')) {
      try { fs.rmSync(path.dirname(file), { recursive: true, force: true }) } catch (_) { /* 仍须终止进程组。 */ }
    }
    process.kill(-process.pid, 'SIGKILL')
  }, 5000)
  process.kill(-process.pid, 'SIGTERM')
}

function disconnected() {
  parentGone = true
  terminateGroup()
}
process.on('disconnect', disconnected)
process.on('SIGTERM', terminateGroup)
process.on('SIGINT', terminateGroup)

function finish(code, signal) {
  if (terminating) return
  process.removeListener('disconnect', disconnected)
  if (process.connected) process.disconnect()
  if (signal) {
    process.removeAllListeners(signal)
    process.kill(process.pid, signal)
    return
  }
  process.exit(code ?? 1)
}
if (!process.connected) {
  disconnected()
} else {
  const child = spawn(process.execPath, [process.argv[2]], { stdio: 'inherit' })
  child.on('error', () => {
    console.error('任务进程启动失败，请联系管理员')
    finish(1)
  })
  child.on('exit', finish)
}
