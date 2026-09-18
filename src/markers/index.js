/**
 * 自定义标注组件统一出口 —— copy 时优先看这里的导出
 *
 * 必 copy：StatusMarker.js
 * 可选 copy：mockAlertWebSocket.js（仅演示）
 */
export {
  MARKER_MASK_URL,
  ALERT_COLORS,
  ALERT_TYPE_MAP,
  resolveType,
  getAlertColor,
  getMarkerLabelParts,
  formatMarkerLabel,
  resolveMarkerTextX,
  MARKER_IMAGE_WIDTH,
  MARKER_IMAGE_HEIGHT,
  MARKER_SCALE,
  MARKER_ANCHOR_X,
  MARKER_ANCHOR_Y,
  MARKER_TEXT_X,
  MARKER_TEXT_X_MIN,
  MARKER_TEXT_X_MAX_RIGHT,
  MARKER_TEXT_Y,
  MARKER_DOM_FONT_SIZE,
  MARKER_FONT_SIZE,
  MARKER_FONT_WEIGHT,
  MARKER_FONT_FAMILY,
  MARKER_ARROW_GAP,
  createStatusMarker,
  createMarkerFromItem,
  bindMarkerPointerEvents,
  updateMarkers,
} from './StatusMarker.js'

export {
  ALERT_TYPE_OPTIONS,
  DEMO_BUILDINGS,
  DEMO1_MARKER_SEED,
  DEMO2_MARKER_SEED,
  MOCK_MARKER_SEED,
  createMockWsPayload,
  createMockAlertWebSocket,
} from './mockAlertWebSocket.js'
