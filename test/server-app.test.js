const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { buildApp } = require("../server/app");

async function main() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ruyi-server-test-"));
  const apps = [];
  try {
    const webDist = path.join(tempDir, "dist");
    const indexHtml = "<!doctype html><html><body>测试页面</body></html>";
    const asset = 'console.log("测试静态文件");';
    fs.mkdirSync(path.join(webDist, "assets"), { recursive: true });
    fs.mkdirSync(path.join(webDist, "api"));
    fs.writeFileSync(path.join(webDist, "index.html"), indexHtml);
    fs.writeFileSync(path.join(webDist, "assets", "a.js"), asset);
    fs.writeFileSync(path.join(webDist, "api", "xxx"), "不应返回的静态文件");

    const app = buildApp({ webDist, logger: false });
    apps.push(app);
    assert.equal(app.server.listening, false);

    const health = await app.inject({ method: "GET", url: "/api/health" });
    assert.equal(health.statusCode, 200);
    assert.deepEqual(health.json(), { ok: true });

    for (const method of ["GET", "POST"]) {
      const missingApi = await app.inject({ method, url: "/api/xxx?test=1" });
      assert.equal(missingApi.statusCode, 404);
      assert.deepEqual(missingApi.json(), { ok: false, message: "接口不存在" });
    }

    for (const url of ["/", "/some/page", "/some/page?test=1"]) {
      const page = await app.inject({ method: "GET", url });
      assert.equal(page.statusCode, 200);
      assert.equal(page.body, indexHtml);
      assert.match(page.headers["content-type"], /text\/html/);
    }

    const staticFile = await app.inject({ method: "GET", url: "/assets/a.js" });
    assert.equal(staticFile.statusCode, 200);
    assert.equal(staticFile.body, asset);

    const missingPage = await app.inject({ method: "POST", url: "/some/page" });
    assert.equal(missingPage.statusCode, 404);

    const emptyDist = path.join(tempDir, "empty-dist");
    fs.mkdirSync(emptyDist);
    for (const unbuiltDist of [path.join(tempDir, "missing-dist"), emptyDist]) {
      const unbuiltApp = buildApp({ webDist: unbuiltDist, logger: false });
      apps.push(unbuiltApp);
      const unbuiltHealth = await unbuiltApp.inject({ method: "GET", url: "/api/health" });
      assert.equal(unbuiltHealth.statusCode, 200);
      assert.deepEqual(unbuiltHealth.json(), { ok: true });

      const missingApi = await unbuiltApp.inject({ method: "GET", url: "/api/xxx" });
      assert.equal(missingApi.statusCode, 404);
      assert.deepEqual(missingApi.json(), { ok: false, message: "接口不存在" });

      for (const url of ["/", "/some/page"]) {
        const unavailable = await unbuiltApp.inject({ method: "GET", url });
        assert.equal(unavailable.statusCode, 503);
        assert.equal(unavailable.json().ok, false);
        assert.match(unavailable.json().message, /npm run build:web/);
      }
    }
  } finally {
    try {
      await Promise.all(apps.map((app) => app.close()));
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  }
  console.log("后端骨架测试通过");
}

main().catch((error) => {
  console.error("后端骨架测试失败：", error);
  process.exitCode = 1;
});
