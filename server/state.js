const { browserHeadless } = require('../config')

module.exports = {
  jobs: new Map(),
  loginContexts: new Set(),
  activeContexts: new Set(),
  loginFlow: null,
  profileProbeRunning: false,
  profileReleaseRunning: false,
  headlessMode: browserHeadless,
}
