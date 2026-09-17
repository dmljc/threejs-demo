/**
 * ============================================================================
 * 自定义状态标注组件（可整体 copy 到其他 Three.js 项目）
 * ============================================================================
 *
 * 【能力】
 * 1. 按告警类型切换背景图：green → 绿 / warning → 黄 / urgent → 红
 * 2. 文案模式：
 *    - name      → 仅厂房名，如 "X01  >"
 *    - nameCount → 厂房名 + 数量，如 "X01-015  >"
 * 3. 支持运行时更新数量 / 告警类型
 * 4. Raycaster 点击拾取（透明像素可穿透）
 *
 * 【依赖】 three
 * 【资源】 public/green.png | yellow.png | red.png（当前 284×154）
 *
 * 【基本用法】
 *   const marker = createStatusMarker({
 *     id: 'm1',
 *     alertType: 'urgent',
 *     code: 'X12',
 *     count: 15,
 *     labelMode: 'nameCount',
 *     position: [0, 1, 0],
 *   })
 *   await marker.ready
 *   scene.add(marker.sprite)
 *   marker.updateCount(20)
 *   await marker.updateAlertType('warning')
 * ============================================================================
 */

import * as THREE from 'three'

// ===========================================================================
// 1. 告警类型 ↔ 背景图
// ===========================================================================

/**
 * 内部标准类型对应的背景图路径
 * - normal  ：绿色（由入参 green 映射而来）
 * - warning ：黄色
 * - urgent  ：红色
 */
export const ALERT_ASSETS = {
  normal: '/green.png',
  warning: '/yellow.png',
  urgent: '/red.png',
}

/**
 * 业务入参 → 内部标准类型
 * 对外只暴露三种：urgent / warning / green
 */
export const ALERT_TYPE_MAP = {
  urgent: 'urgent', // 紧急 → 红
  warning: 'warning', // 注意 → 黄
  green: 'normal', // 正常 → 绿
}

/**
 * 将任意入参规范化为 normal | warning | urgent
 * 未识别时回退为 normal（绿）
 * @param {string} [alertType]
 * @returns {'normal'|'warning'|'urgent'}
 */
export function resolveAlertType(alertType) {
  if (alertType == null || alertType === '') return 'normal'
  const key = String(alertType).trim().toLowerCase()
  return ALERT_TYPE_MAP[key] || 'normal'
}

/**
 * 根据告警类型取背景图 URL
 * @param {string} [alertType]
 * @returns {string}
 */
export function getAlertAsset(alertType) {
  return ALERT_ASSETS[resolveAlertType(alertType)]
}

/**
 * 组装标注文案
 * @param {string|null|undefined} code 厂房编号（固定）
 * @param {number|string|null|undefined} count 实时数量
 * @param {'name'|'nameCount'} [labelMode='nameCount']
 * @returns {string}
 *
 * @example
 * formatMarkerLabel('X01', null, 'name')      // "X01  >"
 * formatMarkerLabel('X01', 15, 'nameCount')   // "X01-015  >"
 */
export function formatMarkerLabel(code, count, labelMode = 'nameCount') {
  const name = code == null ? '' : String(code)
  // 仅厂房名，或没有数量时
  if (labelMode === 'name' || count == null || count === '') {
    return `${name}  >`
  }
  // 数量补零到 3 位，与图二样式一致
  const n = String(count).padStart(3, '0')
  return `${name}-${n}  >`
}

// ===========================================================================
// 2. 标注尺寸 / 锚点（与背景 PNG 对齐，改图时同步调整）
// ===========================================================================

/** 背景图原始宽度（像素） */
export const MARKER_IMAGE_WIDTH = 284
/** 背景图原始高度（像素） */
export const MARKER_IMAGE_HEIGHT = 154
/** Canvas 超采样倍率，越大文字越清晰、性能开销越大 */
export const MARKER_SCALE = 2
/**
 * Sprite 锚点 X（0~1）
 * 约等于圆形中心在整张图中的水平比例，保证尖角对准世界坐标
 */
export const MARKER_ANCHOR_X = 0.22
/** Sprite 锚点 Y：0 表示底部尖角对齐 position */
export const MARKER_ANCHOR_Y = 0
/**
 * 横幅文字起点 X（相对原图像素）
 * 需大于圆形右边缘，避免文字贴住图标
 */
