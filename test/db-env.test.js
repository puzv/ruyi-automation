const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { loadDotEnv } = require("../db/env");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ruyi-env-test-"));
const file = path.join(dir, "config.txt");
const keys = ["RUYI_ENV_TEST_EXISTING", "RUYI_ENV_TEST_EMPTY", "RUYI_ENV_TEST_QUOTED", "RUYI_ENV_TEST_SINGLE", "RUYI_ENV_TEST_PLAIN"];
const previous = keys.map((key) => process.env[key]);
try {
  process.env[keys[0]] = "已有值";
  process.env[keys[1]] = "";
  for (const key of keys.slice(2)) delete process.env[key];
  fs.writeFileSync(file, [
    "# 注释", "无效行", "RUYI_ENV_TEST_EXISTING=覆盖值", "RUYI_ENV_TEST_EMPTY=覆盖值",
    'RUYI_ENV_TEST_QUOTED="中文值"', "RUYI_ENV_TEST_SINGLE='单引号值'", "RUYI_ENV_TEST_PLAIN=value=tail",
  ].join("\r\n"));
  loadDotEnv(path.join(dir, "不存在"));
  loadDotEnv(file);
  assert.deepStrictEqual(keys.map((key) => process.env[key]), ["已有值", "", "中文值", "单引号值", "value=tail"]);
  console.log("环境变量加载测试通过。");
} finally {
  keys.forEach((key, index) => {
    if (previous[index] === undefined) delete process.env[key];
    else process.env[key] = previous[index];
  });
}
