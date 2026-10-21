// 将单机 upload 工作区复制到指定用户目录。模块加载时不执行迁移，便于离线测试。
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const WORKSPACE_DIRECTORIES = ["raw", "idfa", "oaid", "pn", "result"];
const COPY_DIRECTORIES = [...WORKSPACE_DIRECTORIES, "conclusion"];
const MANIFEST_FILES = [
  "createGroupToDoList.json",
  "creategrouptodolist.json",
  "analyseToDoList.json",
  "done.json",
];
const AUXILIARY_FILES = ["总结报告生成流程.md"];
const TEMP_PREFIXES = [".ruyi-pzw-migration-", ".pzw-migration-"];

class MigrationError extends Error {
  constructor(message, plan) {
    super(message);
    this.name = "MigrationError";
    this.plan = plan;
  }
}

function statEntry(filePath) {
  try {
    return fs.lstatSync(filePath);
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "ENOTDIR") return null;
    throw error;
  }
}

function hasTempPrefix(name) {
  return TEMP_PREFIXES.some((prefix) => name.startsWith(prefix));
}

function isExcluded(name) {
  const lower = name.toLowerCase();
  return name.startsWith(".") || hasTempPrefix(name) || lower === "users"
    || ["state-test.json", "auth.json", "ruyi-profile", "chrome-profile"].includes(lower)
    || /\.state\.json(?:\.|$)/i.test(name) || /^state-test\.json\./i.test(name);
}

