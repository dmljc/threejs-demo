/**
 * ============================================================================
 * OpenView 低代码源码（index.js）· 整份复制即可
 * ============================================================================
 * 结构说明：
 *   - 仅保留一个 class LowcodeComponent
 *   - 三维标注相关能力全部作为类方法（_marker* / initStatusMarkers 等）
 *   - 业务逻辑（WebSocket / 场景切换）与标注逻辑分区清晰
 *
 * 使用前搜索 TODO，修改：
 *   1. markerConfig.items —— 各厂房 position（autoFit=true 时会按场景中心自动抬高）
 *   2. markerConfig.assets —— 已配置 OpenView 资源库 green/yellow/red
 *
 * 排查要点（基于 window.coreMgr 实测）：
 *   - OpenView 会丢弃除 state 外的 class 字段 → markerConfig 必须在方法里赋值
 *   - webglPlayer 在 coreMgr.sceneMgr.webglPlayer（不是 window.webglPlayer）
 *   - sceneList/sceneNode 常有 2 个场景，需选 children 最多的那个
 *   - 同步挂 DOM 叠加层，避免 Sprite 挂错场景时完全看不见
 * ============================================================================
 */
class LowcodeComponent extends Component {
  state = {
    btnClass1: 'bottom-btn btn-background-click',
    /**
     * 当前场景索引
     * 0 = 首页 / 大屏概览
     * 1 = X12 厂房
     */
    sceneIndex: 0,
    alarmStats: {},
    disposalStats: {},
    effluentList: { X12: [], X03: [] },
    overviewStats: {},
    deviceTypes: {},
    inspectionStats: {},
    monitoringList: [],
    operationLogList: [],
    alarmList: [],
    inspectionList: [],
    qtcList: {},
  };

  // 注意：OpenView 低代码运行时往往会丢掉除 state 以外的 class 字段
  // （日志已证实 this.markerConfig === undefined）。
  // 因此 markerConfig / _markers 等一律在方法里赋值，不要写 class 字段。

  // ===========================================================================
  // 生命周期
  // ===========================================================================

  /** 确保标注配置存在（OpenView 不会保留 markerConfig = {} 这种 class 字段） */
  _ensureMarkerRuntime() {
    if (!this.markerConfig) {
      this.markerConfig = {
        assets: {
          // OpenView 资源库完整 URL（urgent→red / warning→yellow / green→normal）
          normal:
            'https://openview.czy3d.com/czybucket/czy/tenant/openview/7738F2879717420B962C32CE221C69C9/2026/09/green.png',
          warning:
            'https://openview.czy3d.com/czybucket/czy/tenant/openview/7738F2879717420B962C32CE221C69C9/2026/09/yellow.png',
          urgent:
            'https://openview.czy3d.com/czybucket/czy/tenant/openview/7738F2879717420B962C32CE221C69C9/2026/09/red.png',
        },
        imageWidth: 284,
        imageHeight: 154,
        scale: 2,
        anchorX: 0.22,
        anchorY: 0,
        textX: 148,
        // 与圆形水平中线对齐（green.png 实测圆心约在 46.8% 高度）
        textY: 72,
        fontSize: 28,
        /** 与设计稿一致的 DOM 文本样式 */
        domFontSize: 16,
        domLineHeight: 24,
        domFontWeight: 500,
        domFontFamily:
          'SourceHanSansSC, "Source Han Sans SC", "Noto Sans SC", "PingFang SC", "Microsoft YaHei", sans-serif',
        domTextShadow: '0px 2px 4px rgba(0,0,0,0.5)',
        /**
         * 文字垂直位置：对齐圆形中心（约 47%），不要用整图几何中心
         * （尖角在下方会把几何中心拉低，导致文字看起来偏上）
         */
        domTextTopPercent: 47,
        /** DOM 标注显示尺寸：使横幅可视高度接近设计 24px */
        domWidth: 148,
        domHeight: 80,
        worldWidth: 50,
        autoFit: true,
        depthTest: false,
        clickMoveThreshold: 6,
        mountDelayMs: 800,
        items: [
          { id: 'b-x01', alertType: 'green', code: 'X01', labelMode: 'name', position: [0, 0, 0] },
          { id: 'b-x06', alertType: 'warning', code: 'X06', labelMode: 'name', position: [30, 0, 0] },
          {
            id: 'b-x12',
            alertType: 'urgent',
            code: 'X12',
            count: 12,
            labelMode: 'nameCount',
            position: [-30, 0, 0],
          },
          {
            id: 'b-x09',
            alertType: 'green',
            code: 'X09',
            count: 3,
            labelMode: 'nameCount',
            position: [0, 0, 30],
          },
        ],
      };
      console.log('[Marker] 已在运行时初始化 markerConfig（class 字段被平台丢弃）');
    }
    if (!this._markers) this._markers = [];
    if (this._markerCtx === undefined) this._markerCtx = null;
    if (this._markerPointer === undefined) this._markerPointer = null;
    if (this._markerDomLayer === undefined) this._markerDomLayer = null;
    if (this._markerRaf === undefined) this._markerRaf = 0;
    return this.markerConfig;
  }

  componentDidMount() {
    console.log('[Marker] componentDidMount 开始');
    this._ensureMarkerRuntime();
    this.handleWss();
    this.initStatusMarkers();
  }

  componentWillUnmount() {
    this.destroyStatusMarkers();
    if (this.ws) {
      this.ws.onopen = null;
      this.ws.onmessage = null;
      this.ws.onerror = null;
      this.ws.onclose = null;
      this.ws.close();
      this.ws = null;
    }
  }

  // ===========================================================================
  // 厂房标注 · 对外入口
  // ===========================================================================

  /** 初始化并挂载三维标注 */
  async initStatusMarkers() {
    const cfg = this._ensureMarkerRuntime();
    this._markers = [];
    const delay = (cfg && cfg.mountDelayMs) || 0;
    if (delay > 0) {
      await new Promise((r) => setTimeout(r, delay));
    }

    try {
      const ctx = await this._markerWhenReady(30000);
      this._markerCtx = ctx;
      const THREE = ctx.THREE || this._markerGetTHREE();
      const canSprite = !!(THREE && typeof THREE.Sprite === 'function' && ctx.scene);

      console.log('[Marker] 场景上下文就绪', {
        hasTHREE: !!THREE,
        canSprite,
        compat: !!(THREE && THREE._compat),
        scene: !!ctx.scene,
        sceneFrom: ctx.sceneMeta && ctx.sceneMeta.from,
        sceneChildren: ctx.sceneMeta && ctx.sceneMeta.childCount,
        sceneCount: ctx.sceneCount,
        camera: !!ctx.camera,
        renderer: !!ctx.renderer,
        domElement: !!ctx.domElement,
        player: !!ctx.player,
        ready: ctx.ready,
        isDesign: ctx.isDesign,
        projectId: ctx.projectId,
      });

      if (canSprite && this.markerConfig.autoFit) {
        this._markerAutoFit(ctx);
      } else if (!canSprite && this.markerConfig.autoFit && ctx.scene) {
        this._markerAutoFitLight(ctx);
      }

      if (canSprite) {
        await this._markerMountAll(ctx);
      } else {
        this._markerMountVirtualMarkers(ctx);
      }

      this._markerMountDomOverlay(ctx);
      this.syncMarkerVisibleByScene();
      console.log(
        '[Marker] 已挂载',
        this._markers.length,
        '个标注, mode=',
        canSprite ? 'sprite+dom' : 'dom-only',
        'worldWidth=',
        this.markerConfig.worldWidth,
      );
      this._markers.forEach((m) => {
        const p = m.sprite && m.sprite.position;
        console.log(
          '[Marker] marker',
          m.sprite && m.sprite.userData && m.sprite.userData.code,
          p && (p.toArray ? p.toArray() : [p.x, p.y, p.z]),
        );
      });
    } catch (err) {
      console.error('[Marker] 挂载失败:', err);
      this._markerDebugContext();
      try {
        this._markerMountDomFallbackFixed();
      } catch (e2) {
        console.error('[Marker] 固定 DOM 兜底也失败', e2);
      }
    }
  }

