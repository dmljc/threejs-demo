/**
 * OpenView 告警标注源码：整份复制到平台 index.js。
 * 使用 DOM + CSS mask 绘制标注，每帧将三维坐标投影到画布。
 */
class LowcodeComponent extends Component {
    state = {
      /**
       * 当前场景索引
       * 0 = 首页 / 大屏概览
       * 1 = X12 厂房
       */
      sceneIndex: 0,
      // 警告统计
      alarmStats: {},
      // 处置统计
      disposalStats: {},
      // 流出物
      effluentList: { X12: [], X03: [] },
      // 设备概览
      overviewStats: {},
      // 设备类型
      deviceTypes: {},
      // 设备点检
      inspectionStats: {},
      // 数据监测
      monitoringList: [],
      // 操作日志
      operationLogList: [],
      // 设备告警
      alarmList: [],
      // 设备定检
      inspectionList: [],
      // 流出物折线图
      qtcList: {},
      // 概览页告警标注（接口数据与模型坐标合并后的完整字段）
      overviewAlarmList: [],
      // X12 厂房告警标注（接口数据与模型坐标合并后的完整字段）
      x12AlarmList: [],
    };
  
    // 注意：OpenView 低代码运行时往往会丢掉除 state 以外的 class 字段
    // （日志已证实 this.markerConfig === undefined）。
    // 因此 markerConfig / _markers 等一律在方法里赋值，不要写 class 字段。
  
    // ===========================================================================
    // 生命周期
    // ===========================================================================
  
    /** 确保标注运行时字段存在（OpenView 不会保留 class 字段上的 markerConfig = {}） */
    _ensureMarkerRuntime() {
      if (!this.markerConfig) {
        this.markerConfig = {
          /** 标注外形剪影（白色实心 + 透明底），全类型共用 */
          mask:
            'https://openview.czy3d.com/czybucket/czy/tenant/openview/7738F2879717420B962C32CE221C69C9/2026/09/single.png',
          /** 告警类型 → CSS 背景色（与 StatusMarker.js ALERT_COLORS 对齐） */
          colors: {
            green: '#1f9d55',
            warning: '#d4a017',
            urgent: '#e11d2e',
          },
          /** 剪影源图尺寸（文字 left% / measureText 映射用，改图时同步） */
          imageWidth: 156,
          imageHeight: 197,
          /** 底部箭头中心占源图宽度比例，transform 用它对准投影点 */
          anchorX: 77 / 156,
          /** 短文案默认起点 X（相对源图像素）；长文案会按宽度自动左移 */
          textX: 52,
          /** 长文案允许的最左起点（圆帽右缘外侧） */
          textXMin: 44,
          /** 文案（含 >）右边缘上限，横幅右缘内侧留白 */
          textXMaxRight: 140,
          /** 源图测宽字号：DOM 与源图 1:1，与设计稿 16px 一致 */
          fontSize: 16,
          /** 设计稿固定：font-weight:500; font-size:16px; 不可随文案长短缩放 */
          domFontSize: 16,
          domLineHeight: 24,
          domFontWeight: 500,
          domFontFamily:
            'SourceHanSansSC, "Source Han Sans SC", "Noto Sans SC", "PingFang SC", "Microsoft YaHei", sans-serif',
          domTextShadow: '0px 2px 4px rgba(0,0,0,0.5)',
          /**
           * 文字垂直位置（相对 DOM 标注高度 %）
           * 对齐顶部胶囊中心约 12.2%（源图 y≈24 / 197）
           */
          domTextTopPercent: 12.2,
          /** DOM 标注显示尺寸（与源图 1:1，胶囊高度贴近 16px 字号） */
          domWidth: 156,
          domHeight: 197,
          /** 等场景/播放器就绪的延迟（ms），OpenView 启动较慢时可加大 */
          mountDelayMs: 800,
          /**
           * 可选：OpenView 中对应模型根节点的 name。
           * 留空时通过标注点与候选节点包围盒自动匹配。
           */
          modelRootNames: {
            overview: '',
            x12: '',
          },
          /** overview.fbx 告警点模型坐标，按接口 name 拼接 */
          overviewMarkerPositions: {
            X06: [66, 20, -91],
            X03: [-112, 21, -116],
            X02: [-128, 16, 95],
            X12: [64, 28, 80],
          },
          /** X12.fbx 告警点模型坐标，按接口 name 拼接 */
          x12MarkerPositions: {
            F1: [12, 16, -11],
            F2: [23, 16, -20],
            F3: [35, 16, -13],
          },
          /** 接口数据与坐标合并后的运行时列表 */
          overviewAlarmList: [],
          x12AlarmList: [],
        };
      }
      // 以下运行时字段也不能写在 class 上，统一在此兜底初始化
      if (!this._markers) this._markers = []; // 标注实例列表
      if (this._markerDomLayer === undefined) this._markerDomLayer = null; // DOM 叠加层根节点
      if (this._markerRaf === undefined) this._markerRaf = 0; // 投影 RAF id
      if (this._markerSwitchTimer === undefined) this._markerSwitchTimer = 0;
      if (this._markerInitId === undefined) this._markerInitId = 0;
      if (this._markerInitRunning === undefined) this._markerInitRunning = false;
      return this.markerConfig;
    }
  