function isInside(parent, child) {
  const relative = path.relative(parent, child);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function assertNoSymlinkInExistingPath(filePath, basePath = filePath) {
  const absolute = path.resolve(filePath);
  const base = path.resolve(basePath);
  let current = base;
  const baseEntry = statEntry(current);
  if (baseEntry?.isSymbolicLink()) throw new Error(`路径包含符号链接，已停止：${path.basename(current)}`);
  const relative = path.relative(base, absolute);
  if (relative.startsWith("..") || path.isAbsolute(relative)) return;
  for (const part of relative.split(path.sep).filter(Boolean)) {
    const parentEntry = statEntry(current);
    if (parentEntry && !parentEntry.isDirectory()) throw new Error("路径的父级不是目录，已停止迁移");
    current = path.join(current, part);
    const entry = statEntry(current);
    if (entry?.isSymbolicLink()) throw new Error(`路径包含符号链接，已停止：${path.basename(current)}`);
  }
}

function normalizeOptions(options = {}) {
  // 延迟加载 config，测试和调用方可以完全使用人工临时目录。
  let defaultSource;
  if (options.sourceRoot == null) {
    defaultSource = require("@ruyi/shared/config").uploadRoot;
  }
  for (const value of [options.sourceRoot, options.targetRoot]) {
    if (value != null && (typeof value !== "string" || !value.trim() || value.includes("\0"))) {
      throw new Error("迁移目录参数无效");
    }
  }
  const sourceRoot = path.resolve(options.sourceRoot == null ? defaultSource : options.sourceRoot);
  const targetRoot = path.resolve(options.targetRoot == null
    ? path.join(sourceRoot, "users", "pzw")
    : options.targetRoot);
  return { sourceRoot, targetRoot };
}

function addIssue(issues, message) {
  issues.push(message);
}

function inspectDirectory(sourceRoot, relativeDirectory, files, directories, issues) {
  const sourceDirectory = path.join(sourceRoot, relativeDirectory);
  const entry = statEntry(sourceDirectory);
  if (!entry) return;
  if (!entry.isDirectory() || entry.isSymbolicLink()) {
    addIssue(issues, `源目录不安全，无法迁移：${relativeDirectory}`);
    return;
  }

  function walk(current, relative) {
    assertNoSymlinkInExistingPath(current, sourceRoot);
    directories.push(relative);
    let names;
    try {
      names = fs.readdirSync(current, { encoding: "utf8" });
    } catch (error) {
      addIssue(issues, `无法读取源目录：${relative}`);
      return;
    }
    for (const name of names) {
      // 在 lstat 之前过滤隐藏项，避免接触登录态等敏感文件。
      if (isExcluded(name)) continue;
      const child = path.join(current, name);
      const childRelative = path.join(relative, name);
      const childEntry = statEntry(child);
      if (!childEntry) continue;
      if (childEntry.isSymbolicLink()) {
        addIssue(issues, `源目录包含不支持的符号链接：${relative}`);
        continue;
      }
      if (childEntry.isDirectory()) {
        walk(child, childRelative);
      } else if (childEntry.isFile()) {
        files.push({ relativePath: childRelative, size: childEntry.size, mtimeMs: childEntry.mtimeMs, ino: childEntry.ino, dev: childEntry.dev });
      } else {
        addIssue(issues, `源目录包含无法复制的条目：${relative}`);
      }
    }
  }

  walk(sourceDirectory, relativeDirectory);
}

function inspectManifest(sourceRoot, name, files, issues) {
  const sourcePath = path.join(sourceRoot, name);
  const entry = statEntry(sourcePath);
  if (!entry) return;
  if (!entry.isFile() || entry.isSymbolicLink()) {
    addIssue(issues, `清单不是普通文件：${name}`);
    return;
  }
  try {
    const value = JSON.parse(fs.readFileSync(sourcePath, "utf8"));
    if (!Array.isArray(value)) throw new Error("必须是字符串数组");
    if (value.some((item) => typeof item !== "string" || !item.trim()
      || item === "." || item === ".." || /[\\/\x00-\x1f]/.test(item)
      || path.basename(item) !== item || path.win32.basename(item) !== item)) {
      addIssue(issues, `清单条目不是安全的文件名称：${name}`);
      return;
    }
  } catch (_) {
    addIssue(issues, `清单 JSON 无法解析或不是数组：${name}`);
    return;
  }
  files.push({ relativePath: name, size: entry.size, mtimeMs: entry.mtimeMs, ino: entry.ino, dev: entry.dev });
}

function planMigration(options = {}) {
  const { sourceRoot, targetRoot } = normalizeOptions(options);
  const issues = [];
  const files = [];
  const directories = [...WORKSPACE_DIRECTORIES];

  if (sourceRoot === targetRoot) addIssue(issues, "源目录和目标目录不能相同");
  if (!isInside(sourceRoot, targetRoot)) addIssue(issues, "目标目录必须位于源数据根目录内");
  // 迁移目标是 source/users/pzw；只允许用户目录作为嵌套目标，避免把目标放进 raw 等源目录。
  const targetRelative = path.relative(sourceRoot, targetRoot).split(path.sep).filter(Boolean);
  if (targetRelative[0] !== "users" || targetRelative[1] !== "pzw" || targetRelative.length !== 2) {
    addIssue(issues, "目标目录必须是源目录的 users/pzw");
  }

  let pathsSafe = true;
  try {
    assertNoSymlinkInExistingPath(sourceRoot);
    if (isInside(sourceRoot, targetRoot)) assertNoSymlinkInExistingPath(targetRoot, sourceRoot);
  } catch (error) {
    pathsSafe = false;
    addIssue(issues, error.message);
  }

  const sourceEntry = statEntry(sourceRoot);
  if (!sourceEntry) addIssue(issues, "找不到源数据根目录");
  else if (!sourceEntry.isDirectory() || sourceEntry.isSymbolicLink()) addIssue(issues, "源数据根目录不是安全目录");

  const targetEntry = statEntry(targetRoot);
  if (targetEntry) addIssue(issues, "目标目录已存在，不能覆盖或合并");

  if (pathsSafe && sourceEntry?.isDirectory() && !sourceEntry.isSymbolicLink()) {
    let names = [];
    try {
      names = fs.readdirSync(sourceRoot, { encoding: "utf8" });
    } catch (_) {
      addIssue(issues, "无法读取源数据根目录");
    }
    for (const name of names) {
      // users 是目标父目录，临时目录可能来自上次中断；都不纳入源数据。
      if (isExcluded(name)) continue;
      if (COPY_DIRECTORIES.includes(name)) {
        inspectDirectory(sourceRoot, name, files, directories, issues);
      } else if (MANIFEST_FILES.includes(name)) {
        inspectManifest(sourceRoot, name, files, issues);
      } else if (AUXILIARY_FILES.includes(name)) {
        const entry = statEntry(path.join(sourceRoot, name));
        if (!entry?.isFile() || entry.isSymbolicLink()) {
          addIssue(issues, `辅助文件不是普通文件：${name}`);
        } else {
          files.push({ relativePath: name, size: entry.size, mtimeMs: entry.mtimeMs, ino: entry.ino, dev: entry.dev });
        }
      } else {
        // 只报告 basename 和 lstat 类型；未知条目的内容始终不读取。
        const entry = statEntry(path.join(sourceRoot, name));
        const type = entry?.isSymbolicLink() ? "符号链接" : entry?.isDirectory() ? "目录" : entry?.isFile() ? "普通文件" : "其他条目";
        const safeName = JSON.stringify(path.basename(name)).replace(/[\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g,
          (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`);
        addIssue(issues, `源目录包含未列入迁移白名单的条目：${safeName}（${type}）`);
      }
    }
  }

  const bytes = files.reduce((total, file) => total + file.size, 0);
  return {
    sourceRoot,
    targetRoot,
    files,
    directories: [...new Set(directories)].sort(),
    fileCount: files.length,
    bytes,
    issues: [...new Set(issues)],
    dryRun: options.apply !== true,
  };
}

function formatPlanError(plan) {
  return `迁移预检未通过（已识别 ${plan.fileCount} 个文件，${plan.issues.length} 项冲突）：\n- ${plan.issues.join("\n- ")}`;
}

function hashDescriptor(descriptor) {
  const hash = crypto.createHash("sha256");
  const buffer = Buffer.alloc(1024 * 1024);
  let offset = 0;
  let length;
  while ((length = fs.readSync(descriptor, buffer, 0, buffer.length, offset)) > 0) {
    hash.update(buffer.subarray(0, length));
    offset += length;
  }
  return hash.digest("hex");
}

function copyPlanFiles(plan, temporaryRoot) {
  for (const relative of plan.directories) {
    assertNoSymlinkInExistingPath(temporaryRoot, plan.sourceRoot);
    fs.mkdirSync(path.join(temporaryRoot, relative), { recursive: true });
  }
  const verifiedFiles = [];
  for (const file of plan.files) {
    const sourcePath = path.join(plan.sourceRoot, file.relativePath);
    const targetPath = path.join(temporaryRoot, file.relativePath);
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    assertNoSymlinkInExistingPath(sourcePath, plan.sourceRoot);
    assertNoSymlinkInExistingPath(targetPath, plan.sourceRoot);
    const sourceEntry = statEntry(sourcePath);
    if (!sourceEntry?.isFile() || sourceEntry.isSymbolicLink()) {
      throw new Error(`源文件在复制前变得不安全：${path.basename(file.relativePath)}`);
    }
    if (sourceEntry.size !== file.size || sourceEntry.mtimeMs !== file.mtimeMs
      || sourceEntry.ino !== file.ino || sourceEntry.dev !== file.dev) throw new Error("源文件在预检后发生变化");
    let sourceDescriptor;
    let targetDescriptor;
    try {
      sourceDescriptor = fs.openSync(sourcePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      assertNoSymlinkInExistingPath(sourcePath, plan.sourceRoot);
      const before = fs.fstatSync(sourceDescriptor);
      if (!before.isFile() || before.ino !== sourceEntry.ino || before.dev !== sourceEntry.dev
        || before.size !== file.size || before.mtimeMs !== file.mtimeMs) {
        throw new Error("源文件在复制前发生变化");
      }
      targetDescriptor = fs.openSync(targetPath, "wx+");
      const hash = crypto.createHash("sha256");
      const buffer = Buffer.alloc(1024 * 1024);
      let offset = 0;
      let length;
      while ((length = fs.readSync(sourceDescriptor, buffer, 0, buffer.length, offset)) > 0) {
        hash.update(buffer.subarray(0, length));
        let written = 0;
        while (written < length) written += fs.writeSync(targetDescriptor, buffer, written, length - written, offset + written);
        offset += length;
      }
      fs.fsyncSync(targetDescriptor);
      const digest = hash.digest("hex");
      const after = fs.fstatSync(sourceDescriptor);
      if (before.size !== offset || after.size !== before.size || after.mtimeMs !== before.mtimeMs
        || hashDescriptor(sourceDescriptor) !== digest || hashDescriptor(targetDescriptor) !== digest) {
        throw new Error("源目标 SHA-256 字节校验失败，或复制期间源文件发生变化");
      }
      assertNoSymlinkInExistingPath(sourcePath, plan.sourceRoot);
      const current = statEntry(sourcePath);
      if (!current || current.ino !== before.ino || current.dev !== before.dev) throw new Error("复制期间源文件路径发生变化");
      verifiedFiles.push({ relativePath: file.relativePath, sha256: digest });
    } finally {
      if (sourceDescriptor !== undefined) fs.closeSync(sourceDescriptor);
      if (targetDescriptor !== undefined) fs.closeSync(targetDescriptor);
    }
  }
  return verifiedFiles;
}

function applyMigration(options = {}) {
  const plan = planMigration({ ...options, apply: true });
  if (plan.issues.length) throw new MigrationError(formatPlanError(plan), plan);

  const parent = path.dirname(plan.targetRoot);
  assertNoSymlinkInExistingPath(parent, plan.sourceRoot);
  fs.mkdirSync(parent, { recursive: true });
  const temporaryRoot = fs.mkdtempSync(path.join(parent, ".ruyi-pzw-migration-"));
  try {
    const verifiedFiles = copyPlanFiles(plan, temporaryRoot);
    assertNoSymlinkInExistingPath(plan.targetRoot, plan.sourceRoot);
    // 排他创建发布占位目录；目标若在预检后出现，mkdir 会拒绝而非由 rename 覆盖。
    try {
      fs.mkdirSync(plan.targetRoot);
    } catch (error) {
      if (error.code === "EEXIST") throw new Error("目标目录在迁移过程中出现，已停止且未覆盖目标");
      throw error;
    }
    fs.renameSync(temporaryRoot, plan.targetRoot);
    return { ...plan, applied: true, dryRun: false, verifiedFiles, verifiedFileCount: verifiedFiles.length };
  } catch (error) {
    throw new MigrationError(`迁移复制失败：${error.message}（临时目录已保留：${path.basename(temporaryRoot)}）`, plan);
  }
}

function printPlan(plan, applied) {
  console.log(`${applied ? "迁移完成" : "预检通过（dry-run，未复制）"}：${plan.fileCount} 个文件，共 ${plan.bytes} 字节。`);
  if (applied) console.log(`SHA-256 字节校验通过：${plan.verifiedFileCount} 个文件；源目录保留。`);
}

function parseCli(argv) {
  const options = { apply: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--apply") options.apply = true;
    else if (argument === "--source" || argument === "--target") {
      const value = argv[++index];
      if (!value || value.startsWith("--")) throw new Error(`${argument} 缺少目录参数`);
      options[argument === "--source" ? "sourceRoot" : "targetRoot"] = value;
    }
    else if (argument === "--help" || argument === "-h") options.help = true;
    else throw new Error(`未知参数：${argument}`);
  }
  return options;
}

function main(argv = process.argv.slice(2)) {
  try {
    const options = parseCli(argv);
    if (options.help) {
      console.log("用法：node scripts/migrate-user-workspace.js [--apply] [--source 目录] [--target 目录]");
      return;
    }
    const plan = options.apply ? applyMigration(options) : planMigration(options);
    if (!options.apply && plan.issues.length) throw new MigrationError(formatPlanError(plan), plan);
    printPlan(plan, options.apply);
  } catch (error) {
    console.error(`迁移失败：${error.message}`);
    process.exitCode = 1;
  }
}

if (require.main === module) main();

module.exports = {
  COPY_DIRECTORIES,
  WORKSPACE_DIRECTORIES,
  MANIFEST_FILES,
  AUXILIARY_FILES,
  MigrationError,
  planMigration,
  applyMigration,
  parseCli,
  main,
};