  /** 无 Box3 时的轻量 autoFit：按场景子节点世界坐标估中心 */
  _markerAutoFitLight(ctx) {
    const scene = ctx.scene;
    if (!scene) return;
    const THREE = ctx.THREE || this._markerGetTHREE();
    const Vector3 = THREE && THREE.Vector3;
    if (!Vector3) return;

    let minX = Infinity;
    let minY = Infinity;
    let minZ = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    let maxZ = -Infinity;
    let count = 0;
    const tmp = new Vector3();

    const visit = (obj) => {
      if (!obj) return;
      if (typeof obj.getWorldPosition === 'function') {
        obj.getWorldPosition(tmp);
        minX = Math.min(minX, tmp.x);
        minY = Math.min(minY, tmp.y);
        minZ = Math.min(minZ, tmp.z);
        maxX = Math.max(maxX, tmp.x);
        maxY = Math.max(maxY, tmp.y);
        maxZ = Math.max(maxZ, tmp.z);
        count += 1;
      }
      if (obj.children && obj.children.length) {
        for (let i = 0; i < obj.children.length && i < 200; i += 1) {
          visit(obj.children[i]);
        }
      }
    };
    visit(scene);
    if (!count || !isFinite(minX)) {
      console.warn('[Marker] lightAutoFit 无有效坐标');
      return;
    }
    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;
    const cz = (minZ + maxZ) / 2;
    const sizeX = maxX - minX;
    const sizeY = maxY - minY;
    const sizeZ = maxZ - minZ;
    const maxDim = Math.max(sizeX, sizeY, sizeZ) || 100;
    const fitted = Math.min(300, Math.max(20, maxDim * 0.05));
    this.markerConfig.worldWidth = fitted;
    const liftY = Math.max(sizeY * 0.15, fitted * 0.8);
    console.log('[Marker] lightAutoFit', { maxDim, fitted, liftY, center: [cx, cy, cz], count });

    this.markerConfig.items = (this.markerConfig.items || []).map((item, idx) => {
      const pos = item.position || [0, 0, 0];
      const next = {};
      for (const k in item) {
        if (Object.prototype.hasOwnProperty.call(item, k)) next[k] = item[k];
      }
      next.position = [
        cx + (pos[0] || 0) + idx * fitted * 0.2,
        cy + liftY + (pos[1] || 0),
        cz + (pos[2] || 0) + idx * fitted * 0.15,
      ];
      return next;
    });
  }

  /** 无 Sprite 时创建虚拟标注（仅 position + userData，供 DOM 投影） */
  _markerMountVirtualMarkers(ctx) {
    const items = this.markerConfig.items || [];
    this._markers = items.map((item) => {
      const pos = item.position || [0, 0, 0];
      const alertType = this._markerResolveAlertType(item.alertType);
      const userData = {
        id: item.id,
        alertType,
        code: item.code,
        count: item.count != null ? item.count : null,
        labelMode: item.labelMode || 'nameCount',
        isMarker: true,
      };
      const sprite = {
        position: { x: pos[0], y: pos[1], z: pos[2], toArray: () => [pos[0], pos[1], pos[2]] },
        visible: true,
        userData,
      };
      return {
        sprite,
        ready: Promise.resolve(sprite),
        updateCount: (nextCount) => {
          userData.count = nextCount;
          if (sprite._domEl) {
            this._markerFillDomLabel(
              sprite._domEl,
              userData.code,
              userData.count,
              userData.labelMode,
            );
          }
        },
        updateAlertType: (nextAlertType) => {
          userData.alertType = this._markerResolveAlertType(nextAlertType);
          if (sprite._domEl) {
            const url = this._markerGetAsset(userData.alertType);
            if (url) sprite._domEl.style.backgroundImage = `url("${url}")`;
          }
          return Promise.resolve(userData.alertType);
        },
        dispose: () => {},
      };
    });
    console.log('[Marker] 虚拟标注已创建', this._markers.length);
  }

  /** 无 THREE 时的固定 DOM 标注，确认生命周期已跑通 */
  _markerMountDomFallbackFixed() {
    if (this._markerDomLayer && this._markerDomLayer.parentNode) {
      this._markerDomLayer.parentNode.removeChild(this._markerDomLayer);
    }
    const layer = document.createElement('div');
    layer.setAttribute('data-marker-overlay', 'fixed');
    layer.style.cssText =
      'position:fixed;left:50%;top:42%;transform:translate(-50%,-50%);z-index:9999;pointer-events:none;display:flex;gap:12px;';
    (this.markerConfig.items || []).forEach((item) => {
      const el = document.createElement('div');
      const url = this._markerGetAsset(item.alertType);
      el.style.cssText = `${this._markerDomShellStyle()};position:relative;transform:none;`;
      if (url) el.style.backgroundImage = `url("${url}")`;
      this._markerFillDomLabel(el, item.code, item.count, item.labelMode || 'name');
      layer.appendChild(el);
    });
    document.body.appendChild(layer);
    this._markerDomLayer = layer;
    console.warn('[Marker] 已启用固定 DOM 兜底（说明 THREE/scene 未解析成功）');
  }

  /**
   * 根据场景包围盒估算标注大小，并把 position 相对场景中心抬高
   * 解决：模型很大时 worldWidth=1.6 几乎看不见
   */
  _markerAutoFit(ctx) {
    const THREE = ctx.THREE || this._markerGetTHREE();
    if (!THREE || !ctx.scene || typeof THREE.Box3 !== 'function') {
      this._markerAutoFitLight(ctx);
      return;
    }

    try {
      const box = new THREE.Box3().setFromObject(ctx.scene);
      if (box.isEmpty()) {
        console.warn('[Marker] 场景包围盒为空，跳过 autoFit');
        return;
      }
      const size = new THREE.Vector3();
      const center = new THREE.Vector3();
      box.getSize(size);
      box.getCenter(center);
      const maxDim = Math.max(size.x, size.y, size.z) || 100;
      // 标注宽度约为场景最大边的 4%~8%
      const fitted = Math.min(300, Math.max(20, maxDim * 0.05));
      this.markerConfig.worldWidth = fitted;
      const liftY = Math.max(size.y * 0.15, fitted * 0.8);

      console.log('[Marker] autoFit', { maxDim, fitted, liftY, center: center.toArray() });

      this.markerConfig.items = (this.markerConfig.items || []).map((item, idx) => {
        const pos = item.position || [0, 0, 0];
        const ox = center.x + (pos[0] || 0);
        const oy = center.y + liftY + (pos[1] || 0);
        const oz = center.z + (pos[2] || 0);
        const next = {};
        for (const k in item) {
          if (Object.prototype.hasOwnProperty.call(item, k)) next[k] = item[k];
        }
        next.position = [ox + idx * fitted * 0.2, oy, oz + idx * fitted * 0.15];
        return next;
      });
    } catch (e) {
      console.warn('[Marker] autoFit 失败，使用默认 worldWidth', e);
    }
  }