export const MARKER_TEXT_X = 142
/** 横幅文字起点 Y（相对原图像素，约等于横幅垂直中线） */
export const MARKER_TEXT_Y = 64
/** 文字字号（相对原图像素） */
export const MARKER_FONT_SIZE = 26

// ===========================================================================
// 3. 创建单个标注 Sprite
// ===========================================================================

/**
 * 创建自定义状态标注
 *
 * 实现方式：Canvas 绘制「背景图 + 文案」→ CanvasTexture → Sprite（始终朝向相机）
 *
 * @param {object} options
 * @param {string} options.alertType  告警类型：urgent | warning | green
 * @param {string} options.code       厂房编号（固定），如 X01
 * @param {number|string|null} [options.count] 实时数量；labelMode=nameCount 时展示
 * @param {'name'|'nameCount'} [options.labelMode='nameCount'] 文案模式
 * @param {number[]} options.position 世界坐标 [x, y, z]，尖角对准该点
 * @param {string} [options.id]       业务唯一 id，用于批量更新 / 点击回调
 * @returns {object} 标注实例，含 sprite / ready / updateCount / updateAlertType 等
 */
export function createStatusMarker({
  alertType,
  code,
  count = null,
  labelMode = 'nameCount',
  position,
  id = null,
}) {
  // ---- Canvas：离屏绘制标注外观 ----
  const canvas = document.createElement('canvas')
  canvas.width = MARKER_IMAGE_WIDTH * MARKER_SCALE
  canvas.height = MARKER_IMAGE_HEIGHT * MARKER_SCALE
  // willReadFrequently：点击拾取时会频繁 getImageData 做透明度判断
  const ctx = canvas.getContext('2d', { willReadFrequently: true })

  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  texture.needsUpdate = true

  const material = new THREE.SpriteMaterial({
    map: texture,
    transparent: true, // 背景图含透明区域
    depthTest: true,
    depthWrite: false, // 避免透明排序异常
  })

  const sprite = new THREE.Sprite(material)
  // 尖角对准世界坐标，而不是 Sprite 几何中心
  sprite.center.set(MARKER_ANCHOR_X, MARKER_ANCHOR_Y)
  // 保持 PNG 宽高比
  sprite.scale.set(
    1.6,
    (MARKER_IMAGE_HEIGHT / MARKER_IMAGE_WIDTH) * 1.6,
    1,
  )
  sprite.position.set(position[0], position[1], position[2])

  const initialAlert = resolveAlertType(alertType)
  // userData 供点击拾取、批量更新读取
  sprite.userData = {
    id,
    alertType: initialAlert,
    code,
    count,
    labelMode,
    isMarker: true, // 拾取时用于识别标注 Sprite
    canvas, // 透明度命中检测用
  }

  const bgImage = new Image()
  bgImage.crossOrigin = 'anonymous'
  let bgReady = false // 背景图未加载完时禁止绘制

  /** 重绘：背景图 + 文案；数据变更后调用 */
  const draw = () => {
    if (!bgReady) return
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    ctx.drawImage(bgImage, 0, 0, canvas.width, canvas.height)

    const text = formatMarkerLabel(
      sprite.userData.code,
      sprite.userData.count,
      sprite.userData.labelMode,
    )
    ctx.font = `bold ${MARKER_FONT_SIZE * MARKER_SCALE}px "Helvetica Neue", Arial, sans-serif`
    ctx.fillStyle = '#ffffff'
    ctx.textAlign = 'left'
    ctx.textBaseline = 'middle'
    ctx.shadowColor = 'rgba(0, 0, 0, 0.45)'
    ctx.shadowBlur = 4 * MARKER_SCALE
    ctx.shadowOffsetX = 0
    ctx.shadowOffsetY = 1 * MARKER_SCALE
    ctx.fillText(
      text,
      MARKER_TEXT_X * MARKER_SCALE,
      MARKER_TEXT_Y * MARKER_SCALE,
    )

    // 通知 Three.js 纹理已更新
    texture.needsUpdate = true
  }

  /**
   * 加载指定告警类型的背景图并重绘
   * @param {string} type 内部标准类型 normal | warning | urgent
   */
  const loadBackground = (type) =>
    new Promise((resolve, reject) => {
      bgReady = false
      bgImage.onload = () => {
        bgReady = true
        draw()
        resolve()
      }
      bgImage.onerror = reject
      bgImage.src = getAlertAsset(type)
    })

  // 首次加载完成后再加入场景更稳妥：await marker.ready
  const ready = loadBackground(initialAlert).then(() => sprite)

  return {
    /** Three.js Sprite，加入 scene 即可显示 */
    sprite,
    /** Promise：背景图与首帧绘制完成 */
    ready,
    /** 当前告警类型（内部标准值） */
    get alertType() {
      return sprite.userData.alertType
    },
    /** 厂房编号 */
    get code() {
      return sprite.userData.code
    },
    /** 当前数量 */
    get count() {
      return sprite.userData.count
    },
    /** 文案模式 */
    get labelMode() {
      return sprite.userData.labelMode
    },
    /**
     * 更新实时数量（厂房 code 不变）
     * @param {number|string} nextCount
     */
    updateCount(nextCount) {
      sprite.userData.count = nextCount
      draw()
    },
    /**
     * 按告警类型切换背景色
     * @param {string} nextAlertType urgent | warning | green
     * @returns {Promise<string>} 规范化后的内部类型
     */
    async updateAlertType(nextAlertType) {
      const normalized = resolveAlertType(nextAlertType)
      // 类型未变且背景已就绪，跳过重复加载
      if (normalized === sprite.userData.alertType && bgReady) {
        return sprite.userData.alertType
      }
      sprite.userData.alertType = normalized
      await loadBackground(normalized)
      return normalized
    },
    /**
     * 移动标注位置（尖角对准）
     * @param {number} x
     * @param {number} y
     * @param {number} z
     */
    setPosition(x, y, z) {
      sprite.position.set(x, y, z)
    },
    /** 释放 GPU 资源；从场景移除后务必调用 */
    dispose() {
      material.map?.dispose()
      material.dispose()
    },
  }
}

