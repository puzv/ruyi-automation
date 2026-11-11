<script setup>
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { apiFetch } from '../api.js'
import { formatTime, jobStatusLabels, taskLabels } from '../labels.js'

const props = defineProps({ job: { type: Object, required: true }, admin: Boolean })
const emit = defineEmits(['close'])
const dialog = ref(null)
const output = ref('')
const loading = ref(false)
const error = ref('')
const query = ref('')
const wrap = ref(true)
const updatedAt = ref('')
const logUrl = computed(() => `${props.admin ? '/api/admin/jobs' : '/api/jobs'}/${encodeURIComponent(props.job.id)}/log`)
const lines = computed(() => output.value ? output.value.split(/\r?\n/).map((text, index) => ({ text, number: index + 1 })) : [])
const matches = computed(() => {
  const keyword = query.value.trim().toLowerCase()
  return keyword ? lines.value.filter((line) => line.text.toLowerCase().includes(keyword)) : lines.value
})
// 接口最多返回 5MB；限制同时渲染的行数，避免大日志阻塞界面。
const visibleLines = computed(() => matches.value.slice(-2000))
let disposed = false
let controller
let previousFocus
async function loadLog() {
  if (loading.value || disposed) return
  loading.value = true
  error.value = ''
  controller = new AbortController()
  try {
    const response = await apiFetch(logUrl.value, { signal: controller.signal, cache: 'no-store' })
    if (!response.ok) {
      const data = await response.json().catch(() => ({}))
      throw new Error(data.message || '无法读取日志，请稍后重试')
    }
    const text = await response.text()
    if (disposed) return
    output.value = text
    updatedAt.value = new Date().toISOString()
  } catch (failure) {
    if (!disposed) error.value = failure.message || '无法读取日志，请稍后重试'
  } finally { if (!disposed) loading.value = false }
}
function lineTone(text) {
  if (/error|failed|失败|异常|错误/i.test(text)) return 'log-line-error'
  if (/warn|警告|重试/i.test(text)) return 'log-line-warning'
  return ''
}
onMounted(() => {
  previousFocus = document.activeElement
  dialog.value?.showModal()
  loadLog()
})
onBeforeUnmount(() => { disposed = true; controller?.abort(); previousFocus?.focus() })
</script>

<template>
  <Teleport to="body">
    <dialog ref="dialog" class="log-dialog" aria-labelledby="log-dialog-title" @close="emit('close')">
      <header class="log-dialog-header">
        <div><p class="eyebrow">TASK LOG</p><h2 id="log-dialog-title">{{ taskLabels[job.task] || '任务' }} · 执行日志</h2></div>
        <button class="log-close" type="button" autofocus aria-label="关闭日志" @click="emit('close')">×</button>
      </header>
      <div class="log-job-meta">
        <span class="result-badge" :class="`job-status-${job.status}`">{{ job.status === 'waiting_platform' ? '等待平台处理' : job.status === 'waiting_login' ? '等待登录' : jobStatusLabels[job.status] || job.status }}</span>
        <span>提交于 {{ formatTime(job.queuedAt) }}</span>
        <span class="log-job-id">任务 ID：{{ job.id }}</span>
      </div>
      <div class="log-controls">
        <label class="log-search"><span class="visually-hidden">筛选日志关键词</span><input v-model="query" type="search" placeholder="输入关键词筛选日志…" /></label>
        <label class="log-wrap-toggle"><input v-model="wrap" type="checkbox" />自动换行</label>
        <button class="secondary-button" type="button" :disabled="loading" @click="loadLog">{{ loading ? '刷新中…' : '刷新日志' }}</button>
        <a class="secondary-button log-original" :href="logUrl" target="_blank" rel="noopener noreferrer">原始日志 ↗</a>
      </div>
      <p v-if="error" class="log-error" role="alert">{{ error }}<button type="button" @click="loadLog">重试</button></p>
      <div class="log-terminal" :class="{ 'log-wrap': wrap }" tabindex="0" aria-label="日志内容" :aria-busy="loading">
        <p v-if="loading && !output" class="log-empty" role="status">正在读取任务日志…</p>
        <p v-else-if="!visibleLines.length" class="log-empty">{{ query.trim() ? '没有匹配的日志，请尝试其他关键词' : '暂无日志，任务开始后可点击刷新查看' }}</p>
        <div v-for="line in visibleLines" :key="line.number" class="log-line" :class="lineTone(line.text)"><span class="log-line-number" aria-hidden="true">{{ line.number }}</span><code>{{ line.text || ' ' }}</code></div>
      </div>
      <footer class="log-dialog-footer"><span>{{ query.trim() ? `匹配 ${matches.length} / ${lines.length} 行` : `共 ${lines.length} 行` }}<span v-if="matches.length > visibleLines.length"> · 仅展示最后 2000 行，可筛选或查看原始日志</span></span><span>{{ updatedAt ? `更新于 ${formatTime(updatedAt)}` : '等待加载' }}</span></footer>
    </dialog>
  </Teleport>
