<script setup>
import { computed, onBeforeUnmount, onMounted, reactive, ref } from 'vue'
import { requestJson } from '../api.js'
import { observeResultJob, downloadJobResults } from '../result-download.js'
import { formatTime, isActiveJob, jobDuration, jobStatusLabels, taskLabels } from '../labels.js'

const props = defineProps({ admin: Boolean })
const filters = reactive({ username: '', status: '' })
let appliedFilters = { ...filters }
const items = ref([])
const page = ref(1)
const total = ref(0)
const loading = ref(false)
const error = ref('')
const cancelling = ref({})
const downloading = ref({})
const downloadNotice = ref('')
const now = ref(Date.now())
const pages = computed(() => Math.max(1, Math.ceil(total.value / 20)))
let timer
let disposed = false

function scheduleRefresh() {
  window.clearTimeout(timer)
  if (!disposed && items.value.some(isActiveJob)) timer = window.setTimeout(() => load(page.value), 3000)
}
async function load(nextPage = 1, search = false) {
  if (loading.value || disposed) return
  window.clearTimeout(timer)
  loading.value = true
  error.value = ''
  const selected = search ? { ...filters } : appliedFilters
  try {
    const query = new URLSearchParams({ page: String(nextPage), pageSize: '20' })
    if (props.admin) for (const [key, value] of Object.entries(selected)) if (value) query.set(key, value)
    const data = await requestJson(`${props.admin ? '/api/admin/jobs' : '/api/jobs'}?${query}`)
    if (disposed) return
    items.value = data.items; total.value = data.total; page.value = data.page
    if (!props.admin) for (const item of data.items) {
      observeResultJob(item).then((message) => {
        if (!disposed && message) downloadNotice.value = message
      }).catch((failure) => { if (!disposed) error.value = `ZIP 下载未发起：${failure.message}` })
    }
    now.value = Date.now()
    appliedFilters = selected
  } catch (failure) {
    if (!disposed) error.value = failure.message || '无法获取任务列表'
  } finally {
    loading.value = false
    scheduleRefresh()
  }
}
async function redownload(job) {
  if (props.admin || downloading.value[job.id]) return
  downloading.value[job.id] = true
  error.value = ''
  try {
    const message = await downloadJobResults(job)
    if (!disposed) downloadNotice.value = message
  } catch (failure) { if (!disposed) error.value = failure.message || '下载结果失败，请重试' }
  finally { downloading.value[job.id] = false }
}
async function cancelJob(job) {
  if (props.admin || !isActiveJob(job) || cancelling.value[job.id] || job.cancelRequested) return
  if (!window.confirm(`确定取消${taskLabels[job.task] || '任务'}吗？`)) return
  cancelling.value[job.id] = true
  error.value = ''
  try {
    const data = await requestJson(`/api/jobs/${encodeURIComponent(job.id)}/cancel`, { method: 'POST' })
    if (disposed) return
    if (data.result === 'cancelling') job.cancelRequested = true
    if (data.result === 'cancelled') job.status = 'cancelled'
    await load(page.value)
  } catch (failure) {
    if (!disposed) error.value = failure.message || '取消任务失败'
  } finally {
    cancelling.value[job.id] = false
  }
}
onMounted(() => load())
onBeforeUnmount(() => { disposed = true; window.clearTimeout(timer) })
</script>

<template>
  <form v-if="admin" class="filter-form" @submit.prevent="load(1, true)">
    <label>用户名<input v-model="filters.username" :disabled="loading" /></label>
    <label>状态<select v-model="filters.status" :disabled="loading"><option value="">全部状态</option><option v-for="(label, value) in jobStatusLabels" :key="value" :value="value">{{ label }}</option></select></label>
    <button class="primary-button" :disabled="loading">查询</button>
  </form>
  <div class="job-toolbar"><button class="secondary-button" :disabled="loading" @click="load(page)">刷新</button></div>
  <p v-if="error" class="form-error" role="alert">{{ error }}</p>
  <p v-if="downloadNotice" role="status">{{ downloadNotice }}</p>
  <div class="table-scroll">
    <table class="data-table">
      <thead><tr><th>提交时间</th><th v-if="admin">用户</th><th>任务</th><th>状态</th><th>开始时间</th><th>耗时</th><th>说明</th><th>操作</th></tr></thead>
      <tbody>
        <tr v-for="item in items" :key="item.id">
          <td class="nowrap">{{ formatTime(item.queuedAt) }}</td>
          <td v-if="admin">{{ item.username || '—' }}</td>
          <td>{{ taskLabels[item.task] || item.task }}</td>
          <td><span class="result-badge" :class="`job-status-${item.status}`">{{ jobStatusLabels[item.status] || item.status }}</span></td>
          <td class="nowrap">{{ formatTime(item.startedAt) }}</td>
          <td class="nowrap">{{ jobDuration(item, now) }}</td>
          <td class="log-description">{{ item.errorMessage || '—' }}<span v-if="isActiveJob(item) && item.cancelRequested"> 正在停止任务…</span></td>
          <td><div class="row-actions"><a class="secondary-button job-log-link" :href="`/api/jobs/${encodeURIComponent(item.id)}/log`" target="_blank" rel="noopener noreferrer">查看日志</a><button v-if="!admin && item.task === 'download' && item.status === 'succeeded'" class="secondary-button" :disabled="downloading[item.id]" @click="redownload(item)">重新下载</button><button v-if="!admin && isActiveJob(item)" class="secondary-button" :disabled="loading || cancelling[item.id] || item.cancelRequested" @click="cancelJob(item)">取消</button></div></td>
        </tr>
        <tr v-if="!items.length"><td class="empty-state" :colspan="admin ? 8 : 7">{{ loading ? '正在加载…' : '暂无任务' }}</td></tr>
      </tbody>
    </table>
  </div>
  <div class="pagination"><button class="secondary-button" :disabled="loading || page <= 1" @click="load(page - 1)">上一页</button><span>第 {{ page }} / {{ pages }} 页，共 {{ total }} 条</span><button class="secondary-button" :disabled="loading || page >= pages" @click="load(page + 1)">下一页</button></div>
</template>
