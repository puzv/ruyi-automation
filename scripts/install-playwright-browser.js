const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { spawnSync } = require("child_process");
const { Readable } = require("stream");
const { pipeline } = require("stream/promises");
const { VALID_ARCHES, detectMacArchitecture } = require("../lib/macos-arch");

const projectRoot = path.resolve(__dirname, "..");
const defaultReleaseUrl = "https://gitee.com/puzvv/ruyi-automation/releases/download/playwright-browsers-v1.1.6";

function parseArgs(argv) {
  const options = {
    baseUrl: process.env.GITEE_BROWSER_RELEASE_URL || defaultReleaseUrl,
    manifestPath: "",
    partsDir: "",
    browserDir: path.join(projectRoot, ".playwright-browsers"),
    arch: process.env.RUYI_BROWSER_ARCH || "",
    archSource: process.env.RUYI_BROWSER_ARCH ? "RUYI_BROWSER_ARCH" : "",
    force: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--base-url") options.baseUrl = argv[++index] || "";
    else if (arg === "--manifest") options.manifestPath = path.resolve(argv[++index] || "");
    else if (arg === "--parts-dir") options.partsDir = path.resolve(argv[++index] || "");
    else if (arg === "--browser-dir") options.browserDir = path.resolve(argv[++index] || "");
    else if (arg === "--arch") {
      options.arch = String(argv[++index] || "").toLowerCase();
      options.archSource = "命令行覆盖";
    }
    else if (arg === "--force") options.force = true;
    else throw new Error(`未知参数：${arg}`);
  }
  if (options.manifestPath && !options.partsDir && !options.baseUrl) {
    throw new Error("使用本地 --manifest 时，还需要 --parts-dir 或 --base-url");
  }
  if (options.arch && !VALID_ARCHES.has(options.arch)) throw new Error("--arch 只能是 arm64 或 x64");
  return options;
}

function sha256File(filePath) {
  const hash = crypto.createHash("sha256");
  const descriptor = fs.openSync(filePath, "r");
  const buffer = Buffer.allocUnsafe(4 * 1024 * 1024);
  try {
    while (true) {
      const bytesRead = fs.readSync(descriptor, buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      hash.update(buffer.subarray(0, bytesRead));
    }
  } finally {
    fs.closeSync(descriptor);
  }
  return hash.digest("hex");
}

async function download(url, target) {
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(120000) });
      if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);
      await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(target));
      return;
    } catch (error) {
      lastError = error;
      if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, attempt * 1000));
    }
  }
  throw new Error(`下载失败（重试 3 次）：${url}（${lastError?.message || "未知错误"}）`);
}

function assetUrl(baseUrl, name) {
  return `${String(baseUrl).replace(/\/+$/, "")}/${encodeURIComponent(name)}`;
}

async function readManifest(options, tempDir) {
  if (options.manifestPath) return JSON.parse(fs.readFileSync(options.manifestPath, "utf8"));
  const target = path.join(tempDir, "browser-manifest.json");
  await download(assetUrl(options.baseUrl, "browser-manifest.json"), target);
  return JSON.parse(fs.readFileSync(target, "utf8"));
}

async function obtainPart(options, part, tempDir) {
  if (!part?.name || path.basename(part.name) !== part.name) throw new Error(`非法分片文件名：${part?.name}`);
  if (!part.size || !/^[a-f0-9]{64}$/i.test(part.sha256)) throw new Error(`分片校验字段无效：${part.name}`);
  const target = path.join(tempDir, part.name);
  if (options.partsDir) fs.copyFileSync(path.join(options.partsDir, part.name), target);
  else await download(assetUrl(options.baseUrl, part.name), target);
  const size = fs.statSync(target).size;
  const hash = sha256File(target);
  if (size !== part.size || hash !== part.sha256) {
    throw new Error(`分片校验失败：${part.name}（size=${size}, sha256=${hash}）`);
  }
  console.log(`已校验 ${part.name}`);
  return target;
}