  /** 按首页 / 厂房页切换显隐 */
  syncMarkerVisibleByScene() {
    const show = this.state.sceneIndex === 0;
    this._markers.forEach((m) => {
      if (m.sprite) m.sprite.visible = show;
      if (m._sceneCopies) {
        m._sceneCopies.forEach((c) => {
          c.visible = show;
        });
      }
    });
    if (this._markerDomLayer) {
      this._markerDomLayer.style.display = show ? 'block' : 'none';
    }
  }

  /**
   * WS 推送同步标注
   * @param {Array<{ id: string, alertType?: string, count?: number|string }>} list
   */
  applyBuildingMarkers(list) {
    if (!Array.isArray(list) || !list.length || !this._markers.length) return;
    list.forEach((item) => {
      const target = this._markers.find((m) => m.sprite.userData.id === item.id);
      if (!target) return;
      if (item.count != null) target.updateCount(item.count);
      if (item.alertType != null) target.updateAlertType(item.alertType);
    });
  }

  /** 销毁标注 */
  destroyStatusMarkers() {
    if (this._markerRaf) {
      cancelAnimationFrame(this._markerRaf);
      this._markerRaf = 0;
    }
    if (this._markerPointer) {
      this._markerPointer.unbind();
      this._markerPointer = null;
    }
    if (this._markerDomLayer && this._markerDomLayer.parentNode) {
      this._markerDomLayer.parentNode.removeChild(this._markerDomLayer);
    }
    this._markerDomLayer = null;

    const scene = this._markerCtx && this._markerCtx.scene;
    this._markers.forEach((m) => {
      if (scene && m.sprite) scene.remove(m.sprite);
      // 多场景副本
      if (m._sceneCopies) {
        m._sceneCopies.forEach((copy) => {
          if (copy.parent) copy.parent.remove(copy);
        });
      }
      if (m.dispose) m.dispose();
    });
    this._markers = [];
    this._markerCtx = null;
  }

  // ===========================================================================
  // 厂房标注 · 内部实现（_marker 前缀）
  // ===========================================================================

  /** 从 sceneMgr 上尽量找出播放器（字段名因版本而异） */
  _markerGetWebglPlayer() {
    const sceneMgr =
      (window.coreMgr && window.coreMgr.sceneMgr) ||
      (window.webglPlayer && window.webglPlayer.sceneMgr) ||
      null;
    if (!sceneMgr && window.webglPlayer) return window.webglPlayer;

    const named =
      (sceneMgr &&
        (sceneMgr.webglPlayer ||
          sceneMgr.player ||
          sceneMgr.Player ||
          sceneMgr.viewer ||
          sceneMgr.engine ||
          sceneMgr.app ||
          sceneMgr.glPlayer ||
          sceneMgr.renderPlayer)) ||
      (window.coreMgr && window.coreMgr.webglPlayer) ||
      window.webglPlayer ||
      null;
    if (named) return named;

    // 扫 sceneMgr 自有属性：带 camera/renderer/canvas 的对象即视为 player
    if (sceneMgr && typeof sceneMgr === 'object') {
      try {
        const keys = Object.keys(sceneMgr);
        if (!this._markerLoggedSceneMgrKeys) {
          this._markerLoggedSceneMgrKeys = true;
          console.log('[Marker] sceneMgr.keys=', keys);
        }
        for (let i = 0; i < keys.length; i += 1) {
          const v = sceneMgr[keys[i]];
          if (!v || typeof v !== 'object') continue;
          if (v === sceneMgr) continue;
          if (v.camera || v.renderer || v.canvas || v.domElement || v.webglRenderer) {
            return v;
          }
        }
      } catch (e) {
        // ignore
      }
    }
    return null;
  }

  /** 判断是否像完整 THREE 命名空间 */
  _markerLookLikeTHREE(v) {
    return !!(
      v &&
      typeof v === 'object' &&
      typeof v.Sprite === 'function' &&
      typeof v.Scene === 'function' &&
      typeof v.Vector3 === 'function'
    );
  }

  /**
   * 无 window.THREE 时，从已有 scene 对象上“借”构造器拼出精简兼容对象
   * 至少提供 Vector3（供 DOM 投影）；若场景里已有 Sprite 再借 Sprite/Material
   */
  _markerBuildCompatTHREE(scene) {
    if (!scene || !scene.position || typeof scene.position.constructor !== 'function') {
      return null;
    }
    const Vector3 = scene.position.constructor;
    let Sprite = null;
    let SpriteMaterial = null;
    let CanvasTexture = null;
    let Vector2 = null;
    let Raycaster = null;

    const borrowFrom = (obj) => {
      if (!obj) return;
      if (!Sprite && obj.isSprite && typeof obj.constructor === 'function') {
        Sprite = obj.constructor;
      }
      if (!SpriteMaterial && obj.isSprite && obj.material && obj.material.constructor) {
        SpriteMaterial = obj.material.constructor;
      }
      if (
        !CanvasTexture &&
        obj.material &&
        obj.material.map &&
        obj.material.map.isCanvasTexture &&
        obj.material.map.constructor
      ) {
        CanvasTexture = obj.material.map.constructor;
      }
    };

    if (typeof scene.traverse === 'function') {
      scene.traverse((o) => borrowFrom(o));
    } else if (Array.isArray(scene.children)) {
      scene.children.forEach((o) => borrowFrom(o));
    }

    // Vector2：部分版本挂在同包；没有也不影响 DOM 投影
    try {
      const tmp = new Vector3();
      if (tmp && tmp.constructor) {
        // no-op
      }
    } catch (e) {
      return null;
    }

    return {
      Vector3,
      Vector2,
      Raycaster,
      Sprite,
      SpriteMaterial,
      CanvasTexture,
      Box3: null,
      SRGBColorSpace: null,
      sRGBEncoding: null,
      _compat: true,
    };
  }

