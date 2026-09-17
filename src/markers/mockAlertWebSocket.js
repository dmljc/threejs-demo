/**
 * ============================================================================
 * Mock：模拟后端 WebSocket 推送告警（演示用）
 * ============================================================================
 */

export const ALERT_TYPE_OPTIONS = ['green', 'warning', 'urgent']

/** 四个立方体 / 标注共用的世界坐标（y 为建筑顶面高度） */
const DEMO_LAYOUT = [
  { name: 'X01', x: -2.4, y: 1.0, z: -1.2, h: 1.0, color: 0x9ca3af },
  { name: 'X06', x: 2.4, y: 1.1, z: -1.0, h: 1.1, color: 0x8b919a },
  { name: 'X12', x: -2.2, y: 0.9, z: 1.6, h: 0.9, color: 0xa1a8b3 },
  { name: 'X09', x: 2.2, y: 1.05, z: 1.8, h: 1.05, color: 0x949aa5 },
]

/** 供场景创建 4 个立方体 */
export const DEMO_BUILDINGS = DEMO_LAYOUT.map((item) => ({
  w: 2.2,
  h: item.h,
  d: 1.6,
  x: item.x,
  z: item.z,
  color: item.color,
}))

/** 图一 Demo：仅厂房名，背景随告警类型变 —— 4 个标注 */
export const DEMO1_MARKER_SEED = [
  { type: 'green', name: 'X01', position: [-2.4, 1.0, -1.2] },
  { type: 'warning', name: 'X06', position: [2.4, 1.1, -1.0] },
  { type: 'urgent', name: 'X12', position: [-2.2, 0.9, 1.6] },
  { type: 'green', name: 'X09', position: [2.2, 1.05, 1.8] },
]

/** 图二 Demo：厂房名 + 动态数量 —— 4 个标注 */
export const DEMO2_MARKER_SEED = [
  { type: 'urgent', name: 'X01', count: 1, position: [-2.4, 1.0, -1.2] },
  { type: 'warning', name: 'X06', count: 2, position: [2.4, 1.1, -1.0] },
  { type: 'green', name: 'X12', count: 8, position: [-2.2, 0.9, 1.6] },
  { type: 'warning', name: 'X09', count: 15, position: [2.2, 1.05, 1.8] },
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
      const next = {
        name: item.name,
        type: ALERT_TYPE_OPTIONS[Math.floor(Math.random() * ALERT_TYPE_OPTIONS.length)],
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
