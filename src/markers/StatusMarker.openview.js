/**
 * ============================================================================
 * OpenView 平台专用 · 自定义状态标注（整文件复制粘贴即可用）
 * ============================================================================
 *
 * 【平台环境】（来自 window）
 *   - window.THREE          Three.js 命名空间（平台已注入）
 *   - window.coreMgr        核心管理器
 *   - window.coreMgr.sceneMgr  场景管理器（ready / sceneList / sceneNode）
 *   - window.webglPlayer    播放器（部分版本可从此取 renderer / sceneMgr）
 *
 * 【能力】
 *   1. 告警类型切背景：green 绿 / warning 黄 / urgent 红
 *   2. 文案：name → "X01  >" ；nameCount → "X01-015  >"
 *   3. 更新数量 / 告警类型
 *   4. 点击拾取（透明像素穿透）
 *
 * 【使用前准备】
 *   1. 把 green.png / yellow.png / red.png 上传到 OpenView 资源库
 *   2. 修改下方 ALERT_ASSETS 为平台可访问的图片 URL
 *   3. 等场景 ready 后调用 StatusMarkerOV.mount(...)
 *
 * 【快速开始】
 *   await StatusMarkerOV.whenReady()
 *   const api = await StatusMarkerOV.mount({
 *     items: [
 *       { id: 'm1', alertType: 'green', code: 'X01', labelMode: 'name', position: [0, 5, 0] },
 *       { id: 'm2', alertType: 'urgent', code: 'X12', count: 15, labelMode: 'nameCount', position: [10, 5, 0] },
 *     ],
 *     onClick: (info) => console.log('[标注点击]', info),
 *   })
 *   // 推送更新
 *   api.updateMarkers([{ id: 'm2', alertType: 'warning', count: 28 }])
 *   // 销毁
 *   api.destroy()
 * ============================================================================
 */
