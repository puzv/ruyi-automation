const assert = require('node:assert/strict')
const { isWaitingPlatform, isWaitingLogin } = require('../packages/shared/runtime/task-job-presentation')
const waiting = { taskId: 'business-task', status: 'failed', exitCode: 2 }
assert.equal(isWaitingPlatform(waiting), true)
for (const override of [
  { taskId: null }, { status: 'cancelled' }, { status: 'interrupted' }, { status: 'succeeded' },
  { exitCode: 1 }, { exitCode: null }, { exitCode: '2' }, { exitSignal: 'SIGTERM' },
  { stateExpired: true }, { loginRequired: true }, { errorMessage: '请先完成平台登录' },
]) assert.equal(isWaitingPlatform({ ...waiting, ...override }), false, JSON.stringify(override))
for (const reason of [{ stateExpired: 1 }, { loginRequired: true }, { errorMessage: '请先完成平台登录' }]) {
  assert.equal(isWaitingLogin({ ...waiting, ...reason }), true)
  for (const override of [{ taskId: null }, { status: 'cancelled' }, { status: 'interrupted' }, { exitSignal: 'SIGTERM' }]) {
    assert.equal(isWaitingLogin({ ...waiting, ...reason, ...override }), false)
  }
}
assert.equal(isWaitingLogin({ ...waiting, errorMessage: '请先完成平台登录，其他错误' }), false)
assert.equal(isWaitingLogin(waiting), false)
console.log('任务未就绪业务状态严格分类测试通过')
