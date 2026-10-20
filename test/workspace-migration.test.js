const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");

const {
  MigrationError,
  planMigration,
  applyMigration,
  parseCli,
} = require("../scripts/migrate-user-workspace");

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "ruyi-workspace-migration-"));
function makeSource(label) {
  const root = path.join(temporary, label);
  fs.mkdirSync(root);
  for (const directory of ["raw", "idfa", "oaid", "pn", "result"]) {
    fs.mkdirSync(path.join(root, directory), { recursive: true });
  }
  return root;
}

function targetOf(source) {
  return path.join(source, "users", "pzw");
}

function writeFixture(source) {
  fs.mkdirSync(path.join(source, "raw", "batch"), { recursive: true });
  fs.writeFileSync(path.join(source, "raw", "batch", "a_idfa.txt"), "idfa-data\n");
  fs.writeFileSync(path.join(source, "oaid", "a_oaid.csv"), "oaid-data\n");
  fs.writeFileSync(path.join(source, "result", "学生_pn.xlsx"), Buffer.from([0, 1, 2, 255]));
  fs.writeFileSync(path.join(source, "createGroupToDoList.json"), '["a_idfa"]\n');
  // 旧大小写名称是独立的历史清单，迁移时保留其原始字节。
  fs.writeFileSync(path.join(source, "creategrouptodolist.json"), '["legacy"]\n');
  fs.writeFileSync(path.join(source, "analyseToDoList.json"), "[]\n");
  fs.writeFileSync(path.join(source, "done.json"), '["done"]\n');
  fs.writeFileSync(path.join(source, ".hidden-sensitive"), "must not be read or copied");
  fs.mkdirSync(path.join(source, ".hidden-dir"));
  fs.writeFileSync(path.join(source, ".hidden-dir", "secret"), "must not be read or copied");
  fs.mkdirSync(path.join(source, "conclusion", "empty"), { recursive: true });
  fs.writeFileSync(path.join(source, "conclusion", "旧报告.xlsx"), "人工历史报告");
  fs.mkdirSync(path.join(source, "pn", "done", "empty"), { recursive: true });
  fs.mkdirSync(path.join(source, "users", "someone"), { recursive: true });
  fs.writeFileSync(path.join(source, "users", "someone", "secret"), "其他用户样本不应读取");
  for (const name of ["state-test.json", "auth.json", "login.state.json", "login.state.json.retry.tmp", ".env"]) {
    fs.writeFileSync(path.join(source, "raw", name), "人工敏感样本不应读取");
  }
  fs.mkdirSync(path.join(source, "raw", "ruyi-profile"));
  fs.writeFileSync(path.join(source, "raw", "ruyi-profile", "secret"), "人工 Profile 不应读取");
}

