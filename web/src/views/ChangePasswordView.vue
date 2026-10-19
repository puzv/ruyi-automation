<script setup>
import { ref } from 'vue'
import { requestJson } from '../api.js'

defineProps({ forced: Boolean })
const emit = defineEmits(['changed', 'logout'])
const currentPassword = ref('')
const newPassword = ref('')
const confirmation = ref('')
const busy = ref(false)
const error = ref('')
async function submit() {
  if (busy.value) return
  error.value = ''
  if (newPassword.value.length < 8) { error.value = '新密码至少需要 8 位'; return }
  if (newPassword.value !== confirmation.value) { error.value = '两次输入的新密码不一致'; return }
  busy.value = true
  try {
    await requestJson('/api/auth/change-password', { method: 'POST', body: { currentPassword: currentPassword.value, newPassword: newPassword.value } })
    currentPassword.value = ''; newPassword.value = ''; confirmation.value = ''
    emit('changed')
  } catch (failure) { error.value = failure.message } finally { busy.value = false }
}
</script>

<template>
  <main :class="forced ? 'auth-screen' : 'main-content auth-content'">
    <section class="auth-card">
      <h1>修改密码</h1>
      <p v-if="forced" class="page-description">首次登录或密码被重置，请先修改密码</p>
      <form class="auth-form" @submit.prevent="submit">
        <label>当前密码<input v-model="currentPassword" name="current-password" type="password" autocomplete="current-password" required :disabled="busy" /></label>
        <label>新密码<input v-model="newPassword" name="new-password" type="password" autocomplete="new-password" minlength="8" required :disabled="busy" /></label>
        <label>确认新密码<input v-model="confirmation" name="confirm-password" type="password" autocomplete="new-password" minlength="8" required :disabled="busy" /></label>
        <p v-if="error" class="form-error" role="alert">{{ error }}</p>
        <button class="primary-button" type="submit" :disabled="busy">{{ busy ? '提交中…' : '修改密码' }}</button>
      </form>
      <button v-if="forced" class="text-button" type="button" :disabled="busy" @click="emit('logout')">退出登录</button>
      <a v-else class="text-button" href="#/">返回工作台</a>
    </section>
  </main>
</template>