    /** 组件挂载：先连 WS，再初始化标注 */
    componentDidMount() {
      this._ensureMarkerRuntime();
      this.handleWss();
      this.initStatusMarkers();
    }
  
    /** 组件卸载：销毁标注与 WebSocket */
    componentWillUnmount() {
      if (this._markerSwitchTimer) {
        clearTimeout(this._markerSwitchTimer);
        this._markerSwitchTimer = 0;
      }
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
  
    /** 等场景就绪后创建 DOM 标注并启动投影。 */
    async initStatusMarkers() {
      const cfg = this._ensureMarkerRuntime();
      const initId = ++this._markerInitId;
      this._markerInitRunning = true;
      this._markers = [];
      const delay = (cfg && cfg.mountDelayMs) || 0;
      // OpenView 场景/播放器可能晚于页面脚本就绪，先短暂等待
      if (delay > 0) {
        await new Promise((r) => setTimeout(r, delay));
      }
  
      try {
        const ctx = await this._markerWhenReady(30000);
        // 场景切换期间旧的异步初始化结果直接丢弃
        if (initId !== this._markerInitId) return;
        this._markerMountVirtualMarkers(ctx);
        this._markerMountDomOverlay(ctx);
        this.syncMarkerVisibleByScene();
        this._markerInitRunning = false;
      } catch (err) {
        if (initId === this._markerInitId) this._markerInitRunning = false;
        console.error('[Marker] 挂载失败:', err);
        this._markerDebugContext();
      }
    }
  
    /**
     * 保留接口全部字段，并按 name 拼接模型坐标。
     * 接口已返回 position 时优先使用接口坐标。
     */
    _markerMergeAlarmPositions(list, positionMap) {
      if (!Array.isArray(list)) return [];
      const positions = positionMap || {};
      return list.map((item) => {
        const source = this.asObject(item);
        const position =
          Array.isArray(source.position) && source.position.length >= 3
            ? source.position.slice(0, 3)
            : positions[source.name];
        return {
          ...source,
          position: position ? [...position] : [0, 0, 0],
        };
      });
    }

    /** 将 WS 增量按 name 合并到现有完整列表，不替换或重建标注。 */
    _markerMergeAlarmUpdates(current, updates, positionMap) {
      const byName = new Map(
        (Array.isArray(current) ? current : []).map((item) => [item.name, item]),
      );
      (Array.isArray(updates) ? updates : []).forEach((item) => {
        const source = this.asObject(item);
        const previous = byName.get(source.name) || {};
        byName.set(source.name, { ...previous, ...source });
      });
      return this._markerMergeAlarmPositions(
        Array.from(byName.values()),
        positionMap,
      );
    }

    /** 根据当前场景返回已拼接坐标的报警列表，name 为唯一键。 */
    _markerGetAlarmList() {
      const cfg = this.markerConfig || {};
      return this.state.sceneIndex === 1
        ? cfg.x12AlarmList || []
        : cfg.overviewAlarmList || [];
    }
  
    /** 统计节点及其子级中的 Mesh 数量。 */
    _markerCountMeshes(root) {
      if (!root) return 0;
      let count = root.isMesh ? 1 : 0;
      if (typeof root.traverse === 'function') {
        root.traverse((node) => {
          if (node !== root && node && node.isMesh) count += 1;
        });
      }
      return count;
    }
  
    /** 按 name 精确查找模型根节点。 */
    _markerFindNodeByName(scene, name) {
      if (!scene || !name) return null;
      let found = null;
      if (typeof scene.traverse === 'function') {
        scene.traverse((node) => {
          if (!found && node && node.name === name) found = node;
        });
      }
      return found;
    }
  
    /**
     * 找出承载当前 FBX 的顶层节点。
     * 优先使用配置名称；否则选择“能容纳最多标注点且世界包围盒最小”的候选节点。
     * 这样不会误选 Mesh 更多但体积巨大的背景环境。
     */
    _markerFindModelRoot(scene, items, THREE) {
      if (!scene || !Array.isArray(scene.children)) return scene;
      const cfg = this.markerConfig || {};
      const names = cfg.modelRootNames || {};
      const configuredName =
        this.state.sceneIndex === 1 ? names.x12 : names.overview;
      const configured = this._markerFindNodeByName(scene, configuredName);
      if (configured) return configured;
  
      const candidates = scene.children.filter(
        (child) =>
          child &&
          !child.isCamera &&
          !child.isLight &&
          !child.isHelper &&
          typeof child.localToWorld === 'function' &&
          this._markerCountMeshes(child) > 0,
      );
      if (!candidates.length) return scene;
  
      if (
        !THREE ||
        typeof THREE.Box3 !== 'function' ||
        typeof THREE.Vector3 !== 'function'
      ) {
        return candidates.length === 1 ? candidates[0] : scene;
      }
  
      const localPositions = (items || []).map(
        (item) => item.position || [0, 0, 0],
      );
      let best = null;
      candidates.forEach((node) => {
        try {
          if (typeof node.updateMatrixWorld === 'function') {
            node.updateMatrixWorld(true);
          }
          const box = new THREE.Box3().setFromObject(node);
          if (box.isEmpty()) return;
          const size = box.getSize(new THREE.Vector3());
          const diagonal =
            typeof size.length === 'function'
              ? size.length()
              : Math.hypot(size.x, size.y, size.z);
          // 标注尖角允许略高于模型包围盒顶部。
          const margin = Math.max(size.x, size.y, size.z, 1) * 0.08;
          let contained = 0;
          localPositions.forEach((position) => {
            const point = new THREE.Vector3(
              position[0],
              position[1],
              position[2],
            );
            node.localToWorld(point);
            if (
              point.x >= box.min.x - margin &&
              point.x <= box.max.x + margin &&
              point.y >= box.min.y - margin &&
              point.y <= box.max.y + margin &&
              point.z >= box.min.z - margin &&
              point.z <= box.max.z + margin
            ) {
              contained += 1;
            }
          });
          const candidate = { node, contained, diagonal };
          if (
            !best ||
            candidate.contained > best.contained ||
            (candidate.contained === best.contained &&
              candidate.diagonal < best.diagonal)
          ) {
            best = candidate;
          }
        } catch (error) {
          console.warn('[Marker] 模型根节点候选计算失败', error);
        }
      });
  
      if (!best || best.contained === 0) return scene;
      console.log('[Marker] 模型根节点', {
        sceneIndex: this.state.sceneIndex,
        name: best.node.name || '(unnamed)',
        uuid: best.node.uuid,
        markerHits: `${best.contained}/${localPositions.length}`,
        diagonal: best.diagonal,
      });
      return best.node;
    }
  
    /**
     * 创建虚拟标注锚点（DOM-only 核心数据源）
     * - 不创建真实 THREE.Sprite，只用 { position, userData } 结构兼容后续投影代码
     * - updateCount / updateType 会同步刷新对应 DOM 节点
     */
    _markerMountVirtualMarkers(ctx) {
      const items = this._markerGetAlarmList();
      const THREE = ctx.THREE || this._markerGetTHREE();
      const modelRoot = this._markerFindModelRoot(ctx.scene, items, THREE);
      if (modelRoot && typeof modelRoot.updateMatrixWorld === 'function') {
        modelRoot.updateMatrixWorld(true);
      }
      this._markers = items.map((item) => {
        const local = item.position || [0, 0, 0];
        let pos = local;
        if (
          modelRoot &&
          modelRoot !== ctx.scene &&
          typeof modelRoot.localToWorld === 'function' &&
          THREE &&
          typeof THREE.Vector3 === 'function'
        ) {
          const world = new THREE.Vector3(local[0], local[1], local[2]);
          modelRoot.localToWorld(world);
          pos = [world.x, world.y, world.z];
        }
        const type = this._markerResolveType(item.color || item.type);
        const userData = {
          type,
          color: item.color || null,
          name: item.name,
          count: item.count != null ? item.count : null,
          isMarker: true,
        };
        // 命名沿用 sprite，便于 _markerMountDomOverlay 复用同一套读取逻辑
        const sprite = {
          position: { x: pos[0], y: pos[1], z: pos[2], toArray: () => [pos[0], pos[1], pos[2]] },
          visible: true,
          userData,
        };
        return {
          sprite,
          /** WS 推送数量时重绘 DOM 文案 */
          updateCount: (nextCount) => {
            if (userData.count === nextCount) return;
            userData.count = nextCount;
            if (sprite._domEl) {
              this._markerFillDomLabel(
                sprite._domEl,
                userData.name,
                userData.count,
              );
            }
          },
          /** WS 推送告警类型时切换背景色 */
          updateType: (nextType) => {
            const normalized = this._markerResolveType(nextType);
            if (userData.type === normalized) return;
            userData.type = normalized;
            if (sprite._domEl) {
              this._markerPaintDomSkin(sprite._domEl, userData.type);
            }
          },
        };
      });
    }
  
    /** 当前场景的标注层保持显示，列表由 sceneIndex 决定。 */
    syncMarkerVisibleByScene() {
      if (this._markerDomLayer) {
        this._markerDomLayer.style.display = 'block';
      }
    }
  
    /**
     * 等 OpenView 完成页面/三维场景切换后，重新绑定当前 Scene、相机和画布。
     * 延迟可避免拿到切换前的 webglPlayer。
     */
    _refreshMarkersAfterSceneChange() {
      if (this._markerSwitchTimer) clearTimeout(this._markerSwitchTimer);
      this._markerSwitchTimer = setTimeout(() => {
        this._markerSwitchTimer = 0;
        this.destroyStatusMarkers();
        this.initStatusMarkers();
      }, 300);
    }
  
    /**
     * WS 推送同步标注数量 / 告警色（按 name 匹配）
     * @param {Array<{ name: string, type?: string, color?: string, count?: number|string }>} list
     */
    applyBuildingMarkers(list) {
      if (!Array.isArray(list) || !list.length || !this._markers.length) return;
      list.forEach((item) => {
        const target = this._markers.find((m) => m.sprite.userData.name === item.name);
        if (!target) return;
        if (item.count != null) target.updateCount(item.count);
        if (item.color != null || item.type != null) {
          target.updateType(item.color || item.type);
        }
      });
    }
  
    /** 销毁标注：停 RAF、移除 DOM 层、清空实例 */
    destroyStatusMarkers() {
      this._markerInitId += 1;
      this._markerInitRunning = false;
      if (this._markerRaf) {
        cancelAnimationFrame(this._markerRaf);
        this._markerRaf = 0;
      }
      if (this._markerDomLayer && this._markerDomLayer.parentNode) {
        this._markerDomLayer.parentNode.removeChild(this._markerDomLayer);
      }
      this._markerDomLayer = null;
      this._markers = [];
    }
  
    // ===========================================================================
    // 厂房标注 · 内部实现（_marker 前缀）
    // 场景探测 → 文案/样式 → DOM 投影
    // ===========================================================================
  
    /**
     * 从 sceneMgr 上尽量找出三维播放器（字段名因 OpenView 版本而异）
     * @returns {object|null}
     */
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
  
    /** 判断是否具备 DOM 投影所需的 THREE 能力（至少 Vector3） */
    _markerLookLikeTHREE(v) {
      return !!(v && typeof v === 'object' && typeof v.Vector3 === 'function');
    }
  
    /**
     * 无 window.THREE 时，从 scene.position 借用 Vector3 构造器（供 DOM 投影）
     */
    _markerBuildCompatTHREE(scene) {
      if (!scene || !scene.position || typeof scene.position.constructor !== 'function') {
        return null;
      }
      const Vector3 = scene.position.constructor;
      try {
        new Vector3();
      } catch (e) {
        return null;
      }
      return {
        Vector3,
        Box3: null,
        _compat: true,
      };
    }
  
    /**
     * 解析 THREE：优先 window.THREE，其次缓存的兼容对象，再深度搜索播放器/sceneMgr
     * @returns {object|null}
     */
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
  
    /**
     * 在对象树上查找相机（traverse 或深度扫描）
     * @param {object} root
     * @returns {object|null}
     */
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
      // 优先采用播放器当前激活 Scene；取不到时按 sceneIndex 选两个候选场景。
      const activeScene = this._markerPickProp(
        player,
        ['scene', 'threeScene', 'rootScene'],
      );
      const activeMeta = scenes.find((item) => item.scene === activeScene);
      const best =
        activeMeta ||
        scenes[Math.min(this.state.sceneIndex, Math.max(scenes.length - 1, 0))] ||
        scenes[0] ||
        null;
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
  
    /** 控制台打印当前解析到的 THREE / player / context，挂载失败时排查用 */
    _markerDebugContext() {
      const ctx = this._markerGetContext();
      console.log('[Marker] THREE=', !!this._markerGetTHREE(), this._markerGetTHREE());
      console.log('[Marker] webglPlayer=', !!this._markerGetWebglPlayer());
      console.log('[Marker] context=', ctx);
      return ctx;
    }
  
    /**
     * 等待场景就绪（DOM-only：有 scene 即可；尽量带上 Vector3 供投影）
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
            // 有 Vector3 立刻就绪；否则最多等 1.5s（仍可走无投影的 layout 兜底）
            if (THREE && typeof THREE.Vector3 === 'function') {
              resolve(ctx);
              return;
            }
            if (Date.now() - start >= 1500) {
              console.warn('[Marker] 无 Vector3，DOM 将使用均匀布局兜底', {
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
  
    /** 告警类型对应填充色（urgent 红 / warning 黄 / green 绿） */
    _markerAlertColor(type) {
      const key = this._markerResolveType(type);
      if (
        typeof key === 'string' &&
        (/^#([0-9a-f]{3,8})$/i.test(key) ||
          /^(rgb|hsl)a?\(/i.test(key))
      ) {
        return { fill: key, edge: key };
      }
      const colors = (this.markerConfig && this.markerConfig.colors) || {};
      if (colors[key]) return { fill: colors[key], edge: colors[key] };
      if (key === 'urgent') return { fill: '#e11d2e', edge: '#ff6b6b' };
      if (key === 'warning') return { fill: '#d4a017', edge: '#f5d76e' };
      return { fill: '#1f9d55', edge: '#6ee7a8' };
    }
  
    /**
     * 业务告警类型标准化为 green | warning | urgent。
     * 兼容旧值 normal 及 red/yellow 别名。
     */
    _markerResolveType(type) {
      const value = type == null ? '' : String(type).trim();
      if (
        /^#([0-9a-f]{3,8})$/i.test(value) ||
        /^(rgb|hsl)a?\(/i.test(value)
      ) {
        return value;
      }
      const map = {
        urgent: 'urgent',
        red: 'urgent',
        warning: 'warning',
        yellow: 'warning',
        green: 'green',
        normal: 'green',
      };
      if (!value) return 'green';
      return map[value.toLowerCase()] || 'green';
    }
  
    /** 剪影 mask URL（全类型共用） */
    _markerGetMaskUrl() {
      const cfg = this.markerConfig || {};
      return cfg.mask || '';
    }
  
    /**
     * 用 CSS mask + background-color 给标注上色
     * 剪影与文字分层：mask 不裁切文案；drop-shadow 放在 mask 外层以免 WebKit 失效
     * @param {HTMLElement} el 标注外壳
     * @param {string} type 告警类型
     */
    _markerPaintDomSkin(el, type) {
      const color = this._markerAlertColor(type).fill;
      const mask = this._markerGetMaskUrl();
      let wrap = el.querySelector('[data-marker-bg-wrap]');
      let bg = el.querySelector('[data-marker-bg]');
      if (!wrap || !bg) {
        wrap = document.createElement('div');
        wrap.setAttribute('data-marker-bg-wrap', '1');
        wrap.style.cssText =
          'position:absolute;inset:0;pointer-events:none;filter:drop-shadow(0 2px 4px rgba(0,0,0,.28));';
        bg = document.createElement('div');
        bg.setAttribute('data-marker-bg', '1');
        bg.style.cssText = [
          'position:absolute',
          'inset:0',
          'background-repeat:no-repeat',
          'background-position:center',
          'background-size:100% 100%',
          '-webkit-mask-repeat:no-repeat',
          'mask-repeat:no-repeat',
          '-webkit-mask-position:center',
          'mask-position:center',
          '-webkit-mask-size:100% 100%',
          'mask-size:100% 100%',
          'mask-mode:alpha',
        ].join(';');
        wrap.appendChild(bg);
        el.insertBefore(wrap, el.firstChild);
      }
      bg.style.backgroundColor = color;
      if (mask) {
        const maskCss = `url("${mask}")`;
        bg.style.webkitMaskImage = maskCss;
        bg.style.maskImage = maskCss;
        bg.style.backgroundImage = 'none';
      } else {
        bg.style.webkitMaskImage = 'none';
        bg.style.maskImage = 'none';
        bg.style.backgroundImage = 'none';
      }
    }
  
    /**
     * 拆分标注文案：主文字 + 箭头
     * 无 count → { main:'X01', arrow:'>' }；有 count → { main:'X01-012', arrow:'>' }
     */
    _markerLabelParts(name, count) {
      const mainName = name == null ? '' : String(name);
      if (count == null || count === '') {
        return { main: mainName, arrow: '>' };
      }
      return { main: `${mainName}-${String(count).padStart(3, '0')}`, arrow: '>' };
    }
  
    /**
     * DOM 标注外壳样式（整张剪影含尖角）
     * transform: translate(-anchorX%, -100%) ≈ 底部箭头对准投影点
     */
    _markerDomShellStyle() {
      const cfg = this.markerConfig || {};
      const w = cfg.domWidth != null ? cfg.domWidth : 156;
      const h = cfg.domHeight != null ? cfg.domHeight : 197;
      const ax = cfg.anchorX != null ? cfg.anchorX : 77 / 156;
      return [
        'position:absolute',
        `transform:translate(${-(ax * 100).toFixed(2)}%, -100%)`,
        `width:${w}px`,
        `height:${h}px`,
        'pointer-events:auto',
        'cursor:pointer',
        'box-sizing:border-box',
        'user-select:none',
      ].join(';');
    }
  
    /**
     * 短文案保持 textX；长文案左移，避免「>」落到横幅淡出区外
     * 字号固定 16px / 字重 500，不缩小
     */
    _markerResolveTextX(measureCtx, main, arrow, scale) {
      const cfg = this.markerConfig || {};
      const S = scale != null ? scale : 1;
      const preferred = (cfg.textX != null ? cfg.textX : 52) * S;
      const minX = (cfg.textXMin != null ? cfg.textXMin : 44) * S;
      const maxRight = (cfg.textXMaxRight != null ? cfg.textXMaxRight : 140) * S;
      const gap = 6 * S;
      if (!measureCtx || typeof measureCtx.measureText !== 'function') {
        return preferred;
      }
      const total =
        measureCtx.measureText(main).width +
        gap +
        measureCtx.measureText(arrow).width;
      if (preferred + total <= maxRight) return preferred;
      return Math.max(minX, maxRight - total);
    }
  
    /**
     * 填充 DOM 标注文字（主文案 + >）
     * 先按源图坐标系测宽算 left%，再以设计稿 16px/500 渲染
     * @param {HTMLElement} el 标注外壳节点
     * @param {string} name 厂房名称
     * @param {number|string|null} count 数量；有值则展示 name-count
     */
    _markerFillDomLabel(el, name, count) {
      const parts = this._markerLabelParts(name, count);
      const cfg = this.markerConfig || {};
      // 设计稿固定：font-size:16px; font-weight:500;
      const fs = cfg.domFontSize != null ? cfg.domFontSize : 16;
      const lh = cfg.domLineHeight != null ? cfg.domLineHeight : 24;
      const fw = cfg.domFontWeight != null ? cfg.domFontWeight : 500;
      const ff =
        cfg.domFontFamily ||
        'SourceHanSansSC, "Source Han Sans SC", "Noto Sans SC", "PingFang SC", "Microsoft YaHei", sans-serif';
      const shadow = cfg.domTextShadow || '0px 2px 4px rgba(0,0,0,0.5)';
      const topPct = cfg.domTextTopPercent != null ? cfg.domTextTopPercent : 12.2;
      const imgW = cfg.imageWidth || 156;
      const imgH = cfg.imageHeight || 197;
      const domH = cfg.domHeight != null ? cfg.domHeight : 197;
      const domW = cfg.domWidth != null ? cfg.domWidth : 156;
      const prevLabel = el.querySelector('[data-marker-label]');
      if (prevLabel) prevLabel.remove();
  
      // 用离屏 canvas 按源图固定字号测宽，再映射左偏移（字号本身不变）
      const measure = document.createElement('canvas').getContext('2d');
      const srcFs =
        cfg.fontSize != null
          ? cfg.fontSize
          : Math.round(fs * (imgH / domH));
      measure.font = `${fw} ${srcFs}px ${ff}`;
      const textX = this._markerResolveTextX(measure, parts.main, parts.arrow, 1);
      const leftPct = (textX / imgW) * 100;
      const maxRight = cfg.textXMaxRight != null ? cfg.textXMaxRight : 140;
      const rightPx = Math.max(4, Math.round(domW * (1 - maxRight / imgW)));
  
      // 24×line-height 盒子中心对齐圆形水平中线（设计稿垂直居中）
      // +1px：补偿 text-shadow 向下扩散带来的视觉上浮
      const row = document.createElement('div');
      row.setAttribute('data-marker-label', '1');
      row.style.cssText = [
        'position:absolute',
        `left:${leftPct}%`,
        `right:${rightPx}px`,
        `top:${topPct}%`,
        'transform:translateY(calc(-50% + 1px))',
        'display:flex',
        'flex-direction:row',
        'align-items:center',
        `height:${lh}px`,
        `line-height:${lh}px`,
        'white-space:nowrap',
        'overflow:visible',
        'z-index:1',
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
      // 设计稿箭头与正文同一套样式，间距约 6px
      arrow.style.cssText = `${textStyle};margin-left:6px;width:auto;`;
  
      row.appendChild(main);
      row.appendChild(arrow);
      el.appendChild(row);
      el.title = parts.main;
    }
  
    /** 按候选字段名依次取值，命中即返回 */
    _markerPickProp(obj, paths) {
      if (!obj) return null;
      for (let i = 0; i < paths.length; i += 1) {
        if (obj[paths[i]] != null) return obj[paths[i]];
      }
      return null;
    }
  
    /** 判断对象是否像 THREE.Scene */
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
  
    /** 判断对象是否像相机 */
    _markerLookLikeCamera(v) {
      return !!(
        v &&
        (v.isCamera === true ||
          v.isPerspectiveCamera === true ||
          (v.type && String(v.type).includes('Camera')))
      );
    }
  
    /** 判断对象是否像 WebGLRenderer（有 domElement + render） */
    _markerLookLikeRenderer(v) {
      return !!(v && v.domElement && typeof v.render === 'function');
    }
  
    /**
     * BFS 深度搜索对象树，查找满足 tester 的节点（限制深度与分支数，避免卡死）
     * @param {object} root
     * @param {(v: any) => boolean} tester
     * @param {number} maxDepth
     */
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
  
    /**
     * HTML 叠加标注（主路径：显示 + 点击）
     * - 有 camera + Vector3.project → 每帧把 3D 锚点投到屏幕
     * - 否则 → 画布上均匀排布，保证一定可见
     * - 层 pointer-events:none，单个标注 pointer-events:auto，避免挡场景拖拽
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
      // 覆盖三维画布同级区域；自身不接收事件，交给子标注
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
        el.style.cssText = this._markerDomShellStyle();
        this._markerPaintDomSkin(el, ud.type);
        this._markerFillDomLabel(el, ud.name, ud.count);
        el.addEventListener('click', (e) => {
          e.stopPropagation();
          console.log('[厂房标注点击-DOM]', ud);
          // 业务：点击 X12 进入厂房场景
          if (ud.name === 'X12') this.goX12(null, { key: 1 });
        });
        layer.appendChild(el);
        // 回挂 DOM 节点，供 updateCount / updateType 刷新
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
  
      /** 无相机/投影失败时：在画布中部横向均匀排布 */
      const layoutFallback = (node, rect, offsetX, offsetY) => {
        const n = nodes.length || 1;
        const x = offsetX + rect.width * (0.25 + (0.5 * node.idx) / Math.max(n - 1, 1));
        const y = offsetY + rect.height * 0.42;
        node.el.style.left = `${x}px`;
        node.el.style.top = `${y}px`;
        node.el.style.visibility = 'visible';
      };
  
      /** 每帧把当前场景的世界坐标投影为屏幕 left/top。 */
      const tick = () => {
        this._markerRaf = requestAnimationFrame(tick);
        if (!this._markerDomLayer) return;
  
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
          // NDC → 屏幕像素；z 超出 [-1,1] 视为在视锥外，隐藏
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
  
    // ===========================================================================
    // WebSocket / 业务逻辑（大屏数据与场景切换）
    // ===========================================================================
  
    /** 连接实时 WebSocket，接收 init_data / ws_data */
    handleWss() {
      // const url = 'ws://10.137.162.120:8088';
      const url = 'ws://192.168.1.2:8088';
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
  
      this.ws.onerror = () => { };
    }
  
    /**
     * 进入 X12 厂房场景（标注点击或底部按钮）
     * @param {*} _e
     * @param {{ key?: number }} params key===1 时切换
     */
    goX12(e, params) {
      if (params && params.key === 1) {
        this.setState({
          sceneIndex: 1,
        });
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
          this.ws.send(JSON.stringify({ topic: 'subscribe', buildingId: 12 }));
        }
        this._refreshMarkersAfterSceneChange();
      }
    }
  
    /** 返回首页大屏，取消厂房订阅并重新显示标注 */
    goHome() {
      this.setState({
        sceneIndex: 0,
      });
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ topic: 'unsubscribe' }));
      }
      this._refreshMarkersAfterSceneChange();
    }
  