/**
 * 从接口 / mock 数据条目创建标注
 * 字段约定：id / alertType / code / count / labelMode / position
 * @param {object} item
 * @param {string} [item.id]
 * @param {string} item.alertType  urgent | warning | green
 * @param {string} item.code
 * @param {number|string} [item.count]
 * @param {'name'|'nameCount'} [item.labelMode]
 * @param {number[]} item.position
 */
export function createMarkerFromItem(item) {
  return createStatusMarker({
    id: item.id,
    alertType: item.alertType,
    code: item.code,
    count: item.count ?? null,
    labelMode: item.labelMode || 'nameCount',
    position: item.position,
  })
}

// ===========================================================================
// 4. 标注点击交互（Raycaster）
// ===========================================================================

/** 指针移动超过该像素数视为拖拽，不触发点击（避免与 OrbitControls 冲突） */
const CLICK_MOVE_THRESHOLD = 6

/**
 * 为标注绑定点击与悬停手型
 *
 * @param {object} options
 * @param {THREE.WebGLRenderer} options.renderer
 * @param {() => THREE.Camera} options.getCamera 返回当前相机
 * @param {() => Array<{ sprite: THREE.Sprite }>} options.getMarkers 返回标注列表
 * @param {(payload: {
 *   id: string|null,
 *   code: string,
 *   count: number|string|null,
 *   alertType: string,
 *   labelMode: string,
 *   position: THREE.Vector3,
 *   originalEvent: PointerEvent,
 * }) => void} [options.onClick] 点击回调
 * @returns {{ unbind: () => void }} 记得在组件卸载时调用 unbind
 *
 * @example
 * const { unbind } = bindMarkerPointerEvents({
 *   renderer,
 *   getCamera: () => camera,
 *   getMarkers: () => markers,
 *   onClick: (info) => console.log(info),
 * })
 */
