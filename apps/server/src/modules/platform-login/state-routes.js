const { getStatusSummary } = require("@ruyi/shared/runtime/platform-state/index");
const { clearState } = require("@ruyi/shared/runtime/repos/platform-states");

async function registerPlatformStateRoutes(app) {
  app.get("/api/platform-state", async (request) => ({
    ok: true,
    ...await getStatusSummary(app.db, request.user.id),
  }));
  app.post("/api/platform-state/clear", async (request) => {
    await clearState(app.db, request.user.id);
    return { ok: true };
  });
}

module.exports = { registerPlatformStateRoutes };
