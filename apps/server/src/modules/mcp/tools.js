const TOOL_NAMES = Object.freeze(['get_overview', 'check_platform', 'list_jobs', 'get_job', 'wait_for_job', 'prepare_upload', 'run_task', 'cancel_job', 'set_auto_advance', 'prepare_download']);
const { createTicket } = require('../transfer/repository');
const { version } = require('../../../package.json');
const { uploadRoot: defaultUploadRoot } = require('@ruyi/shared/config');

function publicUrl(request) {
  return (process.env.RUYI_PUBLIC_URL || `${request.protocol}://${request.host}`).replace(/\/+$/, '');
}
const fields = ['id', 'task', 'status', 'position', 'queuedAt', 'startedAt', 'finishedAt', 'exitCode', 'errorMessage', 'resultFiles'];
const pickJob = (job) => job ? Object.fromEntries(fields.filter((key) => job[key] !== undefined).map((key) => [key, job[key]])) : null;
function tail(text, limit = 8192) {
  const bytes = Buffer.from(text);
  let start = Math.max(0, bytes.length - limit);
  while (start < bytes.length && (bytes[start] & 0xc0) === 0x80) start++;
  return bytes.subarray(start).toString('utf8');
}
function decideNextStep(workspace, platform, active, auto, latestDownload) {
  const choices = [
    [platform.status !== 'valid', 'login', '如翼平台未登录或登录已失效，请完成平台登录后再继续。'],
    [!!active.job, 'wait_job', '有排队或运行中的任务，请调用 wait_for_job 等待。'],
    [workspace.pendingUpload > 0, 'run_upload', '有待上传文件，请调用 run_task(upload) 提交上传任务。'],
    [workspace.createCount > 0, 'wait_platform_files', auto.enabled ? '等待平台处理文件，自动推进会自动创建人群。' : '等待平台处理文件，稍后调用 check_platform，文件就绪后调用 run_task(create) 创建人群。'],
    [workspace.analyseCount > 0, 'wait_audience', auto.enabled ? '等待平台生成人群，自动推进会自动提交洞悉。' : '等待平台生成人群，稍后调用 check_platform，就绪后调用 run_task(analyse) 提交洞悉。'],
    [!!latestDownload, 'prepare_download', '下载任务已结束，请调用 prepare_download 取得结果地址，再用 curl 保存到本地。'],
    [workspace.doneCount > 0, auto.phase === 'resultsReady' ? 'run_download' : 'wait_results', auto.phase === 'resultsReady' ? '结果已就绪，请调用 run_task(download) 下载结果。' : '等待平台生成结果，稍后调用 check_platform；结果就绪后需手动下载，自动推进不会自动下载。'],
    [true, 'import_files', '当前无待办，可调用 prepare_upload 导入新文件，不要读取文件内容。'],
  ];
  const [, action, message] = choices.find(([condition]) => condition);
  return { action, message };
}
function createTools(app, request, reply, options = {}) {
  const loginUrl = `${publicUrl(request)}/#/platform-login`;
  const loginMessage = `如翼平台未登录或登录已失效，请在浏览器打开 ${loginUrl} 完成登录后再继续。不要重试。`;
  let closed = reply.raw.destroyed;
  const controller = new AbortController();
  reply.raw.once('close', () => { closed = true; controller.abort(); });
  async function callApi(method, url, body) {
    const response = await app.inject({ method, url, ...(body === undefined ? {} : { payload: body }), headers: {
      authorization: request.headers.authorization,
      'user-agent': `ruyi-mcp/${version} (${String(request.headers['user-agent'] || '').slice(0, 160).replace(/[\r\n]/g, ' ')})`,
    }, remoteAddress: request.ip });
    const status = response.statusCode;
    let data;
    try { data = response.json(); } catch (_) { data = {}; }
    return { status, data };
  }
  async function api(url, method = 'GET', body) {
    const { status, data } = await callApi(method, url, body);
    if (status >= 400) throw new Error(status === 409 && data.code === 'PLATFORM_LOGIN_REQUIRED' ? loginMessage
      : status >= 500 ? '平台服务出错，请稍后重试' : url === '/api/platform-status' && status === 409
        ? '平台检查正在进行，请 1 分钟后再试' : data.message || '请求失败');
    return data;
  }
  const success = (summary, data) => ({ content: [{ type: 'text', text: `${summary}\n${JSON.stringify(data)}` }], structuredContent: data });
  const wrap = (fn) => async (args) => {
    try { return await fn(args || {}); } catch (error) {
      return { isError: true, content: [{ type: 'text', text: error.message }] };
    }
  };
  async function job(jobId) {
    const data = await api(`/api/jobs/${jobId}`);
    const root = options.uploadRoot || defaultUploadRoot;
    const log = String(data.job.output || data.output || '').split(root).join('<工作区>');
    return { ...pickJob(data.job), logTail: tail(log) };
  }
  async function ticket(purpose, jobId) {
    const created = await (options.createTicket || createTicket)(app.db, { userId: request.user.id, purpose, jobId });
    return { url: `${publicUrl(request)}/api/transfer/${purpose}/${created.secret}`, expiresAt: created.expiresAt };
  }
  return {
    prepare_upload: wrap(async () => {
      if ((await api('/api/jobs/active')).job) throw new Error('当前用户有任务正在运行或排队，请等待完成后再导入');
      const { url, expiresAt } = await ticket('upload');
      return success('请用 curl 直接上传，不要读取文件内容。链接 10 分钟有效且只能使用一次。', {
        uploadUrl: url, expiresAt,
        curlExample: `curl -sS -F "files=@/path/to/a_idfa.txt" -F "files=@/path/to/b_pn.csv" '${url}'`,
        rules: ['文件名需包含 idfa、oaid 或 pn，扩展名为 .txt 或 .csv。', '一个链接只能用一次，多个文件请在一条命令中一起上传。', '上传文件夹时先列出符合规则的文件，再逐个添加 -F；不要读取文件内容。'],
      });
    }),
    run_task: wrap(async ({ task }) => {
      const data = await api(`/api/run/${task}`, 'POST');
      return success('任务已提交，请用 wait_for_job 等待。', { jobId: data.id, status: data.status, position: data.position });
    }),
    cancel_job: wrap(async ({ jobId }) => success('取消请求已提交。', await api(`/api/jobs/${jobId}/cancel`, 'POST'))),
    set_auto_advance: wrap(async ({ enabled }) => {
      const data = await api('/api/auto-advance', 'POST', { enabled });
      return success(enabled ? '已开启自动推进。' : '已关闭自动推进。', { enabled: data.enabled, phase: data.phase, message: data.message });
    }),
    prepare_download: wrap(async ({ jobId }) => {
      const data = await api(`/api/jobs/${jobId}/results`);
      const { url, expiresAt } = await ticket('download', jobId);
      return success('请用 curl 保存结果，可自行指定保存目录。链接 10 分钟有效且只能使用一次。下载后不要解压或打开查看，只报告路径和大小，除非用户明确要求查看结果。', {
        downloadUrl: url, expiresAt, fileCount: data.count, size: data.size,
        curlExample: `curl -sS -fL -o ./ruyi-results-${jobId}.zip '${url}'`,
      });
    }),
    get_overview: wrap(async () => {
      const [status, platform, active] = await Promise.all(['/api/status', '/api/platform-state', '/api/jobs/active'].map((url) => api(url)));
      const autoResult = await callApi('GET', '/api/auto-advance');
      const auto = autoResult.status === 404 ? { enabled: false, phase: 'unavailable', message: '服务未启用自动推进' } : (() => {
        if (autoResult.status >= 400) throw new Error(autoResult.data.message || '请求失败');
        return autoResult.data;
      })();
      const workspace = { status: status.workspaceStatus, pendingUpload: status.rawCount, createCount: status.createCount, analyseCount: status.analyseCount, doneCount: status.doneCount };
      const recent = await api('/api/jobs?page=1&pageSize=20');
      const latest = recent.items[0];
      const latestDownload = latest?.task === 'download' && ['succeeded', 'failed'].includes(latest.status) && latest.resultFiles > 0 ? latest : null;
      const nextStep = decideNextStep(workspace, platform, active, auto, latestDownload);
      const data = { workspace, platformLogin: { status: platform.status, loginUrl }, activeJob: pickJob(active.job), autoAdvance: { enabled: auto.enabled, phase: auto.phase, message: auto.message }, nextStep, ...(nextStep.action === 'prepare_download' ? { resultJob: pickJob(latestDownload) } : {}) };
      return success(nextStep.message, data);
    }),
    check_platform: wrap(async () => {
      if ((await api('/api/platform-state')).status !== 'valid') throw new Error(loginMessage);
      const [status, counts] = await Promise.all([api('/api/status'), api('/api/platform-status')]);
      const data = Object.fromEntries(['idfaPending', 'oaidPending', 'pnPending', 'insightPending', 'resultPending'].map((key) => [key, counts[key]]));
      data.ready = { create: status.createCount > 0 && counts.idfaPending + counts.oaidPending + counts.pnPending === 0, analyse: status.analyseCount > 0 && counts.insightPending === 0, download: status.doneCount > 0 && counts.resultPending === 0 };
      // 部分平台检查失败时不能把默认的零误认为已就绪。
      if (counts.errors?.length) { data.ready = { create: false, analyse: false, download: false }; data.message = '部分平台检查失败，请稍后再试'; }
      return success(`平台尚未就绪：IDFA 文件 ${data.idfaPending}，OAID 文件 ${data.oaidPending}，PN 文件 ${data.pnPending}，人群 ${data.insightPending}，结果 ${data.resultPending}。${data.message || ''}`, data);
    }),
    list_jobs: wrap(async ({ page = 1, pageSize = 10 }) => {
      const data = await api(`/api/jobs?page=${page}&pageSize=${pageSize}`);
      return success('任务列表', { items: data.items.map(pickJob), total: data.total, page: data.page, pageSize: data.pageSize });
    }),
    get_job: wrap(async ({ jobId }) => success('任务详情', await job(jobId))),
    wait_for_job: wrap(async ({ jobId, timeoutSeconds = 45 }) => {
      const deadline = Date.now() + timeoutSeconds * 1000;
      while (!closed) {
        const data = await job(jobId);
        const running = ['queued', 'running'].includes(data.status);
        if (!running || Date.now() >= deadline) return success(running ? '等待超时，任务仍在进行，可再次等待。' : '任务已结束。', { ...data, timedOut: running });
        await new Promise((resolve) => {
          const done = () => { clearTimeout(timer); controller.signal.removeEventListener('abort', done); resolve(); };
          const timer = setTimeout(done, Math.min(2000, Math.max(0, deadline - Date.now())));
          controller.signal.addEventListener('abort', done, { once: true });
          if (closed) done();
        });
      }
      throw new Error('客户端已断开，停止等待');
    }),
  };
}
module.exports = { TOOL_NAMES, createTools, publicUrl, tail, decideNextStep };
