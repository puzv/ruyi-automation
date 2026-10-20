<script setup>
import {
  ArrowUpFromLine,
  BarChart3,
  CheckCircle2,
  ChevronRight,
  CircleHelp,
  ChevronDown,
  ChevronUp,
  Download,
  FolderOpen,
  Layers3,
  ListChecks,
  Monitor,
  MonitorOff,
  RefreshCw,
  CircleUserRound,
  UsersRound,
} from 'lucide-vue-next'
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { apiFetch } from '../api.js'
import { formatTime, isActiveJob, jobNotice, taskLabels, jobStatusLabels } from '../labels.js'

const props = defineProps({ currentUser: { type: Object, required: true }, page: { type: String, default: '/' } })
defineEmits(['logout'])

const folderInput = ref(null)
const notice = ref('等待操作')
const jobId = ref('')
const jobs = ref([])
const submitting = ref({})
const cancelling = ref({})
const submissionError = ref('')
const currentJob = computed(() => jobs.value.find((job) => job.id === jobId.value))
const running = computed(() => isActiveJob(currentJob.value) ? currentJob.value.task : '')
const jobTimers = new Map()
const jobVersions = new Map()
let disposed = false
const workspaceStatus = ref('等待操作')
const statusCounts = ref({ rawCount: 0, createCount: 0, analyseCount: 0, doneCount: 0, idfaPending: 0, oaidPending: 0, pnPending: 0, insightPending: 0, resultPending: 0, createNames: [] })
const jobLog = computed(() => currentJob.value?.output || '')
const createExpanded = ref(true)
const insightExpanded = ref(true)
const downloadExpanded = ref(true)
const headlessMode = ref(true)
const modeUpdating = ref(false)
const platformState = ref({ status: 'none', expiresHintAt: null })
const platformStateError = ref('')
const platformLoginRequired = ref(false)

const actions = [
  { label: '选择文件夹', hint: '准备原始数据文件', icon: FolderOpen, tone: 'mint' },
  { label: taskLabels.upload, hint: '提交 IDFA / OAID / PN 数据', icon: ArrowUpFromLine, tone: 'coral' },
  { label: taskLabels.create, hint: '生成可用人群包', icon: UsersRound, tone: 'blue' },
  { label: taskLabels.analyse, hint: '创建洞察分析任务', icon: BarChart3, tone: 'gold' },
  { label: taskLabels.download, hint: '保存分析结果文件', icon: Download, tone: 'violet' },
  { label: '检测当前状态', hint: '查看平台处理进度', icon: RefreshCw, tone: 'teal' },
]

const queues = [
  { label: '待上传文件', key: 'rawCount', unit: '个', icon: ArrowUpFromLine },
  { label: '待创建人群', key: 'createCount', unit: '个', icon: UsersRound },
  { label: '待洞悉人群', key: 'analyseCount', unit: '个', icon: BarChart3 },
  { label: '待下载结果', key: 'doneCount', unit: '个', icon: Download },
]

