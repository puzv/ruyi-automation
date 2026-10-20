<script setup>
import { onMounted, reactive, ref } from 'vue'
import { requestJson } from '../api.js'
import { formatTime } from '../labels.js'

defineProps({ currentUser: { type: Object, required: true } })
const users = ref([])
const form = reactive({ username: '', displayName: '', password: '', role: 'user' })
const loading = ref(false)
const busy = ref(false)
const error = ref('')
const notice = ref('')
async function load() {
  loading.value = true
  try { users.value = (await requestJson('/api/admin/users')).users } finally { loading.value = false }
}
async function createUser() {
  if (busy.value) return
  error.value = ''; notice.value = ''
  if (form.password.length < 8) { error.value = '初始密码至少需要 8 位'; return }
  busy.value = true
  try {
    await requestJson('/api/admin/users', { method: 'POST', body: { ...form } })
    Object.assign(form, { username: '', displayName: '', password: '', role: 'user' })
    notice.value = '请把初始密码告知用户，首次登录需修改'
    await load()
  } catch (failure) { error.value = failure.message } finally { busy.value = false }
}
async function updateUser(user, action) {
  if (busy.value) return
  let body
  if (action === 'disable' && !window.confirm(`确定停用用户“${user.username}”吗？`)) return
  if (action === 'reset-password') {
    const password = window.prompt(`请输入用户“${user.username}”的新临时密码（至少 8 位）`)
    if (password === null) return
    if (password.length < 8) { error.value = '临时密码至少需要 8 位'; return }
    if (!window.confirm(`确定重置用户“${user.username}”的密码吗？该用户需要重新登录并修改密码。`)) return
    body = { password }
  }
  busy.value = true; error.value = ''; notice.value = ''
  try {
    await requestJson(`/api/admin/users/${user.id}/${action}`, { method: 'POST', body })
    notice.value = action === 'reset-password' ? '密码已重置，请把临时密码告知用户，首次登录需修改' : '用户状态已更新'
    await load()
  } catch (failure) { error.value = failure.message } finally { busy.value = false }
}
onMounted(() => load().catch((failure) => { error.value = failure.message }))
</script>

<template>
  <main class="main-content auth-content">
    <header class="topbar"><div><p class="eyebrow">ADMIN / USERS</p><h1>用户管理</h1></div></header>
    <section class="content-card">
      <h2>新建用户</h2>
      <form class="filter-form user-create-form" @submit.prevent="createUser">
        <label>用户名<input v-model="form.username" autocomplete="off" maxlength="12" required :disabled="busy" /><small>3–12 位小写字母、数字或下划线</small></label>
        <label>显示名<input v-model="form.displayName" maxlength="64" required :disabled="busy" /></label>
        <label>初始密码<input v-model="form.password" type="password" autocomplete="new-password" minlength="8" required :disabled="busy" /></label>
        <label>角色<select v-model="form.role" :disabled="busy"><option value="user">普通用户</option><option value="admin">管理员</option></select></label>
        <button class="primary-button" :disabled="busy">{{ busy ? '处理中…' : '新建用户' }}</button>
      </form>
      <p v-if="error" class="form-error" role="alert">{{ error }}</p><p v-if="notice" class="form-success" role="status">{{ notice }}</p>
    </section>
    <section class="content-card">
      <h2>用户列表</h2>
      <div class="table-scroll"><table class="data-table">
        <thead><tr><th>用户名</th><th>显示名</th><th>角色</th><th>状态</th><th>上次登录时间</th><th>上次登录 IP</th><th>需改密码</th><th>操作</th></tr></thead>
        <tbody><tr v-for="user in users" :key="user.id">
          <td>{{ user.username }}</td><td>{{ user.displayName }}</td><td>{{ user.role === 'admin' ? '管理员' : '普通用户' }}</td>
          <td><span class="result-badge" :class="user.status === 'active' ? 'success' : 'failure'">{{ user.status === 'active' ? '启用' : '停用' }}</span></td>
          <td class="nowrap">{{ formatTime(user.lastLoginAt) }}</td><td>{{ user.lastLoginIp || '—' }}</td><td>{{ user.mustChangePassword ? '是' : '否' }}</td>
          <td><div class="row-actions"><button v-if="user.status !== 'active'" class="secondary-button" :disabled="busy" @click="updateUser(user, 'enable')">启用</button><button v-else-if="user.id !== currentUser.id" class="secondary-button" :disabled="busy" @click="updateUser(user, 'disable')">停用</button><button class="secondary-button" :disabled="busy" @click="updateUser(user, 'reset-password')">重置密码</button></div></td>
        </tr><tr v-if="!users.length"><td colspan="8" class="empty-state">{{ loading ? '正在加载…' : '暂无用户' }}</td></tr></tbody>
      </table></div>
    </section>
  </main>
</template>
