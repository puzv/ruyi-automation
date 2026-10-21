<script setup>
import JobsTable from '../components/JobsTable.vue'
</script>

<template>
  <main class="main-content auth-content">
    <header class="topbar"><div><p class="eyebrow">ADMIN / JOBS</p><h1>全部任务</h1></div></header>
    <section class="content-card"><JobsTable admin /></section>
  </main>
</template>