  _markerGetTHREE() {
    if (typeof window === 'undefined') return null;
    if (this._markerLookLikeTHREE(window.THREE)) return window.THREE;
    if (this._markerCompatTHREE && this._markerLookLikeTHREE(this._markerCompatTHREE)) {
      return this._markerCompatTHREE;
    }
    if (this._markerCompatTHREE) return this._markerCompatTHREE;

    const player = this._markerGetWebglPlayer();
    const sceneMgr = window.coreMgr && window.coreMgr.sceneMgr;
    const roots = [window.coreMgr, sceneMgr, player, window];

    for (let i = 0; i < roots.length; i += 1) {
      const root = roots[i];
      if (!root) continue;
      const direct =
        root.THREE ||
        root.three ||
        (root.engine && (root.engine.THREE || root.engine.three)) ||
        (root.renderer && root.renderer.THREE);
      if (this._markerLookLikeTHREE(direct)) return direct;
    }

    for (let i = 0; i < roots.length; i += 1) {
      const found = this._markerDeepFind(
        roots[i],
        (v) => this._markerLookLikeTHREE(v),
        5,
      );
      if (found) return found;
    }
    return null;
  }

  _markerFindCameraInObject(root) {
    if (!root) return null;
    if (this._markerLookLikeCamera(root)) return root;
    if (typeof root.traverse === 'function') {
      let found = null;
      root.traverse((o) => {
        if (!found && this._markerLookLikeCamera(o)) found = o;
      });
      if (found) return found;
    }
    return this._markerDeepFind(root, (v) => this._markerLookLikeCamera(v), 5);
  }

  /**
   * 从 sceneNode/sceneList（OpenView 常有 2 个场景）里挑「内容最多」的节点与 Scene
   */
  _markerCollectSceneCandidates(sceneMgr, player) {
    const nodes = [];
    const listA = (sceneMgr && sceneMgr.sceneNode) || [];
    const listB = (sceneMgr && sceneMgr.sceneList) || [];
    const pushUnique = (n) => {
      if (n && nodes.indexOf(n) < 0) nodes.push(n);
    };
    if (Array.isArray(listA)) listA.forEach(pushUnique);
    if (Array.isArray(listB)) listB.forEach(pushUnique);
    if (sceneMgr) pushUnique(sceneMgr);
    if (player) pushUnique(player);

    const scenes = [];
    const addScene = (s, from) => {
      if (!s || !this._markerLookLikeScene(s)) return;
      if (scenes.some((x) => x.scene === s)) return;
      const childCount = Array.isArray(s.children) ? s.children.length : 0;
      scenes.push({ scene: s, from, childCount });
    };

    // sceneList 项本身就可能是 Scene（K$）
    nodes.forEach((node, idx) => {
      addScene(node, `nodeAsScene[${idx}]`);
      addScene(
        this._markerPickProp(node, ['scene', 'threeScene', 'rootScene', 'Scene']),
        `node[${idx}]`,
      );
      addScene(
        this._markerDeepFind(node, (v) => this._markerLookLikeScene(v), 3),
        `nodeDeep[${idx}]`,
      );
    });
    addScene(this._markerPickProp(player, ['scene', 'threeScene', 'rootScene']), 'player');
    addScene(
      this._markerDeepFind(player, (v) => this._markerLookLikeScene(v), 3),
      'playerDeep',
    );
    addScene(this._markerPickProp(sceneMgr, ['scene', 'threeScene']), 'sceneMgr');

    scenes.sort((a, b) => b.childCount - a.childCount);
    return { nodes, scenes };
  }

  /** 从 window.coreMgr.sceneMgr 解析 scene、camera、renderer */
  _markerGetContext() {
    const coreMgr = window.coreMgr || null;
    const sceneMgr = (coreMgr && coreMgr.sceneMgr) || null;
    const player = this._markerGetWebglPlayer();
    const { nodes, scenes } = this._markerCollectSceneCandidates(sceneMgr, player);
    const best = scenes[0] || null;
    const scene = best ? best.scene : null;
    const node = nodes[0] || sceneMgr || null;

    let camera =
      this._markerPickProp(player, ['camera', 'Camera', 'mainCamera', 'activeCamera']) ||
      this._markerPickProp(sceneMgr, [
        'camera',
        'mainCamera',
        'activeCamera',
        'Camera',
        'currentCamera',
      ]) ||
      this._markerPickProp(node, ['camera', 'Camera', 'mainCamera']) ||
      this._markerFindCameraInObject(player) ||
      this._markerFindCameraInObject(sceneMgr) ||
      this._markerFindCameraInObject(scene) ||
      this._markerFindCameraInObject(node);

    const renderer =
      this._markerPickProp(player, ['renderer', 'webglRenderer', 'Renderer']) ||
      this._markerPickProp(sceneMgr, ['renderer', 'webglRenderer']) ||
      this._markerPickProp(node, ['renderer', 'webglRenderer', 'Renderer']) ||
      this._markerDeepFind(player, (v) => this._markerLookLikeRenderer(v), 5) ||
      this._markerDeepFind(sceneMgr, (v) => this._markerLookLikeRenderer(v), 4) ||
      this._markerDeepFind(node, (v) => this._markerLookLikeRenderer(v), 3);

    const canvases = Array.prototype.slice.call(document.querySelectorAll('canvas'));
    let bestCanvas =
      (renderer && renderer.domElement) ||
      (player && (player.canvas || player.domElement)) ||
      null;
    if (!bestCanvas && canvases.length) {
      // 选面积最大的 canvas，通常是三维视口
      bestCanvas = canvases.reduce((a, b) => {
        const aa = (a.clientWidth || 0) * (a.clientHeight || 0);
        const bb = (b.clientWidth || 0) * (b.clientHeight || 0);
        return bb > aa ? b : a;
      });
    }

    return {
      coreMgr,
      sceneMgr,
      player,
      scene,
      scenes: scenes.map((s) => s.scene),
      sceneMeta: best,
      camera,
      renderer,
      domElement: bestCanvas,
      ready: !!(sceneMgr && sceneMgr.ready),
      isDesign: !!(coreMgr && coreMgr.isDesign),
      projectId: coreMgr && coreMgr.projectId,
      nodeCount: nodes.length,
      sceneCount: scenes.length,
    };
  }

  _markerDebugContext() {
    const ctx = this._markerGetContext();
    console.log('[Marker] THREE=', !!this._markerGetTHREE(), this._markerGetTHREE());
    console.log('[Marker] webglPlayer=', !!this._markerGetWebglPlayer());
    console.log('[Marker] context=', ctx);
    return ctx;
  }

  /**
   * 等待场景：不再强依赖 window.THREE
   * - 有完整 THREE.Sprite → 三维 Sprite 模式
   * - 仅有 scene → 1.5s 后进入 DOM 标注模式
   */
  _markerWhenReady(timeoutMs = 30000) {
    return new Promise((resolve, reject) => {
      const start = Date.now();
      const tick = () => {
        const ctx = this._markerGetContext();
        let THREE = this._markerGetTHREE();
        if (!THREE && ctx.scene) {
          THREE = this._markerBuildCompatTHREE(ctx.scene);
          if (THREE) this._markerCompatTHREE = THREE;
        }
        ctx.THREE = THREE;

        if (ctx.scene && (ctx.ready || ctx.scene)) {
          const full = !!(THREE && typeof THREE.Sprite === 'function');
          const waited = Date.now() - start;
          if (full) {
            resolve(ctx);
            return;
          }
          // OpenView 页面脚本里经常没有 window.THREE，不要空等 30s
          if (waited >= 1500) {
            console.warn('[Marker] 无 window.THREE，切换 DOM 标注模式', {
              hasCompatVector3: !!(THREE && THREE.Vector3),
              camera: !!ctx.camera,
              sceneChildren: ctx.sceneMeta && ctx.sceneMeta.childCount,
            });
            resolve(ctx);
            return;
          }
        }

        if (Date.now() - start > timeoutMs) {
          console.error('[Marker] 等待超时 dump', {
            THREE: !!THREE,
            ready: ctx.ready,
            scene: !!ctx.scene,
            camera: !!ctx.camera,
            player: !!ctx.player,
            sceneCount: ctx.sceneCount,
            isDesign: ctx.isDesign,
          });
          reject(new Error('[Marker] 场景未就绪：请检查 coreMgr.sceneMgr'));
          return;
        }
        setTimeout(tick, 200);
      };
      tick();
    });
  }

