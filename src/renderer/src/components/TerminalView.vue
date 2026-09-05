<script setup>
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { api } from '@/api'

const props = defineProps({ id: { type: String, required: true }, visible: { type: Boolean, default: true } })
const host = ref(null)
let term
let fit
let observer
let resizeTimer
let resizeFrame
let writeFrame
let pendingData = ''
const WRITE_BUDGET = 64 * 1024
let lastCols = 0
let lastRows = 0
let offData
let offExit
let inputDisposable

function flushWrite() {
  writeFrame = null
  if (!term || !pendingData) return
  const data = pendingData.slice(0, WRITE_BUDGET)
  pendingData = pendingData.slice(data.length)
  term.write(data)
  if (pendingData) writeFrame = requestAnimationFrame(flushWrite)
}

function enqueueWrite(data) {
  if (!data) return
  pendingData += data
  if (!writeFrame) writeFrame = requestAnimationFrame(flushWrite)
}

function resize() {
  resizeFrame = null
  if (!term || !host.value || !props.visible) return
  fit.fit()
  if (term.cols === lastCols && term.rows === lastRows) return
  lastCols = term.cols
  lastRows = term.rows
  api.ptyResize(props.id, term.cols, term.rows)
}

function scheduleResize() {
  clearTimeout(resizeTimer)
  resizeTimer = setTimeout(() => {
    resizeFrame ||= requestAnimationFrame(resize)
  }, 100)
}

watch(() => props.visible, async (visible) => {
  if (!visible) return
  enqueueWrite(await api.ptyBuffer(props.id))
  requestAnimationFrame(resize)
})

onMounted(async () => {
  term = new Terminal({
    cursorBlink: true,
    fontFamily: 'Cascadia Mono, Consolas, monospace',
    fontSize: 14,
    scrollback: 500,
    theme: { background: '#131316', foreground: '#f4f4f5' },
    allowProposedApi: true
  })
  fit = new FitAddon()
  term.loadAddon(fit)
  term.open(host.value)
  offData = api.onPtyData(({ id, data }) => { if (id === props.id && props.visible) enqueueWrite(data) })
  offExit = api.onPtyExit(({ id, exitCode }) => { if (id === props.id) enqueueWrite(`\r\n[进程已退出: ${exitCode}]\r\n`) })
  inputDisposable = term.onData((data) => api.ptyInput(props.id, data))
  const buffered = await api.ptyBuffer(props.id)
  enqueueWrite(buffered)
  observer = new ResizeObserver(scheduleResize)
  observer.observe(host.value)
  resize()
  // 首挂可能早于布局/首帧完成：等两帧后再贴合并强制刷新一次字形，
  // 避免极端时序下"行有结构而无字形"，用户看到空白终端
  requestAnimationFrame(() => requestAnimationFrame(() => {
    if (!term) return
    resize()
    term.refresh(0, term.rows - 1)
  }))
})

onBeforeUnmount(() => {
  observer?.disconnect()
  clearTimeout(resizeTimer)
  if (resizeFrame) cancelAnimationFrame(resizeFrame)
  if (writeFrame) cancelAnimationFrame(writeFrame)
  pendingData = ''
  offData?.()
  offExit?.()
  inputDisposable?.dispose()
  term?.dispose()
})
</script>

<template><div ref="host" class="terminal" /></template>

<style scoped>
.terminal { width: 100%; height: 100%; overflow: hidden; background: #131316; }
</style>