try {
{
  const source = makeSource("copy");
  writeFixture(source);
  const target = targetOf(source);
  const dryRun = planMigration({ sourceRoot: source, targetRoot: target });
  assert.equal(dryRun.dryRun, true);
  assert.equal(dryRun.issues.length, 0);
  const manifestCount = fs.readdirSync(source).filter((name) => /^(?:createGroupToDoList|creategrouptodolist|analyseToDoList|done)\.json$/.test(name)).length;
  assert.equal(dryRun.fileCount, 4 + manifestCount);
  assert.equal(fs.existsSync(target), false, "dry-run 不应创建目标目录");

  const applied = applyMigration({ sourceRoot: source, targetRoot: target });
  assert.equal(applied.applied, true);
  assert.equal(applied.fileCount, 4 + manifestCount);
  assert.equal(applied.verifiedFileCount, applied.fileCount);
  for (const file of applied.verifiedFiles) {
    const sourceHash = crypto.createHash("sha256").update(fs.readFileSync(path.join(source, file.relativePath))).digest("hex");
    assert.equal(file.sha256, sourceHash);
  }
  assert.equal(fs.readFileSync(path.join(target, "raw", "batch", "a_idfa.txt"), "utf8"), "idfa-data\n");
  assert.deepEqual(fs.readFileSync(path.join(target, "result", "学生_pn.xlsx")), Buffer.from([0, 1, 2, 255]));
  for (const name of ["createGroupToDoList.json", "creategrouptodolist.json", "analyseToDoList.json", "done.json"]) {
    assert.equal(fs.readFileSync(path.join(target, name), "utf8"), fs.readFileSync(path.join(source, name), "utf8"));
  }
  assert.equal(fs.existsSync(path.join(target, ".hidden-sensitive")), false);
  assert.deepEqual(fs.readdirSync(path.join(target, "raw")).sort(), ["batch"]);
  assert.equal(fs.existsSync(path.join(target, "users")), false);
  assert.equal(fs.statSync(path.join(target, "conclusion", "empty")).isDirectory(), true);
  assert.equal(fs.statSync(path.join(target, "pn", "done", "empty")).isDirectory(), true);
  for (const name of ["raw", "idfa", "oaid", "pn", "result"]) assert.ok(fs.statSync(path.join(target, name)).isDirectory());
  assert.equal(fs.existsSync(path.join(source, "raw", "batch", "a_idfa.txt")), true, "源文件必须保留");

  assert.throws(
    () => applyMigration({ sourceRoot: source, targetRoot: target }),
    (error) => error instanceof MigrationError && /目标目录已存在/.test(error.message),
  );
  assert.equal(fs.readFileSync(path.join(target, "raw", "batch", "a_idfa.txt"), "utf8"), "idfa-data\n");
}

{
  const source = makeSource("invalid");
  fs.writeFileSync(path.join(source, "done.json"), "{bad json");
  const plan = planMigration({ sourceRoot: source, targetRoot: targetOf(source) });
  assert.ok(plan.issues.some((issue) => /JSON/.test(issue)));
  assert.throws(() => applyMigration({ sourceRoot: source, targetRoot: targetOf(source) }), /JSON/);
  assert.equal(fs.existsSync(targetOf(source)), false);
  for (const value of [[1], ["../../outside"], ["..\\outside"], ["C:escape"], [""]]) {
    fs.writeFileSync(path.join(source, "done.json"), JSON.stringify(value));
    assert.throws(() => applyMigration({ sourceRoot: source }), /安全的文件名称/);
  }
}

{
  const source = makeSource("sensitive");
  for (const folder of [source, path.join(source, "raw")]) {
    for (const name of [".env", "state-test.json", "secret.state.json", "auth.json"]) {
      fs.writeFileSync(path.join(folder, name), "人工敏感样本不应读取");
    }
    fs.mkdirSync(path.join(folder, "ruyi-profile"));
    fs.writeFileSync(path.join(folder, "ruyi-profile", "secret"), "人工敏感样本不应读取");
  }
  const originals = { lstatSync: fs.lstatSync, readFileSync: fs.readFileSync, readdirSync: fs.readdirSync, openSync: fs.openSync };
  try {
    for (const [name, original] of Object.entries(originals)) fs[name] = (file, ...args) => {
      if (typeof file === "string") {
        assert.ok(!file.split(path.sep).some((part) => [".env", "state-test.json", "secret.state.json", "auth.json", "ruyi-profile"].includes(part)), "敏感项不能被读取或检查");
      }
      return original(file, ...args);
    };
    assert.equal(applyMigration({ sourceRoot: source }).fileCount, 0);
  } finally { Object.assign(fs, originals); }
}

{
  const source = makeSource("unknown");
  fs.writeFileSync(path.join(source, "unexpected.txt"), "unknown");
  fs.writeFileSync(path.join(source, "other.md"), "unknown");
  fs.mkdirSync(path.join(source, "unknown-folder"));
  fs.writeFileSync(path.join(source, "control\x1b\u202ename.txt"), "unknown");
  const plan = planMigration({ sourceRoot: source, targetRoot: targetOf(source) });
  assert.ok(plan.issues.some((issue) => /白名单/.test(issue)));
  assert.ok(plan.issues.some((issue) => issue.includes('"unexpected.txt"（普通文件）')));
  assert.ok(plan.issues.some((issue) => issue.includes('"other.md"（普通文件）')));
  assert.ok(plan.issues.some((issue) => issue.includes('"unknown-folder"（目录）')));
  const controlIssue = plan.issues.find((issue) => issue.includes("control"));
  assert.ok(controlIssue.includes("\\u001b") && controlIssue.includes("\\u202e"));
  assert.ok(!controlIssue.includes("\x1b") && !controlIssue.includes("\u202e"));
  assert.throws(() => applyMigration({ sourceRoot: source, targetRoot: targetOf(source) }), /白名单/);
  assert.equal(fs.existsSync(targetOf(source)), false);
}

{
  const source = makeSource("auxiliary");
  const name = "总结报告生成流程.md";
  const auxiliaryPath = path.join(source, name);
  const bytes = Buffer.from([0xff, 0x00, 0x7b, 0x62, 0x61, 0x64, 0x0a]);
  fs.writeFileSync(auxiliaryPath, bytes);
  const originalRead = fs.readFileSync;
  try {
    fs.readFileSync = (file, ...args) => {
      assert.notEqual(file, auxiliaryPath, "辅助文件预检不能读取或解析内容");
      return originalRead(file, ...args);
    };
    const plan = planMigration({ sourceRoot: source });
    assert.deepEqual(plan.issues, []);
    assert.equal(plan.fileCount, 1);
    assert.equal(fs.existsSync(targetOf(source)), false);
  } finally { fs.readFileSync = originalRead; }
  const result = applyMigration({ sourceRoot: source });
  assert.equal(result.verifiedFileCount, 1);
  assert.equal(result.verifiedFiles[0].sha256, crypto.createHash("sha256").update(bytes).digest("hex"));
  assert.deepEqual(fs.readFileSync(path.join(targetOf(source), name)), bytes);
  assert.deepEqual(fs.readFileSync(auxiliaryPath), bytes);
}

{
  const source = makeSource("auxiliary-directory");
  fs.mkdirSync(path.join(source, "总结报告生成流程.md"));
  assert.throws(() => applyMigration({ sourceRoot: source }), /辅助文件不是普通文件/);
  assert.equal(fs.existsSync(targetOf(source)), false);
}

{
  const source = makeSource("symlink");
  const outside = path.join(source, "outside-secret");
  fs.writeFileSync(outside, "secret");
  try {
    fs.symlinkSync(outside, path.join(source, "raw", "link.txt"));
    const plan = planMigration({ sourceRoot: source, targetRoot: targetOf(source) });
    assert.ok(plan.issues.some((issue) => /符号链接/.test(issue)));
    assert.throws(() => applyMigration({ sourceRoot: source, targetRoot: targetOf(source) }), /符号链接/);
    assert.equal(fs.existsSync(targetOf(source)), false);
  } catch (error) {
    if (error.code !== "EPERM" && error.code !== "EACCES") throw error;
  }
}

{
  const source = makeSource("paths");
  assert.ok(planMigration({ sourceRoot: source, targetRoot: source }).issues.some((issue) => /不能相同/.test(issue)));
  const outside = path.join(temporary, "outside");
  const outsidePlan = planMigration({ sourceRoot: source, targetRoot: outside });
  assert.ok(outsidePlan.issues.some((issue) => /位于源数据根目录内/.test(issue)));
  assert.ok(outsidePlan.issues.some((issue) => /users\/pzw/.test(issue)));
  assert.throws(() => applyMigration({ sourceRoot: source, targetRoot: outside }), /目标目录/);
}

{
  const source = path.join(temporary, "empty");
  fs.mkdirSync(source);
  const plan = applyMigration({ sourceRoot: source });
  assert.equal(plan.fileCount, 0);
  for (const name of ["raw", "idfa", "oaid", "pn", "result"]) assert.ok(fs.statSync(path.join(targetOf(source), name)).isDirectory());
}

{
  const source = makeSource("multi-chunk");
  const content = Buffer.alloc(2 * 1024 * 1024 + 17, 0x61);
  fs.writeFileSync(path.join(source, "raw", "large_pn.txt"), content);
  const result = applyMigration({ sourceRoot: source });
  assert.equal(result.verifiedFiles[0].sha256, crypto.createHash("sha256").update(content).digest("hex"));
  assert.equal(fs.statSync(path.join(targetOf(source), "raw", "large_pn.txt")).size, content.length);
}

{
  const source = makeSource("corruption");
  fs.writeFileSync(path.join(source, "raw", "sample_pn.txt"), "人工样本");
  const originalWrite = fs.writeSync;
  try {
    fs.writeSync = (descriptor, buffer, offset, length, position) => {
      const corrupted = Buffer.from(buffer);
      corrupted[offset] ^= 1;
      return originalWrite(descriptor, corrupted, offset, length, position);
    };
    assert.throws(() => applyMigration({ sourceRoot: source }), /SHA-256/);
    assert.equal(fs.existsSync(targetOf(source)), false, "校验失败不能发布目标");
  } finally { fs.writeSync = originalWrite; }
  assert.equal(fs.readFileSync(path.join(source, "raw", "sample_pn.txt"), "utf8"), "人工样本");
  assert.equal(applyMigration({ sourceRoot: source }).verifiedFileCount, 1, "保留的临时目录不得影响重试");
}

{
  const source = makeSource("parent-race");
  fs.writeFileSync(path.join(source, "raw", "sample_pn.txt"), "人工样本");
  const outside = path.join(temporary, "external-parent");
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, "sample_pn.txt"), "不得读取的外部样本");
  const originalMkdtemp = fs.mkdtempSync;
  try {
    fs.mkdtempSync = (...args) => {
      const result = originalMkdtemp(...args);
      fs.renameSync(path.join(source, "raw"), path.join(source, "saved-raw"));
      fs.symlinkSync(outside, path.join(source, "raw"));
      return result;
    };
    assert.throws(() => applyMigration({ sourceRoot: source }), /符号链接/);
    assert.equal(fs.existsSync(targetOf(source)), false);
  } finally { fs.mkdtempSync = originalMkdtemp; }
}

