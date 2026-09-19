/**
 * 自定义标注组件统一出口 —— copy 时优先看这里的导出
 *
 * 必 copy：StatusMarker.js
 * 可选 copy：mockAlertWebSocket.js（仅演示）
 */
export {
  createStatusMarker,
  createMarkerFromItem,
  bindMarkerPointerEvents,
  updateMarkers,
} from './StatusMarker.js'

export {
  ALERT_TYPE_OPTIONS,
  OVERVIEW_MARKER_LOCAL,
  X12_MARKER_LOCAL,
  DEMO_BUILDINGS,
  DEMO1_MARKER_SEED,
  DEMO2_MARKER_SEED,
  MOCK_MARKER_SEED,
  createMockWsPayload,
  createMockAlertWebSocket,
} from './mockAlertWebSocket.js'