const taskByLabel = Object.fromEntries(Object.entries(taskLabels).map(([task, label]) => [label, task]))
const statusPageByTask = {
  doneCount: 'https://ruyi.qq.com/audience-profile/result/',
  analyseCount: 'https://ruyi.qq.com/audience',
}
const createPageByType = {
  idfa: 'https://ruyi.qq.com/audience/dnUpload?idType=MD5_IFA',
  oaid: 'https://ruyi.qq.com/audience/dnUpload?idType=MD5_OAID',
  pn: 'https://ruyi.qq.com/audience/dnUpload?idType=MD5_MOBILE_PHONE',
}
async function refreshStatus() {
  const response = await apiFetch('/api/status')
  const data = await response.json()
  if (data.ok) { workspaceStatus.value = data.workspaceStatus; statusCounts.value = { ...statusCounts.value, ...data } }
}
async function refreshRuntimeMode() {
  const response = await apiFetch('/api/runtime-mode')
  const data = await response.json()
  if (data.ok) headlessMode.value = data.headless
}
async function toggleRuntimeMode() {
  if (modeUpdating.value) return
  modeUpdating.value = true
  try {
    const response = await apiFetch('/api/runtime-mode', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ headless: !headlessMode.value }),
    })
    const data = await response.json()
    if (data.ok) {
      headlessMode.value = data.headless
      notice.value = data.headless ? '已切换为后台模式' : '已切换为调试模式'
    } else {
      notice.value = `模式切换失败：${data.message || '未知错误'}`
    }
  } catch (error) {
    notice.value = `模式切换失败：${error.message || '无法连接本地服务'}`
  } finally {
    modeUpdating.value = false
  }
}
async function refreshPlatformState() {
  try {
    const response = await apiFetch('/api/platform-state')
    const data = await response.json()
    if (!response.ok || !data.ok) throw new Error(data.message || '无法获取平台登录状态')
    platformState.value = data
    platformStateError.value = ''
  } catch (error) {
    platformStateError.value = error.message || '无法获取平台登录状态'
  }
}
defineExpose({ refreshPlatformState })
watch(() => props.page, (page) => { if (page === '/') refreshPlatformState() })
onMounted(() => { refreshStatus(); refreshRuntimeMode(); refreshPlatformState(); restoreActiveJob() })
onBeforeUnmount(() => {
  disposed = true
  for (const timer of jobTimers.values()) window.clearTimeout(timer)
  jobTimers.clear()
})
function chooseFolder() { folderInput.value?.click() }
async function detectCurrentStatus(report = (message) => { notice.value = message }) {
  await refreshStatus()
  if ((statusCounts.value.createNames || []).length || statusCounts.value.analyseCount > 0 || statusCounts.value.doneCount > 0) {
    report('正在读取平台文件列表...')
    const platformResponse = await apiFetch('/api/platform-status')
    const platformData = await platformResponse.json()
    if (!platformData.ok) { report(`平台状态读取失败：${platformData.message}`); return }
    statusCounts.value = { ...statusCounts.value, ...platformData }
    if ((platformData.errors || []).length) {
      report(`部分状态读取失败：${platformData.errors.join('；')}`)
      return
    }
  }
  const createNames = statusCounts.value.createNames || []
  const createType = ['pn', 'idfa', 'oaid'].find((type) => createNames.some((name) => name.toLowerCase().includes(type))) || null
  const targetKey = createType ? 'createCount' : statusCounts.value.doneCount > 0 ? 'doneCount' : statusCounts.value.analyseCount > 0 ? 'analyseCount' : null
  if (!targetKey) {
    report('当前没有待处理任务')
    return
  }
  report(`已定位：${workspaceStatus.value}`)
}
async function importFolder(event) {
  const files = [...event.target.files]
  if (!files.length) return
  const eligibleFiles = files.filter((file) => /(?:idfa|oaid|pn)/i.test(file.name) && /\.(?:txt|csv)$/i.test(file.name))
  if (!eligibleFiles.length) {
    notice.value = '未找到符合条件的文件（文件名需含 idfa、oaid 或 pn，格式为 .txt 或 .csv）'
    event.target.value = ''
    return
  }
  const form = new FormData()
  eligibleFiles.forEach((file) => form.append('files', file, file.webkitRelativePath || file.name))
  notice.value = `正在导入 ${eligibleFiles.length} 个符合条件的文件...`
  const response = await apiFetch('/api/import-folder', { method: 'POST', body: form })
  const data = await response.json()
  notice.value = data.ok
    ? `已导入 ${data.count} 个文件到 raw/${data.skipped ? `，跳过 ${data.skipped} 个不符合条件的文件` : ''}`
    : `导入失败：${data.message}`
  await refreshStatus()
  event.target.value = ''
}
function updateJob(job) {
  const index = jobs.value.findIndex((item) => item.id === job.id)
  if (index < 0) jobs.value.push(job)
  else jobs.value[index] = { ...jobs.value[index], ...job }
  if (jobId.value === job.id && !submissionError.value) notice.value = jobNotice(job)
}
function selectJob() {
  if (currentJob.value) notice.value = jobNotice(currentJob.value)
}
async function runTask(label) {
  const task = taskByLabel[label]
  if (!task || submitting.value[task]) return
  submitting.value[task] = true
  submissionError.value = ''
  platformLoginRequired.value = false
  notice.value = `正在启动${label}...`
  try {
    const response = await apiFetch(`/api/run/${task}`, { method: 'POST' })
    const data = await response.json()
    if (!response.ok || !data.ok) {
      platformLoginRequired.value = data.code === 'PLATFORM_LOGIN_REQUIRED'
      notice.value = platformLoginRequired.value ? '请先完成平台登录' : data.message || '任务提交失败'
      submissionError.value = notice.value
      return
    }
    if (disposed) return
    jobId.value = data.id
    updateJob({ ...data, task, output: '' })
    pollJob(data.id)
  } catch (error) {
    notice.value = `任务提交失败：${error.message || '无法连接服务'}`
    submissionError.value = notice.value
  } finally {
    submitting.value[task] = false
  }
}
async function restoreActiveJob() {
  try {
    const response = await apiFetch('/api/jobs/active')
    const data = await response.json()
    if (!response.ok || !data.ok) throw new Error(data.message || '无法恢复任务')
    if (disposed || !data.job || jobId.value) return
    jobId.value = data.job.id
    updateJob(data.job)
    await pollJob(data.job.id)
  } catch (error) {
    if (!disposed && !jobId.value) notice.value = `恢复任务失败：${error.message || '无法连接服务'}`
  }
}
function schedulePoll(id) {
  if (!disposed) jobTimers.set(id, window.setTimeout(() => pollJob(id), 1000))
}
async function pollJob(id) {
  window.clearTimeout(jobTimers.get(id))
  jobTimers.delete(id)
  const version = (jobVersions.get(id) || 0) + 1
  jobVersions.set(id, version)
  try {
    const response = await apiFetch(`/api/jobs/${id}`)
    const data = await response.json()
    if (disposed || jobVersions.get(id) !== version) return
    if (!response.ok || !data.ok) throw new Error(data.message || '无法获取任务状态')
    const job = data.job
    const previous = jobs.value.find((item) => item.id === id)
    updateJob(job)
    if (isActiveJob(job)) { schedulePoll(id); return }
    if (!isActiveJob(previous)) return
    await Promise.all([refreshStatus(), refreshPlatformState()])
    if (disposed || job.status !== 'succeeded' || !['upload', 'create', 'analyse'].includes(job.task)) return
    const report = (message) => { if (!disposed && !submissionError.value && jobId.value === id) notice.value = message }
    report(`${taskLabels[job.task]}已完成，正在检测当前状态...`)
    await detectCurrentStatus(report)
  } catch (error) {
    if (disposed || jobVersions.get(id) !== version) return
    if (jobId.value === id) notice.value = `获取任务状态失败：${error.message || '无法连接服务'}`
    if (isActiveJob(jobs.value.find((item) => item.id === id))) schedulePoll(id)
  }
}
async function cancelJob() {
  const job = currentJob.value
  if (!isActiveJob(job) || cancelling.value[job.id] || job.cancelRequested) return
  if (!window.confirm(`确定取消${taskLabels[job.task] || '任务'}吗？`)) return
  const id = job.id
  cancelling.value[id] = true
  try {
    const response = await apiFetch(`/api/jobs/${id}/cancel`, { method: 'POST' })
    const data = await response.json()
    if (!response.ok || !data.ok) throw new Error(data.message || '取消任务失败')
    if (disposed) return
    // 使取消前的详情响应失效，避免它把状态改回运行中。
    jobVersions.set(id, (jobVersions.get(id) || 0) + 1)
    if (data.result === 'cancelling') updateJob({ ...job, status: 'running', cancelRequested: true })
    if (data.result === 'cancelled') updateJob({ ...job, status: 'cancelled' })
    await pollJob(id)
  } catch (error) {
    if (!disposed && jobId.value === id) notice.value = `取消任务失败：${error.message || '无法连接服务'}`
  } finally {
    cancelling.value[id] = false
  }
}
</script>

