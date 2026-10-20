<script setup>
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { apiFetch, requestJson } from '../api.js'
import { formatTime } from '../labels.js'
import RemoteDesktop from '../components/RemoteDesktop.vue'

const props = defineProps({ currentUser: { type: Object, required: true } })
const emit = defineEmits(['state-changed'])
// 按用户保存会话，避免同一浏览器切换账号后恢复到其他人的会话。
const storageKey = `platform-login-session:${props.currentUser.id}`
const summary = ref(null)
const summaryError = ref('')
const session = ref(null)
const error = ref('')
const busy = ref(false)
const restoring = ref(true)
const now = ref(Date.now())
const active = computed(() => ['starting', 'waiting', 'saving'].includes(session.value?.status))
const statusLabels = { none: '未登录', valid: '有效', expired: '已过期' }
const expiryHours = computed(() => {
  const timestamp = new Date(summary.value?.expiresHintAt).getTime()
  return summary.value?.expiresHintAt && Number.isFinite(timestamp) ? Math.max(0, (timestamp - now.value) / 3600000) : null
})
const expiryLabel = computed(() => expiryHours.value == null ? '未知' : expiryHours.value === 0 ? '已到预计过期时间' : `约 ${Math.max(1, Math.ceil(expiryHours.value))} 小时后过期`)
const countdown = computed(() => {
  const seconds = Math.max(0, Math.ceil((new Date(session.value?.expiresAt).getTime() - now.value) / 1000))
  return Number.isFinite(seconds) ? `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒` : '—'
})
let disposed = false
let pollTimer
let clockTimer
let successTimer
let pollVersion = 0

async function refreshSummary() {
  try {
    const data = await requestJson('/api/platform-state')
    if (disposed) return
    summary.value = data
    summaryError.value = ''
    emit('state-changed')
  } catch (cause) {
    if (!disposed) summaryError.value = cause.message
  }
}

function acceptSession(value) {
  if (disposed) return
  window.clearTimeout(pollTimer)
  window.clearTimeout(successTimer)
  session.value = value
  error.value = ''
  now.value = Date.now()
  if (active.value) {
    pollTimer = window.setTimeout(pollSession, 1500)
  } else if (value.status === 'succeeded') {
    successTimer = window.setTimeout(async () => {
      await refreshSummary()
      if (disposed) return
      sessionStorage.removeItem(storageKey)
      location.hash = '#/'
    }, 2000)
  } else {
    sessionStorage.removeItem(storageKey)
  }
}

async function pollSession() {
  if (disposed || !session.value?.id) return
  const version = ++pollVersion
  window.clearTimeout(pollTimer)
  try {
    const response = await apiFetch(`/api/platform-login/${encodeURIComponent(session.value.id)}`)
    const data = await response.json()
    if (disposed || version !== pollVersion) return
    if (response.status === 404) {
      sessionStorage.removeItem(storageKey)
      session.value = null
      throw new Error(data.message || '登录会话不存在，请重新开始')
    }
    if (!response.ok || !data.ok) throw new Error(data.message || '无法获取登录进度')
    acceptSession(data.session)
  } catch (cause) {
    if (disposed || version !== pollVersion) return
    error.value = cause.message || '无法连接服务，请稍后重试'
    if (active.value) pollTimer = window.setTimeout(pollSession, 1500)
  }
}

async function startLogin() {
  if (busy.value || restoring.value || active.value) return
  busy.value = true
  error.value = ''
  window.clearTimeout(successTimer)
  try {
    const data = await requestJson('/api/platform-login', { method: 'POST' })
    // 请求期间切换页面也保留 ID，回到页面即可继续查看。
    sessionStorage.setItem(storageKey, data.session.id)
    acceptSession(data.session)
  } catch (cause) {
    if (!disposed) error.value = cause.message
  } finally {
    if (!disposed) busy.value = false
  }
}

async function cancelLogin() {
  if (busy.value || !active.value) return
  busy.value = true
  error.value = ''
  window.clearTimeout(pollTimer)
  pollVersion += 1
  let cancelError = ''
  try {
    await requestJson(`/api/platform-login/${encodeURIComponent(session.value.id)}`, { method: 'DELETE' })
  } catch (cause) {
    cancelError = cause.message
  } finally {
    // 取消与成功可能同时发生，以服务端最终状态为准。
    window.clearTimeout(pollTimer)
    await pollSession()
    if (!disposed) {
      if (cancelError) error.value = cancelError
      busy.value = false
    }
  }
}

