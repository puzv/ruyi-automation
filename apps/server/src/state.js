const { browserHeadless } = require('@ruyi/shared/config')

module.exports = {
  jobs: new Map(),
  platformProbes: new Set(),
  activeContexts: new Set(),
  headlessMode: browserHeadless,
}
