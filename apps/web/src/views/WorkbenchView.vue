<script setup>
import {
  ArrowUpFromLine,
  BarChart3,
  ChevronRight,
  CircleHelp,
  Download,
  FolderOpen,
  Layers3,
  ListChecks,
  RefreshCw,
  CircleUserRound,
  UsersRound,
} from 'lucide-vue-next'
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { apiFetch } from '../api.js'
import { observeResultJob, downloadJobResults } from '../result-download.js'
import { formatTime, isActiveJob, jobNotice, taskLabels, jobStatusLabels } from '../labels.js'

const props = defineProps({ currentUser: { type: Object, required: true }, page: { type: String, default: '/' } })
defineEmits(['logout'])

const fileInput = ref(null)
const folderInput = ref(null)
const uploadPickerOpen = ref(false)
const importing = ref(false)
const notice = ref('等待操作')
const jobId = ref('')
const jobs = ref([])
const submitting = ref({})
const cancelling = ref({})
const submissionError = ref('')
const downloadNotice = ref('')
const downloadingResult = ref(false)
const currentJob = computed(() => jobs.value.find((job) => job.id === jobId.value))
const running = computed(() => isActiveJob(currentJob.value) ? currentJob.value.task : '')
const jobTimers = new Map()
const jobVersions = new Map()
let disposed = false
const workspaceStatus = ref('等待操作')
const statusCounts = ref({ rawCount: 0, createCount: 0, analyseCount: 0, doneCount: 0, idfaPending: 0, oaidPending: 0, pnPending: 0, insightPending: 0, resultPending: 0, createNames: [] })
const jobLog = computed(() => currentJob.value?.output || '')
const platformState = ref({ status: 'none', expiresHintAt: null })
const platformStateError = ref('')
const platformLoginRequired = ref(false)
const autoAdvance = ref({ enabled: true, phase: 'idle', message: '', pending: {}, checkedAt: null, nextCheckAt: null, error: null, intervalMs: null })
const autoAdvanceUpdating = ref(false)
const autoProgress = computed(() => {
  const { phase, pending = {} } = autoAdvance.value
  const phases = {
    idle: [0, 'idle'], waitingFiles: [1, 'waiting'], readyCreate: [1, 'submitting'],
    waitingAudience: [2, 'waiting'], readyAnalyse: [2, 'submitting'],
    waitingResults: [3, 'waiting'], resultsReady: [3, 'done'],
  }
  const counts = statusCounts.value
  const inferredStep = counts.createCount > 0 ? 1 : counts.analyseCount > 0 ? 2 : counts.doneCount > 0 ? 3 : 0
  const [step, mode] = phases[phase] || (phase === 'paused'
    ? [inferredStep, 'paused'] : ['stalled', 'error', 'loginRequired'].includes(phase)
      ? [inferredStep, 'blocked'] : [0, 'idle'])
  const [key, unit] = { 1: ['files', '个文件'], 2: ['audiences', '个人群包'], 3: ['results', '个洞悉结果'] }[step] || []
  const count = pending?.[key]
  const pendingText = mode === 'waiting' && typeof count === 'number' && Number.isFinite(count) && count > 0
    ? `剩余 ${count} ${unit}` : ''
  const completedSteps = mode === 'done' || mode === 'submitting' ? step : Math.max(0, step - 1)
  return { step, mode, pendingText, completedSteps }
})
const autoProgressLabels = ['上传文件', '人群包', '人群洞悉', '结果就绪']
// 间隔由服务端下发，前端不硬编码，避免改默认值后两处不一致。
const autoIntervalLabel = computed(() => {
  const ms = Number(autoAdvance.value.intervalMs)
  if (!Number.isFinite(ms) || ms <= 0) return ''
  const minutes = ms / 60000
  return Number.isInteger(minutes) ? `${minutes} 分钟` : `${Math.round(ms / 1000)} 秒`
})
let autoTimer = null