;(function (global) {
  'use strict'

  // =========================================================================
  // 0. 依赖检查：OpenView 注入的 THREE
  // =========================================================================

  const THREE = global.THREE
  if (!THREE) {
    console.error(
      '[StatusMarkerOV] 未找到 window.THREE，请确认在 OpenView 三维场景脚本环境中运行',
    )
    return
  }

  // =========================================================================
  // 1. 告警类型 ↔ 背景图（请改成你在 OpenView 上传后的真实 URL）
  // =========================================================================

  /**
   * 背景图路径 —— 必须改成平台可访问地址
   * 示例：资源库相对路径、CDN 完整 URL、或 /assets/xxx.png
   */
  const ALERT_ASSETS = {
    normal: '/green.png', // TODO: 替换为 OpenView 绿色标注图 URL
    warning: '/yellow.png', // TODO: 替换为 OpenView 黄色标注图 URL
    urgent: '/red.png', // TODO: 替换为 OpenView 红色标注图 URL
  }

  /** 业务入参 → 内部标准类型（仅三种） */
  const ALERT_TYPE_MAP = {
    urgent: 'urgent',
    warning: 'warning',
    green: 'normal',
  }

  function resolveAlertType(alertType) {
    if (alertType == null || alertType === '') return 'normal'
    const key = String(alertType).trim().toLowerCase()
    return ALERT_TYPE_MAP[key] || 'normal'
  }

  function getAlertAsset(alertType) {
    return ALERT_ASSETS[resolveAlertType(alertType)]
  }

  /**
   * 组装文案
   * name → "X01  >"
   * nameCount → "X01-015  >"
   */
  function formatMarkerLabel(code, count, labelMode) {
    const name = code == null ? '' : String(code)
    if (labelMode === 'name' || count == null || count === '') {
      return name + '  >'
    }
    const n = String(count).padStart(3, '0')
    return name + '-' + n + '  >'
  }

  // =========================================================================
  // 2. 标注尺寸 / 锚点（与 PNG 284×154 对齐）
  // =========================================================================

  const MARKER_IMAGE_WIDTH = 284
  const MARKER_IMAGE_HEIGHT = 154
  const MARKER_SCALE = 2
  const MARKER_ANCHOR_X = 0.22
  const MARKER_ANCHOR_Y = 0
  const MARKER_TEXT_X = 142
  const MARKER_TEXT_Y = 64
  const MARKER_FONT_SIZE = 26
  /** 世界空间显示宽度，可按场景比例调整 */
  const MARKER_WORLD_WIDTH = 1.6

  // =========================================================================
  // 3. OpenView 上下文：从 window.coreMgr / webglPlayer 取 scene / camera / renderer
  // =========================================================================

  /**
   * 从候选对象上按路径取值
   * @param {object} obj
   * @param {string[]} paths 如 ['scene', 'threeScene']
   */
  function pickProp(obj, paths) {
    if (!obj) return null
    for (let i = 0; i < paths.length; i++) {
      const key = paths[i]
      if (obj[key] != null) return obj[key]
    }
    return null
  }

  /**
   * 解析 OpenView 运行时上下文
   * 不同版本字段名可能略有差异，这里做多层兜底
   */
  function getOpenViewContext() {
    const coreMgr = global.coreMgr || null
    const sceneMgr =
      (coreMgr && coreMgr.sceneMgr) ||
      (global.webglPlayer && global.webglPlayer.sceneMgr) ||
      null

    const sceneNodeList =
      (sceneMgr && (sceneMgr.sceneNode || sceneMgr.sceneList)) || []
    const activeNode =
      (Array.isArray(sceneNodeList) && sceneNodeList[0]) ||
      sceneMgr ||
      null

    // 场景 / 相机 / 渲染器：按常见字段名探测
    const scene =
      pickProp(activeNode, ['scene', 'threeScene', 'rootScene', 'Scene']) ||
      pickProp(sceneMgr, ['scene', 'threeScene']) ||
      pickProp(global.webglPlayer, ['scene', 'threeScene'])

    const camera =
      pickProp(activeNode, ['camera', 'Camera', 'mainCamera']) ||
      pickProp(sceneMgr, ['camera', 'mainCamera']) ||
      pickProp(global.webglPlayer, ['camera', 'mainCamera'])

    const renderer =
      pickProp(activeNode, ['renderer', 'webglRenderer', 'Renderer']) ||
      pickProp(sceneMgr, ['renderer', 'webglRenderer']) ||
      pickProp(global.webglPlayer, ['renderer', 'webglRenderer'])

    // 渲染用 canvas：用于绑定点击
    let domElement = renderer && renderer.domElement
    if (!domElement && global.webglPlayer && global.webglPlayer.canvas) {
      domElement = global.webglPlayer.canvas
    }

    return {
      coreMgr: coreMgr,
      sceneMgr: sceneMgr,
      sceneNode: activeNode,
      scene: scene,
      camera: camera,
      renderer: renderer,
      domElement: domElement,
      projectId: coreMgr && coreMgr.projectId,
      isDesign: !!(coreMgr && coreMgr.isDesign),
      ready: !!(sceneMgr && sceneMgr.ready),
    }
  }

  /**
   * 等待 sceneMgr.ready === true（或超时）
   * @param {number} [timeoutMs=30000]
   */
  function whenReady(timeoutMs) {
    timeoutMs = timeoutMs == null ? 30000 : timeoutMs
    return new Promise(function (resolve, reject) {
      const start = Date.now()
      function tick() {
        const ctx = getOpenViewContext()
        if (ctx.sceneMgr && ctx.sceneMgr.ready && ctx.scene && ctx.camera) {
          resolve(ctx)
          return
        }
        if (Date.now() - start > timeoutMs) {
          reject(
            new Error(
              '[StatusMarkerOV] 等待 OpenView 场景就绪超时。请确认 window.coreMgr.sceneMgr.ready === true，并检查 scene/camera 字段名是否匹配',
            ),
          )
          return
        }
        setTimeout(tick, 200)
      }
      tick()
    })
  }

  /**
   * 兼容不同 Three 版本的颜色空间设置
   * r152+ 用 colorSpace；旧版用 encoding
   */
  function applyTextureColorSpace(texture) {
    if (!texture) return
    if ('colorSpace' in texture && THREE.SRGBColorSpace != null) {
      texture.colorSpace = THREE.SRGBColorSpace
    } else if ('encoding' in texture && THREE.sRGBEncoding != null) {
      texture.encoding = THREE.sRGBEncoding
    }
  }

  // =========================================================================
  // 4. 创建单个标注 Sprite
  // =========================================================================

  /**
   * @param {object} options
   * @param {string} options.alertType  urgent | warning | green
   * @param {string} options.code
   * @param {number|string|null} [options.count]
   * @param {'name'|'nameCount'} [options.labelMode='nameCount']
   * @param {number[]} options.position  [x,y,z]
   * @param {string} [options.id]
   * @param {number} [options.worldWidth] 世界空间宽度，默认 MARKER_WORLD_WIDTH
   */
  function createStatusMarker(options) {
    const alertType = options.alertType
    const code = options.code
    const count = options.count != null ? options.count : null
    const labelMode = options.labelMode || 'nameCount'
    const position = options.position
    const id = options.id != null ? options.id : null
    const worldWidth =
      options.worldWidth != null ? options.worldWidth : MARKER_WORLD_WIDTH

    const canvas = document.createElement('canvas')
    canvas.width = MARKER_IMAGE_WIDTH * MARKER_SCALE
    canvas.height = MARKER_IMAGE_HEIGHT * MARKER_SCALE
    const ctx = canvas.getContext('2d', { willReadFrequently: true })

    const texture = new THREE.CanvasTexture(canvas)
    applyTextureColorSpace(texture)
    texture.needsUpdate = true

    const material = new THREE.SpriteMaterial({
      map: texture,
      transparent: true,
      depthTest: true,
      depthWrite: false,
    })

    const sprite = new THREE.Sprite(material)
    sprite.center.set(MARKER_ANCHOR_X, MARKER_ANCHOR_Y)
    sprite.scale.set(
      worldWidth,
      (MARKER_IMAGE_HEIGHT / MARKER_IMAGE_WIDTH) * worldWidth,
      1,
    )
    sprite.position.set(position[0], position[1], position[2])

    const initialAlert = resolveAlertType(alertType)
    sprite.userData = {
      id: id,
      alertType: initialAlert,
      code: code,
      count: count,
      labelMode: labelMode,
      isMarker: true,
      canvas: canvas,
    }

    const bgImage = new Image()
    bgImage.crossOrigin = 'anonymous'
    let bgReady = false

    function draw() {
      if (!bgReady) return
      ctx.clearRect(0, 0, canvas.width, canvas.height)
      ctx.drawImage(bgImage, 0, 0, canvas.width, canvas.height)

      const text = formatMarkerLabel(
        sprite.userData.code,
        sprite.userData.count,
        sprite.userData.labelMode,
      )
      ctx.font =
        'bold ' +
        MARKER_FONT_SIZE * MARKER_SCALE +
        'px "Helvetica Neue", Arial, sans-serif'
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
      texture.needsUpdate = true
    }

    function loadBackground(type) {
      return new Promise(function (resolve, reject) {
        bgReady = false
        bgImage.onload = function () {
          bgReady = true
          draw()
          resolve()
        }
        bgImage.onerror = function (err) {
          console.error(
            '[StatusMarkerOV] 背景图加载失败:',
            getAlertAsset(type),
            '请检查 ALERT_ASSETS 是否已改为 OpenView 可访问 URL',
          )
          reject(err)
        }
        bgImage.src = getAlertAsset(type)
      })
    }

    const ready = loadBackground(initialAlert).then(function () {
      return sprite
    })

    return {
      sprite: sprite,
      ready: ready,
      get alertType() {
        return sprite.userData.alertType
      },
      get code() {
        return sprite.userData.code
      },
      get count() {
        return sprite.userData.count
      },
      get labelMode() {
        return sprite.userData.labelMode
      },
      updateCount: function (nextCount) {
        sprite.userData.count = nextCount
        draw()
      },
      updateAlertType: function (nextAlertType) {
        const normalized = resolveAlertType(nextAlertType)
        if (normalized === sprite.userData.alertType && bgReady) {
          return Promise.resolve(sprite.userData.alertType)
        }
        sprite.userData.alertType = normalized
        return loadBackground(normalized).then(function () {
          return normalized
        })
      },
      setPosition: function (x, y, z) {
        sprite.position.set(x, y, z)
      },
      dispose: function () {
        if (material.map) material.map.dispose()
        material.dispose()
      },
    }
  }

  function createMarkerFromItem(item) {
    return createStatusMarker({
      id: item.id,
      alertType: item.alertType,
      code: item.code,
      count: item.count != null ? item.count : null,
      labelMode: item.labelMode || 'nameCount',
      position: item.position,
      worldWidth: item.worldWidth,
    })
  }

  // =========================================================================
  // 5. 点击交互
  // =========================================================================

  const CLICK_MOVE_THRESHOLD = 6

  /**
   * @param {object} options
   * @param {HTMLElement} options.domElement 渲染 canvas
   * @param {() => THREE.Camera} options.getCamera
   * @param {() => Array} options.getMarkers
   * @param {Function} [options.onClick]
   */
  function bindMarkerPointerEvents(options) {
    const domElement = options.domElement
    const getCamera = options.getCamera
    const getMarkers = options.getMarkers
    const onClick = options.onClick

    const raycaster = new THREE.Raycaster()
    const pointerNdc = new THREE.Vector2()
    let pointerDown = null

    if (domElement && domElement.style) {
      domElement.style.touchAction = 'none'
    }

    function setPointerFromEvent(event) {
      const rect = domElement.getBoundingClientRect()
      pointerNdc.x = ((event.clientX - rect.left) / rect.width) * 2 - 1
      pointerNdc.y = -((event.clientY - rect.top) / rect.height) * 2 + 1
    }

    function isOpaqueMarkerHit(hit) {
      const canvas = hit.object && hit.object.userData && hit.object.userData.canvas
      const uv = hit.uv
      if (!canvas || !uv) return true
      const x = Math.min(
        canvas.width - 1,
        Math.max(0, Math.floor(uv.x * canvas.width)),
      )
      const y = Math.min(
        canvas.height - 1,
        Math.max(0, Math.floor((1 - uv.y) * canvas.height)),
      )
      const pixel = canvas.getContext('2d').getImageData(x, y, 1, 1).data
      return pixel[3] > 16
    }

    function pickMarker(event) {
      const camera = getCamera()
      if (!camera) return null
      setPointerFromEvent(event)
      raycaster.setFromCamera(pointerNdc, camera)
      const sprites = getMarkers().map(function (m) {
        return m.sprite
      })
      const hits = raycaster.intersectObjects(sprites, false)
      for (let i = 0; i < hits.length; i++) {
        const hit = hits[i]
        if (
          hit.object &&
          hit.object.userData &&
          hit.object.userData.isMarker &&
          isOpaqueMarkerHit(hit)
        ) {
          return hit.object
        }
      }
      return null
    }

    function onPointerDown(event) {
      if (event.button != null && event.button !== 0) return
      pointerDown = { x: event.clientX, y: event.clientY }
    }

    function onPointerMove(event) {
      if (!domElement) return
      domElement.style.cursor = pickMarker(event) ? 'pointer' : ''
    }

    function onPointerUp(event) {
      if (!pointerDown) return
      const moved = Math.hypot(
        event.clientX - pointerDown.x,
        event.clientY - pointerDown.y,
      )
      pointerDown = null
      if (moved > CLICK_MOVE_THRESHOLD) return
      const sprite = pickMarker(event)
      if (!sprite) return
      if (typeof onClick === 'function') {
        onClick({
          id: sprite.userData.id,
          code: sprite.userData.code,
          count: sprite.userData.count,
          alertType: sprite.userData.alertType,
          labelMode: sprite.userData.labelMode,
          position: sprite.position.clone(),
          originalEvent: event,
        })
      }
    }

    function onPointerLeave() {
      pointerDown = null
      if (domElement) domElement.style.cursor = ''
    }

    domElement.addEventListener('pointerdown', onPointerDown)
    domElement.addEventListener('pointermove', onPointerMove)
    domElement.addEventListener('pointerup', onPointerUp)
    domElement.addEventListener('pointerleave', onPointerLeave)

    return {
      unbind: function () {
        domElement.removeEventListener('pointerdown', onPointerDown)
        domElement.removeEventListener('pointermove', onPointerMove)
        domElement.removeEventListener('pointerup', onPointerUp)
        domElement.removeEventListener('pointerleave', onPointerLeave)
        pointerDown = null
        if (domElement) domElement.style.cursor = ''
      },
    }
  }

  // =========================================================================
  // 6. 批量更新
  // =========================================================================

  function updateMarkers(markers, payload) {
    const list = payload || []
    return Promise.all(
      list.map(function (item) {
        const target = markers.find(function (m) {
          return m.sprite.userData.id === item.id
        })
        if (!target) return Promise.resolve()
        if (item.count != null) target.updateCount(item.count)
        if (item.alertType != null) return target.updateAlertType(item.alertType)
        return Promise.resolve()
      }),
    )
  }

  // =========================================================================
  // 7. 一键挂载：复制到 OpenView 后主要用这个
  // =========================================================================

  /**
   * 在 OpenView 当前场景挂载一批标注
   *
   * @param {object} options
   * @param {Array} options.items 标注数据列表
   *   { id, alertType, code, count?, labelMode?, position: [x,y,z] }
   * @param {Function} [options.onClick] 点击回调
   * @param {THREE.Scene} [options.scene] 可手动传入，不传则自动从 coreMgr 解析
   * @param {THREE.Camera} [options.camera]
   * @param {HTMLElement} [options.domElement] 渲染 canvas
   * @returns {Promise<{ markers, updateMarkers, destroy, context }>}
   */
  function mount(options) {
    options = options || {}
    const items = options.items || []

    return whenReady().then(function (autoCtx) {
      const scene = options.scene || autoCtx.scene
      const camera = options.camera || autoCtx.camera
      const renderer = options.renderer || autoCtx.renderer
      const domElement =
        options.domElement ||
        autoCtx.domElement ||
        (renderer && renderer.domElement)

      if (!scene) {
        throw new Error(
          '[StatusMarkerOV] 未解析到 THREE.Scene。请在 mount({ scene }) 手动传入，或在控制台检查 coreMgr.sceneMgr.sceneNode[0] 的字段名',
        )
      }
      if (!camera) {
        throw new Error(
          '[StatusMarkerOV] 未解析到 Camera。请在 mount({ camera }) 手动传入',
        )
      }
      if (!domElement) {
        console.warn(
          '[StatusMarkerOV] 未解析到渲染 canvas，点击事件可能不可用。请传 mount({ domElement: renderer.domElement })',
        )
      }

      const markers = []
      let pointerApi = null

      // 串行创建，避免瞬间并发过多图片请求
      let chain = Promise.resolve()
      items.forEach(function (item) {
        chain = chain.then(function () {
          const marker = createMarkerFromItem(item)
          return marker.ready.then(function () {
            scene.add(marker.sprite)
            markers.push(marker)
          })
        })
      })

      return chain.then(function () {
        if (domElement) {
          pointerApi = bindMarkerPointerEvents({
            domElement: domElement,
            getCamera: function () {
              return camera
            },
            getMarkers: function () {
              return markers
            },
            onClick: options.onClick,
          })
        }

        console.log(
          '[StatusMarkerOV] 已挂载 ' +
            markers.length +
            ' 个标注，projectId=',
          autoCtx.projectId,
        )

        return {
          /** 当前标注实例列表 */
          markers: markers,
          /** OpenView 上下文快照 */
          context: {
            coreMgr: autoCtx.coreMgr,
            sceneMgr: autoCtx.sceneMgr,
            scene: scene,
            camera: camera,
            renderer: renderer,
            projectId: autoCtx.projectId,
            isDesign: autoCtx.isDesign,
          },
          /**
           * 批量更新
           * @param {Array<{ id: string, alertType?: string, count?: number|string }>} payload
           */
          updateMarkers: function (payload) {
            return updateMarkers(markers, payload)
          },
          /** 从场景移除并释放资源 */
          destroy: function () {
            if (pointerApi) pointerApi.unbind()
            pointerApi = null
            markers.forEach(function (m) {
              scene.remove(m.sprite)
              m.dispose()
            })
            markers.length = 0
          },
        }
      })
    })
  }

  /**
   * 调试：打印 OpenView 上下文，方便核对 scene/camera 字段
   * 在控制台执行：StatusMarkerOV.debugContext()
   */
  function debugContext() {
    const ctx = getOpenViewContext()
    console.log('[StatusMarkerOV] OpenView 上下文 =', ctx)
    console.log('  coreMgr =', ctx.coreMgr)
    console.log('  sceneMgr =', ctx.sceneMgr)
    console.log('  sceneNode =', ctx.sceneNode)
    console.log('  scene =', ctx.scene)
    console.log('  camera =', ctx.camera)
    console.log('  renderer =', ctx.renderer)
    console.log('  domElement =', ctx.domElement)
    return ctx
  }

  // =========================================================================
  // 8. 挂到 window，供 OpenView 脚本直接调用
  // =========================================================================

  const StatusMarkerOV = {
    /** 修改背景图 URL：StatusMarkerOV.setAssets({ normal, warning, urgent }) */
    setAssets: function (assets) {
      if (!assets) return
      if (assets.normal) ALERT_ASSETS.normal = assets.normal
      if (assets.warning) ALERT_ASSETS.warning = assets.warning
      if (assets.urgent) ALERT_ASSETS.urgent = assets.urgent
      if (assets.green) ALERT_ASSETS.normal = assets.green
      if (assets.yellow) ALERT_ASSETS.warning = assets.yellow
      if (assets.red) ALERT_ASSETS.urgent = assets.red
    },
    getAssets: function () {
      return {
        normal: ALERT_ASSETS.normal,
        warning: ALERT_ASSETS.warning,
        urgent: ALERT_ASSETS.urgent,
      }
    },
    resolveAlertType: resolveAlertType,
    formatMarkerLabel: formatMarkerLabel,
    getOpenViewContext: getOpenViewContext,
    whenReady: whenReady,
    debugContext: debugContext,
    createStatusMarker: createStatusMarker,
    createMarkerFromItem: createMarkerFromItem,
    bindMarkerPointerEvents: bindMarkerPointerEvents,
    updateMarkers: updateMarkers,
    mount: mount,
  }

  global.StatusMarkerOV = StatusMarkerOV

  console.log(
    '[StatusMarkerOV] 已加载。请先 StatusMarkerOV.setAssets({...}) 配置图片 URL，再 StatusMarkerOV.mount({ items, onClick })',
  )
})(typeof window !== 'undefined' ? window : this)
