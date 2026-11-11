const { TASK_OUTCOME } = require('./task-outcome')

// 存储层保留非零退出事实；仅新整任务中明确的暂未就绪检查使用业务等待状态。
function isWaitingPlatform({ taskId, status, exitCode, exitSignal, stateExpired, loginRequired, errorMessage }) {
  return Boolean(taskId) && status === 'failed' && exitCode === TASK_OUTCOME.NOT_READY
    && !exitSignal && !stateExpired && !loginRequired && errorMessage !== '请先完成平台登录'
}

function isWaitingLogin({ taskId, status, exitSignal, stateExpired, loginRequired, errorMessage }) {
  return Boolean(taskId) && status === 'failed' && !exitSignal
    && Boolean(stateExpired || loginRequired || errorMessage === '请先完成平台登录')
}

module.exports = { isWaitingPlatform, isWaitingLogin }
