const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
const z = require('zod');
const { authenticateBearer } = require('../auth/guard');
const { version } = require('../../../package.json');
const { createTools } = require('./tools');

const instructions = `本服务操作如翼 / DataNexus 人群包工作流，流程固定为：导入文件 → 上传（upload）→ 平台处理文件 → 创建人群包（create）→ 平台生成人群 → 人群洞悉（analyse）→ 平台生成结果 → 下载结果（download）。
开始前先调用 get_overview 了解当前进度与建议的下一步。
平台登录只能由用户本人在网页完成；工具提示未登录时，把登录地址告诉用户并停止，不要重试。
任务提交后是异步执行的，用 wait_for_job 等待；一次最多等 50 秒，未结束可再次调用。平台侧处理通常需要几分钟到几十分钟。
check_platform 会启动浏览器访问平台，较慢，不要频繁调用（两次间隔至少 1 分钟）；提示“正在进行”时等待后再试。
上传和下载必须使用 prepare_upload / prepare_download 返回的一次性地址，配合 curl 直接传输。不要读取文件内容，不要把文件内容作为参数传给任何工具。
提交任务（run_task）前向用户说明将要执行的操作；下载任务结束后调用 prepare_download 取回结果。
除非用户明确要求查看结果，不得以任何方式（cat、head、python、解压后打开等）读取、预览或统计人群包文件和下载的结果文件的内容，也不得输出或转述其中的设备号、手机号等内容。下载完成后只报告保存路径与文件大小。`;

async function registerMcpRoutes(app, options) {
  async function authorize(request, reply) {
    const credential = await authenticateBearer(app.db, request.headers.authorization);
    if (!credential) return reply.header('WWW-Authenticate', 'Bearer realm="ruyi"').code(401)
      .send({ ok: false, code: 'UNAUTHENTICATED', message: '需要有效的 API 令牌' });
    request.user = credential.user;
    if (credential.user.must_change_password || credential.user.mustChangePassword) return reply.code(403)
      .send({ ok: false, code: 'PASSWORD_CHANGE_REQUIRED', message: '请先修改密码' });
  }
  for (const method of ['GET', 'DELETE']) app.route({ method, url: '/mcp', handler: (_req, reply) => reply.code(405).send({ ok: false, message: '仅支持 POST' }) });
  for (const base of ['/.well-known/oauth-protected-resource', '/.well-known/oauth-authorization-server']) {
    for (const url of [base, `${base}/*`]) app.get(url, (_req, reply) => reply.code(404).send({ ok: false, message: '接口不存在' }));
  }
  app.post('/mcp', { onRequest: authorize }, async (request, reply) => {
    const server = new McpServer({ name: 'ruyi', version }, { instructions });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    const tools = createTools(app, request, reply, options);
    const schemas = {
      get_overview: {}, check_platform: {}, prepare_upload: {},
      run_task: { task: z.enum(['upload', 'create', 'analyse', 'download']) },
      cancel_job: { jobId: z.string().uuid() },
      set_auto_advance: { enabled: z.boolean() },
      prepare_download: { jobId: z.string().uuid() },
      list_jobs: { page: z.number().int().min(1).optional(), pageSize: z.number().int().min(1).max(20).default(10) },
      get_job: { jobId: z.string().uuid() },
      wait_for_job: { jobId: z.string().uuid(), timeoutSeconds: z.number().int().min(5).max(50).default(45) },
    };
    const descriptions = {
      prepare_upload: '获取一次性上传地址，使用 curl 直接上传，绝不读取文件内容。',
      run_task: '提交上传、创建、洞悉或下载任务；提交前向用户说明操作，之后用 wait_for_job 等待。',
      cancel_job: '取消指定任务。',
      set_auto_advance: '开启或关闭自动推进。',
      prepare_download: '获取已结束下载任务结果 ZIP 的一次性地址，使用 curl 保存到用户指定目录；下载后不要解压或打开查看，只报告路径和大小，除非用户明确要求查看结果。',
      get_overview: '查看当前用户的人群包工作流进度（待上传、待创建、待洞悉、待下载数量）、平台登录状态、正在运行的任务和自动推进状态，并给出下一步建议。开始任何操作前先调用。',
      check_platform: '启动浏览器访问如翼平台，核对已上传文件、人群包、洞悉结果在平台上是否已就绪。耗时 10 秒到数分钟，两次调用至少间隔 1 分钟；只在需要判断能否进行下一步时调用。',
      list_jobs: '分页列出当前用户提交过的任务（上传、创建、洞悉、下载）及状态。',
      get_job: '查看单个任务的状态和日志末尾，用于了解任务失败原因。',
      wait_for_job: '等待任务结束，单次最多 50 秒；返回 timedOut=true 表示仍在进行，可再次调用。',
    };
    const annotations = {
      prepare_upload: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      run_task: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      cancel_job: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
      set_auto_advance: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      prepare_download: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    };
    for (const [name, handler] of Object.entries(tools)) server.registerTool(name, { description: descriptions[name], inputSchema: schemas[name], annotations: annotations[name] || { readOnlyHint: true, openWorldHint: name === 'check_platform' } }, handler);
    reply.raw.once('close', () => { void Promise.allSettled([transport.close(), server.close()]); });
    try {
      await server.connect(transport);
      reply.hijack();
      await transport.handleRequest(request.raw, reply.raw, request.body);
    } catch (_) {
      // 不记录 SDK 异常原文，防止请求凭据进入日志。
      request.log.error('MCP 请求处理失败');
      if (!reply.raw.headersSent && !reply.raw.destroyed) {
        reply.raw.writeHead(500, { 'Content-Type': 'application/json' });
        reply.raw.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32603, message: '服务内部错误' }, id: null }));
      }
    }
  });
}
module.exports = { registerMcpRoutes };
