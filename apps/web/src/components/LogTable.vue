<script setup>
import { actionLabels, formatTime, logDescription, logTarget } from '../labels.js'

defineProps({ items: { type: Array, default: () => [] }, admin: Boolean, loading: Boolean })
</script>

<template>
  <div class="table-scroll">
    <table class="data-table">
      <thead><tr><th>时间</th><th v-if="admin">用户</th><th>操作</th><th>对象</th><th>结果</th><th>说明</th><th>IP</th></tr></thead>
      <tbody>
        <tr v-for="item in items" :key="item.id" :title="admin ? item.userAgent || '未记录 User-Agent' : undefined">
          <td class="nowrap">{{ formatTime(item.createdAt) }}</td>
          <td v-if="admin">{{ item.username || '—' }}</td>
          <td>{{ actionLabels[item.action] || item.action }}</td><td>{{ logTarget(item) }}</td>
          <td><span class="result-badge" :class="item.result === 'success' ? 'success' : 'failure'">{{ item.result === 'success' ? '成功' : '失败' }}</span></td>
          <td class="log-description">{{ logDescription(item) }}</td><td>{{ item.ip || '—' }}</td>
        </tr>
        <tr v-if="!items.length"><td class="empty-state" :colspan="admin ? 7 : 6">{{ loading ? '正在加载…' : '暂无操作记录' }}</td></tr>
      </tbody>
    </table>
  </div>
</template>
