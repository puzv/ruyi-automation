const assert = require("assert");
const { checkStatement, createdTable } = require("../db/migration-guard");

const rejected = [
  "DROP TABLE users",
  "DROP TABLE ruyi_users",
  "DROP DATABASE bsg_dw",
  "TRUNCATE ruyi_users",
  "TRUNCATE TABLE bsg_orders",
  "DELETE FROM ruyi_users",
  "UPDATE bsg_orders SET a = 1",
  "INSERT INTO bsg_orders VALUES (1)",
  "RENAME TABLE bsg_orders TO ruyi_orders",
  "CREATE TABLE other_table (id INT)",
  "ALTER TABLE bsg_orders ADD COLUMN x INT",
  "CREATE INDEX idx_x ON bsg_orders (x)",
  "CREATE TABLE ruyi_x (id INT, FOREIGN KEY (id) REFERENCES bsg_orders (id))",
  "CREATE TABLE ruyi_x (id INT); DROP TABLE bsg_orders",
  "ALTER TABLE ruyi_users DROP COLUMN status",
  "ALTER TABLE ruyi_users RENAME TO bsg_users",
  "/* comment */ DROP TABLE bsg_orders",
];
for (const statement of rejected) {
  assert.ok(checkStatement(statement), `should reject: ${statement}`);
}

const allowed = [
  "CREATE TABLE ruyi_x (id INT, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP)",
  "CREATE TABLE ruyi_x (id INT COMMENT '删除 DROP TABLE bsg_orders 只是注释文字')",
  "CREATE TABLE ruyi_child (id INT, CONSTRAINT fk FOREIGN KEY (id) REFERENCES ruyi_users (id))",
  "ALTER TABLE ruyi_users ADD COLUMN department VARCHAR(64) NULL",
  "CREATE INDEX idx_dept ON ruyi_users (department)",
];
for (const statement of allowed) {
  assert.strictEqual(checkStatement(statement), null, `should allow: ${statement}`);
}

assert.strictEqual(createdTable("\n  CREATE TABLE ruyi_users (id INT)"), "ruyi_users");
assert.strictEqual(createdTable("ALTER TABLE ruyi_users ADD x INT"), null);

console.log("Migration guard checks passed");
