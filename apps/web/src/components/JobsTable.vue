<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref } from 'vue'
import { requestJson } from '../api.js'
import { formatTime, jobStatusLabels, taskLabels } from '../labels.js'
import { downloadJobResults } from '../result-download.js'
import JobLogDialog from './JobLogDialog.vue'
import { groupWaitRecords, waitRecordRange } from '../wait-records.js'

const props = defineProps({ admin: Boolean })
const items = ref([])
const page = ref(1)
const total = ref(0)
const loading = ref(false)
const error = ref('')
const notice = ref('')
const expanded = reactive({})
const expandedChecks = reactive({})
const files = reactive({})
const jobs = reactive({})
const busy = reactive({})
const showCreate = ref(false)
const createDialog = ref(null)
const platformStatus = ref('none')
const platformLoading = ref(true)
const form = reactive({ name: '', files: [], busy: false })
const fileInput = ref(null)
const folderInput = ref(null)
const selectedSummary = ref({ skipped: 0, error: '' })
const pages = computed(() => Math.max(1, Math.ceil(total.value / 20)))
const statusLabels = { ...jobStatusLabels, waiting_login: '等待登录', waiting_platform: '等待平台处理', pending: '未开始' }
const stepOrder = ['upload', 'create', 'analyse', 'download']
const endpoint = computed(() => props.admin ? '/api/admin/tasks' : '/api/tasks')
const logJob = ref(null)
const filters = reactive({ username: '', status: '' })
let appliedFilters = { username: '', status: '' }
let disposed = false
let timer

