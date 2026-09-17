/**
 * ============================================================================
 * 自定义状态标注组件（本地 Demo / 可整体 copy 到其他 Three.js 项目）
 * ============================================================================
 *
 * 【与 openview.result.js 的关系】
 * - 本文件：标准 Three.js 环境，用 Sprite + CanvasTexture 画标注，Raycaster 点击
 * - openview.result.js：OpenView 低代码环境，DOM-only 叠加层投影（平台常无 window.THREE）
 * - 文案规则、告警色映射、textX 安全区等设计约定两边应对齐
 *
 * 【能力】
 * 1. 按告警类型切换背景图：green → 绿 / warning → 黄 / urgent → 红
 * 2. 文案由是否有 count 自动决定：
 *    - 无 count → 仅厂房名，如 "X01  >"
 *    - 有 count → 厂房名 + 数量，如 "X01-015  >"（数量补零 3 位）
 * 3. 运行时更新数量 / 告警类型
 * 4. Raycaster 点击拾取（透明像素可穿透，避免点到空白矩形）
 * 5. 长文案自动左移，保证「>」不画出横幅实色区；字号固定 16px / 字重 500
 *
 * 【绘制管线】
 *   PNG 背景 → Canvas 叠白字 → CanvasTexture → THREE.Sprite（billboard）
 *
 * 【依赖】 three
 * 【资源】 public/green.png | yellow.png | red.png（当前 284×154）
 *
 * ============================================================================
 * 使用案例
 * ============================================================================
 *
 * ----- 1. 创建单个标注并加入场景 -----
 *
 *   import {
 *     createStatusMarker,
 *     createMarkerFromItem,
 *     bindMarkerPointerEvents,
 *     updateMarkers,
 *   } from './markers/StatusMarker.js'
 *
 *   const marker = createStatusMarker({
 *     type: 'urgent',      // urgent | warning | green
 *     name: 'X12',         // 唯一标识 + 展示文案（批量更新按 name 匹配）
 *     count: 15,           // 有 count → "X12-015 >"；无 count → "X12 >"
 *     position: [0, 1, 0], // 世界坐标，尖角对准该点
 *   })
 *   await marker.ready
 *   scene.add(marker.sprite)
 *
 *   // 运行时更新
 *   marker.updateCount(20)
 *   await marker.updateType('warning')
 *   marker.setPosition(2, 1, -1)
 *
 * ----- 2. 从接口 / mock 条目批量创建 -----
 *
 *   const items = [
 *     { type: 'green', name: 'X01', position: [-2, 1, -1] },
 *     { type: 'urgent', name: 'X12', count: 12, position: [2, 1, 1] },
 *   ]
 *   const markers = []
 *   for (const item of items) {
 *     const m = createMarkerFromItem(item)
 *     await m.ready
 *     scene.add(m.sprite)
 *     markers.push(m)
 *   }
 *
 * ----- 3. 绑定点击（需在组件卸载时 unbind） -----
 *
 *   const { unbind } = bindMarkerPointerEvents({
 *     renderer,
 *     getCamera: () => camera,
 *     getMarkers: () => markers,
 *     onClick: (info) => {
 *       // info: { name, count, type, position, originalEvent }
 *       console.log('点击标注', info.name)
 *     },
 *   })
 *   // onBeforeUnmount: unbind()
 *
 * ----- 4. WebSocket / HTTP 批量更新 -----
 *
 *   // payload 按 name 匹配
 *   await updateMarkers(markers, [
 *     { name: 'X12', type: 'urgent', count: 28 },
 *     { name: 'X01', type: 'warning' },
 *   ])
 *
 * ----- 5. 销毁 -----
 *
 *   markers.forEach((m) => {
 *     scene.remove(m.sprite)
 *     m.dispose()
 *   })
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
 * @param {string} [type]
 * @returns {'normal'|'warning'|'urgent'}
 */
export function resolveType(type) {
  if (type == null || type === '') return 'normal'
  const key = String(type).trim().toLowerCase()
  return ALERT_TYPE_MAP[key] || 'normal'
}

/**
 * 根据告警类型取背景图 URL
 * @param {string} [type]
 * @returns {string}
 */
export function getAlertAsset(type) {
  return ALERT_ASSETS[resolveType(type)]
}

/**
 * 拆分标注文案：主文字 + 箭头（便于控制间距与样式）
 * 有 count → "X01-015"；无 count → "X01"
 * @param {string|null|undefined} name 厂房名称（固定）
 * @param {number|string|null|undefined} count 实时数量；null/undefined/'' 时不展示数量
 * @returns {{ main: string, arrow: string }}
 *
 * @example
 * getMarkerLabelParts('X01', null)  // { main: 'X01', arrow: '>' }
 * getMarkerLabelParts('X01', 15)    // { main: 'X01-015', arrow: '>' }
 */
