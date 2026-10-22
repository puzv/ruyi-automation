<script setup>
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { apiFetch } from './api.js'
import { resetResultDownloads } from './result-download.js'
import WorkbenchView from './views/WorkbenchView.vue'
import PlatformLoginView from './views/PlatformLoginView.vue'
import LoginView from './views/LoginView.vue'
import ChangePasswordView from './views/ChangePasswordView.vue'
import MyLogsView from './views/MyLogsView.vue'
import AdminUsersView from './views/AdminUsersView.vue'
import AdminLogsView from './views/AdminLogsView.vue'
import MyJobsView from './views/MyJobsView.vue'
import AdminJobsView from './views/AdminJobsView.vue'

const currentUser = ref(null)
const workbench = ref(null)
const loading = ref(true)
const error = ref('')
const page = ref('/')
const loggingOut = ref(false)
const routes = ['/', '/platform-login', '/logs', '/jobs', '/admin/users', '/admin/logs', '/admin/jobs', '/password']

function syncPage() {
  let next = location.hash.slice(1) || '/'
  if (!routes.includes(next) || (next.startsWith('/admin/') && currentUser.value?.role !== 'admin')) next = '/'
  if (currentUser.value?.mustChangePassword) next = '/password'
  page.value = next
  if (location.hash !== `#${next}`) location.hash = `#${next}`
}
function loggedOut() {
  resetResultDownloads()
  currentUser.value = null
  error.value = ''
}
function requirePasswordChange() {
  if (currentUser.value) {
    currentUser.value = { ...currentUser.value, mustChangePassword: true }
    syncPage()
  }
}
function loggedIn(user) {
  resetResultDownloads()
  currentUser.value = user
  location.hash = user.mustChangePassword ? '#/password' : '#/'
  syncPage()
}
async function loadUser() {
  loading.value = true
  error.value = ''
  try {
    const response = await apiFetch('/api/auth/me')
    const data = await response.json()
    if (response.status === 401) currentUser.value = null
    else if (!response.ok || !data.ok) throw new Error(data.message || '无法获取当前用户')
    else currentUser.value = data.user
    syncPage()
  } catch (cause) {
    error.value = cause.message || '无法连接服务，请稍后重试'
  } finally {
    loading.value = false
  }
}
async function passwordChanged() {
  await loadUser()
  if (currentUser.value && !error.value) {
    location.hash = '#/'
    syncPage()
  }
}
async function logout() {
  if (loggingOut.value) return
  loggingOut.value = true
  error.value = ''
  try {
    const response = await apiFetch('/api/auth/logout', { method: 'POST' })
    const data = await response.json()
    if (!response.ok && response.status !== 401) throw new Error(data.message || '退出登录失败')
    loggedOut()
    location.hash = '#/'
  } catch (cause) {
    error.value = cause.message || '退出登录失败，请重试'
  } finally {
    loggingOut.value = false
  }
}
onMounted(() => {
  window.addEventListener('hashchange', syncPage)
  window.addEventListener('auth:unauthenticated', loggedOut)
  window.addEventListener('auth:password-change-required', requirePasswordChange)
  loadUser()
})
onBeforeUnmount(() => {
  window.removeEventListener('hashchange', syncPage)
  window.removeEventListener('auth:unauthenticated', loggedOut)
  window.removeEventListener('auth:password-change-required', requirePasswordChange)
})
</script>

<template>
  <div v-if="loading" class="auth-screen" role="status">正在加载…</div>
  <template v-else>
    <div v-if="error" class="global-error" role="alert">{{ error }} <button type="button" @click="loadUser">重试</button></div>
    <LoginView v-if="!currentUser && !error" @logged-in="loggedIn" />
    <ChangePasswordView v-else-if="currentUser?.mustChangePassword" forced @changed="passwordChanged" @logout="logout" />
    <WorkbenchView v-else-if="currentUser" ref="workbench" :current-user="currentUser" :page="page" @logout="logout">
      <template v-if="page !== '/'" #default>
        <PlatformLoginView v-if="page === '/platform-login'" :current-user="currentUser" @state-changed="workbench?.refreshPlatformState()" />
        <MyLogsView v-else-if="page === '/logs'" />
        <MyJobsView v-else-if="page === '/jobs'" />
        <AdminUsersView v-else-if="page === '/admin/users'" :current-user="currentUser" />
        <AdminLogsView v-else-if="page === '/admin/logs'" />
        <AdminJobsView v-else-if="page === '/admin/jobs'" />
        <ChangePasswordView v-else-if="page === '/password'" @changed="passwordChanged" @logout="logout" />
      </template>
    </WorkbenchView>
  </template>
</template>
