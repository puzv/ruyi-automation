<script setup>
import { CircleUserRound, Layers3, ListChecks, UsersRound } from 'lucide-vue-next'
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { apiFetch } from '../api.js'
import { formatTime } from '../labels.js'

const props = defineProps({ currentUser: { type: Object, required: true }, page: { type: String, default: '/' } })
defineEmits(['logout'])
const platformState = ref({ status: 'none', expiresHintAt: null })
const platformStateError = ref('')
let disposed = false
let requestVersion = 0
async function refreshPlatformState() {
  const version = ++requestVersion
  try {
    const response = await apiFetch('/api/platform-state')
    const data = await response.json()
    if (disposed || version !== requestVersion) return
    if (!response.ok || data.ok === false) throw new Error(data.message || '无法获取平台登录状态')
    platformState.value = data
    platformStateError.value = ''
  } catch (cause) {
    if (!disposed && version === requestVersion) platformStateError.value = cause.message || '无法获取平台登录状态'
  }
}
defineExpose({ refreshPlatformState })
watch(() => props.page, refreshPlatformState)
onMounted(refreshPlatformState)
onBeforeUnmount(() => { disposed = true; requestVersion++ })
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
        <a class="side-link" :class="{ active: page === '/' || page === '/jobs' }" href="#/jobs"><ListChecks :size="17" /> 我的任务</a>
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

    <slot />
  </div>
</template>
