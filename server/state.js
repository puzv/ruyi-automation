const { browserHeadless } = require('../config')

module.exports = {
  jobs: new Map(),
  platformProbes: new Set(),
  activeContexts: new Set(),
  headlessMode: browserHeadless,
}