const actions = [
  { label: taskLabels.upload, hint: '选择文件或文件夹，导入后自动上传', icon: ArrowUpFromLine, tone: 'coral' },
  { label: taskLabels.create, hint: '生成可用人群包', icon: UsersRound, tone: 'blue' },
  { label: taskLabels.analyse, hint: '创建洞察分析任务', icon: BarChart3, tone: 'gold' },
  { label: taskLabels.download, hint: '保存分析结果文件', icon: Download, tone: 'violet' },
  { label: '检测当前状态', hint: '查看平台处理进度', icon: RefreshCw, tone: 'teal' },
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
async function refreshAutoAdvance() {
  try {
    const response = await apiFetch('/api/auto-advance')
    const data = await response.json()
    if (!response.ok || !data.ok) return null
    autoAdvance.value = data
    return data
  } catch (_) {
    // 状态轮询失败不打断用户的其它操作，下次继续。
    return null
  }
}
// 请求服务端立刻检查该用户，避免等下一轮 5 分钟。引擎内部有占位互斥，
// 重复调用不会启动第二个浏览器。
async function engineCheck() {
  try {
    const response = await apiFetch('/api/auto-advance/check', { method: 'POST' })
    const data = await response.json()
    if (response.ok && data.ok) autoAdvance.value = data
  } catch (_) {
    // 唤醒失败不影响后续定时检查。
  }
}
async function toggleAutoAdvance() {
  if (autoAdvanceUpdating.value) return
  autoAdvanceUpdating.value = true
  try {
    const response = await apiFetch('/api/auto-advance', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: !autoAdvance.value.enabled }),
    })
    const data = await response.json()
    if (!response.ok || !data.ok) throw new Error(data.message || '切换自动推进失败')
    autoAdvance.value = data
    notice.value = data.enabled ? '已开启自动推进' : '已关闭自动推进'
  } catch (error) {
    notice.value = `切换自动推进失败：${error.message || '无法连接服务'}`
  } finally {
    autoAdvanceUpdating.value = false
  }
}
// 页面打开时刷新自动推进状态；关闭页面后引擎仍在服务端继续运行。
function scheduleAutoRefresh() {
  window.clearTimeout(autoTimer)
  if (disposed) return
  autoTimer = window.setTimeout(async () => {
    if (disposed) return
    await refreshAutoAdvance()
    scheduleAutoRefresh()
  }, 15000)
}
defineExpose({ refreshPlatformState, refreshAutoAdvance })
watch(() => props.page, (page) => { if (page === '/') refreshPlatformState() })
onMounted(() => {
  refreshStatus(); refreshPlatformState(); refreshAutoAdvance()
  restoreActiveJob(); scheduleAutoRefresh()
})
onBeforeUnmount(() => {
  disposed = true
  window.clearTimeout(autoTimer)
  for (const timer of jobTimers.values()) window.clearTimeout(timer)
  jobTimers.clear()
})
function toggleUploadPicker() {
  if (importing.value) return
  uploadPickerOpen.value = !uploadPickerOpen.value
}
function closeUploadPicker() { uploadPickerOpen.value = false }
// 文件夹选项依赖 webkitdirectory；不支持的浏览器（如部分 Safari 版本）
// 仍可通过“选择文件”多选，两者最终走同一个导入流程。
function chooseFiles() { fileInput.value?.click() }
function chooseFolder() { folderInput.value?.click() }
async function detectCurrentStatus(report = (message) => { notice.value = message }) {
  await refreshStatus()
  if ((statusCounts.value.createNames || []).length || statusCounts.value.analyseCount > 0 || statusCounts.value.doneCount > 0) {
    report('正在读取平台文件列表...')
    // 手动检查可能与自动推进撞上同一个用户占位，接口会返回 409。
    // 短暂重试即可，不要让用户等太久。
    let platformResponse = await apiFetch('/api/platform-status')
    for (let attempt = 1; platformResponse.status === 409 && attempt <= 3; attempt += 1) {
      report(`自动推进正在检查平台，稍候重试…（${attempt}/3）`)
      await new Promise((resolve) => { window.setTimeout(resolve, 3000) })
      platformResponse = await apiFetch('/api/platform-status')
    }
    const platformData = await platformResponse.json()
    if (!platformData.ok) {
      report(platformResponse.status === 409
        ? '自动推进仍在检查平台，请稍后再试'
        : `平台状态读取失败：${platformData.message}`)
      return
    }
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
// 返回实际新增的文件数；只有大于 0 时调用方才会提交上传任务。
async function importUploadFiles(files) {
  const eligibleFiles = files.filter((file) => /(?:idfa|oaid|pn)/i.test(file.name) && /\.(?:txt|csv)$/i.test(file.name))
  if (!eligibleFiles.length) {
    notice.value = '未找到符合条件的文件（文件名需含 idfa、oaid 或 pn，格式为 .txt 或 .csv），未提交上传任务'
    return 0
  }
  const form = new FormData()
  eligibleFiles.forEach((file) => form.append('files', file, file.webkitRelativePath || file.name))
  notice.value = `正在导入 ${eligibleFiles.length} 个符合条件的文件...`
  let count = 0
  importing.value = true
  try {
    const response = await apiFetch('/api/import-folder', { method: 'POST', body: form })
    const data = await response.json()
    if (data.ok) {
      count = data.count
      notice.value = count
        ? `已导入 ${data.count} 个文件到 raw/${data.skipped ? `，跳过 ${data.skipped} 个不符合条件的文件` : ''}`
        : '没有新增文件，未提交上传任务'
    } else {
      notice.value = `导入失败：${data.message}`
    }
  } catch (error) {
    notice.value = `导入失败：${error.message || '无法连接服务'}`
  } finally {
    importing.value = false
  }
  // 状态刷新失败不影响导入结果，下次检测时再读取。
  refreshStatus().catch(() => {})
  return count
}
async function handleUploadSelection(event) {
  const input = event.target
  const files = [...(input.files || [])]
  // 清空 value，否则再次选择同一文件夹时不会触发 change。
  input.value = ''
  closeUploadPicker()
  if (!files.length) {
    notice.value = '未选择文件，未提交上传任务'
    return
  }
  const imported = await importUploadFiles(files)
  if (imported > 0) await runTask(taskLabels.upload)
}
function updateJob(job) {
  const index = jobs.value.findIndex((item) => item.id === job.id)
  if (index < 0) jobs.value.push(job)
  else jobs.value[index] = { ...jobs.value[index], ...job }
  if (jobId.value === job.id && !submissionError.value) notice.value = jobNotice(job)
  observeResultJob(job).then((message) => {
    if (!disposed && message) downloadNotice.value = message
  }).catch((error) => {
    if (!disposed) downloadNotice.value = `ZIP 下载未发起：${error.message}。可在“我的任务”中重新下载。`
  })
}
async function redownloadResult() {
  if (downloadingResult.value || !currentJob.value) return
  downloadingResult.value = true
  try { downloadNotice.value = await downloadJobResults(currentJob.value) }
  catch (error) { downloadNotice.value = error.message || '无法下载结果，请重试' }
  finally { downloadingResult.value = false }
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
    if (disposed) return
    // 任务结束后自动推进可能已经提交了下一个任务，立即同步状态。
    const advance = await refreshAutoAdvance()
    if (disposed || job.status !== 'succeeded' || !['upload', 'create', 'analyse'].includes(job.task)) return
    const report = (message) => { if (!disposed && !submissionError.value && jobId.value === id) notice.value = message }
    // 自动推进开启时由服务端接管探测：前端再探测会与它在同一个占位集合上
    // 抢浏览器，接口返回 409 被误显示成“平台状态读取失败”。
    if (advance?.enabled) {
      report(`${taskLabels[job.task]}已完成，自动推进正在接管后续步骤`)
      await engineCheck()
      // 引擎检查可能已经推进了本地清单（例如提交下一步任务），立即同步面板，
      // 避免自动推进成功后仍显示任务完成前的待办数量。
      await refreshStatus()
      return
    }
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
        <a class="side-link" :class="{ active: page === '/api-tokens' }" href="#/api-tokens"><ListChecks :size="17" /> API 令牌</a>
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
          <a class="help-button" href="https://cf.ge.cn/pages/viewpage.action?pageId=289808671" target="_blank" rel="noopener noreferrer" aria-label="帮助"><CircleHelp :size="18" /><span>使用帮助</span></a>
        </div>
      </header>
      <input ref="fileInput" class="visually-hidden" type="file" multiple @change="handleUploadSelection" />
      <input ref="folderInput" class="visually-hidden" type="file" webkitdirectory directory multiple @change="handleUploadSelection" />

      <section class="welcome-band">
        <div>
          <p class="section-kicker">今日工作区</p>
          <h2>开始处理你的数据任务</h2>
          <p class="welcome-copy">从文件整理到结果下载，按顺序完成如翼平台工作流。</p>
        </div>
        <div class="date-chip"><span class="date-label">工作区状态</span><strong>{{ workspaceStatus }}</strong></div>
      </section>

      <section id="operations" class="operations-section">
        <div class="section-heading"><div><p class="section-kicker">QUICK ACTIONS</p><h3>快捷操作</h3></div><span class="section-note">共 5 项操作</span></div>
        <div class="action-grid">
          <button v-for="(action, index) in actions" :key="action.label" class="action-card" :class="[`tone-${action.tone}`, { running: running === taskByLabel[action.label] }]" type="button" :disabled="!!submitting[taskByLabel[action.label]] || importing" :aria-expanded="action.label === taskLabels.upload ? uploadPickerOpen : undefined" @click="action.label === taskLabels.upload ? toggleUploadPicker() : action.label === '检测当前状态' ? detectCurrentStatus() : runTask(action.label)">
            <span class="action-index">0{{ index + 1 }}</span>
            <span class="action-icon"><component :is="action.icon" :size="22" stroke-width="1.8" /></span>
            <span class="action-copy"><strong>{{ action.label }}</strong><small>{{ action.hint }}</small></span>
            <ChevronRight class="action-arrow" :size="18" />
          </button>
        </div>
        <div v-if="uploadPickerOpen" class="upload-picker" role="group" aria-label="选择上传文件来源">
          <p class="upload-picker-rule">文件名需包含 idfa、oaid 或 pn，格式为 .txt 或 .csv。导入成功后自动提交上传任务。</p>
          <div class="upload-picker-actions">
            <button class="secondary-button" type="button" @click="chooseFiles"><ArrowUpFromLine :size="14" />选择文件（可多选）</button>
            <button class="secondary-button" type="button" @click="chooseFolder"><FolderOpen :size="14" />选择文件夹</button>
            <button class="upload-picker-cancel" type="button" @click="closeUploadPicker">取消</button>
          </div>
        </div>
      </section>

      <div class="auto-panel" :class="`auto-${autoAdvance.phase}`">
        <div class="auto-head">
          <div class="auto-copy">
            <strong>自动推进</strong>
            <p role="status">{{ autoAdvance.message || '当前没有需要自动推进的任务' }}</p>
          </div>
          <button class="auto-switch" :class="{ active: autoAdvance.enabled }" type="button" role="switch"
            :aria-checked="autoAdvance.enabled" :disabled="autoAdvanceUpdating"
            :title="autoAdvance.enabled ? '点击关闭自动推进' : '点击开启自动推进'"
            @click="toggleAutoAdvance">
            <span class="auto-switch-track"><span class="auto-switch-thumb"></span></span>
            <span>{{ autoAdvance.enabled ? '已开启' : '已关闭' }}</span>
          </button>
        </div>
        <div class="auto-progress" :class="`auto-progress-${autoProgress.mode}`" role="progressbar"
          aria-valuemin="0" aria-valuemax="3" :aria-valuenow="autoProgress.completedSteps" :aria-valuetext="autoAdvance.message">
          <div class="auto-progress-tracks" aria-hidden="true">
            <div v-for="segment in 3" :key="segment" class="auto-progress-track"
              :class="{ current: segment === autoProgress.step, completed: segment <= autoProgress.completedSteps }">
              <span class="auto-progress-fill" :style="{ width: segment <= autoProgress.completedSteps || segment === autoProgress.step ? '100%' : '0%' }"></span>
              <small v-if="segment === autoProgress.step && autoProgress.pendingText" class="auto-progress-pending">{{ autoProgress.pendingText }}</small>
            </div>
          </div>
          <div class="auto-progress-nodes" aria-hidden="true">
            <div v-for="(label, index) in autoProgressLabels" :key="label" class="auto-progress-node"
              :class="{ current: autoProgress.step > 0 && index === autoProgress.step, completed: autoProgress.step > 0 && index <= autoProgress.completedSteps }">
              <span class="auto-progress-dot">{{ autoProgress.mode === 'blocked' && index === autoProgress.step ? '!' : '' }}</span>
              <span class="auto-progress-label">{{ label }}</span>
            </div>
          </div>
        </div>
        <div class="auto-meta">
          <span v-if="autoAdvance.phase === 'resultsReady'">洞悉结果已就绪，请在下方手动下载，自动推进已停止</span>
          <span v-else-if="autoAdvance.error">{{ autoAdvance.error }}</span>
          <span v-else>平台处理完成后会自动创建人群包、提交人群洞悉；结果就绪后停止<span v-if="autoIntervalLabel">（每 {{ autoIntervalLabel }}检查一次）</span></span>
        </div>
        <div class="auto-times">
          <span>上次检查：{{ autoAdvance.checkedAt ? formatTime(new Date(autoAdvance.checkedAt).toISOString()) : '尚未检查' }}</span>
          <span v-if="autoAdvance.nextCheckAt">下次检查：{{ formatTime(new Date(autoAdvance.nextCheckAt).toISOString()) }}</span>
          <span v-else-if="autoAdvance.enabled">暂不检查</span>
        </div>
        <a v-if="autoAdvance.phase === 'loginRequired'" class="platform-login-link" href="#/platform-login">前往平台登录</a>
      </div>

      <section v-if="currentJob || notice !== '等待操作' || downloadNotice" class="task-feedback" aria-label="任务反馈">
        <p v-if="notice !== '等待操作'" role="status">{{ notice }}</p>
        <a v-if="platformLoginRequired" class="platform-login-link" href="#/platform-login">前往平台登录</a>
        <div v-if="currentJob" class="job-toolbar">
          <label v-if="jobs.length > 1">查看任务 <select v-model="jobId" @change="selectJob"><option v-for="job in jobs" :key="job.id" :value="job.id">{{ taskLabels[job.task] }} · {{ jobStatusLabels[job.status] }} · {{ job.id.slice(0, 8) }}</option></select></label>
          <span role="status">{{ jobNotice(currentJob) }}</span>
          <button v-if="isActiveJob(currentJob)" class="secondary-button" type="button" :disabled="cancelling[jobId] || currentJob.cancelRequested" @click="cancelJob">取消任务</button>
          <button v-if="currentJob.task === 'download' && ['succeeded', 'failed'].includes(currentJob.status) && currentJob.resultFiles" class="secondary-button" type="button" :disabled="downloadingResult" @click="redownloadResult">重新下载</button>
        </div>
        <p v-if="downloadNotice" role="status">{{ downloadNotice }}</p>
        <pre v-if="currentJob" class="job-log">{{ jobLog || '暂无日志' }}</pre>
        <a v-if="currentJob && !isActiveJob(currentJob)" class="job-log-link" :href="`/api/jobs/${encodeURIComponent(jobId)}/log`" target="_blank" rel="noopener noreferrer">查看完整日志</a>
      </section>
      <footer class="footer-note">本地自动化工作台 <span>·</span> 所有操作将在浏览器中执行</footer>
    </main>
    </slot>
  </div>
</template>