export function bindMarkerPointerEvents({
  renderer,
  getCamera,
  getMarkers,
  onClick,
}) {
  const raycaster = new THREE.Raycaster()
  const pointerNdc = new THREE.Vector2()
  const canvasEl = renderer.domElement
  canvasEl.style.touchAction = 'none'

  let pointerDown = null

  /** 屏幕坐标 → NDC（-1 ~ 1），供 Raycaster 使用 */
  const setPointerFromEvent = (event) => {
    const rect = canvasEl.getBoundingClientRect()
    pointerNdc.x = ((event.clientX - rect.left) / rect.width) * 2 - 1
    pointerNdc.y = -((event.clientY - rect.top) / rect.height) * 2 + 1
  }

  /**
   * 判断交点是否落在不透明像素上
   * Sprite 的包围盒是整张矩形，透明区域也要能「点穿」
   */
  const isOpaqueMarkerHit = (hit) => {
    const canvas = hit.object?.userData?.canvas
    const uv = hit.uv
    if (!canvas || !uv) return true
    const x = Math.min(
      canvas.width - 1,
      Math.max(0, Math.floor(uv.x * canvas.width)),
    )
    // Canvas Y 轴向下，UV Y 轴向上，需要翻转
    const y = Math.min(
      canvas.height - 1,
      Math.max(0, Math.floor((1 - uv.y) * canvas.height)),
    )
    const pixel = canvas.getContext('2d').getImageData(x, y, 1, 1).data
    // alpha > 16 视为实体区域
    return pixel[3] > 16
  }

  /** 拾取当前指针下最近的标注 Sprite；未命中返回 null */
  const pickMarker = (event) => {
    const camera = getCamera()
    if (!camera) return null
    setPointerFromEvent(event)
    raycaster.setFromCamera(pointerNdc, camera)
    const sprites = getMarkers().map((m) => m.sprite)
    const hits = raycaster.intersectObjects(sprites, false)
    for (const hit of hits) {
      if (hit.object?.userData?.isMarker && isOpaqueMarkerHit(hit)) {
        return hit.object
      }
    }
    return null
  }

  const onPointerDown = (event) => {
    // 仅响应主按键（鼠标左键）
    if (event.button != null && event.button !== 0) return
    pointerDown = { x: event.clientX, y: event.clientY }
  }

  const onPointerMove = (event) => {
    // 悬停在标注上时显示手型
    canvasEl.style.cursor = pickMarker(event) ? 'pointer' : ''
  }

  const onPointerUp = (event) => {
    if (!pointerDown) return
    const moved = Math.hypot(
      event.clientX - pointerDown.x,
      event.clientY - pointerDown.y,
    )
    pointerDown = null
    // 拖拽旋转场景时不触发点击
    if (moved > CLICK_MOVE_THRESHOLD) return
    const sprite = pickMarker(event)
    if (!sprite) return
    onClick?.({
      id: sprite.userData.id,
      code: sprite.userData.code,
      count: sprite.userData.count,
      alertType: sprite.userData.alertType,
      labelMode: sprite.userData.labelMode,
      position: sprite.position.clone(),
      originalEvent: event,
    })
  }

  const onPointerLeave = () => {
    pointerDown = null
    canvasEl.style.cursor = ''
  }

  canvasEl.addEventListener('pointerdown', onPointerDown)
  canvasEl.addEventListener('pointermove', onPointerMove)
  canvasEl.addEventListener('pointerup', onPointerUp)
  canvasEl.addEventListener('pointerleave', onPointerLeave)

  return {
    /** 移除事件监听，组件销毁时调用 */
    unbind() {
      canvasEl.removeEventListener('pointerdown', onPointerDown)
      canvasEl.removeEventListener('pointermove', onPointerMove)
      canvasEl.removeEventListener('pointerup', onPointerUp)
      canvasEl.removeEventListener('pointerleave', onPointerLeave)
      pointerDown = null
      canvasEl.style.cursor = ''
    },
  }
}

// ===========================================================================
// 5. 批量更新（对接 HTTP / WebSocket 推送）
// ===========================================================================

/**
 * 按 id 批量更新已有标注的数量和/或告警类型
 *
 * @param {ReturnType<typeof createStatusMarker>[]} markers 已创建的标注列表
 * @param {Array<{
 *   id: string,
 *   count?: number|string,
 *   alertType?: string,
 * }>} payload 推送数据；厂房 code 不会被修改
 *
 * @example
 * // WebSocket onmessage
 * updateMarkers(markers, [
 *   { id: 'm1', alertType: 'urgent', count: 28 },
 * ])
 */
export async function updateMarkers(markers, payload) {
  await Promise.all(
    (payload || []).map(async (item) => {
      const target = markers.find((m) => m.sprite.userData.id === item.id)
      if (!target) return
      if (item.count != null) {
        target.updateCount(item.count)
      }
      if (item.alertType != null) {
        await target.updateAlertType(item.alertType)
      }
    }),
  )
}
