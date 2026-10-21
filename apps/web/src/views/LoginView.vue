<script setup>
import { ref } from 'vue'
import { Layers3 } from 'lucide-vue-next'
import { requestJson } from '../api.js'

const emit = defineEmits(['logged-in'])
const username = ref('')
const registering = ref(false)
const displayName = ref('')
const password = ref('')
const confirmPassword = ref('')
const busy = ref(false)
const error = ref('')
const success = ref('')
function switchMode() {
  if (busy.value) return
  registering.value = !registering.value
  password.value = ''
  confirmPassword.value = ''
  error.value = ''
  success.value = ''
}
async function register() {
  if (busy.value) return
  error.value = ''
  success.value = ''
  if (password.value !== confirmPassword.value) {
    error.value = '两次输入的密码不一致'
    return
  }
  busy.value = true
  try {
    const data = await requestJson('/api/auth/register', { method: 'POST', body: {
      username: username.value, displayName: displayName.value, password: password.value,
    } })
    registering.value = false
    displayName.value = ''
    password.value = ''
    confirmPassword.value = ''
    success.value = data.message
  } catch (failure) { error.value = failure.message } finally { busy.value = false }
}
async function login() {
  if (busy.value) return
  busy.value = true
  error.value = ''
  success.value = ''
  try {
    const data = await requestJson('/api/auth/login', { method: 'POST', body: { username: username.value, password: password.value } })
    password.value = ''
    emit('logged-in', data.user)
  } catch (failure) { error.value = failure.message } finally { busy.value = false }
}
</script>

<template>
  <main class="auth-screen">
    <section class="auth-card">
      <div class="brand auth-brand"><div class="brand-mark"><Layers3 :size="19" /></div><div><div class="brand-name">如翼自动化</div><div class="brand-caption">RUYI WORKBENCH</div></div></div>
      <h1>{{ registering ? '注册账号' : '登录工作台' }}</h1>
      <form class="auth-form" @submit.prevent="registering ? register() : login()">
        <label>用户名<input v-model="username" name="username" autocomplete="username" required :minlength="registering ? 3 : undefined" :maxlength="registering ? 12 : undefined" :pattern="registering ? '[a-z0-9_]{3,12}' : undefined" :disabled="busy" /><span v-if="registering">3–12 位小写字母、数字或下划线</span></label>
        <label v-if="registering">显示名<input v-model="displayName" name="displayName" autocomplete="nickname" required maxlength="64" :disabled="busy" /><span>1–64 位字符</span></label>
        <label>密码<input v-model="password" name="password" type="password" :autocomplete="registering ? 'new-password' : 'current-password'" required :minlength="registering ? 8 : undefined" :disabled="busy" /><span v-if="registering">至少 8 位，最多 72 字节（中文通常每字 3 字节）</span></label>
        <label v-if="registering">确认密码<input v-model="confirmPassword" name="confirmPassword" type="password" autocomplete="new-password" required :disabled="busy" /></label>
        <p v-if="error" class="form-error" role="alert">{{ error }}</p>
        <p v-if="success" class="form-success" role="status">{{ success }}</p>
        <button class="primary-button" type="submit" :disabled="busy">{{ registering ? (busy ? '注册中…' : '注册') : (busy ? '登录中…' : '登录') }}</button>
        <button class="secondary-button" type="button" :disabled="busy" @click="switchMode">{{ registering ? '已有账号？返回登录' : '没有账号？注册账号' }}</button>
      </form>
    </section>
  </main>
</template>