  _markerAlertColor(type) {
    const key = this._markerResolveAlertType(type);
    if (key === 'urgent') return { fill: '#e11d2e', edge: '#ff6b6b' };
    if (key === 'warning') return { fill: '#d4a017', edge: '#f5d76e' };
    return { fill: '#1f9d55', edge: '#6ee7a8' };
  }

  /** 图片失败时的程序化背景，保证标注仍可见 */
  _markerDrawFallbackBg(ctx2d, type, width, height) {
    const color = this._markerAlertColor(type);
    const cx = width * 0.22;
    const cy = height * 0.42;
    const r = height * 0.28;

    ctx2d.clearRect(0, 0, width, height);

    const grad = ctx2d.createLinearGradient(cx, 0, width, 0);
    grad.addColorStop(0, color.fill);
    grad.addColorStop(1, 'rgba(0,0,0,0)');
    ctx2d.fillStyle = grad;
    ctx2d.fillRect(cx, cy - r * 0.55, width - cx, r * 1.1);

    ctx2d.beginPath();
    ctx2d.arc(cx, cy, r, 0, Math.PI * 2);
    ctx2d.fillStyle = color.fill;
    ctx2d.fill();
    ctx2d.lineWidth = Math.max(4, width * 0.012);
    ctx2d.strokeStyle = color.edge;
    ctx2d.stroke();

    ctx2d.beginPath();
    ctx2d.moveTo(cx - r * 0.35, cy + r * 0.75);
    ctx2d.lineTo(cx + r * 0.35, cy + r * 0.75);
    ctx2d.lineTo(cx, cy + r * 1.45);
    ctx2d.closePath();
    ctx2d.fillStyle = color.fill;
    ctx2d.fill();
  }

  _markerResolveAlertType(alertType) {
    const map = {
      urgent: 'urgent',
      red: 'urgent',
      warning: 'warning',
      yellow: 'warning',
      green: 'normal',
      normal: 'normal',
    };
    if (alertType == null || alertType === '') return 'normal';
    return map[String(alertType).trim().toLowerCase()] || 'normal';
  }

  _markerGetAsset(alertType) {
    const key = this._markerResolveAlertType(alertType);
    const assets = this.markerConfig.assets || {};
    return assets[key] || assets.normal || '';
  }

  _markerFormatLabel(code, count, labelMode) {
    const parts = this._markerLabelParts(code, count, labelMode);
    return `${parts.main}  ${parts.arrow}`;
  }

  /** 文案拆分：主文字 + 箭头，方便 DOM 分区样式 */
  _markerLabelParts(code, count, labelMode) {
    const name = code == null ? '' : String(code);
    let main = name;
    if (!(labelMode === 'name' || count == null || count === '')) {
      main = `${name}-${String(count).padStart(3, '0')}`;
    }
    return { main, arrow: '>' };
  }

  /** DOM 标注容器：背景为完整 PNG（含下方尖角），文字按圆形中线定位 */
  _markerDomShellStyle() {
    const cfg = this.markerConfig || {};
    const w = cfg.domWidth != null ? cfg.domWidth : 148;
    const h = cfg.domHeight != null ? cfg.domHeight : 80;
    return [
      'position:absolute',
      'transform:translate(-22%, -100%)',
      `width:${w}px`,
      `height:${h}px`,
      'background-size:100% 100%',
      'background-repeat:no-repeat',
      'background-position:center',
      'pointer-events:auto',
      'cursor:pointer',
      'box-sizing:border-box',
      'user-select:none',
      'filter:drop-shadow(0 2px 4px rgba(0,0,0,.28))',
    ].join(';');
  }

  _markerFillDomLabel(el, code, count, labelMode) {
    const parts = this._markerLabelParts(code, count, labelMode);
    const cfg = this.markerConfig || {};
    const fs = cfg.domFontSize != null ? cfg.domFontSize : 16;
    const lh = cfg.domLineHeight != null ? cfg.domLineHeight : 24;
    const fw = cfg.domFontWeight != null ? cfg.domFontWeight : 500;
    const ff =
      cfg.domFontFamily ||
      'SourceHanSansSC, "Source Han Sans SC", "Noto Sans SC", "PingFang SC", "Microsoft YaHei", sans-serif';
    const shadow = cfg.domTextShadow || '0px 2px 4px rgba(0,0,0,0.5)';
    const topPct = cfg.domTextTopPercent != null ? cfg.domTextTopPercent : 47;
    const imgW = cfg.imageWidth || 284;
    const textX = cfg.textX != null ? cfg.textX : 148;
    // 与 PNG 横幅文字起点比例一致（约 52%），避免硬编码 px 偏进圆内
    const leftPct = (textX / imgW) * 100;
    el.innerHTML = '';

    // 24×line-height 盒子中心对齐圆形水平中线（设计稿垂直居中）
    // +1px：补偿 text-shadow 向下扩散带来的视觉上浮
    const row = document.createElement('div');
    row.style.cssText = [
      'position:absolute',
      `left:${leftPct}%`,
      'right:6px',
      `top:${topPct}%`,
      'transform:translateY(calc(-50% + 1px))',
      'display:flex',
      'flex-direction:row',
      'align-items:center',
      `height:${lh}px`,
      `line-height:${lh}px`,
      'white-space:nowrap',
      'overflow:visible',
      'text-align:left',
      'font-style:normal',
      'box-sizing:border-box',
    ].join(';');

    const textStyle = [
      `font-family:${ff}`,
      `font-size:${fs}px`,
      `font-weight:${fw}`,
      `line-height:${lh}px`,
      'height:' + lh + 'px',
      'color:#FFFFFF',
      `text-shadow:${shadow}`,
      'text-align:left',
      'font-style:normal',
      'display:inline-block',
      'vertical-align:middle',
      '-webkit-font-smoothing:antialiased',
      'moz-osx-font-smoothing:grayscale',
    ].join(';');

    const main = document.createElement('span');
    main.textContent = parts.main;
    main.style.cssText = textStyle;

    const arrow = document.createElement('span');
    arrow.textContent = parts.arrow;
    // 设计稿箭头与正文同一套样式，间距约 4px
    arrow.style.cssText = `${textStyle};margin-left:4px;width:auto;`;

    row.appendChild(main);
    row.appendChild(arrow);
    el.appendChild(row);
    el.title = parts.main;
  }

