<script setup>
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import RFB from '@novnc/novnc'

const props = defineProps({ sessionId: { type: String, required: true } })
const screen = ref(null)
const status = ref('连接中')
let rfb

function disconnect() {
  const previous = rfb
  rfb = null
  previous?.disconnect()
}

function connect() {
  disconnect()
  status.value = '连接中'
  if (!screen.value || !props.sessionId) { status.value = '已断开'; return }
  try {
    const protocol = location.protocol === 'https:' ? 'wss' : 'ws'
    const client = new RFB(screen.value, `${protocol}://${location.host}/api/platform-login/${encodeURIComponent(props.sessionId)}/vnc`, { wsProtocols: ['binary'] })
    rfb = client
    client.scaleViewport = true
    client.resizeSession = false
    client.background = '#15211f'
    client.addEventListener('connect', () => { if (rfb === client) status.value = '已连接' })
    client.addEventListener('disconnect', () => { if (rfb === client) status.value = '已断开' })
  } catch (_) {
    disconnect()
    status.value = '已断开'
  }
}

onMounted(connect)
watch(() => props.sessionId, connect)
onBeforeUnmount(disconnect)
</script>

<template>
  <div class="remote-desktop">
    <div class="remote-desktop-status" role="status" aria-live="polite">
      {{ status }}
      <button v-if="status === '已断开'" type="button" @click="connect">重连</button>
    </div>
    <div ref="screen" class="remote-desktop-screen" aria-label="平台登录远程桌面"></div>
  </div>
</template>

<style scoped>
.remote-desktop-status { display: flex; align-items: center; gap: 12px; margin-bottom: 8px; }
.remote-desktop-screen { width: 100%; aspect-ratio: 1280 / 800; overflow: hidden; background: #15211f; }
</style>