<template>
  <div class="app-shell">
    <aside class="sidebar">
      <div class="brand">
        <div class="brand-mark"><Layers3 :size="19" /></div>
        <div>
          <div class="brand-name">如翼自动化</div>
          <div class="brand-caption">RUYI WORKBENCH</div>
        </div>
      </div>

      <a class="login-status" :class="{ logged: !platformStateError && platformState.status === 'valid' }" :title="platformStateError || (platformState.status === 'valid' ? `预计过期时间：${formatTime(platformState.expiresHintAt)}` : '点击进入平台登录')" href="#/platform-login">
        <CircleUserRound :size="26" /><span>{{ platformStateError ? '登录状态不可用' : platformState.status === 'valid' ? '平台已登录' : platformState.status === 'expired' ? '平台登录已过期' : '需要平台登录' }}</span>
      </a>
      <div class="side-section-label">工作流</div>
      <nav class="side-nav" aria-label="工作流导航">
        <a class="side-link" :class="{ active: page === '/' }" href="#/"><ListChecks :size="17" /> 操作面板</a>
        <a class="side-link" :class="{ active: page === '/platform-login' }" href="#/platform-login"><CircleUserRound :size="17" /> 平台登录</a>
        <a class="side-link" :class="{ active: page === '/jobs' }" href="#/jobs"><ListChecks :size="17" /> 我的任务</a>
        <a class="side-link" :class="{ active: page === '/logs' }" href="#/logs"><ListChecks :size="17" /> 我的操作记录</a>
        <template v-if="currentUser.role === 'admin'">
          <a class="side-link" :class="{ active: page === '/admin/users' }" href="#/admin/users"><UsersRound :size="17" /> 用户管理</a>
          <a class="side-link" :class="{ active: page === '/admin/jobs' }" href="#/admin/jobs"><ListChecks :size="17" /> 全部任务</a>
          <a class="side-link" :class="{ active: page === '/admin/logs' }" href="#/admin/logs"><ListChecks :size="17" /> 全部操作记录</a>
        </template>
      </nav>

      <div class="sidebar-footer">
      <div class="sidebar-user"><strong>{{ currentUser.displayName }}</strong><span>{{ currentUser.username }}</span></div>
        <div class="sidebar-account-actions"><a href="#/password">修改密码</a><button type="button" @click="$emit('logout')">退出登录</button></div>
      </div>
    </aside>

    <slot>
    <main class="main-content">
      <header class="topbar">
        <div>
          <p class="eyebrow">DATA OPERATIONS / 01</p>
          <h1>操作面板</h1>
        </div>
        <div class="topbar-actions">
          <button class="mode-switch" :class="{ active: headlessMode }" type="button" :disabled="modeUpdating" :aria-checked="headlessMode" role="switch" :aria-label="headlessMode ? '后台模式，点击切换为调试模式' : '调试模式，点击切换为后台模式'" :title="headlessMode ? '点击切换为调试模式' : '点击切换为后台模式'" @click="toggleRuntimeMode">
            <span class="mode-option" :class="{ selected: !headlessMode }"><Monitor :size="16" /><span>调试模式</span></span>
            <span class="mode-option" :class="{ selected: headlessMode }"><MonitorOff :size="16" /><span>后台模式</span></span>
          </button>
          <a class="help-button" href="https://cf.ge.cn/pages/viewpage.action?pageId=289808671" target="_blank" rel="noopener noreferrer" aria-label="帮助"><CircleHelp :size="18" /><span>使用帮助</span></a>
        </div>
      </header>
      <input ref="folderInput" class="visually-hidden" type="file" webkitdirectory directory multiple @change="importFolder" />

      <section class="welcome-band">
        <div>
          <p class="section-kicker">今日工作区</p>
          <h2>开始处理你的数据任务</h2>
          <p class="welcome-copy">从文件整理到结果下载，按顺序完成如翼平台工作流。</p>
        </div>
        <div class="date-chip"><span class="date-label">工作区状态</span><strong>{{ workspaceStatus }}</strong></div>
      </section>

      <section id="operations" class="operations-section">
        <div class="section-heading"><div><p class="section-kicker">QUICK ACTIONS</p><h3>快捷操作</h3></div><span class="section-note">共 6 项操作</span></div>
        <div class="action-grid">
          <button v-for="(action, index) in actions" :key="action.label" class="action-card" :class="[`tone-${action.tone}`, { running: running === taskByLabel[action.label] }]" type="button" :disabled="!!submitting[taskByLabel[action.label]]" @click="action.label === '选择文件夹' ? chooseFolder() : action.label === '检测当前状态' ? detectCurrentStatus() : runTask(action.label)">
            <span class="action-index">0{{ index + 1 }}</span>
            <span class="action-icon"><component :is="action.icon" :size="22" stroke-width="1.8" /></span>
            <span class="action-copy"><strong>{{ action.label }}</strong><small>{{ action.hint }}</small></span>
            <ChevronRight class="action-arrow" :size="18" />
          </button>
        </div>
      </section>

      <section id="status" class="status-section">
        <div class="section-heading"><div><p class="section-kicker">WORKSPACE SNAPSHOT</p><h3>当前状态</h3></div></div>
        <div class="status-layout">
          <div class="queue-panel">
            <template v-for="queue in queues" :key="queue.label">
            <button class="queue-row queue-toggle" :class="{ expanded: (queue.key === 'createCount' && createExpanded) || (queue.key === 'analyseCount' && insightExpanded) || (queue.key === 'doneCount' && downloadExpanded) }" type="button" @click="queue.key === 'createCount' ? (createExpanded = !createExpanded) : queue.key === 'analyseCount' ? (insightExpanded = !insightExpanded) : queue.key === 'doneCount' && (downloadExpanded = !downloadExpanded)">
              <span class="queue-icon"><component :is="queue.icon" :size="17" /></span><span class="queue-label">{{ queue.label }}</span><strong>{{ statusCounts[queue.key] }}</strong><small>{{ queue.unit }}</small>
              <component v-if="queue.key === 'createCount' || queue.key === 'analyseCount' || queue.key === 'doneCount'" :is="(queue.key === 'createCount' ? createExpanded : queue.key === 'analyseCount' ? insightExpanded : downloadExpanded) ? ChevronUp : ChevronDown" class="queue-chevron" :size="15" />
            </button>
            <div v-if="queue.key === 'createCount' && createExpanded" class="queue-details">
              <div class="queue-detail"><span>IDFA 平台处理中</span><strong>{{ statusCounts.idfaPending }}</strong><small>个</small></div>
              <div class="queue-detail"><span>OAID 平台处理中</span><strong>{{ statusCounts.oaidPending }}</strong><small>个</small></div>
              <div class="queue-detail"><span>PN 平台处理中</span><strong>{{ statusCounts.pnPending }}</strong><small>个</small></div>
            </div>
            <div v-if="queue.key === 'analyseCount' && insightExpanded" class="queue-details">
              <div class="queue-detail"><span>人群包平台处理中</span><strong>{{ statusCounts.insightPending }}</strong><small>个</small></div>
            </div>
            <div v-if="queue.key === 'doneCount' && downloadExpanded" class="queue-details">
              <div class="queue-detail"><span>洞悉结果未就绪</span><strong>{{ statusCounts.resultPending }}</strong><small>个</small></div>
            </div>
            </template>
          </div>
          <div class="ready-panel"><div class="ready-icon"><CheckCircle2 :size="22" /></div><div><strong>{{ notice }}</strong><a v-if="platformLoginRequired" class="platform-login-link" href="#/platform-login">前往平台登录</a><p>选择一个操作以开始本次任务</p></div></div>
        </div>
        <div v-if="currentJob" class="job-toolbar">
          <label v-if="jobs.length > 1">查看任务 <select v-model="jobId" @change="selectJob"><option v-for="job in jobs" :key="job.id" :value="job.id">{{ taskLabels[job.task] }} · {{ jobStatusLabels[job.status] }} · {{ job.id.slice(0, 8) }}</option></select></label>
          <span role="status">{{ jobNotice(currentJob) }}</span>
          <button v-if="isActiveJob(currentJob)" class="secondary-button" type="button" :disabled="cancelling[jobId] || currentJob.cancelRequested" @click="cancelJob">取消任务</button>
        </div>
        <pre v-if="currentJob" class="job-log">{{ jobLog || '暂无日志' }}</pre>
        <a v-if="currentJob && !isActiveJob(currentJob)" class="job-log-link" :href="`/api/jobs/${encodeURIComponent(jobId)}/log`" target="_blank" rel="noopener noreferrer">查看完整日志</a>
      </section>
      <footer class="footer-note">本地自动化工作台 <span>·</span> 所有操作将在浏览器中执行</footer>
    </main>
    </slot>
  </div>
</template>
