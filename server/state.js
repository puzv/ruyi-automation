const { browserHeadless } = require('../config')

module.exports = {
  jobs: new Map(),
  jobStarts: new Set(),
  platformProbes: new Set(),
  activeContexts: new Set(),
  headlessMode: browserHeadless,
}
