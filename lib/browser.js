const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");
const { profileDir, chromePath, browserHeadless } = require("../config");
const { waitForProfileRelease } = require("./preflight");

function launchBrowser(options = {}) {
  // Remove stale Singleton* links left by a crashed/forcibly closed Chrome
  // before creating a new persistent context. Without this, Chromium refuses
  // to launch even though the recorded owner PID is already gone.
  waitForProfileRelease({ timeoutMs: 3000 });
  return chromium.launchPersistentContext(profileDir, {
    headless: browserHeadless,
    executablePath: chromePath,
    viewport: { width: 1440, height: 1000 },
    ...options,
  });
}

async function closeBrowserContext(context) {
  if (!context) return;
  await context.close().catch(() => {});
  // Chrome may release Singleton* files shortly after Playwright resolves close().
  // Wait here so the next workflow can safely reuse the same persistent profile.
  if (waitForProfileRelease({ timeoutMs: 3000 })) return;

  // In some macOS/Chrome combinations persistent contexts leave the browser
  // process alive after context.close().  The SingletonLock identifies that
  // exact process; terminate it so subsequent probes do not report a false
  // "需要登录" state because the shared profile is still locked.
  const lockFile = path.join(profileDir, "SingletonLock");
  try {
    const target = fs.readlinkSync(lockFile);
    const match = target.match(/-(\d+)$/);
    const pid = match && Number(match[1]);
    if (Number.isInteger(pid) && pid > 0) {
      process.kill(pid, "SIGTERM");
      waitForProfileRelease({ timeoutMs: 3000 });
      if (fs.existsSync(lockFile)) process.kill(pid, "SIGKILL");
    }
  } catch (_) {
    // The process may have exited between checking the lock and terminating it.
  }
  waitForProfileRelease({ timeoutMs: 3000 });
}

module.exports = { launchBrowser, closeBrowserContext };
