const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const projectRoot = path.resolve(__dirname, "..");
const defaults = {
  sourceDir: path.join(projectRoot, "1"),
  outputDir: path.join(projectRoot, "browser-release"),
  chunkMiB: 90,
};

function parseArgs(argv) {
  const options = { ...defaults, force: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--source") options.sourceDir = path.resolve(argv[++index] || "");
    else if (arg === "--output") options.outputDir = path.resolve(argv[++index] || "");
    else if (arg === "--chunk-mib") options.chunkMiB = Number(argv[++index]);
    else if (arg === "--force") options.force = true;
    else throw new Error(`未知参数：${arg}`);
  }
  const chunkBytes = Math.floor(options.chunkMiB * 1024 * 1024);
  if (!Number.isFinite(options.chunkMiB) || options.chunkMiB <= 0 || chunkBytes >= 100000000) {
    throw new Error("--chunk-mib 必须大于 0，且换算后的分片必须小于 100,000,000 字节，建议使用默认值 90");
  }
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

function splitArchive(sourcePath, archiveName, outputDir, chunkBytes) {
  const archiveSize = fs.statSync(sourcePath).size;
  const descriptor = fs.openSync(sourcePath, "r");
  const parts = [];
  try {
    for (let index = 0, offset = 0; offset < archiveSize; index += 1) {
      const size = Math.min(chunkBytes, archiveSize - offset);
      const buffer = Buffer.allocUnsafe(size);
      let read = 0;
      while (read < size) read += fs.readSync(descriptor, buffer, read, size - read, offset + read);
      const name = `${archiveName}.part-${String(index + 1).padStart(3, "0")}`;
      const target = path.join(outputDir, name);
      fs.writeFileSync(target, buffer);
      parts.push({ name, size, sha256: crypto.createHash("sha256").update(buffer).digest("hex") });
      offset += size;
      console.log(`已生成 ${name}（${(size / 1024 / 1024).toFixed(1)} MiB）`);
    }
  } finally {
    fs.closeSync(descriptor);
  }
  return { archive: archiveName, size: archiveSize, sha256: sha256File(sourcePath), parts };
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const chromium = require(path.join(projectRoot, "node_modules/playwright-core/browsers.json"))
    .browsers.find((browser) => browser.name === "chromium");
  if (!chromium?.revision) throw new Error("无法从当前 Playwright 依赖读取 Chromium revision");
  const archives = {
    "darwin-arm64": { source: `chromium-${chromium.revision}-arm64.zip`, asset: `chromium-${chromium.revision}-darwin-arm64.zip` },
    "darwin-x64": { source: `chromium-${chromium.revision}.zip`, asset: `chromium-${chromium.revision}-darwin-x64.zip` },
  };
  for (const archive of Object.values(archives)) {
    const source = path.join(options.sourceDir, archive.source);
    if (!fs.existsSync(source)) throw new Error(`找不到浏览器压缩包：${source}`);
  }

  fs.mkdirSync(options.outputDir, { recursive: true });
  const existing = fs.readdirSync(options.outputDir).filter((name) => !name.startsWith("."));
  if (existing.length && !options.force) {
    throw new Error(`输出目录不是空目录：${options.outputDir}。确认可覆盖后增加 --force`);
  }
  if (options.force) {
    for (const name of existing) fs.rmSync(path.join(options.outputDir, name), { recursive: true, force: true });
  }

  const chunkBytes = Math.floor(options.chunkMiB * 1024 * 1024);
  const platforms = {};
  for (const [platform, archive] of Object.entries(archives)) {
    platforms[platform] = splitArchive(
      path.join(options.sourceDir, archive.source),
      archive.asset,
      options.outputDir,
      chunkBytes,
    );
  }
  const manifest = {
    schemaVersion: 1,
    playwrightVersion: require(path.join(projectRoot, "package.json")).dependencies.playwright,
    chromiumRevision: chromium.revision,
    chunkSize: chunkBytes,
    platforms,
  };
  const manifestPath = path.join(options.outputDir, "browser-manifest.json");
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  console.log(`已生成清单：${manifestPath}`);
}

try { main(); } catch (error) {
  console.error(`浏览器分片失败：${error.message}`);
  process.exitCode = 1;
}
