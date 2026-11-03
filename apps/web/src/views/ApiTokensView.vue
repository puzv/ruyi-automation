<script setup>
import { onBeforeUnmount, onMounted, reactive, ref } from 'vue'
import { requestJson } from '../api.js'
import { formatTime } from '../labels.js'

const origin = window.location.origin
const shellQuote = (value) => "'" + value.replace(/'/g, "'\\''") + "'"
async function copyText(text) {
  if (window.isSecureContext && navigator.clipboard?.writeText) {
    try { await navigator.clipboard.writeText(text); return true } catch {}
  }
  let textarea
  try {
    textarea = document.createElement('textarea')
    textarea.readOnly = true
    textarea.style.position = 'fixed'
    textarea.style.top = '-1000px'
    textarea.value = text
    document.body.appendChild(textarea)
    textarea.select()
    return document.execCommand('copy') === true
  } catch { return false } finally { textarea?.remove() }
}
const textFields = {}
const copyFailure = '浏览器不允许自动复制，请选中下方文字后按 ⌘C / Ctrl+C 复制'
function connectionCommand(client, token = '<令牌>') {
  const url = shellQuote(`${origin}/mcp`)
  return client === 'claude'
    ? `claude mcp remove ruyi --scope user 2>/dev/null; claude mcp add --transport http --scope user ruyi ${url} --header ${shellQuote(`Authorization: Bearer ${token}`)}`
    : `codex mcp remove ruyi 2>/dev/null; mkdir -p ~/.codex && printf '\\n[mcp_servers.ruyi]\\nurl = "%s"\\nhttp_headers = { Authorization = "Bearer %s" }\\n' ${url} ${shellQuote(token)} >> ~/.codex/config.toml && chmod 600 ~/.codex/config.toml`
}
function skillCommand(client) {
  const directory = client === 'claude' ? '.claude' : '.codex'
  return `mkdir -p ~/${directory}/skills && unzip -o ~/Downloads/ruyi-audience.zip -d ~/${directory}/skills/`
}
async function copyField(text, field, message) {
  error.value = ''; notice.value = ''
  const copied = await copyText(text)
  if (disposed) return
  if (copied) notice.value = message
  else {
    error.value = copyFailure
    textFields[field]?.focus()
    textFields[field]?.select()
  }
}
async function copyConnection(client) {
  await copyField(connectionCommand(client, secret.value || '<令牌>'), client, '接入命令已复制，请在本机终端执行并妥善保管令牌')
}
async function copySkill(client) {
  await copyField(skillCommand(client), `${client}Skill`, 'Skill 安装命令已复制，请在本机终端执行')
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
  await copyField(secret.value, 'token', '令牌已复制，请妥善保存')
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
      <textarea :ref="(el) => textFields.token = el" class="token-secret" readonly aria-label="新令牌内容" :value="secret" />
      <div class="row-actions"><button class="primary-button" type="button" @click="copyToken">复制</button><button class="secondary-button" type="button" @click="secret = ''">关闭</button></div>
    </section>
    <section class="content-card ai-setup" id="ai-setup" aria-labelledby="ai-setup-title">
      <header class="setup-heading">
        <div>
          <p class="eyebrow">AI INTEGRATION</p>
          <h2 id="ai-setup-title">接入 AI 工具</h2>
          <p class="setup-description">让 Claude Code 或 Codex 帮你完成上传、创建、分析与下载。</p>
        </div>
        <span class="setup-badge">一次配置，持续使用</span>
      </header>

      <div class="setup-step">
        <div class="step-heading">
          <span class="step-number" aria-hidden="true">01</span>
          <div><h3>连接你的 AI 客户端</h3><p>先在上方生成令牌，再在本机终端执行对应命令。选择你使用的客户端即可。</p></div>
        </div>
        <div class="setup-token-note" :class="{ ready: secret }">
          {{ secret ? '已填入刚生成的令牌，可直接复制命令。请勿分享含令牌的命令。' : '命令中的 <令牌> 需替换为你保存的 API 令牌，请勿分享命令。' }}
        </div>
        <div class="client-grid">
          <article v-for="client in ['claude', 'codex']" :key="client" class="client-card">
            <header class="client-heading">
              <span class="client-mark" :class="client" aria-hidden="true">{{ client === 'claude' ? '✳' : '>_' }}</span>
              <div><h4>{{ client === 'claude' ? 'Claude Code' : 'Codex' }}</h4><span>在本机终端执行</span></div>
            </header>
            <div class="command-box">
              <div class="command-toolbar"><span>接入命令</span><button v-if="secret" class="command-copy" type="button" @click="copyConnection(client)" :aria-label="`复制 ${client === 'claude' ? 'Claude Code' : 'Codex'} 接入命令（含新令牌）`">复制命令</button><span v-else class="command-placeholder">需替换令牌</span></div>
              <textarea :ref="(el) => textFields[client] = el" class="connection-command" readonly spellcheck="false" :aria-label="`${client} 接入命令`" :value="connectionCommand(client, secret || '<令牌>')" />
            </div>
            <p class="verify-command">验证连接 <code>{{ client }} mcp list</code><span>列表中出现 ruyi 即表示接入成功</span></p>
          </article>
        </div>
        <p class="setup-footnote">配置会永久保存在本机；令牌到期或吊销后，生成新令牌并重新执行对应命令即可。</p>
      </div>

      <div class="setup-step">
        <div class="step-heading skill-heading">
          <span class="step-number" aria-hidden="true">02</span>
          <div><h3>安装如翼 Skill</h3><p>下载 ZIP 到本机 Downloads 目录，再执行对应安装命令。</p></div>
          <a class="secondary-button skill-download" href="/api/skill/ruyi-audience.zip" download>下载如翼 Skill <span aria-hidden="true">↓</span></a>
        </div>
        <div class="client-grid">
          <div v-for="client in ['claude', 'codex']" :key="client" class="command-box skill-command">
            <div class="command-toolbar"><span>{{ client === 'claude' ? 'Claude Code' : 'Codex' }} Skill</span><button class="command-copy" type="button" @click="copySkill(client)" :aria-label="`复制 ${client === 'claude' ? 'Claude Code' : 'Codex'} Skill 安装命令`">复制命令</button></div>
            <textarea :ref="(el) => textFields[`${client}Skill`] = el" class="connection-command" readonly spellcheck="false" :aria-label="`${client} Skill 安装命令`" :value="skillCommand(client)" />
          </div>
        </div>
      </div>

      <footer class="setup-finish">
        <span class="finish-mark" aria-hidden="true">✓</span>
        <div><h3>重新打开客户端，开始使用</h3><p class="example-prompt">“把指定目录的文件跑完整个流程，结果放到指定目录。”</p><p>平台登录失效时，请先在网页的“平台登录”页面登录。Skill 只传输文件，不读取人群包内容。</p></div>
      </footer>
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
.ai-setup { padding: 28px; }
.setup-heading { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; padding-bottom: 24px; }
.setup-heading .eyebrow { margin-bottom: 8px; color: #648675; }
.setup-heading h2 { margin: 0; font-size: 19px; }
.setup-description, .step-heading p, .setup-footnote, .setup-finish p { margin: 8px 0 0; color: #71827b; font-size: 12px; line-height: 1.8; }
.setup-badge { flex-shrink: 0; padding: 6px 10px; border: 1px solid #dcebe2; border-radius: 20px; color: #47705d; background: #f1f8f4; font-size: 11px; }
.setup-step { padding: 24px 0; border-top: 1px solid #edf1ef; }
.step-heading { display: flex; align-items: flex-start; gap: 12px; margin-bottom: 16px; }
.step-number { display: grid; place-items: center; flex: 0 0 30px; height: 30px; border: 1px solid #dcebe2; border-radius: 8px; background: #f1f8f4; color: #47705d; font: 12px "DM Mono", monospace; }
.step-heading h3, .setup-finish h3 { margin: 3px 0 0; font-size: 14px; font-weight: 700; }
.step-heading p { margin-top: 5px; }
.setup-token-note { margin: 0 0 16px; padding: 10px 13px; border-left: 3px solid #dcc79a; border-radius: 0 5px 5px 0; background: #fcf9f1; color: #866d3d; font-size: 12px; line-height: 1.7; }
.setup-token-note.ready { border-color: #73b79a; background: #f1f8f4; color: #47705d; }
.client-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; }
.client-card { min-width: 0; padding: 16px; border: 1px solid #e0e7e3; border-radius: 10px; }
.client-heading { display: flex; align-items: center; gap: 10px; margin-bottom: 16px; }
.client-mark { display: grid; place-items: center; width: 36px; height: 36px; border-radius: 9px; font: 700 16px monospace; }
.client-mark.claude { background: #f7ede7; color: #b36c4e; font-size: 26px; }
.client-mark.codex { background: #eaf2ed; color: #36604c; }
.client-heading h4 { margin: 0; font-size: 14px; }
.client-heading div > span { display: block; margin-top: 4px; color: #71827b; font-size: 11px; }
.command-box { min-width: 0; overflow: hidden; border: 1px solid #dfe7e2; border-radius: 7px; background: #f6f8f6; }
.command-toolbar { display: flex; align-items: center; justify-content: space-between; gap: 8px; min-height: 39px; padding: 7px 12px; border-bottom: 1px solid #e5ebe7; color: #61736a; font-size: 11px; }
.command-copy { flex-shrink: 0; padding: 4px 8px; border: 1px solid #d8e3dc; border-radius: 5px; background: #fff; color: #36604c; font-size: 11px; }
.command-copy:hover { border-color: #91b7a1; background: #edf5f0; }
.command-placeholder { color: #8a7957; font-size: 10px; }
.connection-command { display: block; box-sizing: border-box; width: 100%; height: 170px; margin: 0; padding: 14px; border: 0; border-radius: 0; resize: vertical; background: transparent; color: #344d42; font: 11px/1.8 "DM Mono", ui-monospace, SFMono-Regular, Consolas, monospace; white-space: pre-wrap; overflow-wrap: anywhere; }
.ai-setup button:focus-visible, .ai-setup a:focus-visible, .connection-command:focus-visible { outline: 2px solid #73b79a; outline-offset: 2px; }
.connection-command:focus-visible { outline-offset: -2px; }
.verify-command { display: flex; flex-wrap: wrap; align-items: center; gap: 7px; margin: 14px 0 0; color: #71827b; font-size: 11px; line-height: 1.7; }
.verify-command code { color: #3c5e4d; padding: 2px 6px; border-radius: 4px; background: #edf4ef; font-size: 11px; }
.verify-command > span { flex-basis: 100%; }
.setup-footnote { margin-top: 14px; }
.skill-heading > div { flex: 1; }
.skill-download { flex-shrink: 0; gap: 12px; text-decoration: none; }
.skill-command .connection-command { height: 100px; }
.setup-finish { display: flex; align-items: flex-start; gap: 12px; padding: 18px; border: 1px solid #dcebe2; border-radius: 9px; background: #f3f8f5; }
.finish-mark { display: grid; place-items: center; flex: 0 0 24px; height: 24px; border-radius: 50%; background: #dceee2; color: #3d7757; font-size: 13px; }
.setup-finish .example-prompt { color: #3d604d; font-size: 13px; }
.token-secret { display: block; box-sizing: border-box; width: 100%; overflow-wrap: anywhere; padding: 16px 0; }
@media (max-width: 1100px) {
  .client-grid { grid-template-columns: 1fr; }
  .connection-command { height: 120px; }
  .skill-command .connection-command { height: 80px; }
}
@media (max-width: 620px) {
  .ai-setup { padding: 18px 14px; }
  .setup-heading { flex-direction: column; gap: 12px; }
  .setup-step { padding: 20px 0; }
  .skill-heading { flex-wrap: wrap; }
  .skill-heading > div { flex-basis: calc(100% - 42px); }
  .skill-download { margin-left: 42px; }
  .client-card { padding: 12px; }
  .connection-command { height: 180px; }
  .skill-command .connection-command { height: 120px; }
  .setup-finish { padding: 14px; }
}
</style>