async function clearState() {
  if (busy.value || active.value || !window.confirm('确定清除平台登录态吗？清除后需要重新登录才能运行任务。')) return
  busy.value = true
  error.value = ''
  try {
    await requestJson('/api/platform-state/clear', { method: 'POST' })
    await refreshSummary()
  } catch (cause) {
    if (!disposed) error.value = cause.message
  } finally {
    if (!disposed) busy.value = false
  }
}

onMounted(async () => {
  clockTimer = window.setInterval(() => { now.value = Date.now() }, 1000)
  const id = sessionStorage.getItem(storageKey)
  if (id) session.value = { id, status: 'starting' }
  await Promise.all([refreshSummary(), id ? pollSession() : Promise.resolve()])
  if (!disposed) restoring.value = false
})
onBeforeUnmount(() => {
  disposed = true
  window.clearTimeout(pollTimer)
  window.clearTimeout(successTimer)
  window.clearInterval(clockTimer)
})
</script>

<template>
  <main class="main-content auth-content platform-login-page">
    <header class="topbar"><div><p class="eyebrow">PLATFORM LOGIN</p><h1>平台登录</h1></div></header>
    <p class="page-description">完成如翼与 DataNexus 登录后，即可运行数据任务。</p>
    <section class="content-card" aria-label="当前平台登录态">
      <h2>当前登录态</h2>
      <p v-if="summaryError" class="form-error" role="alert">{{ summaryError }} <button class="secondary-button" type="button" @click="refreshSummary">重试</button></p>
      <dl v-if="summary" class="platform-state-summary">
        <div><dt>状态</dt><dd :class="summary.status === 'valid' ? 'form-success' : 'platform-expiry-warning'">{{ statusLabels[summary.status] }}</dd></div>
        <div><dt>登录时间</dt><dd>{{ formatTime(summary.capturedAt) }}</dd></div>
        <div><dt>最近刷新时间</dt><dd>{{ formatTime(summary.refreshedAt) }}</dd></div>
        <div><dt>预计过期时间</dt><dd :class="{ 'platform-expiry-warning': expiryHours != null && expiryHours < 6 }" :title="formatTime(summary.expiresHintAt)">{{ expiryLabel }}</dd></div>
      </dl>
      <p v-else-if="!summaryError" class="page-description" role="status">正在加载登录态…</p>
      <div v-if="!active" class="row-actions">
        <button class="primary-button" type="button" :disabled="busy || restoring" @click="startLogin">{{ busy ? '正在处理…' : session && session.status !== 'succeeded' ? '重新开始' : summary?.status === 'valid' ? '重新登录' : '开始登录' }}</button>
        <button v-if="summary?.status === 'valid'" class="secondary-button" type="button" :disabled="busy || restoring" @click="clearState">清除登录态</button>
      </div>
    </section>
    <p v-if="error" class="form-error platform-login-error" role="alert">{{ error }}</p>
    <section v-if="session" class="content-card" aria-label="平台登录会话">
      <h2>登录进度</h2>
      <div class="platform-site-progress">
        <span v-for="site in [{ key: 'ruyi', label: '如翼' }, { key: 'datanexus', label: 'DataNexus' }]" :key="site.key" :class="['result-badge', session.sites?.[site.key] ? 'success' : '']">{{ site.label }}：{{ session.sites?.[site.key] ? '已登录' : '等待登录' }}</span>
      </div>
      <p :class="session.status === 'succeeded' ? 'form-success' : 'page-description'" role="status">{{ session.message }}{{ session.status === 'succeeded' ? '，2 秒后自动返回操作面板' : '' }}</p>
      <template v-if="active">
        <p class="page-description">剩余时间：{{ countdown }}</p>
        <RemoteDesktop v-if="session.display === 'vnc'" :session-id="session.id" />
        <p v-else-if="session.display === 'local'" class="platform-local-hint">登录窗口已在服务器所在电脑上打开，请在该窗口中完成扫码登录</p>
        <button class="secondary-button" type="button" :disabled="busy || restoring" @click="cancelLogin">取消登录</button>
      </template>
    </section>
  </main>
</template>