  _markerPickProp(obj, paths) {
    if (!obj) return null;
    for (let i = 0; i < paths.length; i += 1) {
      if (obj[paths[i]] != null) return obj[paths[i]];
    }
    return null;
  }

  _markerLookLikeScene(v) {
    return !!(
      v &&
      typeof v === 'object' &&
      (v.isScene === true ||
        (v.type === 'Scene' && Array.isArray(v.children)) ||
        (typeof v.add === 'function' &&
          typeof v.remove === 'function' &&
          Array.isArray(v.children) &&
          v.uuid))
    );
  }

  _markerLookLikeCamera(v) {
    return !!(
      v &&
      (v.isCamera === true ||
        v.isPerspectiveCamera === true ||
        (v.type && String(v.type).includes('Camera')))
    );
  }

  _markerLookLikeRenderer(v) {
    return !!(v && v.domElement && typeof v.render === 'function');
  }

  _markerDeepFind(root, tester, maxDepth) {
    if (!root || typeof root !== 'object') return null;
    const seen = typeof WeakSet !== 'undefined' ? new WeakSet() : null;
    const queue = [{ obj: root, depth: 0 }];

    while (queue.length) {
      const cur = queue.shift();
      const { obj, depth } = cur;
      if (!obj || typeof obj !== 'object') continue;
      if (seen) {
        if (seen.has(obj)) continue;
        seen.add(obj);
      }
      if (tester(obj)) return obj;
      if (depth >= maxDepth) continue;

      if (Array.isArray(obj)) {
        for (let i = 0; i < obj.length && i < 30; i += 1) {
          queue.push({ obj: obj[i], depth: depth + 1 });
        }
      } else {
        const keys = Object.keys(obj);
        for (let k = 0; k < keys.length && k < 60; k += 1) {
          const key = keys[k];
          if (key === 'parent' || key.startsWith('__')) continue;
          if (key === 'children' && depth > 1) continue;
          try {
            queue.push({ obj: obj[key], depth: depth + 1 });
          } catch (e) {
            // ignore
          }
        }
      }
    }
    return null;
  }

  _markerApplyColorSpace(texture) {
    const THREE = this._markerGetTHREE();
    if (!texture || !THREE) return;
    if ('colorSpace' in texture && THREE.SRGBColorSpace != null) {
      texture.colorSpace = THREE.SRGBColorSpace;
    } else if ('encoding' in texture && THREE.sRGBEncoding != null) {
      texture.encoding = THREE.sRGBEncoding;
    }
  }

  /** 创建单个标注实例 */
  _markerCreate(item) {
    const THREE = this._markerGetTHREE();
    if (!THREE || typeof THREE.Sprite !== 'function' || typeof THREE.SpriteMaterial !== 'function') {
      throw new Error('[Marker] 当前环境无 Sprite 构造器，请走 DOM 模式');
    }
    if (typeof THREE.CanvasTexture !== 'function') {
      throw new Error('[Marker] 当前环境无 CanvasTexture');
    }

    const cfg = this.markerConfig;
    const W = cfg.imageWidth;
    const H = cfg.imageHeight;
    const S = cfg.scale;
    const worldWidth = item.worldWidth != null ? item.worldWidth : cfg.worldWidth;
    const labelMode = item.labelMode || 'nameCount';
    // 默认不被建筑挡住（配置 depthTest:false）
    const depthTest = cfg.depthTest === true;

    const canvas = document.createElement('canvas');
    canvas.width = W * S;
    canvas.height = H * S;
    const ctx2d = canvas.getContext('2d', { willReadFrequently: true });

    const texture = new THREE.CanvasTexture(canvas);
    this._markerApplyColorSpace(texture);
    texture.needsUpdate = true;

    const material = new THREE.SpriteMaterial({
      map: texture,
      transparent: true,
      depthTest,
      depthWrite: false,
      sizeAttenuation: true,
    });
    const sprite = new THREE.Sprite(material);
    sprite.center.set(cfg.anchorX, cfg.anchorY);
    sprite.scale.set(worldWidth, (H / W) * worldWidth, 1);
    sprite.position.set(item.position[0], item.position[1], item.position[2]);
    sprite.renderOrder = 999;

    const initialAlert = this._markerResolveAlertType(item.alertType);
    sprite.userData = {
      id: item.id,
      alertType: initialAlert,
      code: item.code,
      count: item.count != null ? item.count : null,
      labelMode,
      isMarker: true,
      canvas,
      useImageBg: false,
    };

    let currentBg = null; // 当前用于绘制的已加载 Image
    let bgReady = false;
    let loadToken = 0;

    const drawText = () => {
      const parts = this._markerLabelParts(
        sprite.userData.code,
        sprite.userData.count,
        sprite.userData.labelMode,
      );
      // Canvas：字号按设计 16px 映射到源图；垂直位置对齐圆形中心 textY
      const domFs = cfg.domFontSize != null ? cfg.domFontSize : 16;
      const domH = cfg.domHeight != null ? cfg.domHeight : 80;
      const fontPx = Math.round(domFs * (cfg.imageHeight / domH) * S);
      const fw = cfg.domFontWeight != null ? cfg.domFontWeight : 500;
      const fontFamily =
        cfg.domFontFamily ||
        'SourceHanSansSC, "Source Han Sans SC", "Noto Sans SC", "PingFang SC", "Microsoft YaHei", sans-serif';
      ctx2d.font = `${fw} ${fontPx}px ${fontFamily}`;
      ctx2d.textAlign = 'left';
      ctx2d.textBaseline = 'middle';

      const x = cfg.textX * S;
      const y = cfg.textY * S + S; // +1px 光学补偿，对齐设计稿
      const main = parts.main;

      // text-shadow: 0px 2px 4px rgba(0,0,0,0.5)
      ctx2d.shadowColor = 'rgba(0,0,0,0.5)';
      ctx2d.shadowBlur = 4 * S;
      ctx2d.shadowOffsetX = 0;
      ctx2d.shadowOffsetY = 2 * S;
      ctx2d.fillStyle = '#FFFFFF';
      ctx2d.fillText(main, x, y);

      const mainWidth = ctx2d.measureText(main).width;
      const arrowX = x + mainWidth + 4 * S;
      ctx2d.fillText(parts.arrow, arrowX, y);
      ctx2d.shadowBlur = 0;
      ctx2d.shadowOffsetY = 0;
    };

    const draw = () => {
      if (!bgReady) return;
      ctx2d.clearRect(0, 0, canvas.width, canvas.height);
      if (sprite.userData.useImageBg && currentBg) {
        try {
          ctx2d.drawImage(currentBg, 0, 0, canvas.width, canvas.height);
        } catch (err) {
          console.warn('[Marker] drawImage 失败，使用程序化兜底:', err);
          sprite.userData.useImageBg = false;
          this._markerDrawFallbackBg(
            ctx2d,
            sprite.userData.alertType,
            canvas.width,
            canvas.height,
          );
        }
      } else {
        this._markerDrawFallbackBg(
          ctx2d,
          sprite.userData.alertType,
          canvas.width,
          canvas.height,
        );
      }
      drawText();
      texture.needsUpdate = true;
    };

    const loadBackground = (type) => {
      const token = ++loadToken;
      bgReady = false;
      const url = this._markerGetAsset(type);
      console.log('[Marker] 加载背景', type, '→', url);

      return new Promise((resolve) => {
        const useFallback = () => {
          if (token !== loadToken) return;
          currentBg = null;
          sprite.userData.useImageBg = false;
          bgReady = true;
          draw();
          resolve();
        };

        if (!url) {
          console.warn('[Marker] 未配置 assets，使用程序化兜底:', type);
          useFallback();
          return;
        }

        // 每次换图新建 Image，避免 onload 竞态与缓存脏读
        const img = new Image();
        img.crossOrigin = 'anonymous';
        img.onload = () => {
          if (token !== loadToken) return;
          currentBg = img;
          sprite.userData.useImageBg = true;
          bgReady = true;
          draw();
          resolve();
        };
        img.onerror = () => {
          console.warn('[Marker] 背景图加载失败，使用程序化兜底:', url);
          useFallback();
        };
        img.src = url;
      });
    };

    const ready = loadBackground(initialAlert).then(() => sprite);

    return {
      sprite,
      ready,
      updateCount: (nextCount) => {
        sprite.userData.count = nextCount;
        draw();
      },
      updateAlertType: (nextAlertType) => {
        const normalized = this._markerResolveAlertType(nextAlertType);
        if (normalized === sprite.userData.alertType && bgReady) {
          return Promise.resolve(normalized);
        }
        sprite.userData.alertType = normalized;
        return loadBackground(normalized);
      },
      dispose: () => {
        if (material.map) material.map.dispose();
        material.dispose();
      },
    };
  }