function statusLabel(status) { return statusLabels[status] || '未知状态' }
function presentJob(job) {
  // 兼容尚未重启的新任务 API；仅识别旧协议的固定 NOT_READY 前缀。
  if (job.status === 'failed' && typeof job.errorMessage === 'string'
    && job.errorMessage.startsWith('任务未就绪，稍后可重试') && job.outcome === undefined
    && job.exitCode === undefined && job.exitSignal === undefined) {
    return { ...job, status: 'waiting_platform', outcome: 'not_ready', exitCode: 2, errorMessage: null,
      message: '本轮检查时平台尚未处理完成' }
  }
  return job
}
function activeFiles(id) { return (files[id] || []).filter((file) => !file.excludedAt) }
function groupsFor(task) {
  return groupWaitRecords(jobs[task.id] || [], { taskId: task.id, userId: task.userId || task.username || task.id })
}
function canEdit(task) { return ['queued', 'waiting_login'].includes(task.status) }
function stepStatus(task, step) {
  if (step === task.currentStep && task.status === 'waiting_login') return 'waiting_login'
  // 平台异步处理未就绪时，本次检查可能以非零退出码结束，整任务仍在推进。
  if (step === task.currentStep && task.status === 'running') return 'running'
  const record = [...(jobs[task.id] || [])].reverse().find((job) => job.task === step)
  if (record) return record.status
  const current = stepOrder.indexOf(task.currentStep)
  if (task.status === 'succeeded' || (current >= 0 && stepOrder.indexOf(step) < current)) return 'succeeded'
  if (step === task.currentStep) return task.status
  return 'pending'
}
function resultJob(task) {
  return [...(jobs[task.id] || [])].reverse().find((job) => job.task === 'download' && job.status === 'succeeded')
}
async function refreshPlatform() {
  if (props.admin) return
  platformLoading.value = true
  try {
    const data = await requestJson('/api/platform-state')
    if (!disposed) platformStatus.value = data.status
  } catch (cause) {
    if (!disposed) { platformStatus.value = 'none'; error.value = cause.message }
  } finally { if (!disposed) platformLoading.value = false }
}
async function load(next = 1, search = false) {
  if (loading.value || disposed) return
  window.clearTimeout(timer)
  loading.value = true
  error.value = ''
  const selected = search ? { ...filters } : appliedFilters
  try {
    const query = new URLSearchParams({ page: String(next), pageSize: '20' })
    if (props.admin) for (const [key, value] of Object.entries(selected)) if (value) query.set(key, value)
    const data = await requestJson(`${endpoint.value}?${query}`)
    if (disposed) return
    items.value = data.items || []; total.value = Number(data.total || 0); page.value = data.page || next
    appliedFilters = selected
    await Promise.all(items.value.map(async (task) => {
      const detail = await requestJson(`${endpoint.value}/${encodeURIComponent(task.id)}`)
      if (disposed) return
      jobs[task.id] = (detail.jobs || []).map(presentJob)
      if (expanded[task.id]) await loadFiles(task)
    }))
  } catch (cause) { if (!disposed) error.value = cause.message || '无法获取任务列表' }
  finally { if (!disposed) { loading.value = false; schedule() } }
}
function schedule() {
  window.clearTimeout(timer)
  if (!disposed) timer = window.setTimeout(() => load(page.value), 5000)
}
async function loadFiles(task) {
  const data = await requestJson(`${endpoint.value}/${encodeURIComponent(task.id)}/files`)
  if (!disposed) files[task.id] = data.items || []
}
async function toggleTask(task) {
  expanded[task.id] = !expanded[task.id]
  if (expanded[task.id]) {
    try { await loadFiles(task) } catch (cause) { if (!disposed) error.value = cause.message }
  }
}
async function openCreate() {
  if (props.admin || disposed) return
  showCreate.value = true
  await nextTick()
  if (disposed) return
  createDialog.value?.showModal()
  await refreshPlatform()
}
function fileBaseName(file) {
  const value = file.webkitRelativePath || file.name || ''
  return value.split('/').pop() || ''
}
function collectFiles(event) {
  const picked = [...(event.target.files || [])]
  if (!picked.length) return
  const valid = [], names = new Set(), stems = new Set()
  let skipped = 0, duplicate = ''
  for (const file of picked) {
    const relative = file.webkitRelativePath || file.name || ''
    const parts = relative.split('/')
    const name = fileBaseName(file)
    const lower = name.toLowerCase()
    const typeOk = ['pn', 'idfa', 'oaid'].some((type) => lower.includes(type))
    const extOk = /\.(txt|csv)$/i.test(name)
    const hidden = parts.some((part) => part.startsWith('.'))
    if (!name || hidden || !typeOk || !extOk) { skipped++; continue }
    const normalized = name.normalize('NFC')
    const stem = normalized.slice(0, normalized.length - name.match(/\.(txt|csv)$/i)[0].length).normalize('NFC')
    if (names.has(normalized) || stems.has(stem)) duplicate = name
    names.add(normalized); stems.add(stem); valid.push(file)
  }
  form.files = valid
  const tooLarge = valid.reduce((size, file) => size + file.size, 0) > 1024 * 1024 * 1024
  selectedSummary.value = { skipped, error: duplicate ? `文件重名或结果主名称重复：${duplicate}。请重新选择后再提交`
    : valid.length > 1000 ? '单个任务最多上传 1000 个有效文件，请减少后重新选择'
      : tooLarge ? '单个任务文件总大小不得超过 1GB，请减少后重新选择'
        : valid.length ? '' : '没有可导入的文件，请选择名称包含 pn、idfa 或 oaid 的 txt/csv 文件' }
  event.target.value = ''
  if (fileInput.value) fileInput.value.value = ''
  if (folderInput.value) folderInput.value.value = ''
}
function chooseFiles(event) { collectFiles(event) }
function chooseFolder(event) { collectFiles(event) }
async function createTask() {
  if (props.admin || form.busy || disposed) return
  error.value = ''
  if (selectedSummary.value.error) { error.value = selectedSummary.value.error; return }
  if (!form.files.length) { error.value = selectedSummary.value.error || '请选择至少一个文件'; return }
  form.busy = true
  try {
    await refreshPlatform()
    if (disposed) return
    if (platformStatus.value !== 'valid') { error.value = '请先完成平台登录'; return }
    const body = new FormData()
    if (form.name.trim()) body.append('name', form.name.trim())
    for (const file of form.files) body.append('files', file, file.name)
    await requestJson('/api/tasks', { method: 'POST', body })
    if (disposed) return
    form.name = ''; form.files = []; selectedSummary.value = { skipped: 0, error: '' }; if (fileInput.value) fileInput.value.value = ''; if (folderInput.value) folderInput.value.value = ''
    showCreate.value = false
    notice.value = '任务已创建并进入队列'
    await load(1)
  } catch (cause) { if (!disposed) error.value = cause.message || '创建任务失败' }
  finally { if (!disposed) form.busy = false }
}
async function mutate(key, action) {
  if (props.admin || disposed || busy[key]) return
  busy[key] = true; error.value = ''
  try { await action(); if (!disposed) await load(page.value) }
  catch (cause) { if (!disposed) error.value = cause.message || '操作失败，请刷新后重试' }
  finally { if (!disposed) busy[key] = false }
}
async function removeFile(task, file) {
  if (props.admin || !canEdit(task) || busy[file.id]) return
  const last = activeFiles(task.id).length === 1 ? '这是最后一个文件，移除后任务将取消。' : '后续流程将不再处理该文件。'
  if (!window.confirm(`确定移除“${file.originalName}”吗？${last}`)) return
  await mutate(file.id, () => requestJson(`/api/tasks/${encodeURIComponent(task.id)}/files/${encodeURIComponent(file.id)}`, { method: 'DELETE', body: { version: task.version } }))
}
async function removeTask(task) {
  if (props.admin || busy[task.id]) return
  const stopping = task.status === 'running'
  const message = stopping ? '停止后将标记为已中断，保留已完成进度，之后可继续任务。' : '删除后将从任务列表中移除，不删除平台上的人群资源。'
  if (!window.confirm(`确定${stopping ? '停止' : '删除'}“${task.name || task.id}”吗？${message}`)) return
  await mutate(task.id, async () => {
    const data = await requestJson(`/api/tasks/${encodeURIComponent(task.id)}${stopping ? '/stop' : ''}`, { method: stopping ? 'POST' : 'DELETE', body: { version: task.version } })
    if (!disposed) notice.value = data.status === 'interrupted' ? '任务已中断，可继续任务'
      : data.status === 'cancelling' ? '停止请求已提交，完成后可继续任务' : '任务已删除'
  })
}
async function continueTask(task) {
  if (props.admin || task.status !== 'interrupted' || busy[task.id]) return
  await mutate(task.id, async () => {
    await refreshPlatform()
    if (disposed) return
    if (platformStatus.value !== 'valid') throw new Error('请先完成平台登录，再继续任务')
    if (!window.confirm('将从未完成步骤继续并重新入队，已完成流程不会重复执行，是否继续？')) return
    const data = await requestJson(`/api/tasks/${encodeURIComponent(task.id)}/continue`, { method: 'POST', body: { version: task.version } })
    if (!disposed) notice.value = data.message || '任务已从未完成步骤重新入队'
  })
}
async function resume(task) {
  await mutate(task.id, async () => {
    await refreshPlatform()
    if (disposed) return
    if (platformStatus.value !== 'valid') throw new Error('请先完成平台登录，再恢复任务')
    if (!window.confirm('将恢复你的全部“等待登录”任务，并按原顺序重新入队，是否继续？')) return
    await requestJson(`/api/tasks/${encodeURIComponent(task.id)}/resume`, { method: 'POST' })
    if (!disposed) notice.value = '等待登录任务已重新入队'
  })
}
async function download(task) {
  if (props.admin || busy[task.id] || task.status !== 'succeeded') return
  const job = resultJob(task)
  if (!job) return
  busy[task.id] = true; error.value = ''
  try { const message = await downloadJobResults(job); if (!disposed) notice.value = message || '该任务暂无可下载结果' }
  catch (cause) { if (!disposed) error.value = cause.message || '下载结果失败' }
  finally { if (!disposed) busy[task.id] = false }
}
onMounted(() => Promise.all([load(), refreshPlatform()]))
onBeforeUnmount(() => { disposed = true; window.clearTimeout(timer) })
</script>
<template>
  <div class="job-toolbar">
    <button v-if="!admin" class="primary-button" type="button" @click="openCreate">创建任务</button>
    <button class="secondary-button" type="button" :disabled="loading" @click="load(page)">刷新</button>
    <span class="batch-hint">同用户按入队顺序执行，同时只运行一个任务</span>
  </div>
  <form v-if="admin" class="filter-form" @submit.prevent="load(1, true)">
    <label>用户名<input v-model="filters.username" /></label>
    <label>状态<select v-model="filters.status"><option value="">全部状态</option><option v-for="(label, value) in statusLabels" v-show="!['pending', 'waiting_platform'].includes(value)" :key="value" :value="value">{{ label }}</option></select></label>
    <button class="primary-button" :disabled="loading">查询</button>
  </form>
  <Teleport to="body"><dialog v-if="showCreate && !admin" ref="createDialog" class="task-create" aria-labelledby="task-create-title" @cancel="form.busy ? $event.preventDefault() : (showCreate = false)" @close="showCreate = false">
    <h2 id="task-create-title">创建任务</h2>
    <p class="page-description">文件名需包含 idfa、oaid 或 pn，格式为 .txt 或 .csv；提交后自动入队，不支持补传。</p>
    <p v-if="platformLoading" role="status">正在确认平台登录状态…</p>
    <p v-else-if="platformStatus !== 'valid'" class="form-error">请先完成平台登录。<a href="#/platform-login">前往平台登录</a></p>
    <form class="task-create-form" @submit.prevent="createTask">
      <label>任务名称（可选）<input v-model="form.name" autofocus :disabled="form.busy" maxlength="120" placeholder="不填写则使用任务编号" /></label>
      <label class="file-picker">选择文件<input ref="fileInput" type="file" multiple accept=".txt,.csv" :disabled="form.busy || platformLoading || platformStatus !== 'valid'" @change="chooseFiles" /></label>
      <label class="file-picker">选择文件夹（包含子目录）<input ref="folderInput" type="file" webkitdirectory multiple :disabled="form.busy || platformLoading || platformStatus !== 'valid'" @change="chooseFolder" /></label>
      <p v-if="form.files.length || selectedSummary.skipped" class="page-description">有效 {{ form.files.length }} 个文件，已跳过 {{ selectedSummary.skipped }} 个不符合条件的文件。换选文件或文件夹会替换当前清单。</p>
      <p v-if="selectedSummary.error" class="form-error" role="alert">{{ selectedSummary.error }}</p>
      <div class="row-actions"><button class="primary-button" :disabled="form.busy || !form.files.length || !!selectedSummary.error || platformLoading || platformStatus !== 'valid'">{{ form.busy ? '正在上传…' : '上传并创建任务' }}</button><button class="secondary-button" type="button" :disabled="form.busy" @click="showCreate = false">关闭</button></div>
    </form>
    <ul v-if="form.files.length" class="selected-files"><li v-for="(file, index) in form.files" :key="index">{{ file.webkitRelativePath || file.name }}</li></ul>
    <p v-if="error" class="form-error" role="alert">{{ error }}</p>
  </dialog></Teleport>
  <p v-if="error" class="form-error" role="alert">{{ error }}</p>
  <p v-if="notice" class="form-success" role="status">{{ notice }}</p>
  <div class="table-scroll"><table class="data-table task-table">
    <thead><tr><th>任务</th><th v-if="admin">用户</th><th>创建时间</th><th>整体状态</th><th>流程进度</th><th>操作</th></tr></thead>
    <tbody>
      <template v-for="task in items" :key="task.id">
        <tr>
          <td><strong>{{ task.name || task.id }}</strong><small class="batch-note task-id">{{ task.id }}</small></td>
          <td v-if="admin">{{ task.username || '—' }}</td>
          <td class="nowrap">{{ formatTime(task.createdAt || task.queuedAt) }}</td>
          <td><span class="result-badge" :class="`job-status-${task.status}`">{{ statusLabel(task.status) }}</span><small v-if="task.status === 'running' && task.cancelRequested" class="batch-note">正在停止…</small><small v-else-if="task.status === 'running' && task.nextCheckAt" class="batch-note">等待平台处理，系统将自动继续</small></td>
          <td><ol class="batch-progress" aria-label="任务流程进度"><li v-for="step in stepOrder" :key="step" :class="`job-status-${stepStatus(task, step)}`"><span>{{ taskLabels[step] }}</span><small>{{ statusLabel(stepStatus(task, step)) }}</small></li></ol></td>
          <td><div class="row-actions">
            <button class="secondary-button" type="button" :aria-expanded="!!expanded[task.id]" @click="toggleTask(task)">{{ expanded[task.id] ? '收起详情' : '文件与流程' }}</button>
            <button v-if="!admin && task.status === 'interrupted'" class="secondary-button" type="button" :disabled="busy[task.id]" @click="continueTask(task)">继续任务</button>
            <button v-if="!admin && task.status === 'waiting_login'" class="secondary-button" type="button" :disabled="busy[task.id]" @click="resume(task)">恢复入队</button>
            <button v-if="!admin && task.status === 'succeeded' && resultJob(task)" class="secondary-button" type="button" :disabled="busy[task.id]" @click="download(task)">下载结果</button>
            <button v-if="!admin" class="secondary-button danger" type="button" :disabled="busy[task.id] || (task.status === 'running' && task.cancelRequested)" @click="removeTask(task)">{{ task.status === 'running' ? '停止任务' : '删除任务' }}</button>
          </div></td>
        </tr>
        <tr v-if="expanded[task.id]" class="batch-detail"><td :colspan="admin ? 6 : 5">
          <p v-if="task.errorMessage" class="form-error">{{ task.errorMessage }}</p>
          <p v-if="task.status === 'waiting_login'" class="page-description">请先完成平台登录，再手动恢复入队；登录成功不会自动启动任务。</p>
          <h3>初始文件清单 <small v-if="files[task.id]">（有效 {{ activeFiles(task.id).length }} / 共 {{ files[task.id].length }} 个）</small></h3>
          <p v-if="!files[task.id]" role="status">正在读取文件清单…</p>
          <ul v-else class="task-file-list"><li v-for="file in files[task.id]" :key="file.id" :class="{ excluded: file.excludedAt }"><span>{{ file.originalName }}</span><small>{{ file.excludedAt ? '已移除，不再推进' : `${file.fileType} · ${file.sizeBytes} 字节` }}</small><button v-if="!admin && !file.excludedAt && canEdit(task)" class="link-button danger" type="button" :disabled="busy[file.id]" @click="removeFile(task, file)">移除文件</button></li></ul>
          <p v-if="!canEdit(task)" class="page-description">运行中和已结束任务的文件清单只读。</p>
          <h3>流程执行记录</h3>
          <p v-if="!(jobs[task.id] || []).length" class="page-description">尚无执行记录，任务按队列顺序启动。</p>
          <ul class="task-job-list">
            <li v-for="group in groupsFor(task)" :key="group.id">
              <span>{{ taskLabels[group.record.task] }}</span><span class="result-badge" :class="`job-status-${group.record.status}`">{{ statusLabel(group.record.status) }}</span>
              <template v-if="group.records.length > 1"><strong>连续 {{ group.records.length }} 次检查</strong><small class="batch-note">首次 {{ formatTime(waitRecordRange(group).first) }} · 最近 {{ formatTime(waitRecordRange(group).last) }}</small><button class="secondary-button" type="button" :aria-expanded="!!expandedChecks[group.id]" @click="expandedChecks[group.id] = !expandedChecks[group.id]">{{ expandedChecks[group.id] ? '收起检查' : '展开每次日志' }}</button>
                <ul v-if="expandedChecks[group.id]" class="check-records"><li v-for="item in group.records" :key="item.id"><span>{{ formatTime(item.startedAt || item.queuedAt) }}</span><span>{{ statusLabel(item.status) }}</span><button class="secondary-button" type="button" @click="logJob = item">查看日志</button><small>{{ item.message || '本轮检查正在等待' }}</small></li></ul>
              </template>
              <template v-else><span>{{ formatTime(group.record.startedAt) }}</span><button class="secondary-button" type="button" @click="logJob = group.record">查看日志</button><small v-if="group.record.message" class="batch-note">{{ group.record.message }}</small><small v-if="group.record.errorMessage" class="form-error">{{ group.record.errorMessage }}</small></template>
            </li>
          </ul>
        </td></tr>
      </template>
      <tr v-if="!items.length"><td class="empty-state" :colspan="admin ? 6 : 5">{{ loading ? '正在加载…' : admin ? '暂无符合条件的任务' : '暂无任务，点击“创建任务”开始' }}</td></tr>
    </tbody>
  </table></div>
  <div class="pagination"><button class="secondary-button" :disabled="loading || page <= 1" @click="load(page - 1)">上一页</button><span>第 {{ page }} / {{ pages }} 页，共 {{ total }} 个任务</span><button class="secondary-button" :disabled="loading || page >= pages" @click="load(page + 1)">下一页</button></div>
  <JobLogDialog v-if="logJob" :key="logJob.id" :job="logJob" :admin="admin" @close="logJob = null" />
