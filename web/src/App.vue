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
  UsersRound,
} from 'lucide-vue-next'
import { onMounted, ref } from 'vue'

const folderInput = ref(null)
const notice = ref('等待操作')
const running = ref('')
const jobId = ref('')
const workspaceStatus = ref('等待操作')
const statusCounts = ref({ rawCount: 0, createCount: 0, analyseCount: 0, doneCount: 0, idfaPending: 0, oaidPending: 0, insightPending: 0, resultPending: 0, createNames: [] })
const jobLog = ref('')
const createExpanded = ref(false)
const insightExpanded = ref(false)
const downloadExpanded = ref(false)
const headlessMode = ref(false)
const modeUpdating = ref(false)

const actions = [
  { label: '选择文件夹', hint: '准备原始数据文件', icon: FolderOpen, tone: 'mint' },
  { label: '上传文件', hint: '提交 IDFA / OAID 数据', icon: ArrowUpFromLine, tone: 'coral' },
  { label: '创建人群', hint: '生成可用人群包', icon: UsersRound, tone: 'blue' },
  { label: '人群洞悉', hint: '创建洞察分析任务', icon: BarChart3, tone: 'gold' },
  { label: '下载洞悉结果', hint: '保存分析结果文件', icon: Download, tone: 'violet' },
  { label: '检测当前状态', hint: '查看平台处理进度', icon: RefreshCw, tone: 'teal' },
]

const queues = [
  { label: '待上传文件', key: 'rawCount', unit: '个', icon: ArrowUpFromLine },
  { label: '待创建人群', key: 'createCount', unit: '个', icon: UsersRound },
  { label: '待洞悉人群', key: 'analyseCount', unit: '个', icon: BarChart3 },
  { label: '待下载结果', key: 'doneCount', unit: '个', icon: Download },
]

const taskByLabel = { '上传文件': 'upload', '创建人群': 'create', '人群洞悉': 'analyse', '下载洞悉结果': 'download' }
const statusPageByTask = {
  doneCount: 'https://ruyi.qq.com/audience-profile/result/',
  analyseCount: 'https://ruyi.qq.com/audience',
}
const createPageByType = {
  idfa: 'https://ruyi.qq.com/audience/dnUpload?idType=MD5_IFA',
  oaid: 'https://ruyi.qq.com/audience/dnUpload?idType=MD5_OAID',
}
async function refreshStatus() {
  const response = await fetch('/api/status')
  const data = await response.json()
  if (data.ok) { workspaceStatus.value = data.workspaceStatus; statusCounts.value = { ...statusCounts.value, ...data } }
}
async function refreshRuntimeMode() {
  const response = await fetch('/api/runtime-mode')
  const data = await response.json()
  if (data.ok) headlessMode.value = data.headless
}
async function toggleRuntimeMode() {
  if (modeUpdating.value) return
  modeUpdating.value = true
  try {
    const response = await fetch('/api/runtime-mode', {
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
onMounted(() => { refreshStatus(); refreshRuntimeMode() })
function chooseFolder() { folderInput.value?.click() }
async function detectCurrentStatus() {
  await refreshStatus()
  if ((statusCounts.value.createNames || []).length || statusCounts.value.analyseCount > 0 || statusCounts.value.doneCount > 0) {
    notice.value = '正在读取平台文件列表...'
    const platformResponse = await fetch('/api/platform-status')
    const platformData = await platformResponse.json()
    if (!platformData.ok) { notice.value = `平台状态读取失败：${platformData.message}`; return }
    statusCounts.value = { ...statusCounts.value, ...platformData }
    if ((platformData.errors || []).length) {
      notice.value = `部分状态读取失败：${platformData.errors.join('；')}`
      return
    }
  }
  const createNames = statusCounts.value.createNames || []
  const createType = createNames.find((name) => /idfa/i.test(name)) ? 'idfa' : createNames.find((name) => /oaid/i.test(name)) ? 'oaid' : null
  const targetKey = createType ? 'createCount' : statusCounts.value.doneCount > 0 ? 'doneCount' : statusCounts.value.analyseCount > 0 ? 'analyseCount' : null
  if (!targetKey) {
    notice.value = '当前没有待处理任务'
    return
  }
  notice.value = `已定位：${workspaceStatus.value}`
}
async function importFolder(event) {
  const files = [...event.target.files]
  if (!files.length) return
  const form = new FormData()
  files.forEach((file) => form.append('files', file, file.webkitRelativePath || file.name))
  notice.value = `正在导入 ${files.length} 个文件...`
  const response = await fetch('/api/import-folder', { method: 'POST', body: form })
  const data = await response.json()
  notice.value = data.ok ? `已导入 ${data.count} 个文件到 raw/` : `导入失败：${data.message}`
  event.target.value = ''
}
async function runTask(label) {
  const task = taskByLabel[label]
  if (!task || running.value) return
  running.value = task
  notice.value = `正在启动${label}...`
  const response = await fetch(`/api/run/${task}`, { method: 'POST' })
  const data = await response.json()
  if (!data.ok) { notice.value = data.message; running.value = ''; return }
  jobId.value = data.id
  pollJob(label)
}
async function pollJob(label) {
  const response = await fetch(`/api/jobs/${jobId.value}`)
  const job = await response.json()
  jobLog.value = job.output || ''
  if (job.running) { notice.value = `${label}运行中...`; window.setTimeout(() => pollJob(label), 1000); return }
  running.value = ''
  notice.value = job.code === 0 ? `${label}已完成` : `${label}执行失败，请查看终端日志`
  refreshStatus()
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

      <div class="side-section-label">工作流</div>
      <nav class="side-nav" aria-label="工作流导航">
        <a class="side-link active" href="#operations"><ListChecks :size="17" /> 操作面板</a>
        <a class="side-link" href="#status"><BarChart3 :size="17" /> 运行状态</a>
      </nav>

      <div class="sidebar-footer">
        <div class="connection"><span class="status-dot"></span><span>本地工作区已就绪</span></div>
        <div class="version">v1.0 · macOS</div>
      </div>
    </aside>

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
          <button class="help-button" type="button" aria-label="帮助"><CircleHelp :size="18" /><span>使用帮助</span></button>
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
          <button v-for="(action, index) in actions" :key="action.label" class="action-card" :class="[`tone-${action.tone}`, { running: running === taskByLabel[action.label] }]" type="button" @click="action.label === '选择文件夹' ? chooseFolder() : action.label === '检测当前状态' ? detectCurrentStatus() : runTask(action.label)">
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
            </div>
            <div v-if="queue.key === 'analyseCount' && insightExpanded" class="queue-details">
              <div class="queue-detail"><span>人群包平台处理中</span><strong>{{ statusCounts.insightPending }}</strong><small>个</small></div>
            </div>
            <div v-if="queue.key === 'doneCount' && downloadExpanded" class="queue-details">
              <div class="queue-detail"><span>人群包平台洞悉中</span><strong>{{ statusCounts.resultPending }}</strong><small>个</small></div>
            </div>
            </template>
          </div>
          <div class="ready-panel"><div class="ready-icon"><CheckCircle2 :size="22" /></div><div><strong>{{ notice }}</strong><p>选择一个操作以开始本次任务</p></div></div>
        </div>
        <pre v-if="jobLog" class="job-log">{{ jobLog }}</pre>
      </section>
      <footer class="footer-note">本地自动化工作台 <span>·</span> 所有操作将在浏览器中执行</footer>
    </main>
  </div>
</template>