  /** 挂载配置中的全部标注 + 绑定点击 */
  async _markerMountAll(ctx) {
    const { scene, camera, domElement, scenes } = ctx;
    const items = this.markerConfig.items || [];
    this._markers = [];
    const targetScenes =
      scenes && scenes.length ? scenes : scene ? [scene] : [];

    if (!targetScenes.length) {
      throw new Error('[Marker] 未找到可挂载的 THREE.Scene');
    }

    for (const item of items) {
      try {
        const marker = this._markerCreate(item);
        await marker.ready;
        // 主场景
        targetScenes[0].add(marker.sprite);
        marker._sceneCopies = [];
        // 其余场景各挂一份可见 Sprite（OpenView 常有 2 个 scene）
        for (let i = 1; i < targetScenes.length; i += 1) {
          const clone = marker.sprite.clone();
          clone.material = marker.sprite.material;
          clone.userData = marker.sprite.userData;
          clone.position.copy(marker.sprite.position);
          clone.scale.copy(marker.sprite.scale);
          clone.center.copy(marker.sprite.center);
          clone.renderOrder = 999;
          targetScenes[i].add(clone);
          marker._sceneCopies.push(clone);
        }
        this._markers.push(marker);
        console.log(
          '[Marker] 已添加',
          item.code,
          marker.sprite.position.toArray(),
          'scenes=',
          targetScenes.length,
        );
      } catch (err) {
        console.error('[Marker] 单项创建失败:', item && item.id, err);
      }
    }

    if (!this._markers.length) {
      throw new Error('[Marker] 没有任何标注挂载成功');
    }

    this._markerPointer = this._markerBindPointer({
      domElement,
      getCamera: () => (this._markerCtx && this._markerCtx.camera) || camera,
      getMarkers: () => this._markers,
      onClick: (info) => {
        console.log('[厂房标注点击]', info);
        if (info && info.code === 'X12') {
          this.goX12(null, { key: 1 });
        }
      },
    });
  }

