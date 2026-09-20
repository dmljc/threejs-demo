/**
 * ============================================================================
 * Mock：模拟后端 WebSocket 推送告警（演示用）
 * ============================================================================
 */

export const ALERT_TYPE_OPTIONS = ['green', 'warning', 'urgent']
export const ALERT_COLOR_OPTIONS = ['#00B42A', '#D4A017', '#E61E1E']

/**
 * 概览页 4 个厂房告警点（模型本地坐标，与 overview.fbx / README 一致）
 * 场景加载后需经模型 matrix 转到世界坐标
 */
export const OVERVIEW_MARKER_LOCAL = [
  { name: 'X06', position: [66, 20, -91] },
  { name: 'X03', position: [-112, 21, -116] },
  { name: 'X02', position: [-128, 16, 95] },
  { name: 'X12', position: [64, 28, 80] },
]

/** @deprecated 旧立方体布局，保留导出兼容 */
export const DEMO_BUILDINGS = OVERVIEW_MARKER_LOCAL.map((item) => ({
  w: 2.2,
  h: item.position[1],
  d: 1.6,
  x: item.position[0],
  z: item.position[2],
  color: 0x9ca3af,
}))

/** 图一 Demo（概览页）：仅厂房名，背景随告警类型变 */
export const DEMO1_MARKER_SEED = [
  { type: 'green', name: 'X06', position: [...OVERVIEW_MARKER_LOCAL[0].position] },
  { type: 'warning', name: 'X03', position: [...OVERVIEW_MARKER_LOCAL[1].position] },
  { type: 'urgent', name: 'X02', position: [...OVERVIEW_MARKER_LOCAL[2].position] },
  { type: 'green', name: 'X12', position: [...OVERVIEW_MARKER_LOCAL[3].position] },
]

/**
 * X12 厂房页 3 个告警点（模型本地坐标，与 X12.fbx / README 一致）
 * 场景加载后需经模型 matrix 转到世界坐标
 */
export const X12_MARKER_LOCAL = [
  { name: 'F1', position: [12, 16, -14] },
  { name: 'F2', position: [23, 16, -23] },
  { name: 'F3', position: [35, 16, -16] },
]

/** 图二 Demo（X12厂房）：模拟接口 floorAlarmList 数据结构 */
export const DEMO2_MARKER_SEED = [
  { name: 'F1', count: 1, color: '#E61E1E', position: [...X12_MARKER_LOCAL[0].position] },
  { name: 'F2', count: 0, color: '#00B42A', position: [...X12_MARKER_LOCAL[1].position] },
  { name: 'F3', count: 0, color: '#00B42A', position: [...X12_MARKER_LOCAL[2].position] },
]

/** @deprecated 兼容旧引用 */
export const MOCK_MARKER_SEED = DEMO2_MARKER_SEED

/**
 * @param {Array} seed
 * @param {{ updateCount?: boolean }} [options] updateCount=false 时只推告警类型（图一）
 */
export function createMockWsPayload(seed, options = {}) {
  const { updateCount = true } = options
  return {
    type: 'alert_update',
    timestamp: Date.now(),
    data: seed.map((item) => {
      const next = { name: item.name }
      if (item.color != null) {
        next.color =
          ALERT_COLOR_OPTIONS[
            Math.floor(Math.random() * ALERT_COLOR_OPTIONS.length)
          ]
      } else {
        next.type =
          ALERT_TYPE_OPTIONS[
            Math.floor(Math.random() * ALERT_TYPE_OPTIONS.length)
          ]
      }
      if (updateCount) {
        next.count = Math.floor(Math.random() * 50) + 1
      }
      return next
    }),
  }
}

/**
 * 模拟 WebSocket
 * @param {{
 *   seed?: Array,
 *   updateCount?: boolean,
 *   intervalMs?: number,
 *   onMessage?: Function,
 *   onOpen?: Function,
 *   onClose?: Function,
 * }} options
 */
export function createMockAlertWebSocket({
  seed = DEMO2_MARKER_SEED,
  updateCount = true,
  intervalMs = 5000,
  onMessage,
  onOpen,
  onClose,
} = {}) {
  let timer = null
  let closed = false
  let tick = 0

  const socket = {
    readyState: 0,
    send() {},
    close() {
      if (closed) return
      closed = true
      socket.readyState = 3
      if (timer) clearInterval(timer)
      timer = null
      onClose?.({ code: 1000, reason: 'mock closed' })
    },
  }

  setTimeout(() => {
    if (closed) return
    socket.readyState = 1
    onOpen?.()
    onMessage?.(createMockWsPayload(seed, { updateCount }))
    timer = setInterval(() => {
      if (closed) return
      tick += 1
      const payload = createMockWsPayload(seed, { updateCount })
      payload.tick = tick
      console.log('[mock-ws] alert_update', payload)
      onMessage?.(payload)
    }, intervalMs)
  }, 300)

  return socket
}
