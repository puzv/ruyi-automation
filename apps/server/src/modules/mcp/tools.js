const TOOL_NAMES = Object.freeze(['get_overview', 'check_platform', 'list_tasks', 'get_task', 'wait_for_task', 'prepare_upload', 'stop_task', 'continue_task', 'resume_task', 'list_task_files', 'rename_task', 'delete_task', 'exclude_task_file', 'prepare_download', 'list_jobs', 'get_job', 'wait_for_job', 'run_task', 'cancel_job', 'set_auto_advance']);
const { createTicket } = require('../transfer/repository');
const { version } = require('../../../package.json');
const { uploadRoot: defaultUploadRoot } = require('@ruyi/shared/config');

function publicUrl(request) {
  return (process.env.RUYI_PUBLIC_URL || `${request.protocol}://${request.host}`).replace(/\/+$/, '');
}
function tail(text, limit = 8192) {
  const bytes = Buffer.from(text);
  let start = Math.max(0, bytes.length - limit);
  while (start < bytes.length && (bytes[start] & 0xc0) === 0x80) start++;
  return bytes.subarray(start).toString('utf8');
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
  async function ticket(purpose, jobId) {
    const created = await (options.createTicket || createTicket)(app.db, { userId: request.user.id, purpose, jobId });
    return { url: `${publicUrl(request)}/api/transfer/${purpose}/${created.secret}`, expiresAt: created.expiresAt };
  }
  async function wholeTask(taskId, includeLog = false) {
    if (typeof taskId !== 'string' || !/^[a-f0-9-]{36}$/i.test(taskId)) throw new Error('请提供整任务 taskId');
    const data = await api(`/api/tasks/${taskId}`);
    const jobs = data.jobs || [];
    const result = { ...data.item, taskId: data.item.id, jobs: jobs.slice(-50), jobCount: jobs.length };
    if (includeLog && jobs.length) {
      const latest = jobs[jobs.length - 1];
      const detail = await api(`/api/jobs/${latest.id}`);
      const root = options.uploadRoot || defaultUploadRoot;
      const log = String(detail.job?.output || detail.output || '').split(root).join('<工作区>')
        .replace(/ruyi_pat_[A-Za-z0-9_-]+/g, '<凭据>')
        .replace(/Bearer\s+\S+/gi, 'Bearer <凭据>')
        .replace(/(\/api\/transfer\/(?:upload|download)\/)\S+/g, '$1<票据>')
        .replace(/(?:cookie|authorization|storageState|state_ciphertext)\s*[:=]\s*[^\n]+/gi, '<登录凭据已隐藏>');
      result.logTail = tail(log);
    }
    return result;
  }
  async function mutate(taskId, action, version) {
    const data = await wholeTask(taskId);
    return api(`/api/tasks/${taskId}${action ? `/${action}` : ''}`, action ? 'POST' : 'DELETE', { version: version ?? data.version });
  }
  const wait = wrap(async ({ taskId, jobId, timeoutSeconds = 45 }) => {
    const deadline = Date.now() + Math.min(50, Math.max(0, timeoutSeconds)) * 1000;
    while (!closed) {
      const data = await wholeTask(taskId || jobId);
      const running = ['queued', 'running'].includes(data.status);
      if (!running || Date.now() >= deadline) return success(running ? '等待超时，整任务仍在进行，可再次等待。' : data.status === 'waiting_login' ? loginMessage : '整任务已结束。', { ...data, timedOut: running });
      await new Promise((resolve) => {
        const done = () => { clearTimeout(timer); controller.signal.removeEventListener('abort', done); resolve(); };
        const timer = setTimeout(done, Math.min(2000, Math.max(0, deadline - Date.now())));
        controller.signal.addEventListener('abort', done, { once: true });
        if (closed) done();
      });
    }
    throw new Error('客户端已断开，停止等待');
  });
  const list = wrap(async ({ page = 1, pageSize = 10 }) => success('整任务列表', await api(`/api/tasks?page=${page}&pageSize=${pageSize}`)));
  const detail = wrap(async ({ taskId, jobId }) => success('整任务详情（包含最近 50 条流程记录）', await wholeTask(taskId || jobId, true)));
  const handlers = {
    prepare_upload: wrap(async () => {
      if ((await api('/api/platform-state')).status !== 'valid') throw new Error(loginMessage);
      const { url, expiresAt } = await ticket('upload');
      return success('请用 curl 直接上传，不要读取文件内容。上传成功即创建一个独立整任务并自动排队执行全部流程，无需再调用 run_task。链接 10 分钟有效且只能使用一次。', {
        uploadUrl: url, expiresAt,
        curlExample: `curl -sS -F "files=@/path/to/a_idfa.txt" -F "files=@/path/to/b_pn.csv" '${url}'`,
        rules: ['文件名需包含 idfa、oaid 或 pn，扩展名为 .txt 或 .csv。', '一个链接只能用一次，多个文件请在一条命令中一起上传。', '上传文件夹时先列出符合规则的文件，再逐个添加 -F；不要读取文件内容。'],
      });
    }),
    run_task: wrap(async () => { throw new Error('已切换整任务系统：请使用 prepare_upload 上传文件；上传成功后自动执行全部流程，不再支持单独提交步骤。'); }),
    cancel_job: wrap(async ({ jobId, version }) => success('停止请求已提交，退出后为已中断，可继续。', await mutate(jobId, 'stop', version))),
    set_auto_advance: wrap(async () => { throw new Error('整任务默认自动推进全部流程，不再提供旧工作区自动推进开关。'); }),
    prepare_download: wrap(async ({ taskId, jobId: alias }) => {
      if (taskId && alias && taskId !== alias) throw new Error('taskId 与兼容 jobId 必须指向同一个整任务');
      const task = await wholeTask(taskId || alias);
      if (task.status !== 'succeeded') throw new Error('整任务尚未成功完成，暂时不能下载结果');
      const all = await api(`/api/tasks/${task.id}`);
      const download = [...(all.jobs || [])].reverse().find((job) => job.task === 'download' && job.status === 'succeeded');
      if (!download) throw new Error('整任务没有可下载的结果');
      const jobId = download.id;
      const data = await api(`/api/jobs/${jobId}/results`);
      const { url, expiresAt } = await ticket('download', jobId);
      return success('请用 curl 保存结果，可自行指定保存目录。链接 10 分钟有效且只能使用一次。下载后不要解压或打开查看，只报告路径和大小，除非用户明确要求查看结果。', {
        taskId: task.id, downloadUrl: url, expiresAt, fileCount: data.count, size: data.size,
        curlExample: `curl -sS -fL -o ./ruyi-results-${jobId}.zip '${url}'`,
      });
    }),
    get_overview: wrap(async () => {
      const [platform, recent] = await Promise.all([api('/api/platform-state'), api('/api/tasks?page=1&pageSize=20')]);
      const nextStep = platform.status !== 'valid' ? { action: 'login', message: loginMessage }
        : { action: 'list_tasks', message: '上传即创建整任务，按用户先进先出自动推进。使用 list_tasks 查看全部任务，get_task / wait_for_task 查看或等待指定整任务。' };
      const data = { platformLogin: { status: platform.status, loginUrl }, tasks: recent.items, total: recent.total,
        automatic: true, polling: { platformRetrySeconds: 30, waitForTaskSeconds: 2 }, nextStep };
      return success(nextStep.message, data);
    }),
    check_platform: wrap(async () => {
      if ((await api('/api/platform-state')).status !== 'valid') throw new Error(loginMessage);
      return success('平台登录有效。每个整任务由 Worker 在隔离工作区自行检查平台进度，无需手动触发旧工作区检查。', { platformLogin: 'valid', automatic: true });
    }),
    list_tasks: list, list_jobs: list,
    get_task: detail, get_job: detail,
    wait_for_task: wait, wait_for_job: wait,
    list_task_files: wrap(async ({ taskId }) => success('任务原始文件清单', await api(`/api/tasks/${taskId}/files`))),
    stop_task: wrap(async ({ taskId, version }) => success('停止请求已提交，退出后为已中断，可继续。', await mutate(taskId, 'stop', version))),
    continue_task: wrap(async ({ taskId, version }) => success('已请求继续中断任务。', await mutate(taskId, 'continue', version))),
    resume_task: wrap(async ({ taskId, confirm }) => {
      if (confirm !== true) throw new Error('恢复登录等待会将该用户所有等待登录任务重新入队，请向用户说明并明确确认后传 confirm=true');
      return success('已恢复当前用户的等待登录任务。', await mutate(taskId, 'resume'));
    }),
    rename_task: wrap(async ({ taskId, name, version }) => {
      const data = await wholeTask(taskId);
      return success('任务名称已更新。', await api(`/api/tasks/${taskId}/name`, 'PATCH', { name, version: version ?? data.version }));
    }),
    delete_task: wrap(async ({ taskId, version }) => {
      const data = await wholeTask(taskId);
      if (data.status === 'running') throw new Error('请先调用 stop_task，待任务已中断后再明确删除');
      return success('任务已删除。', await mutate(taskId, '', version));
    }),
    exclude_task_file: wrap(async ({ taskId, fileId, version }) => {
      const data = await wholeTask(taskId);
      return success('已请求从后续执行清单移除该文件。', await api(`/api/tasks/${taskId}/files/${fileId}`, 'DELETE', { version: version ?? data.version }));
    }),
  };
  return handlers;
}
module.exports = { TOOL_NAMES, createTools, publicUrl, tail };