  /**
   * HTML 叠加标注（OpenView 页面脚本通常没有 window.THREE，以此为主路径）
   * - 有 camera + Vector3.project → 按 3D 坐标投影
   * - 否则 → 按厂房在画布上均匀排布，保证一定可见
   */
  _markerMountDomOverlay(ctx) {
    const THREE = ctx.THREE || this._markerGetTHREE();
    let camera = ctx.camera;
    const canvas = ctx.domElement;
    if (!canvas || !this._markers.length) {
      console.warn('[Marker] DOM 叠加层跳过：缺少 canvas/markers');
      return;
    }

    if (this._markerDomLayer && this._markerDomLayer.parentNode) {
      this._markerDomLayer.parentNode.removeChild(this._markerDomLayer);
    }

    const parent = canvas.parentElement || document.body;
    const layer = document.createElement('div');
    layer.setAttribute('data-marker-overlay', '1');
    layer.style.cssText =
      'position:absolute;left:0;top:0;width:100%;height:100%;pointer-events:none;overflow:hidden;z-index:20;';
    if (getComputedStyle(parent).position === 'static') {
      parent.style.position = 'relative';
    }
    parent.appendChild(layer);
    this._markerDomLayer = layer;

    const nodes = this._markers.map((m, idx) => {
      const el = document.createElement('div');
      const ud = m.sprite.userData;
      const url = this._markerGetAsset(ud.alertType);
      el.style.cssText = this._markerDomShellStyle();
      if (url) el.style.backgroundImage = `url("${url}")`;
      else el.style.background = this._markerAlertColor(ud.alertType).fill;
      this._markerFillDomLabel(el, ud.code, ud.count, ud.labelMode);
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        console.log('[厂房标注点击-DOM]', ud);
        if (ud.code === 'X12') this.goX12(null, { key: 1 });
      });
      layer.appendChild(el);
      m.sprite._domEl = el;
      return { el, marker: m, idx };
    });

    const canProject = !!(
      camera &&
      THREE &&
      typeof THREE.Vector3 === 'function' &&
      typeof new THREE.Vector3().project === 'function'
    );

    let tmp = null;
    if (canProject) tmp = new THREE.Vector3();

    const layoutFallback = (node, rect, offsetX, offsetY) => {
      const n = nodes.length || 1;
      const x = offsetX + rect.width * (0.25 + (0.5 * node.idx) / Math.max(n - 1, 1));
      const y = offsetY + rect.height * 0.42;
      node.el.style.left = `${x}px`;
      node.el.style.top = `${y}px`;
      node.el.style.visibility = 'visible';
    };

    const tick = () => {
      this._markerRaf = requestAnimationFrame(tick);
      if (!this._markerDomLayer) return;
      const show = this.state.sceneIndex === 0;
      this._markerDomLayer.style.display = show ? 'block' : 'none';
      if (!show) return;

      // 运行中再次尝试找 camera（OpenView 可能晚于页面脚本就绪）
      if (!camera) {
        camera =
          this._markerFindCameraInObject(ctx.sceneMgr) ||
          this._markerFindCameraInObject(ctx.scene) ||
          this._markerFindCameraInObject(this._markerGetWebglPlayer());
        if (camera) ctx.camera = camera;
      }

      const rect = canvas.getBoundingClientRect();
      const parentRect = layer.parentElement.getBoundingClientRect();
      const offsetX = rect.left - parentRect.left;
      const offsetY = rect.top - parentRect.top;
      const projectNow = !!(
        camera &&
        tmp &&
        typeof tmp.project === 'function'
      );

      nodes.forEach((node) => {
        if (!projectNow) {
          layoutFallback(node, rect, offsetX, offsetY);
          return;
        }
        const pos = node.marker.sprite.position;
        tmp.set(pos.x, pos.y, pos.z);
        try {
          tmp.project(camera);
        } catch (e) {
          layoutFallback(node, rect, offsetX, offsetY);
          return;
        }
        const visible = tmp.z >= -1 && tmp.z <= 1;
        const x = ((tmp.x + 1) / 2) * rect.width + offsetX;
        const y = ((-tmp.y + 1) / 2) * rect.height + offsetY;
        node.el.style.left = `${x}px`;
        node.el.style.top = `${y}px`;
        node.el.style.visibility = visible ? 'visible' : 'hidden';
      });
    };
    tick();
    console.log('[Marker] DOM 叠加层已启用', nodes.length, canProject ? 'project' : 'layout');
  }

  _markerBindPointer(options) {
    const THREE = this._markerGetTHREE();
    const { domElement, getCamera, getMarkers, onClick } = options;
    const threshold =
      (this.markerConfig && this.markerConfig.clickMoveThreshold) != null
        ? this.markerConfig.clickMoveThreshold
        : 6;

    if (!domElement || !THREE) {
      return { unbind() {} };
    }

    const raycaster = new THREE.Raycaster();
    const pointerNdc = new THREE.Vector2();
    let pointerDown = null;
    domElement.style.touchAction = 'none';

    const setPointer = (event) => {
      const rect = domElement.getBoundingClientRect();
      pointerNdc.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
      pointerNdc.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
    };

    const isOpaque = (hit) => {
      const canvas = hit.object && hit.object.userData && hit.object.userData.canvas;
      const uv = hit.uv;
      if (!canvas || !uv) return true;
      const x = Math.min(canvas.width - 1, Math.max(0, Math.floor(uv.x * canvas.width)));
      const y = Math.min(
        canvas.height - 1,
        Math.max(0, Math.floor((1 - uv.y) * canvas.height)),
      );
      return canvas.getContext('2d').getImageData(x, y, 1, 1).data[3] > 16;
    };

    const pick = (event) => {
      const camera = getCamera();
      if (!camera) return null;
      setPointer(event);
      raycaster.setFromCamera(pointerNdc, camera);
      const sprites = getMarkers().map((m) => m.sprite);
      const hits = raycaster.intersectObjects(sprites, false);
      for (let i = 0; i < hits.length; i += 1) {
        const hit = hits[i];
        if (hit.object.userData && hit.object.userData.isMarker && isOpaque(hit)) {
          return hit.object;
        }
      }
      return null;
    };

    const onDown = (e) => {
      if (e.button != null && e.button !== 0) return;
      pointerDown = { x: e.clientX, y: e.clientY };
    };
    const onMove = (e) => {
      domElement.style.cursor = pick(e) ? 'pointer' : '';
    };
    const onUp = (e) => {
      if (!pointerDown) return;
      const moved = Math.hypot(e.clientX - pointerDown.x, e.clientY - pointerDown.y);
      pointerDown = null;
      if (moved > threshold) return;
      const sprite = pick(e);
      if (!sprite || typeof onClick !== 'function') return;
      onClick({
        id: sprite.userData.id,
        code: sprite.userData.code,
        count: sprite.userData.count,
        alertType: sprite.userData.alertType,
        labelMode: sprite.userData.labelMode,
        position: sprite.position.clone(),
        originalEvent: e,
      });
    };
    const onLeave = () => {
      pointerDown = null;
      domElement.style.cursor = '';
    };

    domElement.addEventListener('pointerdown', onDown);
    domElement.addEventListener('pointermove', onMove);
    domElement.addEventListener('pointerup', onUp);
    domElement.addEventListener('pointerleave', onLeave);

    return {
      unbind: () => {
        domElement.removeEventListener('pointerdown', onDown);
        domElement.removeEventListener('pointermove', onMove);
        domElement.removeEventListener('pointerup', onUp);
        domElement.removeEventListener('pointerleave', onLeave);
        pointerDown = null;
        domElement.style.cursor = '';
      },
    };
  }

  // ===========================================================================
  // WebSocket / 业务逻辑
  // ===========================================================================

  handleWss() {
    const url = 'ws://10.137.162.120:8088';
    this.ws = new WebSocket(`${url}/api/ws/realtime`);

    this.ws.onopen = () => {
      console.log('✅ WebSocket 连接已建立');
    };

    this.ws.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data);
        if (!msg || !msg.data) return;
        if (msg.topic === 'init_data') {
          this.applyInitData(msg.data);
          return;
        }
        if (msg.topic === 'ws_data') {
          this.applyWsData(msg.data);
        }
      } catch (error) {
        console.error('❌ 解析消息失败:', error);
      }
    };

    this.ws.onerror = () => {};
  }

  goX12(e, params) {
    if (params && params.key === 1) {
      this.setState({
        btnClass1: 'bottom-btn btn-background-click',
        sceneIndex: 1,
      });
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ topic: 'subscribe', buildingId: 12 }));
      }
      this.syncMarkerVisibleByScene();
    }
  }

  goHome() {
    this.setState({
      btnClass1: 'bottom-btn btn-background-click',
      sceneIndex: 0,
    });
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ topic: 'unsubscribe' }));
    }
    this.syncMarkerVisibleByScene();
  }

  runX12Open() {
    this.$('devanimation-95339045').runAnimation();
  }

  runX12Close() {
    this.$('devanimation-464782d2').runAnimation();
  }

  asObject(value) {
    return Object.prototype.toString.call(value) === '[object Object]' ? value : {};
  }

  hasOwn(obj, key) {
    return Object.prototype.hasOwnProperty.call(obj, key);
  }

  applyInitData(data) {
    const payload = this.asObject(data);
    this.setState({
      alarmStats: payload.alarmStats || {},
      disposalStats: payload.disposalStats || {},
      effluentList: payload.effluentList || {},
      overviewStats: payload.overviewStats || {},
      deviceTypes: payload.deviceTypes || {},
      inspectionStats: payload.inspectionStats || {},
      monitoringList: payload.monitoringList || [],
      operationLogList: payload.operationLogList || [],
      alarmList: payload.alarmList || [],
      inspectionList: payload.inspectionList || [],
      qtcList: payload.qtcList || {},
    });
    // buildingMarkers: [{ id, alertType, count }]
    this.applyBuildingMarkers(payload.buildingMarkers);
  }

  applyWsData(data) {
    const payload = this.asObject(data);
    if (!Object.keys(payload).length) return;

    const keys = [
      'alarmStats',
      'disposalStats',
      'effluentList',
      'overviewStats',
      'deviceTypes',
      'inspectionStats',
      'monitoringList',
      'operationLogList',
      'alarmList',
      'inspectionList',
      'qtcList',
    ];
    const next = {};
    keys.forEach((key) => {
      if (this.hasOwn(payload, key)) next[key] = payload[key];
    });
    if (Object.keys(next).length) this.setState(next);
    this.applyBuildingMarkers(payload.buildingMarkers);
  }
}
