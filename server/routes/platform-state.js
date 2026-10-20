const { getStatusSummary } = require("../platform-state");
const { clearState } = require("../repos/platform-states");

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
