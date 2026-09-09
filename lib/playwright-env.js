const fs = require("fs");
const path = require("path");

// Playwright reads PLAYWRIGHT_BROWSERS_PATH while it is first required, so
// this helper must be loaded before any module imports `playwright`.
const bundledBrowsersPath = path.join(__dirname, "..", ".playwright-browsers");
if (!process.env.PLAYWRIGHT_BROWSERS_PATH && fs.existsSync(bundledBrowsersPath)) {
  process.env.PLAYWRIGHT_BROWSERS_PATH = bundledBrowsersPath;
}

module.exports = { bundledBrowsersPath };
