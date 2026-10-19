<script setup>
import { computed, onMounted, ref } from 'vue'
import { requestJson } from '../api.js'
import { actionLabels } from '../labels.js'
import LogTable from '../components/LogTable.vue'

const action = ref('')
let appliedAction = ''
const items = ref([])
const page = ref(1)
const total = ref(0)
const loading = ref(false)
const error = ref('')
const pages = computed(() => Math.max(1, Math.ceil(total.value / 20)))
async function load(nextPage = 1, search = false) {
  if (loading.value) return
  loading.value = true
  error.value = ''
  const selectedAction = search ? action.value : appliedAction
  try {
    const query = new URLSearchParams({ page: String(nextPage), pageSize: '20' })
    if (selectedAction) query.set('action', selectedAction)
    const data = await requestJson(`/api/logs/mine?${query}`)
    items.value = data.items; total.value = data.total; page.value = data.page
    appliedAction = selectedAction
  } catch (failure) { error.value = failure.message } finally { loading.value = false }
}
onMounted(() => load())
</script>

<template>
  <main class="main-content auth-content">
    <header class="topbar"><div><p class="eyebrow">OPERATION LOGS</p><h1>我的操作记录</h1></div></header>
    <section class="content-card">
      <form class="filter-form" @submit.prevent="load(1, true)"><label>操作类型<select v-model="action" :disabled="loading"><option value="">全部操作</option><option v-for="(label, value) in actionLabels" :key="value" :value="value">{{ label }}</option></select></label><button class="primary-button" :disabled="loading">查询</button></form>
      <p v-if="error" class="form-error" role="alert">{{ error }}</p>
      <LogTable :items="items" :loading="loading" />
      <div class="pagination"><button class="secondary-button" :disabled="loading || page <= 1" @click="load(page - 1)">上一页</button><span>第 {{ page }} / {{ pages }} 页，共 {{ total }} 条</span><button class="secondary-button" :disabled="loading || page >= pages" @click="load(page + 1)">下一页</button></div>
    </section>
  </main>
</template>
