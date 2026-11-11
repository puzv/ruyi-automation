<script setup>
import { computed, reactive } from 'vue'
import { actionLabels, formatTime, isLoginWaitLog, isPlatformWaitLog, logDescription, logTarget } from '../labels.js'
import { groupWaitRecords, waitRecordRange } from '../wait-records.js'
import { requestJson } from '../api.js'

const props = defineProps({ items: { type: Array, default: () => [] }, admin: Boolean, loading: Boolean, context: String })
const expanded = reactive({})
const raw = reactive({})
const groups = computed(() => props.items.some((item) => item.waitGroup)
  ? props.items.map((record) => ({ id: record.id, record, records: [record] })) : groupWaitRecords(props.items))
const count = (group) => group.record.waitGroup?.count || group.records.length
const range = (group) => group.record.waitGroup || waitRecordRange(group)
const rawKey = (group) => `${props.context || ''}:${group.id}`
const rawState = (group) => raw[rawKey(group)]
async function loadRaw(group, page = 1) {
  const key = rawKey(group)
  if (!raw[key]) raw[key] = { items: [], page: 0, loading: false, error: '' }
  const state = raw[key]
  state.loading = true; state.error = ''
  try {
    const query = new URLSearchParams(props.context)
    query.set('groupId', String(group.id)); query.set('page', String(page)); query.set('pageSize', '20')
    const data = await requestJson(`${props.admin ? '/api/admin/logs' : '/api/logs/mine'}?${query}`)
    state.items = data.items; state.page = data.page; state.total = data.total
  } catch (error) { state.error = error.message } finally { state.loading = false }
}
function toggle(group) {
  const key = rawKey(group)
  expanded[key] = !expanded[key]
  if (expanded[key] && group.record.waitGroup && !raw[key]) loadRaw(group)
}
function resultLabel(item) {
  if (isPlatformWaitLog(item)) return '等待平台处理'
  if (isLoginWaitLog(item)) return '等待登录'
  return item.result === 'success' ? '成功' : '失败'
}
function resultTone(item) {
  if (isPlatformWaitLog(item)) return 'job-status-running'
  if (isLoginWaitLog(item)) return 'job-status-queued'
  return item.result === 'success' ? 'success' : 'failure'
}
</script>

<template>
  <p class="page-description">连续等待检查已合并，按合并后的条目分页；展开可查看全部原始记录。</p>
  <div class="table-scroll">
    <table class="data-table">
      <thead><tr><th>时间</th><th v-if="admin">用户</th><th>操作</th><th>对象</th><th>结果</th><th>说明</th><th>IP</th></tr></thead>
      <tbody>
        <template v-for="group in groups" :key="group.id">
          <tr :title="admin ? group.record.userAgent || '未记录 User-Agent' : undefined">
            <td class="nowrap">{{ formatTime(group.record.createdAt) }}</td>
            <td v-if="admin">{{ group.record.username || '—' }}</td>
            <td>{{ actionLabels[group.record.action] || group.record.action }}</td><td>{{ count(group) > 1 ? `任务 · ${group.record.detail.taskId}` : logTarget(group.record) }}</td>
            <td><span class="result-badge" :class="resultTone(group.record)">{{ resultLabel(group.record) }}</span></td>
            <td class="log-description"><template v-if="count(group) > 1"><strong>连续 {{ count(group) }} 次等待检查</strong><small class="wait-time-range">{{ logDescription(group.record) }}</small><small class="wait-time-range">{{ formatTime(range(group).first) }} — {{ formatTime(range(group).last) }}</small><button class="secondary-button" type="button" :aria-expanded="!!expanded[rawKey(group)]" @click="toggle(group)">{{ expanded[rawKey(group)] ? '收起原始记录' : '展开原始记录' }}</button></template><span v-else>{{ logDescription(group.record) }}</span></td><td>{{ group.record.ip || '—' }}</td>
          </tr>
          <template v-if="count(group) > 1 && expanded[rawKey(group)]"><tr v-for="item in (group.record.waitGroup ? rawState(group)?.items || [] : group.records)" :key="`raw-${item.id}`" class="wait-raw-record"><td>{{ formatTime(item.createdAt) }}</td><td v-if="admin">{{ item.username || '—' }}</td><td>{{ actionLabels[item.action] || item.action }}</td><td>{{ logTarget(item) }}</td><td><span class="result-badge" :class="resultTone(item)">{{ resultLabel(item) }}</span></td><td class="log-description">{{ logDescription(item) }}<small class="wait-time-range">记录 ID：{{ item.id }}</small></td><td>{{ item.ip || '—' }}</td></tr>
            <tr v-if="group.record.waitGroup" class="wait-raw-record"><td :colspan="admin ? 7 : 6"><p v-if="rawState(group)?.error" class="form-error" role="alert">{{ rawState(group).error }} <button type="button" @click="loadRaw(group)">重试</button></p><span v-if="rawState(group)?.loading">正在加载原始记录…</span><div v-else-if="rawState(group)?.page" class="pagination"><button type="button" class="secondary-button" :disabled="rawState(group).page <= 1" @click="loadRaw(group, rawState(group).page - 1)">上一页原始记录</button><span>原始记录第 {{ rawState(group).page }} / {{ Math.max(1, Math.ceil(rawState(group).total / 20)) }} 页，共 {{ rawState(group).total }} 条</span><button type="button" class="secondary-button" :disabled="rawState(group).page * 20 >= rawState(group).total" @click="loadRaw(group, rawState(group).page + 1)">下一页原始记录</button></div></td></tr>
          </template>
        </template>
        <tr v-if="!items.length"><td class="empty-state" :colspan="admin ? 7 : 6">{{ loading ? '正在加载…' : '暂无操作记录' }}</td></tr>
      </tbody>
    </table>
  </div>
</template>

<style scoped>
.wait-time-range { display: block; margin: 4px 0; color: #71827b; font-size: 11px; }
.wait-raw-record { background: #f7faf8; }
</style>
