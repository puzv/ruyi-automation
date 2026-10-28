'use strict'

const assert = require('node:assert/strict')
const { TASK_OUTCOME, outcomeLabel } = require('@ruyi/shared/runtime/task-outcome')

assert.deepEqual(TASK_OUTCOME, { SUCCESS: 0, FAILURE: 1, NOT_READY: 2 })
assert.equal(outcomeLabel(0), 'success')
assert.equal(outcomeLabel(1), 'failure')
assert.equal(outcomeLabel(2), 'not_ready')
assert.equal(outcomeLabel(99), 'failure')

// A failed or not-ready child must never be coerced to a successful parent
// outcome.  The aggregators expose the same numeric contract at their process
// boundary; this assertion protects the shared constants used by both sides.
assert.notEqual(TASK_OUTCOME.NOT_READY, TASK_OUTCOME.SUCCESS)
assert.notEqual(TASK_OUTCOME.FAILURE, TASK_OUTCOME.SUCCESS)

console.log('自动化任务退出码契约测试通过')
