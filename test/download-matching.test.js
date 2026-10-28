const assert = require("node:assert/strict");

const { normalizeTaskName, sameTaskTitle } = require("@ruyi/automation/download");

assert.equal(normalizeTaskName(" puzw_oaid_09149fe5_1.txt\n"), "puzw_oaid_09149fe5_1");
assert.equal(normalizeTaskName("puzw_oaid_09149fe5_1.CSV"), "puzw_oaid_09149fe5_1");
assert.equal(normalizeTaskName("puzw_oaid_09149fe5_1\u200b"), "puzw_oaid_09149fe5_1");
assert.equal(sameTaskTitle("puzw_oaid_09149fe5_1.txt", " puzw_oaid_09149fe5_1 "), true);
assert.equal(sameTaskTitle("puzw_oaid_09149fe5_10", "puzw_oaid_09149fe5_1"), false);
assert.equal(sameTaskTitle("puzw_oaid_09149fe5_1", "puzw_oaid_09149fe5_1.txt"), true);

console.log("下载任务名称匹配测试通过：扩展名、空白和相似序号均正确处理");