    /** 触发 X12 开门动画（平台动画组件 id） */
    runX12Open() {
      this.$('devanimation-95339045').runAnimation();
    }
  
    /** 触发 X12 关门动画 */
    runX12Close() {
      this.$('devanimation-464782d2').runAnimation();
    }

    /** 保留按钮事件入口，不再切换选中/非选中样式。 */
    onX12Close() {
      this.runX12Close();
    }

    onX12Open() {
      this.runX12Open();
    }

    onX12F1() {}

    onX12F2() {}

    onX12F3() {}
  
    /** 安全转普通对象，非 object 返回 {} */
    asObject(value) {
      return Object.prototype.toString.call(value) === '[object Object]' ? value : {};
    }
  
    hasOwn(obj, key) {
      return Object.prototype.hasOwnProperty.call(obj, key);
    }
  
    /** 处理 WS 全量初始化数据，并将接口告警与模型坐标合并。 */
    applyInitData(data) {
      const payload = this.asObject(data);
      const cfg = this._ensureMarkerRuntime();
      const overviewAlarmList = this._markerMergeAlarmPositions(
        payload.overviewAlarmList,
        cfg.overviewMarkerPositions,
      );
      const x12AlarmList = this._markerMergeAlarmPositions(
        payload.x12AlarmList,
        cfg.x12MarkerPositions,
      );
      // markerConfig 是标注运行时数据源，必须同步写入，不能只 setState。
      cfg.overviewAlarmList = overviewAlarmList;
      cfg.x12AlarmList = x12AlarmList;
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
        overviewAlarmList,
        x12AlarmList,
      });
      this._refreshMarkersAfterSceneChange();
    }
  
    /** 处理 WS 增量推送，并同步完整告警列表或局部 buildingMarkers。 */
    applyWsData(data) {
      const payload = this.asObject(data);
      if (!Object.keys(payload).length) return;
      const cfg = this._ensureMarkerRuntime();
  
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
      let currentAlarmList = null;
      let currentAlarmUpdates = null;
      if (this.hasOwn(payload, 'overviewAlarmList')) {
        const list = this._markerMergeAlarmUpdates(
          cfg.overviewAlarmList,
          payload.overviewAlarmList,
          cfg.overviewMarkerPositions,
        );
        cfg.overviewAlarmList = list;
        next.overviewAlarmList = list;
        if (this.state.sceneIndex === 0) {
          currentAlarmList = list;
          currentAlarmUpdates = payload.overviewAlarmList;
        }
      }
      if (this.hasOwn(payload, 'x12AlarmList')) {
        const list = this._markerMergeAlarmUpdates(
          cfg.x12AlarmList,
          payload.x12AlarmList,
          cfg.x12MarkerPositions,
        );
        cfg.x12AlarmList = list;
        next.x12AlarmList = list;
        if (this.state.sceneIndex === 1) {
          currentAlarmList = list;
          currentAlarmUpdates = payload.x12AlarmList;
        }
      }
      if (Object.keys(next).length) this.setState(next);
      if (currentAlarmList) {
        // 标注未挂载时只触发一次初始化；挂载后永不因实时推送重建 DOM。
        if (
          !this._markers.length &&
          !this._markerInitRunning &&
          !this._markerSwitchTimer
        ) {
          this._refreshMarkersAfterSceneChange();
        } else {
          this.applyBuildingMarkers(currentAlarmUpdates);
        }
      }
      this.applyBuildingMarkers(payload.buildingMarkers);
    }
  }
  