const { chromium } = require("playwright");
const { profileDir, chromePath } = require("../config");

function launchBrowser(options = {}) {
  return chromium.launchPersistentContext(profileDir, {
    headless: false,
    executablePath: chromePath,
    viewport: { width: 1440, height: 1000 },
    ...options,
  });
}

module.exports = { launchBrowser };