{
  const source = makeSource("source-open-race");
  const sourcePath = path.join(source, "raw", "sample_pn.txt");
  fs.writeFileSync(sourcePath, "人工样本");
  const originalOpen = fs.openSync;
  let injected = false;
  try {
    fs.openSync = (file, ...args) => {
      const descriptor = originalOpen(file, ...args);
      if (file === sourcePath && !injected) {
        injected = true;
        fs.writeFileSync(sourcePath, "在源文件打开后、返回文件描述符前写入的不同长度内容");
      }
      return descriptor;
    };
    assert.throws(() => applyMigration({ sourceRoot: source }), /源文件在复制前发生变化/);
    assert.equal(injected, true);
    assert.equal(fs.existsSync(targetOf(source)), false, "打开文件后的变化不能成为新的校验基线");
  } finally { fs.openSync = originalOpen; }
}

{
  const source = makeSource("target-race");
  fs.writeFileSync(path.join(source, "raw", "sample_pn.txt"), "人工样本");
  const originalMkdir = fs.mkdirSync;
  let injected = false;
  try {
    fs.mkdirSync = (directory, ...args) => {
      if (directory === targetOf(source) && !injected) {
        injected = true;
        originalMkdir(directory);
        fs.writeFileSync(path.join(directory, "sentinel"), "已有目标");
      }
      return originalMkdir(directory, ...args);
    };
    assert.throws(() => applyMigration({ sourceRoot: source }), /迁移复制失败/);
    assert.equal(fs.readFileSync(path.join(targetOf(source), "sentinel"), "utf8"), "已有目标");
  } finally { fs.mkdirSync = originalMkdir; }
}

{
  const source = makeSource("cli");
  assert.throws(() => parseCli(["--source"]), /缺少目录参数/);
  const script = path.resolve(__dirname, "../scripts/migrate-user-workspace.js");
  const dry = spawnSync(process.execPath, [script, "--source", source], { encoding: "utf8" });
  assert.equal(dry.status, 0, dry.stderr);
  assert.match(dry.stdout, /dry-run/);
  assert.equal(fs.existsSync(targetOf(source)), false);
  fs.writeFileSync(path.join(source, "done.json"), "{}");
  const invalid = spawnSync(process.execPath, [script, "--source", source], { encoding: "utf8" });
  assert.equal(invalid.status, 1);
  assert.match(invalid.stderr, /JSON/);
}
console.log("工作区迁移预检、复制、字节校验与故障恢复测试通过");
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}
