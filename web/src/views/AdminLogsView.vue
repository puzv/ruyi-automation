<script setup>
import { computed, onMounted, reactive, ref } from 'vue'
import { requestJson } from '../api.js'
import { actionLabels } from '../labels.js'
import LogTable from '../components/LogTable.vue'

const filters = reactive({ username: '', action: '', result: '', from: '', to: '' })
let appliedFilters = { ...filters }
const items = ref([])
const page = ref(1)
const total = ref(0)
const loading = ref(false)
const error = ref('')
const pages = computed(() => Math.max(1, Math.ceil(total.value / 20)))
async function load(nextPage = 1, search = false) {
  if (loading.value) return
  error.value = ''
  const selected = search ? { ...filters } : appliedFilters
  if (selected.from && selected.to && selected.from > selected.to) { error.value = '开始日期不能晚于结束日期'; return }
  loading.value = true
  try {
    const query = new URLSearchParams({ page: String(nextPage), pageSize: '20' })
    for (const [key, value] of Object.entries(selected)) if (value) query.set(key, value)
    const data = await requestJson(`/api/admin/logs?${query}`)
    items.value = data.items; total.value = data.total; page.value = data.page
    appliedFilters = selected
  } catch (failure) { error.value = failure.message } finally { loading.value = false }
}
onMounted(() => load())
</script>

<template>
  <main class="main-content auth-content">
    <header class="topbar"><div><p class="eyebrow">ADMIN / OPERATION LOGS</p><h1>全部操作记录</h1></div></header>
    <section class="content-card">
      <form class="filter-form" @submit.prevent="load(1, true)">
        <label>用户名<input v-model="filters.username" :disabled="loading" /></label>
        <label>操作类型<select v-model="filters.action" :disabled="loading"><option value="">全部操作</option><option v-for="(label, value) in actionLabels" :key="value" :value="value">{{ label }}</option></select></label>
        <label>结果<select v-model="filters.result" :disabled="loading"><option value="">全部</option><option value="success">成功</option><option value="failure">失败</option></select></label>
        <label>开始日期<input v-model="filters.from" type="date" :disabled="loading" /></label><label>结束日期<input v-model="filters.to" type="date" :disabled="loading" /></label>
        <button class="primary-button" :disabled="loading">查询</button>
      </form>
      <p v-if="error" class="form-error" role="alert">{{ error }}</p>
      <LogTable :items="items" admin :loading="loading" />
      <div class="pagination"><button class="secondary-button" :disabled="loading || page <= 1" @click="load(page - 1)">上一页</button><span>第 {{ page }} / {{ pages }} 页，共 {{ total }} 条</span><button class="secondary-button" :disabled="loading || page >= pages" @click="load(page + 1)">下一页</button></div>
    </section>
  </main>
</template>
