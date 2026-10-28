'use strict'

// Automation processes use these codes at their process boundary.  A worker
// may attach richer status metadata, but must never treat NOT_READY as success.
const TASK_OUTCOME = Object.freeze({
  SUCCESS: 0,
  FAILURE: 1,
  NOT_READY: 2,
})

const TASK_OUTCOME_LABELS = Object.freeze({
  0: 'success',
  1: 'failure',
  2: 'not_ready',
})

function outcomeLabel(code) {
  return TASK_OUTCOME_LABELS[code] || 'failure'
}

module.exports = { TASK_OUTCOME, TASK_OUTCOME_LABELS, outcomeLabel }
