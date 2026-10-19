const fs = require("fs");
const path = require("path");
const Fastify = require("fastify");
const { LogController } = Fastify;
const fastifyStatic = require("@fastify/static");
const { registerRoutes } = require("./routes");

function defaultLogger() {
  const levels = { 30: "INFO", 40: "WARN", 50: "ERROR", 60: "FATAL" };
  return {
    level: "info",
    stream: {
      write(line) {
        const record = JSON.parse(line);
        const date = new Date(record.time);
        const time = [date.getHours(), date.getMinutes(), date.getSeconds()]
          .map((value) => String(value).padStart(2, "0")).join(":");
        const stack = record.err?.stack;
        process.stdout.write(`${time} ${levels[record.level] || record.level} ${record.msg || ""}${stack ? `\n${stack}` : ""}\n`);
      },
    },
  };
}

function buildApp(options = {}) {
  const app = Fastify({
    logger: options.logger ?? defaultLogger(),
    logController: new LogController({ disableRequestLogging: true }),
    bodyLimit: 2 * 1024 * 1024,
  });
  const webDist = path.resolve(options.webDist ?? path.join(__dirname, "..", "web", "dist"));
  const indexFile = path.join(webDist, "index.html");
  const hasWebBuild = fs.existsSync(indexFile) && fs.statSync(indexFile).isFile();

  app.addHook("onResponse", async (request, reply) => {
    if (request.url.startsWith("/api/") && (request.method !== "GET" || reply.statusCode >= 400)) {
      request.log.info(`${request.method} ${request.url} ${reply.statusCode} ${Math.round(reply.elapsedTime)}ms`);
    }
  });

  app.setErrorHandler((error, request, reply) => {
    if (request.url.startsWith("/api/")) {
      // API 自行返回 JSON，需显式记录异常以保留默认错误处理器的堆栈信息。
      if ((error.statusCode || 500) >= 500) request.log.error({ err: error }, error.message);
      return reply.code(error.statusCode || 500).send({ ok: false, message: error.message });
    }
    return reply.send(error);
  });

  app.get("/api/health", async () => ({ ok: true }));
  app.register(registerRoutes);
  // API 路径不能被同名静态文件或单页应用回退接管。
  app.all("/api/*", async (request, reply) => {
    return reply.code(404).send({ ok: false, message: "接口不存在" });
  });

  if (hasWebBuild) {
    app.register(fastifyStatic, { root: webDist });
  }

  app.setNotFoundHandler((request, reply) => {
    if (request.method === "GET") {
      if (!hasWebBuild) {
        return reply.code(503).send({
          ok: false,
          message: "前端尚未构建，请先执行 npm run build:web",
        });
      }
      return reply.sendFile("index.html");
    }
    return reply.code(404).send({ ok: false, message: "页面不存在" });
  });

  return app;
}

module.exports = { buildApp };