export function getMarkerLabelParts(name, count) {
  const mainName = name == null ? '' : String(name)
  if (count == null || count === '') {
    return { main: mainName, arrow: '>' }
  }
  // 数量补零到 3 位，与设计稿一致（如 X01-001）
  return { main: `${mainName}-${String(count).padStart(3, '0')}`, arrow: '>' }
}

/**
 * 组装标注文案（主文字与箭头以双空格分隔，仅作调试/兼容）
 * @param {string|null|undefined} name 厂房名称（固定）
 * @param {number|string|null|undefined} count 实时数量
 * @returns {string}
 *
 * @example
 * formatMarkerLabel('X01', null)  // "X01  >"
 * formatMarkerLabel('X01', 15)    // "X01-015  >"
 */
export function formatMarkerLabel(name, count) {
  const { main, arrow } = getMarkerLabelParts(name, count)
  return `${main}  ${arrow}`
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
 * 横幅文字默认起点 X（相对原图像素）
 * 短文案（仅厂房名）用此值；长文案会按宽度自动左移
 */
export const MARKER_TEXT_X = 148
/**
 * 长文案允许的最左起点（相对原图像素）
 * 紧贴圆形右缘外侧，尽量把 > 留在横幅内
 */
export const MARKER_TEXT_X_MIN = 118
/**
 * 文案（含 >）右边缘上限（相对原图像素）
 * 约等于短文案「X06 >」的右边缘，长文案与之对齐
 */
export const MARKER_TEXT_X_MAX_RIGHT = 236
/**
 * 横幅文字起点 Y（相对原图像素）
 * 对齐圆形 / 横幅垂直中线（实测约 y=60~64）
 */
export const MARKER_TEXT_Y = 64
/** 设计稿字号（显示像素），固定 16px，不可缩放 */
export const MARKER_DOM_FONT_SIZE = 16
/**
 * Canvas 源图字号：16px 映射到 284×154 源图
 * 显示高 80 → 16 * 154/80 ≈ 31；绘制时固定，不随文案长短变化
 */
export const MARKER_FONT_SIZE = Math.round(
  MARKER_DOM_FONT_SIZE * (MARKER_IMAGE_HEIGHT / 80),
)
/** 字重：设计稿固定 500 */
export const MARKER_FONT_WEIGHT = 500
/** 字体栈：与设计稿 Source Han Sans SC 一致 */
export const MARKER_FONT_FAMILY =
  'SourceHanSansSC, "Source Han Sans SC", "Noto Sans SC", "PingFang SC", "Microsoft YaHei", "Helvetica Neue", Arial, sans-serif'
/** 主文字与箭头间距（相对原图像素），设计稿约 4~6px */
export const MARKER_ARROW_GAP = 6
/** 文字阴影模糊半径（对应 CSS text-shadow blur） */
export const MARKER_TEXT_SHADOW_BLUR = 4
/** 文字阴影纵向偏移（对应 CSS text-shadow offset-y） */
export const MARKER_TEXT_SHADOW_OFFSET_Y = 2

/**
 * 按文案宽度计算绘制起点 X
 * - 短文案（如 X06）：保持 MARKER_TEXT_X，样式与设计一致
 * - 长文案（如 X12-012）：整体左移，使右边缘落在 MARKER_TEXT_X_MAX_RIGHT 内
 * - 字号不缩小（设计要求固定 16px / 500）
 *
 * @param {CanvasRenderingContext2D} ctx 需已设置好与绘制一致的 font
 * @param {string} main 主文案
 * @param {string} arrow 箭头字符，通常为 '>'
 * @param {number} [scale=1] 与 MARKER_SCALE 一致时传入
 * @returns {number} 绘制起点 X（已乘 scale）
 */
export function resolveMarkerTextX(ctx, main, arrow, scale = 1) {
  const preferred = MARKER_TEXT_X * scale
  const minX = MARKER_TEXT_X_MIN * scale
  const maxRight = MARKER_TEXT_X_MAX_RIGHT * scale
  const gap = MARKER_ARROW_GAP * scale
  const total =
    ctx.measureText(main).width + gap + ctx.measureText(arrow).width
  // 未超出安全右界 → 用默认起点；否则左移，但不越过圆形右缘
  if (preferred + total <= maxRight) return preferred
  return Math.max(minX, maxRight - total)
}

// ===========================================================================
// 3. 创建单个标注 Sprite
// ===========================================================================

/**
 * 创建自定义状态标注
 *
 * 实现方式：Canvas 绘制「背景图 + 文案」→ CanvasTexture → Sprite（始终朝向相机）
 *
 * @param {object} options
 * @param {string} options.type  告警类型：urgent | warning | green
 * @param {string} options.name       厂房名称（固定），如 X01
 * @param {number|string|null} [options.count] 实时数量；有值则展示 name-count，否则仅 name
 * @param {number[]} options.position 世界坐标 [x, y, z]，尖角对准该点
 * @returns {object} 标注实例，含 sprite / ready / updateCount / updateType 等
 */
export function createStatusMarker({
  type,
  name,
  count = null,
  position,
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

  const initialType = resolveType(type)
  // userData 供点击拾取、批量更新读取
  sprite.userData = {
    type: initialType,
    name,
    count,
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

    const { main, arrow } = getMarkerLabelParts(
      sprite.userData.name,
      sprite.userData.count,
    )
    const S = MARKER_SCALE
    // 设计稿固定：font-weight 500 / font-size 16px（源图映射为 MARKER_FONT_SIZE）
    ctx.font = `${MARKER_FONT_WEIGHT} ${MARKER_FONT_SIZE * S}px ${MARKER_FONT_FAMILY}`
    ctx.fillStyle = '#ffffff'
    ctx.textAlign = 'left'
    ctx.textBaseline = 'middle'
    // 设计稿 text-shadow: 0px 2px 4px rgba(0,0,0,0.5)
    ctx.shadowColor = 'rgba(0, 0, 0, 0.5)'
    ctx.shadowBlur = MARKER_TEXT_SHADOW_BLUR * S
    ctx.shadowOffsetX = 0
    ctx.shadowOffsetY = MARKER_TEXT_SHADOW_OFFSET_Y * S

    // 主文案与箭头分两次绘制，便于控制间距；长文案自动左移
    const x = resolveMarkerTextX(ctx, main, arrow, S)
    // +1px：阴影下沉会造成字形视觉偏上，做光学补偿
    const y = MARKER_TEXT_Y * S + S
    ctx.fillText(main, x, y)
    const arrowX = x + ctx.measureText(main).width + MARKER_ARROW_GAP * S
    ctx.fillText(arrow, arrowX, y)

    ctx.shadowBlur = 0
    ctx.shadowOffsetY = 0

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
  const ready = loadBackground(initialType).then(() => sprite)

  return {
    /** Three.js Sprite，加入 scene 即可显示 */
    sprite,
    /** Promise：背景图与首帧绘制完成 */
    ready,
    /** 当前告警类型（内部标准值） */
    get type() {
      return sprite.userData.type
    },
    /** 厂房名称 */
    get name() {
      return sprite.userData.name
    },
    /** 当前数量 */
    get count() {
      return sprite.userData.count
    },
    /**
     * 更新实时数量（厂房 name 不变）
     * @param {number|string} nextCount
     */
    updateCount(nextCount) {
      sprite.userData.count = nextCount
      draw()
    },
    /**
     * 按告警类型切换背景色
     * @param {string} nextType urgent | warning | green
     * @returns {Promise<string>} 规范化后的内部类型
     */
    async updateType(nextType) {
      const normalized = resolveType(nextType)
      // 类型未变且背景已就绪，跳过重复加载
      if (normalized === sprite.userData.type && bgReady) {
        return sprite.userData.type
      }
      sprite.userData.type = normalized
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
 * 字段约定：type / name / count / position（name 唯一；有 count 则带数量文案）
 * @param {object} item
 * @param {string} item.type  urgent | warning | green
 * @param {string} item.name  唯一标识兼展示名
 * @param {number|string} [item.count]
 * @param {number[]} item.position
 */
export function createMarkerFromItem(item) {
  return createStatusMarker({
    type: item.type,
    name: item.name,
    count: item.count ?? null,
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
 *   name: string,
 *   count: number|string|null,
 *   type: string,
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
      name: sprite.userData.name,
      count: sprite.userData.count,
      type: sprite.userData.type,
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
 * 按 name 批量更新已有标注的数量和/或告警类型
 *
 * @param {ReturnType<typeof createStatusMarker>[]} markers 已创建的标注列表
 * @param {Array<{
 *   name: string,
 *   count?: number|string,
 *   type?: string,
 * }>} payload 推送数据（按 name 匹配）
 *
 * @example
 * // WebSocket onmessage
 * updateMarkers(markers, [
 *   { name: 'X12', type: 'urgent', count: 28 },
 * ])
 */
export async function updateMarkers(markers, payload) {
  await Promise.all(
    (payload || []).map(async (item) => {
      const target = markers.find((m) => m.sprite.userData.name === item.name)
      if (!target) return
      if (item.count != null) {
        target.updateCount(item.count)
      }
      if (item.type != null) {
        await target.updateType(item.type)
      }
    }),
  )
}
