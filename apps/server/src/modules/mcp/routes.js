const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
const z = require('zod');
const { authenticateBearer } = require('../auth/guard');
const { version } = require('../../../package.json');
const { createTools } = require('./tools');

const instructions = `本服务使用与网页相同的整任务系统，每次上传创建独立任务，自动完成上传、创建人群、洞悉和下载；同用户先进先出，同时仅运行一个整任务。
开始前先调用 get_overview 了解当前进度与建议的下一步。
平台登录只能由用户本人在网页完成；工具提示未登录时，把登录地址告诉用户并停止，不要重试。
上传返回 taskId，用 get_task / wait_for_task 查询；一次最多等 50 秒，仍在排队或运行可再次等待。平台未就绪时任务保持运行并默认每 30 秒检查，不算失败。
等待登录时停止等待，告知用户重新登录并明确选择 resume_task；已中断仅用户明确要求后 continue_task；失败/取消不可盲目重复创建。resume_task 会恢复当前用户所有等待登录任务。
上传和下载必须使用 prepare_upload / prepare_download 返回的一次性地址，配合 curl 直接传输。不要读取文件内容，不要把文件内容作为参数传给任何工具。
上传前说明会自动执行全部流程，用户只要求单一步骤时不得擅自运行全流程。run_task / set_auto_advance 已弃用，不要调用。旧 list_jobs/get_job/wait_for_job/cancel_job 只是整任务别名，其 jobId 必须是整任务 taskId。
整任务成功后调用 prepare_download(taskId) 取回结果。
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
      prepare_download: z.object({ taskId: z.string().uuid().optional(), jobId: z.string().uuid().optional() })
        .refine((value) => Boolean(value.taskId || value.jobId), '请提供整任务 taskId')
        .refine((value) => !value.taskId || !value.jobId || value.taskId === value.jobId, 'taskId 与 jobId 必须一致'),
      list_jobs: { page: z.number().int().min(1).optional(), pageSize: z.number().int().min(1).max(20).default(10) },
      get_job: { jobId: z.string().uuid() },
      wait_for_job: { jobId: z.string().uuid(), timeoutSeconds: z.number().int().min(5).max(50).default(45) },
      list_tasks: { page: z.number().int().min(1).optional(), pageSize: z.number().int().min(1).max(20).default(10) },
      get_task: { taskId: z.string().uuid() },
      wait_for_task: { taskId: z.string().uuid(), timeoutSeconds: z.number().int().min(5).max(50).default(45) },
      stop_task: { taskId: z.string().uuid(), version: z.number().int().positive().optional() },
      continue_task: { taskId: z.string().uuid(), version: z.number().int().positive().optional() },
      resume_task: { taskId: z.string().uuid(), confirm: z.boolean() },
      list_task_files: { taskId: z.string().uuid() },
      rename_task: { taskId: z.string().uuid(), name: z.string().max(128), version: z.number().int().positive().optional() },
      delete_task: { taskId: z.string().uuid(), version: z.number().int().positive().optional() },
      exclude_task_file: { taskId: z.string().uuid(), fileId: z.string().uuid(), version: z.number().int().positive().optional() },
    };
    const descriptions = {
      list_tasks: '分页查询当前用户的整任务，与网页我的任务一致。',
      get_task: '查询整任务状态、版本和各流程记录；不读取文件内容。',
      wait_for_task: '等待整任务，单次最多 50 秒；等待登录、中断、失败、取消时立即返回，运行中超时可再次等待。',
      stop_task: '请求停止运行中整任务，进程退出后为已中断，可继续。',
      continue_task: '仅在用户明确要求时，从中断任务未完成步骤重新入队。',
      resume_task: '用户重新登录并明确确认后，将其所有等待登录任务恢复入队；confirm 必须为 true。',
      list_task_files: '查看整任务的初始文件名清单和状态，不返回文件内容。',
      rename_task: '修改整任务名称。',
      delete_task: '软删除非运行中的整任务；运行中的任务先停止。',
      exclude_task_file: '任务开始前从后续执行清单移除文件；删除最后一个会取消任务。',
      prepare_upload: '获取一次性上传地址；上传成功即创建整任务并自动执行全部流程，返回 taskId。同用户可创建多个任务排队。',
      run_task: '已弃用：不提交单独步骤，请 prepare_upload 创建自动推进的整任务。',
      set_auto_advance: '已弃用：整任务默认自动推进，无需设置旧开关。',
      get_overview: '查看当前用户整任务与平台登录状态，不访问旧工作区。',
      check_platform: '查看登录态；平台处理进度由各整任务自行检查，不使用旧工作区就绪数量。',
      list_jobs: '兼容别名：同 list_tasks，返回整任务。',
      get_job: '兼容别名：同 get_task，jobId 必须为整任务 taskId。',
      wait_for_job: '兼容别名：同 wait_for_task，jobId 必须为整任务 taskId。',
      cancel_job: '兼容别名：同 stop_task，jobId 必须为整任务 taskId，停止后为已中断。',
      prepare_download: '按 taskId（或兼容 jobId 整任务编号）获取已成功整任务结果 ZIP 的一次性地址；下载后不要解压或打开查看，只报告路径和大小，除非用户明确要求查看结果。',
    };
    const annotations = {
      prepare_upload: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      run_task: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      cancel_job: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
      set_auto_advance: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      prepare_download: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    };
    for (const name of ['stop_task', 'continue_task', 'resume_task', 'rename_task', 'delete_task', 'exclude_task_file']) annotations[name] = {
      readOnlyHint: false, destructiveHint: ['stop_task', 'delete_task', 'exclude_task_file'].includes(name), idempotentHint: false, openWorldHint: false,
    };

    for (const [name, handler] of Object.entries(tools)) server.registerTool(name, { description: descriptions[name], inputSchema: schemas[name], annotations: annotations[name] || { readOnlyHint: true, openWorldHint: false } }, handler);
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