function combineParts(files, archivePath) {
  const output = fs.openSync(archivePath, "w");
  try {
    for (const file of files) {
      const input = fs.openSync(file, "r");
      const buffer = Buffer.allocUnsafe(4 * 1024 * 1024);
      try {
        while (true) {
          const bytesRead = fs.readSync(input, buffer, 0, buffer.length, null);
          if (!bytesRead) break;
          fs.writeSync(output, buffer, 0, bytesRead);
        }
      } finally {
        fs.closeSync(input);
      }
    }
  } finally {
    fs.closeSync(output);
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (process.platform !== "darwin") throw new Error(`当前仅支持 macOS，检测到 ${process.platform}`);
  const detected = detectMacArchitecture();
  const architecture = options.arch || detected.arch;
  if (!architecture || !VALID_ARCHES.has(architecture)) {
    throw new Error(`无法识别 Mac 芯片架构（Node=${process.arch}，来源=${detected.source}）。可使用 --arch arm64 或 --arch x64 指定`);
  }
  console.log(`浏览器架构：${architecture}（${options.archSource || detected.source}，Node=${process.arch}）`);
  const expectedVersion = require(path.join(projectRoot, "node_modules/playwright/package.json")).version;
  const expectedRevision = require(path.join(projectRoot, "node_modules/playwright-core/browsers.json"))
    .browsers.find((browser) => browser.name === "chromium")?.revision;
  if (!expectedRevision) throw new Error("无法从当前 Playwright 依赖读取 Chromium revision");
  const browserRoot = options.browserDir;
  fs.mkdirSync(path.dirname(browserRoot), { recursive: true });
  const tempDir = fs.mkdtempSync(path.join(path.dirname(browserRoot), ".ruyi-browser-"));
  try {
    const manifest = await readManifest(options, tempDir);
    if (manifest.schemaVersion !== 1) throw new Error(`不支持的清单版本：${manifest.schemaVersion}`);
    if (manifest.playwrightVersion !== expectedVersion) {
      throw new Error(`Playwright 版本不匹配：当前 ${expectedVersion}，清单 ${manifest.playwrightVersion}`);
    }
    if (!/^\d+$/.test(String(manifest.chromiumRevision)) || String(manifest.chromiumRevision) !== String(expectedRevision)) {
      throw new Error(`Chromium revision 不匹配：当前 ${expectedRevision}，清单 ${manifest.chromiumRevision}`);
    }
    const platform = `darwin-${architecture}`;
    const selected = manifest.platforms?.[platform];
    if (!selected?.parts?.length) throw new Error(`清单中没有 ${platform} 浏览器包`);
    if (!selected.archive || path.basename(selected.archive) !== selected.archive) throw new Error(`非法压缩包文件名：${selected.archive}`);
    if (!selected.size || !/^[a-f0-9]{64}$/i.test(selected.sha256)) throw new Error("完整压缩包校验字段无效");

    const revisionDir = path.join(browserRoot, `chromium-${manifest.chromiumRevision}`);
    const executableDir = architecture === "arm64" ? "chrome-mac-arm64" : "chrome-mac-x64";
    const executable = path.join(revisionDir, executableDir, "Google Chrome for Testing.app", "Contents", "MacOS", "Google Chrome for Testing");
    const otherArchitecture = architecture === "arm64" ? "x64" : "arm64";
    const otherExecutable = path.join(revisionDir, `chrome-mac-${otherArchitecture}`, "Google Chrome for Testing.app", "Contents", "MacOS", "Google Chrome for Testing");
    if (fs.existsSync(executable) && !options.force) {
      console.log(`浏览器已安装：${executable}`);
      return;
    }
    if (fs.existsSync(revisionDir) && !options.force && !fs.existsSync(otherExecutable)) {
      throw new Error(`检测到不完整目录 ${revisionDir}，确认可替换后增加 --force`);
    }
    if (fs.existsSync(otherExecutable) && !options.force) {
      console.log(`检测到 ${otherArchitecture} 浏览器，将在校验新包后替换为 ${architecture}`);
    }

    const partFiles = [];
    for (const part of selected.parts) partFiles.push(await obtainPart(options, part, tempDir));
    const archivePath = path.join(tempDir, selected.archive);
    combineParts(partFiles, archivePath);
    const archiveSize = fs.statSync(archivePath).size;
    const archiveHash = sha256File(archivePath);
    if (archiveSize !== selected.size || archiveHash !== selected.sha256) {
      throw new Error(`完整压缩包校验失败（size=${archiveSize}, sha256=${archiveHash}）`);
    }

    const extractDir = path.join(tempDir, "extract");
    fs.mkdirSync(extractDir);
    const result = spawnSync("ditto", ["-x", "-k", archivePath, extractDir], { encoding: "utf8" });
    if (result.status !== 0) throw new Error(`解压失败：${result.stderr || result.stdout || `exit ${result.status}`}`);
    const extractedRevision = path.join(extractDir, `chromium-${manifest.chromiumRevision}`);
    const extractedExecutable = path.join(extractedRevision, executableDir, "Google Chrome for Testing.app", "Contents", "MacOS", "Google Chrome for Testing");
    const installationMarker = path.join(extractedRevision, "INSTALLATION_COMPLETE");
    if (!fs.existsSync(installationMarker)) throw new Error(`压缩包结构不正确，找不到：${installationMarker}`);
    if (!fs.existsSync(extractedExecutable)) throw new Error(`压缩包结构不正确，找不到：${extractedExecutable}`);

    fs.mkdirSync(browserRoot, { recursive: true });
    const backup = `${revisionDir}.backup-${Date.now()}`;
    if (fs.existsSync(revisionDir)) fs.renameSync(revisionDir, backup);
    try {
      fs.renameSync(extractedRevision, revisionDir);
      if (fs.existsSync(backup)) fs.rmSync(backup, { recursive: true, force: true });
    } catch (error) {
      if (!fs.existsSync(revisionDir) && fs.existsSync(backup)) fs.renameSync(backup, revisionDir);
      throw error;
    }
    console.log(`浏览器安装完成：${executable}`);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(`浏览器安装失败：${error.message}`);
  process.exitCode = 1;
});