</template>
<style scoped>
.batch-hint, .batch-note { color: #71827b; font-size: 12px; }
.job-toolbar { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; margin-bottom: 18px; }
.batch-note { display: block; margin-top: 6px; overflow-wrap: anywhere; }
.task-id { font: 10px ui-monospace, monospace; }
.task-table td:first-child { white-space: normal; min-width: 150px; }
.task-create { width: min(560px, calc(100vw - 32px)); max-height: 90dvh; overflow: auto; padding: 26px; border: 1px solid #c7dfd2; border-radius: 12px; background: #fff; box-shadow: 0 24px 80px #10251d40; }
.task-create::backdrop { background: #10251d80; backdrop-filter: blur(3px); }
.task-create h2 { margin: 0 0 12px; font-size: 20px; }
.task-create-form { display: grid; gap: 18px; margin-top: 18px; }
.task-create-form label { display: grid; gap: 7px; min-width: 200px; color: #53635d; font-size: 12px; }
.task-create-form input { max-width: 100%; padding: 10px; border: 1px solid #dce4df; border-radius: 6px; background: white; font: inherit; }
.task-create :focus-visible { outline: 2px solid #73b79a; outline-offset: 2px; }
.task-create-form input[type="file"] { width: 100%; padding: 16px; border-style: dashed; background: #f7faf8; }
.task-create-form input::file-selector-button { margin-right: 12px; padding: 8px 12px; border: 1px solid #c7dfd2; border-radius: 6px; color: #27624a; background: #e4f2ec; font: inherit; cursor: pointer; }
.selected-files { max-height: 160px; overflow: auto; padding-left: 20px; color: #53635d; font-size: 12px; }
.batch-progress { display: flex; gap: 6px; padding: 0; margin: 0; list-style: none; }
.batch-progress li { display: grid; gap: 4px; min-width: 70px; padding: 8px; border-radius: 6px; font-size: 11px; }
.batch-progress small { font-size: 10px; }
.job-status-pending { color: #71827b; background: #edf1ef; }
.job-status-waiting_login { color: #92702b; background: #f7eed5; }
.job-status-waiting_platform { color: #416e98; background: #e2edf8; }
.batch-detail > td { padding: 20px; background: #f7faf8; }
.batch-detail h3 { font-size: 13px; margin: 16px 0 12px; }
.batch-detail h3 small { font-weight: normal; color: #71827b; }
.task-file-list, .task-job-list { list-style: none; margin: 0; padding: 0; display: grid; gap: 8px; }
.check-records { flex: 1 0 100%; margin: 4px 0; padding: 0 0 0 16px; list-style: none; background: #edf3ef; }
.task-file-list li, .task-job-list li { display: flex; flex-wrap: wrap; gap: 12px; align-items: center; padding: 8px; border-bottom: 1px solid #e0e7e3; }
.task-file-list span { overflow-wrap: anywhere; }
.task-file-list small { color: #71827b; }
.task-file-list .excluded span { text-decoration: line-through; color: #8b9691; }
.link-button { border: 0; background: none; color: #27624a; cursor: pointer; padding: 2px 5px; }
.danger { color: #a33f37; }
@media (max-width: 700px) { .batch-progress { flex-wrap: wrap; min-width: 170px; } }
</style>
