/**
 * ============================================================================
 * Mock：模拟后端 WebSocket 推送告警（演示用）
 * ============================================================================
 */

export const ALERT_TYPE_OPTIONS = ['green', 'warning', 'urgent']

/** 四个立方体 / 标注共用的世界坐标（y 为建筑顶面高度） */
const DEMO_LAYOUT = [
  { code: 'X01', x: -2.4, y: 1.0, z: -1.2, h: 1.0, color: 0x9ca3af },
  { code: 'X06', x: 2.4, y: 1.1, z: -1.0, h: 1.1, color: 0x8b919a },
  { code: 'X12', x: -2.2, y: 0.9, z: 1.6, h: 0.9, color: 0xa1a8b3 },
  { code: 'X09', x: 2.2, y: 1.05, z: 1.8, h: 1.05, color: 0x949aa5 },
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
  { id: 'd1-m1', alertType: 'green', code: 'X01', labelMode: 'name', position: [-2.4, 1.0, -1.2] },
  { id: 'd1-m2', alertType: 'warning', code: 'X06', labelMode: 'name', position: [2.4, 1.1, -1.0] },
  { id: 'd1-m3', alertType: 'urgent', code: 'X12', labelMode: 'name', position: [-2.2, 0.9, 1.6] },
  { id: 'd1-m4', alertType: 'green', code: 'X09', labelMode: 'name', position: [2.2, 1.05, 1.8] },
]

/** 图二 Demo：厂房名 + 动态数量 —— 4 个标注 */
export const DEMO2_MARKER_SEED = [
  { id: 'd2-m1', alertType: 'urgent', code: 'X01', count: 1, labelMode: 'nameCount', position: [-2.4, 1.0, -1.2] },
  { id: 'd2-m2', alertType: 'warning', code: 'X06', count: 2, labelMode: 'nameCount', position: [2.4, 1.1, -1.0] },
  { id: 'd2-m3', alertType: 'green', code: 'X12', count: 8, labelMode: 'nameCount', position: [-2.2, 0.9, 1.6] },
  { id: 'd2-m4', alertType: 'warning', code: 'X09', count: 15, labelMode: 'nameCount', position: [2.2, 1.05, 1.8] },
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
        id: item.id,
        code: item.code,
        alertType: ALERT_TYPE_OPTIONS[Math.floor(Math.random() * ALERT_TYPE_OPTIONS.length)],
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