</template>

<style scoped>
.log-dialog { width: min(1120px, calc(100vw - 48px)); height: min(820px, calc(100dvh - 64px)); max-width: none; max-height: none; padding: 0; border: 1px solid #dce4df; border-radius: 14px; background: #fff; color: #182522; box-shadow: 0 24px 80px #10251d40; overflow: hidden; }
.log-dialog[open] { display: flex; flex-direction: column; }
.log-dialog::backdrop { background: #10251d80; backdrop-filter: blur(3px); }
.log-dialog-header { display: flex; justify-content: space-between; align-items: center; gap: 16px; padding: 24px 26px 16px; }
.log-dialog-header h2 { margin: 0; font-size: 20px; }
.log-close { display: grid; place-items: center; width: 34px; height: 34px; flex-shrink: 0; border: 1px solid #e0e7e3; border-radius: 8px; background: #f7faf8; color: #53635d; font-size: 24px; }
.log-close:hover { background: #eaf2ed; }
.log-job-meta { display: flex; flex-wrap: wrap; align-items: center; gap: 10px 18px; padding: 0 26px 20px; color: #71827b; font-size: 11px; }
.log-job-id { overflow-wrap: anywhere; font-family: ui-monospace, monospace; }
.log-controls { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; padding: 14px 26px; border-top: 1px solid #edf1ef; background: #f7faf8; }
.log-search { flex: 1 1 200px; }
.log-search input { width: 100%; padding: 10px 12px; border: 1px solid #dce4df; border-radius: 6px; background: #fff; color: #182522; font: inherit; font-size: 12px; }
.log-wrap-toggle { display: flex; align-items: center; gap: 5px; color: #53635d; font-size: 12px; white-space: nowrap; }
.log-wrap-toggle input { accent-color: #27624a; }
.log-original { text-decoration: none; }
.log-terminal { flex: 1; min-height: 0; margin: 0 26px; padding: 16px 0; overflow: auto; background: #172420; border: 1px solid #263a31; border-radius: 8px; color: #d0e0d7; scrollbar-color: #52685c #172420; }
.log-line { display: flex; min-width: fit-content; font: 12px/1.9 "DM Mono", ui-monospace, SFMono-Regular, Consolas, monospace; }
.log-line:hover { background: #ffffff06; }
.log-line-number { position: sticky; left: 0; flex: 0 0 58px; padding: 0 12px; border-right: 1px solid #ffffff0d; background: #172420; color: #718b7d; text-align: right; user-select: none; }
.log-line code { display: block; flex: 1; padding: 0 16px; white-space: pre; font: inherit; }
.log-wrap .log-line { min-width: 0; }
.log-wrap .log-line code { min-width: 0; white-space: pre-wrap; overflow-wrap: anywhere; }
.log-line-error code { color: #f2aaa1; }
.log-line-warning code { color: #e7ca88; }
.log-empty { padding: 40px 20px; color: #9aafa2; text-align: center; font-size: 13px; }
.log-error { margin: 0 26px 12px; padding: 10px 12px; border-radius: 6px; background: #fbece8; color: #a33f37; font-size: 12px; }
.log-error button { margin-left: 12px; padding: 0; border: 0; background: none; color: inherit; text-decoration: underline; }
.log-dialog-footer { display: flex; flex-wrap: wrap; justify-content: space-between; gap: 8px; padding: 14px 26px; color: #71827b; font-size: 11px; }
.log-dialog :focus-visible { outline: 2px solid #73b79a; outline-offset: 2px; }
@media (max-width: 620px) {
  .log-dialog { width: calc(100vw - 16px); height: calc(100dvh - 24px); border-radius: 10px; }
  .log-dialog-header { padding: 18px 14px 12px; }.log-dialog-header h2 { font-size: 17px; }
  .log-job-meta { padding: 0 14px 14px; gap: 8px; }.log-controls { padding: 12px 14px; gap: 8px; }
  .log-search { flex-basis: 100%; }.log-terminal { margin: 0 10px; }.log-line-number { flex-basis: 42px; padding: 0 8px; }
  .log-line code { padding: 0 10px; }.log-dialog-footer { padding: 12px 14px; }.log-error { margin: 0 14px 10px; }
}
</style>
