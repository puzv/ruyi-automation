<script setup>
import { ref } from 'vue'
import { Layers3 } from 'lucide-vue-next'
import { requestJson } from '../api.js'

const emit = defineEmits(['logged-in'])
const username = ref('')
const password = ref('')
const busy = ref(false)
const error = ref('')
async function login() {
  if (busy.value) return
  busy.value = true
  error.value = ''
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
      <h1>登录工作台</h1>
      <form class="auth-form" @submit.prevent="login">
        <label>用户名<input v-model="username" name="username" autocomplete="username" required :disabled="busy" /></label>
        <label>密码<input v-model="password" name="password" type="password" autocomplete="current-password" required :disabled="busy" /></label>
        <p v-if="error" class="form-error" role="alert">{{ error }}</p>
        <button class="primary-button" type="submit" :disabled="busy">{{ busy ? '登录中…' : '登录' }}</button>
      </form>
    </section>
  </main>
</template>
