const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const config = require("../config");

const PROFILE_LOCK_NAMES = ["SingletonLock", "SingletonCookie", "SingletonSocket"];

function profileLockFiles() {
  return PROFILE_LOCK_NAMES
    .map((name) => path.join(config.profileDir, name))
    // Singleton* entries are symlinks whose targets (especially the socket)
    // may disappear during Chrome shutdown. `existsSync` follows the link and
    // therefore reports a live/dangling lock as absent, allowing a persistent
    // browser process to leak and leaving the profile locked for the next
    // probe. lstat checks the directory entry itself, which is what we need.
    .filter((file) => {
      try { return fs.lstatSync(file).isSymbolicLink() || fs.existsSync(file); }
      catch (_) { return false; }
    });
}

function lockOwnerIsAlive(lockFile) {
  // Chromium's SingletonLock is normally a symlink ending in <hostname>-<pid>.
  // This lets us distinguish a live Chrome process from a leftover lock after a crash.
  try {
    const target = fs.readlinkSync(lockFile);
    const match = target.match(/-(\d+)$/);
    if (!match) return null;
    const pid = Number(match[1]);
    if (!Number.isInteger(pid) || pid <= 0) return null;
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return error.code === "EPERM";
    }
  } catch (_) {
    return null;
  }
}

function lockTargetExists(lockFile) {
  try {
    const target = fs.readlinkSync(lockFile);
    return fs.existsSync(path.resolve(path.dirname(lockFile), target));
  } catch (_) {
    return null;
  }
}

function removeStaleProfileLocks() {
  const locks = profileLockFiles();
  if (!locks.length) return [];
  const singletonLock = path.join(config.profileDir, "SingletonLock");
  // SingletonLock is Chromium's owner marker. If it is absent while only a
  // SingletonSocket/Cookie symlink remains, the browser has already exited
  // and those entries are stale leftovers from an interrupted shutdown.
  if (!fs.existsSync(singletonLock)) {
    for (const file of locks) {
      try { fs.unlinkSync(file); } catch (_) { /* another process may remove it */ }
    }
    return profileLockFiles();
  }
  const owner = lockOwnerIsAlive(singletonLock);
  if (owner === true) return locks;
  if (owner === null) {
    // When SingletonLock is absent (or has no PID), a dangling symlink such as
    // SingletonSocket is safe to clean up only if its target is also gone.
    const targetStates = locks.map(lockTargetExists);
    if (targetStates.some((state) => state === true || state === null)) return locks;
  }
  for (const file of locks) {
    try { fs.unlinkSync(file); } catch (_) { /* another process may remove it */ }
  }
  return profileLockFiles();
}

function sleepSync(milliseconds) {
  const waitArray = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(waitArray, 0, 0, milliseconds);
}

function waitForProfileRelease({ timeoutMs = 30000, pollMs = 250 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const remaining = removeStaleProfileLocks();
    if (!remaining.length) return true;
    if (Date.now() >= deadline) return false;
    sleepSync(Math.min(pollMs, Math.max(1, deadline - Date.now())));
  }
}

function checkPreflight({ taskFiles = [] } = {}) {
  const errors = [];
  const nodeMajor = Number(process.versions.node.split(".")[0]);
  if (nodeMajor < 18) errors.push("Node.js 版本过低（需要 18 或更高），请升级 Node.js。");

  try { require.resolve("playwright"); } catch (_) {
    errors.push("未安装 Playwright，请在项目目录执行：npm install");
  }

  if (!config.chromePath || !fs.existsSync(config.chromePath)) {
    const candidates = process.platform === "darwin"
      ? ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Chromium.app/Contents/MacOS/Chromium"]
      : process.platform === "win32" ? [] : ["/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"];
    const detected = candidates.find((file) => fs.existsSync(file))
      || (process.platform !== "win32" && ["google-chrome", "chromium", "chromium-browser"].find((command) => spawnSync("which", [command], { stdio: "ignore" }).status === 0));
    if (!detected) errors.push("找不到 Chrome/Chromium，请安装浏览器，或设置 RUYI_CHROME_PATH。");
  }

  for (const [label, dir] of [["upload", config.uploadRoot], ["profile", config.profileDir]]) {
    if (!fs.existsSync(dir)) {
      errors.push(`${label} 目录不存在：${dir}。请创建该目录。`);
      continue;
    }
    try { fs.accessSync(dir, fs.constants.R_OK | fs.constants.W_OK); } catch (_) {
      errors.push(`${label} 目录不可读写：${dir}。请检查文件权限。`);
    }
  }

  for (const fileName of taskFiles) {
    const filePath = path.join(config.uploadRoot, fileName);
    if (!fs.existsSync(filePath)) continue;
    try {
      const value = JSON.parse(fs.readFileSync(filePath, "utf8") || "[]");
      if (!Array.isArray(value)) errors.push(`任务清单必须是 JSON 数组：${filePath}`);
    } catch (error) {
      errors.push(`任务清单 JSON 格式错误：${filePath}（${error.message}）`);
    }
  }

  if (!waitForProfileRelease({ timeoutMs: 10000 })) {
    const lockFiles = profileLockFiles();
    errors.push(`Chrome profile 可能正被其他实例占用（存在锁文件：${lockFiles.join(", ")}）。请先完全退出 Chrome 后重试。`);
  }

  if (errors.length) {
    throw new Error(`启动前检查失败：\n- ${errors.join("\n- ")}`);
  }
}

module.exports = { checkPreflight, profileLockFiles, waitForProfileRelease };
