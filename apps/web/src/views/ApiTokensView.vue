<script setup>
import { onBeforeUnmount, onMounted, reactive, ref } from 'vue'
import { requestJson } from '../api.js'
import { formatTime } from '../labels.js'

const origin = window.location.origin
const shellQuote = (value) => "'" + value.replace(/'/g, "'\\''") + "'"
function connectionCommand(client, token = '<令牌>') {
  const url = shellQuote(`${origin}/mcp`)
  return client === 'claude'
    ? `claude mcp add --transport http --scope user ruyi ${url} --header ${shellQuote(`Authorization: Bearer ${token}`)}`
    : `export RUYI_TOKEN=${shellQuote(token)}\ncodex mcp add ruyi --url ${url} --bearer-token-env-var RUYI_TOKEN`
}
async function copyConnection(client) {
  error.value = ''; notice.value = ''
  try {
    await navigator.clipboard.writeText(connectionCommand(client, secret.value))
    if (!disposed) notice.value = '接入命令已复制，请在本机终端执行并妥善保管令牌'
  } catch { if (!disposed) error.value = '复制失败，请手动配置接入命令' }
}
const items = ref([])
const form = reactive({ name: '', expiresInDays: 90 })
const loading = ref(false)
const busy = ref(false)
const error = ref('')
const notice = ref('')
const secret = ref('')
const statusLabels = { active: '有效', expired: '已过期', revoked: '已吊销' }
let disposed = false
async function load() {
  loading.value = true
  try {
    const data = await requestJson('/api/api-tokens')
    if (!disposed) items.value = data.items
  } finally { loading.value = false }
}
async function createToken() {
  if (busy.value) return
  error.value = ''; notice.value = ''
  const name = form.name.trim()
  if (!name || name.length > 64) { error.value = '名称需为 1–64 个字符'; return }
  busy.value = true
  try {
    const data = await requestJson('/api/api-tokens', { method: 'POST', body: { name, expiresInDays: form.expiresInDays } })
    if (disposed) return
    secret.value = data.token
    form.name = ''
    await load()
  } catch (failure) { if (!disposed) error.value = failure.message } finally { busy.value = false }
}
async function copyToken() {
  error.value = ''; notice.value = ''
  try {
    await navigator.clipboard.writeText(secret.value)
    if (!disposed) notice.value = '令牌已复制，请妥善保存'
  } catch { if (!disposed) error.value = '复制失败，请手动选择令牌复制' }
}
async function revokeToken(item) {
  if (busy.value || !window.confirm(`确定吊销令牌“${item.name}”吗？吊销后将立即失效。`)) return
  busy.value = true; error.value = ''; notice.value = ''
  try {
    await requestJson(`/api/api-tokens/${item.id}/revoke`, { method: 'POST' })
    if (disposed) return
    secret.value = ''
    notice.value = '令牌已吊销'
    await load()
  } catch (failure) { if (!disposed) error.value = failure.message } finally { busy.value = false }
}
onMounted(() => load().catch((failure) => { if (!disposed) error.value = failure.message }))
onBeforeUnmount(() => { disposed = true; secret.value = '' })
</script>

<template>
  <main class="main-content auth-content">
    <header class="topbar"><div><p class="eyebrow">API TOKENS</p><h1>API 令牌</h1></div></header>
    <section class="content-card">
      <h2>生成令牌</h2>
      <p>令牌用于 AI 工具接入平台，可访问工作区与任务，不能做管理操作。不要分享给他人。</p>
      <form class="filter-form" @submit.prevent="createToken">
        <label>名称<input v-model="form.name" maxlength="64" required :disabled="busy" autocomplete="off" /></label>
        <label>有效期<select v-model="form.expiresInDays" :disabled="busy"><option :value="30">30 天</option><option :value="90">90 天</option><option :value="365">365 天</option></select></label>
        <button class="primary-button" :disabled="busy">{{ busy ? '处理中…' : '生成令牌' }}</button>
      </form>
      <p v-if="error" class="form-error" role="alert">{{ error }}</p>
      <p v-if="notice" class="form-success" role="status">{{ notice }}</p>
    </section>
    <section v-if="secret" class="content-card" role="status" aria-label="新令牌">
      <h2>请立即保存新令牌</h2>
      <p class="form-error">关闭后无法再次查看，请立即保存</p>
      <code class="token-secret">{{ secret }}</code>
      <div class="row-actions"><button class="primary-button" type="button" @click="copyToken">复制</button><button class="secondary-button" type="button" @click="secret = ''">关闭</button></div>
    </section>
    <section class="content-card" id="ai-setup">
      <h2>接入 AI 工具</h2>
      <p>1. 先在上方生成令牌，将下列占位符替换为令牌；请勿分享命令。</p>
      <p>2. 在本机终端执行对应命令：</p>
      <h3>Claude Code</h3>
      <pre class="connection-command">{{ connectionCommand('claude') }}</pre>
      <button v-if="secret" class="secondary-button" @click="copyConnection('claude')">复制 Claude Code 命令（含新令牌）</button>
      <h3>Codex</h3>
      <pre class="connection-command">{{ connectionCommand('codex') }}</pre>
      <button v-if="secret" class="secondary-button" @click="copyConnection('codex')">复制 Codex 命令（含新令牌）</button>
      <p>启动 Codex 的终端环境中也必须设置 RUYI_TOKEN。</p>
      <p>3. <a href="/api/skill/ruyi-audience.zip" download>下载如翼 Skill</a>，将 ZIP 解压到对应目录：</p>
      <pre class="connection-command">Claude Code: ~/.claude/skills/ruyi-audience/SKILL.md
Codex: ~/.codex/skills/ruyi-audience/SKILL.md</pre>
      <p>例如：unzip ruyi-audience.zip -d ~/.claude/skills/（Codex 改为 ~/.codex/skills/）。重新打开客户端后，可要求“把指定目录的文件跑完整个流程，结果放到指定目录”。</p>
      <p>平台登录失效时，请先在网页的“平台登录”页面登录，再继续操作。Skill 只传输文件，不读取人群包内容。</p>
    </section>
    <section class="content-card">
      <h2>我的令牌</h2>
      <div class="table-scroll"><table class="data-table">
        <thead><tr><th>名称</th><th>令牌前缀</th><th>创建时间</th><th>最后使用</th><th>过期时间</th><th>状态</th><th>操作</th></tr></thead>
        <tbody><tr v-for="item in items" :key="item.id">
          <td>{{ item.name }}</td><td>{{ item.displayPrefix }}…</td><td class="nowrap">{{ formatTime(item.createdAt) }}</td><td class="nowrap">{{ formatTime(item.lastUsedAt) }}</td><td class="nowrap">{{ formatTime(item.expiresAt) }}</td>
          <td><span class="result-badge" :class="item.status === 'active' ? 'success' : 'failure'">{{ statusLabels[item.status] }}</span></td>
          <td><button v-if="item.status === 'active'" class="secondary-button" :disabled="busy" @click="revokeToken(item)">吊销</button></td>
        </tr><tr v-if="!items.length"><td colspan="7" class="empty-state">{{ loading ? '正在加载…' : '暂无令牌' }}</td></tr></tbody>
      </table></div>
    </section>
  </main>
</template>

<style scoped>
.connection-command { white-space: pre-wrap; overflow-wrap: anywhere; }
.token-secret { display: block; overflow-wrap: anywhere; padding: 16px 0; }
</style>
