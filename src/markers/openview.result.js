/**
 * OpenView 告警标注源码：整份复制到平台 index.js。
 * 使用 DOM + CSS mask 绘制标注，每帧将三维坐标投影到画布。
 */
class LowcodeComponent extends Component {
  state = {
    btnClassoOverView: 'bottom-btn btn-background-click',

    btnClassX12Close: 'bottom-btn btn-background-click',
    btnClassX12Open: 'bottom-btn btn-background-unclick',
    btnClassX12F1: 'bottom-btn btn-background-unclick',
    btnClassX12F2: 'bottom-btn btn-background-unclick',
    btnClassX12F3: 'bottom-btn btn-background-unclick',
    btnClassX12Pipe: 'bottom-btn btn-background-unclick',
    /**
     * 当前场景索引
     * 0 = 首页 / 大屏概览
     * 1 = X12 厂房
     * 刷新必须在首帧就是 1。若从 0 起画，播放器会先绑概览模型，之后 setState 只改 UI 和标注。
     */
    sceneIndex: this._getWsTargetBuildingId() === 12 ? 1 : 0,
    alarmStats: {}, // 警告统计
    disposalStats: {}, // 处置统计
    effluentList: { X12: [], X03: [] }, // 流出物
    overviewStats: {}, // 设备概览
    deviceTypes: {}, // 设备类型
    inspectionStats: {}, // 设备点检
    monitoringList: [], // 数据监测
    operationLogList: [], // 操作日志
    alarmList: [], // 设备告警
    inspectionList: [], // 设备定检
    qtcList: {}, // 流出物折线图
    overviewAlarmList: [], // 概览页告警标注（接口数据与模型坐标合并后的完整字段）
    floorAlarmList: [], // X12 厂房楼层告警标注（接口 floorAlarmList 与模型坐标合并）
    httpBaseUrl: 'https://115111ob8gw23.vicp.fun',
  };

  // 注意：OpenView 低代码运行时往往会丢掉除 state 以外的 class 字段
  // （日志已证实 this.markerConfig === undefined）。
  // 因此 markerConfig / _markers 等一律在方法里赋值，不要写 class 字段。

  // ===========================================================================
  // 生命周期
  // ===========================================================================

  /** 组件挂载：先连 WS，再初始化标注 */
  componentDidMount() {
    this._ensureMarkerRuntime();
    const buildingId = this._getWsTargetBuildingId();
    this._wsTargetBuildingId = buildingId;
    const start = () => {
      this.handleWss();
      this.initStatusMarkers();
    };
    // OpenView 场景跳转会重新挂载组件，需恢复 X12 场景状态与订阅目标。
    if (buildingId === 12 && this.state.sceneIndex !== 1) {
      this.setState({ sceneIndex: 1 }, start);
    } else {
      start();
    }
  }

  /** 组件卸载：销毁标注与 WebSocket */
  componentWillUnmount() {
    clearTimeout(this._markerSwitchTimer);
    this._markerSwitchTimer = 0;
    this.destroyStatusMarkers();
    if (this.ws) {
      ['onopen', 'onmessage', 'onerror', 'onclose'].forEach((k) => {
        this.ws[k] = null;
      });
      this.ws.close();
      this.ws = null;
    }
  }

  // x12 厂房动画：分层 / 合并分层 / 设备1~3 / 管道（OpenView 按钮按方法名绑定，需保留）
  runX12Open() { this._runX12Animation(); }
  runX12Close() { this._runX12Animation(); }
  runX12F1() { this._runX12Animation(); }
  runX12F2() { this._runX12Animation(); }
  runX12F3() { this._runX12Animation(); }
  runX12Pipe() { this._runX12Animation(); }

  _runX12Animation() {
    this.$('devanimation-464782d2').runAnimation();
  }

  // 点击x12厂房按钮组：只切换选中样式。
  // 分层/镜头动画由 OpenView 按钮自己绑定 runX12Open 等，这里不要再播一遍。
  btnClick(e, params) {
    const names = ['Close', 'Open', 'F1', 'F2', 'F3', 'Pipe'];
    const active = names.find((n) => n.toLowerCase() === params.key);
    if (!active) return;
    const next = {};
    names.forEach((n) => {
      next[`btnClassX12${n}`] = `bottom-btn btn-background-${n === active ? 'click' : 'unclick'}`;
    });
    this.setState(next);
    this[`runX12${active}`]();
  }

  // ===========================================================================
  // WebSocket / 业务逻辑（大屏数据与场景切换）
  // ===========================================================================

  /** 连接实时 WebSocket，接收 init_data / ws_data */
  handleWss() {
    this.ws = new WebSocket('https://115111ob8gw23.vicp.fun/api/ws/realtime');

    this.ws.onopen = () => {
      console.log('✅ WebSocket 连接已建立');
      // 场景跳转后的新连接也必须恢复目标厂房订阅。
      this._sendWsBuildingSubscription(this._wsTargetBuildingId);
    };

    this.ws.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data);
        if (!msg || !msg.data) return;
        if (msg.topic === 'init_data') this.applyInitData(msg.data);
        else if (msg.topic === 'ws_data') this.applyWsData(msg.data);
      } catch (error) {
        console.error('❌ 解析消息失败:', error);
      }
    };

    this.ws.onerror = () => { };
  }

  /**
   * 进入 X12 厂房场景（标注点击或底部按钮）
   * 平台按钮可能只传事件对象，因此不能依赖 params.key 才订阅和刷新标注。
   */
  goX12() {
    this._setWsTargetBuildingId(12);
    this._sendWsBuildingSubscription(12);
    // 等 sceneIndex 生效后再销毁概览标注并挂载 X12 标注。
    this.setState({ sceneIndex: 1 }, () => this._refreshMarkersAfterSceneChange());
  }

  /** 返回首页大屏，取消厂房订阅并重新显示标注 */
  goHome() {
    this._setWsTargetBuildingId(null);
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ topic: 'unsubscribe' }));
    }
    this.setState({ sceneIndex: 0 }, () => this._refreshMarkersAfterSceneChange());
  }

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
    // markerConfig 是标注运行时数据源，必须同步写入，不能只 setState。
    cfg.overviewAlarmList = this._markerMergeAlarmPositions(payload.overviewAlarmList, cfg.overviewMarkerPositions);
    cfg.floorAlarmList = this._markerMergeAlarmPositions(payload.floorAlarmList, cfg.x12MarkerPositions);

    const lists = ['monitoringList', 'operationLogList', 'alarmList', 'inspectionList'];
    const next = {
      overviewAlarmList: cfg.overviewAlarmList,
      floorAlarmList: cfg.floorAlarmList,
    };
    [
      'alarmStats', 'disposalStats', 'effluentList', 'overviewStats', 'deviceTypes',
      'inspectionStats', 'qtcList', ...lists,
    ].forEach((key) => {
      next[key] = payload[key] || (lists.includes(key) ? [] : {});
    });
    this.setState(next);
    this._refreshMarkersAfterSceneChange();
  }

  /** 处理 WS 增量推送，并同步完整告警列表或局部 buildingMarkers。 */
  applyWsData(data) {
    const payload = this.asObject(data);
    if (!Object.keys(payload).length) return;
    const cfg = this._ensureMarkerRuntime();

    const next = {};
    [
      'alarmStats', 'disposalStats', 'effluentList', 'overviewStats', 'deviceTypes',
      'inspectionStats', 'monitoringList', 'operationLogList', 'alarmList',
      'inspectionList', 'qtcList',
    ].forEach((key) => {
      if (this.hasOwn(payload, key)) next[key] = payload[key];
    });

    // 完整告警列表：[接口字段, 坐标表, 对应场景索引]
    let hasCurrent = false;
    let currentUpdates = null;
    [
      ['overviewAlarmList', 'overviewMarkerPositions', 0],
      ['floorAlarmList', 'x12MarkerPositions', 1],
    ].forEach(([key, positionKey, sceneIndex]) => {
      if (!this.hasOwn(payload, key)) return;
      cfg[key] = next[key] = this._markerMergeAlarmUpdates(cfg[key], payload[key], cfg[positionKey]);
      if (this.state.sceneIndex === sceneIndex) {
        hasCurrent = true;
        currentUpdates = payload[key];
      }
    });

    if (Object.keys(next).length) this.setState(next);
    if (hasCurrent) {
      // 标注未挂载时只触发一次初始化；挂载后永不因实时推送重建 DOM。
      if (!this._markers.length && !this._markerInitRunning && !this._markerSwitchTimer) {
        this._refreshMarkersAfterSceneChange();
      } else {
        this.applyBuildingMarkers(currentUpdates);
      }
    }
    this.applyBuildingMarkers(payload.buildingMarkers);
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
    // OpenView 场景/播放器可能晚于页面脚本就绪，先短暂等待
    if (cfg.mountDelayMs > 0) {
      await new Promise((r) => setTimeout(r, cfg.mountDelayMs));
    }

    try {
      const ctx = await this._markerWhenReady();
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

  /** 当前场景的标注层保持显示，列表由 sceneIndex 决定。 */
  syncMarkerVisibleByScene() {
    if (this._markerDomLayer) this._markerDomLayer.style.display = 'block';
  }

  /**
   * WS 推送同步标注数量 / 告警色（按 name 匹配）
   * @param {Array<{ name: string, type?: string, color?: string, count?: number|string }>} list
   */
  applyBuildingMarkers(list) {
    if (!Array.isArray(list) || !list.length || !this._markers.length) return;
    list.forEach((item) => {
      const marker = this._markers.find((m) => m.userData.name === item.name);
      if (!marker) return;
      if (item.count != null) this._markerSetCount(marker, item.count);
      if (item.color != null || item.type != null) {
        this._markerSetType(marker, item.color || item.type);
      }
    });
  }

  /** 销毁标注：停 RAF、移除 DOM 层、清空实例 */
  destroyStatusMarkers() {
    this._markerInitId += 1;
    this._markerInitRunning = false;
    cancelAnimationFrame(this._markerRaf);
    this._markerRaf = 0;
    if (this._markerDomLayer) this._markerDomLayer.remove();
    this._markerDomLayer = null;
    this._markers = [];
  }

  // ===========================================================================
  // 厂房标注 · 内部实现
  // WS 订阅 → 运行时配置 → 场景探测 → 文案/样式 → DOM 投影
  // ===========================================================================

  /** 保存目标厂房，使 OpenView 场景跳转后的新组件实例能够恢复订阅。 */
  _setWsTargetBuildingId(buildingId) {
    this._wsTargetBuildingId = buildingId;
    window.__openViewWsBuildingId = buildingId;
    try {
      if (buildingId == null) window.sessionStorage.removeItem('openview.wsBuildingId');
      else window.sessionStorage.setItem('openview.wsBuildingId', String(buildingId));
    } catch (error) {
      console.warn('[WS] 保存厂房订阅状态失败', error);
    }
  }

  /** 读取场景跳转前保存的目标厂房。 */
  _getWsTargetBuildingId() {
    const saved = [this._wsTargetBuildingId, window.__openViewWsBuildingId].find((v) => v != null);
    if (saved != null) return Number(saved);
    try {
      const value = window.sessionStorage.getItem('openview.wsBuildingId');
      return value ? Number(value) : null;
    } catch (error) {
      console.warn('[WS] 读取厂房订阅状态失败', error);
      return null;
    }
  }

  /** 在连接可用时发送厂房订阅，并输出明确的上行日志。 */
  _sendWsBuildingSubscription(buildingId) {
    if (buildingId == null) return false;
    if (!this.ws || this.ws.readyState !== 1) {
      console.log('[WS] 等待连接后订阅厂房', buildingId);
      return false;
    }
    const message = { topic: 'subscribe', buildingId: Number(buildingId) };
    this.ws.send(JSON.stringify(message));
    console.log('[WS] 已发送厂房订阅', message);
    return true;
  }

  /** 确保标注运行时字段存在（OpenView 不会保留 class 字段上的 markerConfig = {}） */
  _ensureMarkerRuntime() {
    if (!this.markerConfig) {
      const base = 'https://openview.czy3d.com/czybucket/czy/tenant/openview/7738F2879717420B962C32CE221C69C9/2026/09';
      this.markerConfig = {
        mask: `${base}/alarm_bg.png`, // 标注外形剪影（白色实心 + 透明底），全类型共用
        icon: `${base}/icon.png`, // 左侧圆帽内的透明白色告警图标（24×24）
        // 图标在 156×156 源图中的布局：圆帽中心约为 (24, 24)
        iconLeft: 12,
        iconTop: 12,
        iconWidth: 24,
        iconHeight: 24,
        // 告警类型 → CSS 背景色（与 StatusMarker.js ALERT_COLORS 对齐）
        colors: { green: '#1f9d55', warning: '#d4a017', urgent: '#e11d2e' },
        // 剪影源图尺寸（文字 left% / measureText 映射用，改图时同步）
        imageWidth: 156,
        imageHeight: 156,
        anchorX: 77 / 156, // 底部箭头中心占源图宽度比例，transform 用它对准投影点
        textX: 52, // 短文案默认起点 X（相对源图像素）；长文案会按宽度自动左移
        textXMin: 44, // 长文案允许的最左起点（圆帽右缘外侧）
        textXMaxRight: 140, // 文案（含 >）右边缘上限，横幅右缘内侧留白
        fontSize: 20, // 源图测宽字号：DOM 与源图 1:1，与设计稿 20px 一致
        // 设计稿固定：font-weight:500; font-size:20px; 不可随文案长短缩放
        domFontSize: 20,
        domLineHeight: 24,
        domFontWeight: 500,
        domFontFamily:
          'SourceHanSansSC, "Source Han Sans SC", "Noto Sans SC", "PingFang SC", "Microsoft YaHei", sans-serif',
        domTextShadow: '0px 2px 4px rgba(0,0,0,0.5)',
        domTextTopPercent: 15.4, // 文字垂直位置（相对 DOM 标注高度 %），对齐顶部胶囊中心 y≈24/156
        // DOM 标注显示尺寸（与源图 1:1，胶囊高度贴近 20px 字号）
        domWidth: 156,
        domHeight: 156,
        mountDelayMs: 800, // 等场景/播放器就绪的延迟（ms），OpenView 启动较慢时可加大
        // 可选：OpenView 中对应模型根节点的 name。留空时通过标注点与候选节点包围盒自动匹配。
        modelRootNames: { overview: '', x12: '' },
        // overview.fbx 告警点模型坐标，按接口 name 拼接
        overviewMarkerPositions: {
          X06: [66, 20, -91],
          X03: [-112, 21, -116],
          X02: [-128, 16, 95],
          X12: [64, 28, 80],
        },
        // X12.fbx 告警点模型坐标，按接口 name 拼接
        x12MarkerPositions: {
          F1: [12, 16, -14],
          F2: [23, 16, -23],
          F3: [35, 16, -16],
        },
        // 接口数据与坐标合并后的运行时列表
        overviewAlarmList: [],
        floorAlarmList: [],
      };
    }
    // 以下运行时字段也不能写在 class 上，统一在此兜底初始化
    const runtime = {
      _markers: [], // 标注实例列表
      _markerDomLayer: null, // DOM 叠加层根节点
      _markerRaf: 0, // 投影 RAF id
      _markerSwitchTimer: 0,
      _markerInitId: 0,
      _markerInitRunning: false,
    };
    Object.keys(runtime).forEach((k) => {
      if (this[k] === undefined) this[k] = runtime[k];
    });
    return this.markerConfig;
  }

  /**
   * 保留接口全部字段，并按 name 拼接模型坐标。
   * 接口已返回 position 时优先使用接口坐标。
   */
  _markerMergeAlarmPositions(list, positionMap) {
    if (!Array.isArray(list)) return [];
    return list.map((item) => {
      const source = this.asObject(item);
      const position =
        Array.isArray(source.position) && source.position.length >= 3
          ? source.position.slice(0, 3)
          : positionMap[source.name];
      return { ...source, position: position ? [...position] : [0, 0, 0] };
    });
  }

  /** 将 WS 增量按 name 合并到现有完整列表，不替换或重建标注。 */
  _markerMergeAlarmUpdates(current, updates, positionMap) {
    const byName = new Map((Array.isArray(current) ? current : []).map((item) => [item.name, item]));
    (Array.isArray(updates) ? updates : []).forEach((item) => {
      const source = this.asObject(item);
      byName.set(source.name, { ...(byName.get(source.name) || {}), ...source });
    });
    return this._markerMergeAlarmPositions(Array.from(byName.values()), positionMap);
  }

  /** 根据当前场景返回已拼接坐标的报警列表，name 为唯一键。 */
  _markerGetAlarmList() {
    const cfg = this.markerConfig;
    return this.state.sceneIndex === 1 ? cfg.floorAlarmList : cfg.overviewAlarmList;
  }

  /**
   * 找出承载当前 FBX 的顶层节点。
   * 优先使用配置名称；否则选择“能容纳最多标注点且世界包围盒最小”的候选节点。
   * 这样不会误选 Mesh 更多但体积巨大的背景环境。
   */
  _markerFindModelRoot(scene, items, THREE) {
    if (!scene || !Array.isArray(scene.children)) return scene;
    const names = this.markerConfig.modelRootNames;
    const configuredName = this.state.sceneIndex === 1 ? names.x12 : names.overview;
    if (configuredName && typeof scene.traverse === 'function') {
      let configured = null;
      scene.traverse((node) => {
        if (!configured && node && node.name === configuredName) configured = node;
      });
      if (configured) return configured;
    }

    const countMeshes = (root) => {
      let count = 0;
      if (typeof root.traverse === 'function') {
        root.traverse((node) => {
          if (node && node.isMesh) count += 1;
        });
      }
      return count;
    };
    const candidates = scene.children.filter(
      (child) =>
        child &&
        !child.isCamera &&
        !child.isLight &&
        !child.isHelper &&
        typeof child.localToWorld === 'function' &&
        countMeshes(child) > 0,
    );
    if (!candidates.length) return scene;

    if (!THREE || typeof THREE.Box3 !== 'function' || typeof THREE.Vector3 !== 'function') {
      return candidates.length === 1 ? candidates[0] : scene;
    }

    const localPositions = (items || []).map((item) => item.position || [0, 0, 0]);
    let best = null;
    candidates.forEach((node) => {
      try {
        if (typeof node.updateMatrixWorld === 'function') node.updateMatrixWorld(true);
        const box = new THREE.Box3().setFromObject(node);
        if (box.isEmpty()) return;
        const size = box.getSize(new THREE.Vector3());
        const diagonal = size.length();
        // 标注尖角允许略高于模型包围盒顶部。
        const margin = Math.max(size.x, size.y, size.z, 1) * 0.08;
        const contained = localPositions.filter((p) => {
          const point = new THREE.Vector3(p[0], p[1], p[2]);
          node.localToWorld(point);
          return ['x', 'y', 'z'].every(
            (a) => point[a] >= box.min[a] - margin && point[a] <= box.max[a] + margin,
          );
        }).length;
        if (
          !best ||
          contained > best.contained ||
          (contained === best.contained && diagonal < best.diagonal)
        ) {
          best = { node, contained, diagonal };
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
   * - 不创建真实 THREE.Sprite，只保存 { position, userData, el }
   * - _markerSetCount / _markerSetType 会同步刷新对应 DOM 节点
   */
  _markerMountVirtualMarkers(ctx) {
    const items = this._markerGetAlarmList();
    const THREE = ctx.THREE || this._markerGetTHREE();
    const modelRoot = this._markerFindModelRoot(ctx.scene, items, THREE);
    if (modelRoot && typeof modelRoot.updateMatrixWorld === 'function') {
      modelRoot.updateMatrixWorld(true);
    }
    const toWorld =
      modelRoot &&
      modelRoot !== ctx.scene &&
      typeof modelRoot.localToWorld === 'function' &&
      THREE &&
      typeof THREE.Vector3 === 'function';
    this._markers = items.map((item) => {
      const [x, y, z] = item.position || [0, 0, 0];
      let position = { x, y, z };
      if (toWorld) {
        position = new THREE.Vector3(x, y, z);
        modelRoot.localToWorld(position);
      }
      return {
        position,
        el: null, // 挂载 DOM 后回填，供 _markerSetCount / _markerSetType 刷新
        userData: {
          type: this._markerResolveType(item.color || item.type),
          color: item.color || null,
          name: item.name,
          count: item.count != null ? item.count : null,
          isMarker: true,
        },
      };
    });
  }

  /** WS 推送数量时重绘 DOM 文案 */
  _markerSetCount(marker, count) {
    const ud = marker.userData;
    if (ud.count === count) return;
    ud.count = count;
    if (marker.el) this._markerFillDomLabel(marker.el, ud.name, ud.count);
  }

  /** WS 推送告警类型时切换背景色 */
  _markerSetType(marker, type) {
    const normalized = this._markerResolveType(type);
    if (marker.userData.type === normalized) return;
    marker.userData.type = normalized;
    if (marker.el) this._markerPaintDomSkin(marker.el, normalized);
  }

  /**
   * 等 OpenView 完成页面/三维场景切换后，重新绑定当前 Scene、相机和画布。
   * 延迟可避免拿到切换前的 webglPlayer。
   */
  _refreshMarkersAfterSceneChange() {
    clearTimeout(this._markerSwitchTimer);
    this._markerSwitchTimer = setTimeout(() => {
      this._markerSwitchTimer = 0;
      this.destroyStatusMarkers();
      this.initStatusMarkers();
    }, 300);
  }

  /** 从 sceneMgr 上尽量找出三维播放器（字段名因 OpenView 版本而异） */
  _markerGetWebglPlayer() {
    const sceneMgr =
      (window.coreMgr && window.coreMgr.sceneMgr) ||
      (window.webglPlayer && window.webglPlayer.sceneMgr) ||
      null;
    if (!sceneMgr && window.webglPlayer) return window.webglPlayer;

    const named =
      this._markerPickProp(sceneMgr, [
        'webglPlayer', 'player', 'Player', 'viewer', 'engine', 'app', 'glPlayer', 'renderPlayer',
      ]) ||
      (window.coreMgr && window.coreMgr.webglPlayer) ||
      window.webglPlayer ||
      null;
    if (named) return named;

    // 扫 sceneMgr 自有属性：带 camera/renderer/canvas 的对象即视为 player
    if (sceneMgr && typeof sceneMgr === 'object') {
      try {
        for (const key of Object.keys(sceneMgr)) {
          const v = sceneMgr[key];
          if (!v || typeof v !== 'object' || v === sceneMgr) continue;
          if (v.camera || v.renderer || v.canvas || v.domElement || v.webglRenderer) return v;
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

  /** 无 window.THREE 时，从 scene.position 借用 Vector3 构造器（供 DOM 投影） */
  _markerBuildCompatTHREE(scene) {
    const Vector3 = scene && scene.position && scene.position.constructor;
    if (typeof Vector3 !== 'function') return null;
    try {
      new Vector3();
    } catch (e) {
      return null;
    }
    return { Vector3 };
  }

  /** 解析 THREE：优先 window.THREE，其次缓存的兼容对象，再深度搜索播放器/sceneMgr */
  _markerGetTHREE() {
    if (this._markerLookLikeTHREE(window.THREE)) return window.THREE;
    if (this._markerCompatTHREE) return this._markerCompatTHREE;

    const sceneMgr = window.coreMgr && window.coreMgr.sceneMgr;
    const roots = [window.coreMgr, sceneMgr, this._markerGetWebglPlayer(), window].filter(Boolean);

    for (const root of roots) {
      const direct =
        root.THREE ||
        root.three ||
        (root.engine && (root.engine.THREE || root.engine.three)) ||
        (root.renderer && root.renderer.THREE);
      if (this._markerLookLikeTHREE(direct)) return direct;
    }
    for (const root of roots) {
      const found = this._markerDeepFind(root, (v) => this._markerLookLikeTHREE(v), 5);
      if (found) return found;
    }
    return null;
  }

  /** 在对象树上查找相机（traverse 或深度扫描） */
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

  /** 从 sceneNode/sceneList（OpenView 常有 2 个场景）里挑「内容最多」的节点与 Scene */
  _markerCollectSceneCandidates(sceneMgr, player) {
    const nodes = [];
    const pushUnique = (n) => {
      if (n && nodes.indexOf(n) < 0) nodes.push(n);
    };
    [(sceneMgr && sceneMgr.sceneNode) || [], (sceneMgr && sceneMgr.sceneList) || []].forEach(
      (list) => Array.isArray(list) && list.forEach(pushUnique),
    );
    pushUnique(sceneMgr);
    pushUnique(player);

    const scenes = [];
    const addScene = (s) => {
      if (!s || !this._markerLookLikeScene(s) || scenes.some((x) => x.scene === s)) return;
      scenes.push({ scene: s, childCount: Array.isArray(s.children) ? s.children.length : 0 });
    };
    const deepScene = (root, depth) => this._markerDeepFind(root, (v) => this._markerLookLikeScene(v), depth);

    // sceneList 项本身就可能是 Scene
    nodes.forEach((node) => {
      addScene(node);
      addScene(this._markerPickProp(node, ['scene', 'threeScene', 'rootScene', 'Scene']));
      addScene(deepScene(node, 3));
    });
    addScene(this._markerPickProp(player, ['scene', 'threeScene', 'rootScene']));
    addScene(deepScene(player, 3));
    addScene(this._markerPickProp(sceneMgr, ['scene', 'threeScene']));

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
    const activeScene = this._markerPickProp(player, ['scene', 'threeScene', 'rootScene']);
    const best =
      scenes.find((item) => item.scene === activeScene) ||
      scenes[Math.min(this.state.sceneIndex, scenes.length - 1)] ||
      null;
    const scene = best ? best.scene : null;
    const node = nodes[0] || sceneMgr;

    const camera =
      this._markerPickProp(player, ['camera', 'Camera', 'mainCamera', 'activeCamera']) ||
      this._markerPickProp(sceneMgr, [
        'camera', 'mainCamera', 'activeCamera', 'Camera', 'currentCamera',
      ]) ||
      this._markerPickProp(node, ['camera', 'Camera', 'mainCamera']) ||
      this._markerFindCameraInObject(player) ||
      this._markerFindCameraInObject(sceneMgr) ||
      this._markerFindCameraInObject(scene) ||
      this._markerFindCameraInObject(node);

    const isRenderer = (v) => this._markerLookLikeRenderer(v);
    const renderer =
      this._markerPickProp(player, ['renderer', 'webglRenderer', 'Renderer']) ||
      this._markerPickProp(sceneMgr, ['renderer', 'webglRenderer']) ||
      this._markerPickProp(node, ['renderer', 'webglRenderer', 'Renderer']) ||
      this._markerDeepFind(player, isRenderer, 5) ||
      this._markerDeepFind(sceneMgr, isRenderer, 4) ||
      this._markerDeepFind(node, isRenderer, 3);

    let domElement =
      (renderer && renderer.domElement) ||
      (player && (player.canvas || player.domElement)) ||
      null;
    if (!domElement) {
      // 选面积最大的 canvas，通常是三维视口
      const canvases = Array.from(document.querySelectorAll('canvas'));
      const area = (c) => (c.clientWidth || 0) * (c.clientHeight || 0);
      domElement = canvases.length ? canvases.reduce((a, b) => (area(b) > area(a) ? b : a)) : null;
    }

    return {
      sceneMgr,
      player,
      scene,
      sceneMeta: best,
      camera,
      renderer,
      domElement,
      ready: !!(sceneMgr && sceneMgr.ready),
      readyKnown: !!(sceneMgr && typeof sceneMgr.ready === 'boolean'),
      isDesign: !!(coreMgr && coreMgr.isDesign),
      sceneCount: scenes.length,
    };
  }

  /** 控制台打印当前解析到的 THREE / player / context，挂载失败时排查用 */
  _markerDebugContext() {
    const THREE = this._markerGetTHREE();
    console.log('[Marker] THREE=', !!THREE, THREE);
    console.log('[Marker] webglPlayer=', !!this._markerGetWebglPlayer());
    console.log('[Marker] context=', this._markerGetContext());
  }

  /** 等待场景、画布和 OpenView ready 状态稳定后再挂载标注。 */
  _markerWhenReady(timeoutMs = 30000) {
    return new Promise((resolve, reject) => {
      const start = Date.now();
      let stableScene = null;
      let stableCanvas = null;
      let stableTicks = 0;
      const tick = () => {
        const ctx = this._markerGetContext();
        let THREE = this._markerGetTHREE();
        if (!THREE && ctx.scene) {
          THREE = this._markerBuildCompatTHREE(ctx.scene);
          if (THREE) this._markerCompatTHREE = THREE;
        }
        ctx.THREE = THREE;

        const canvas = ctx.domElement;
        const rect =
          canvas && canvas.parentElement && canvas.isConnected !== false
            ? canvas.getBoundingClientRect()
            : null;
        const canvasUsable = !!rect && rect.width > 0 && rect.height > 0;
        if (canvasUsable && ctx.scene === stableScene && canvas === stableCanvas) {
          stableTicks += 1;
        } else if (canvasUsable && ctx.scene) {
          stableScene = ctx.scene;
          stableCanvas = canvas;
          stableTicks = 1;
        } else {
          stableTicks = 0;
        }

        const elapsed = Date.now() - start;
        // 某些 OpenView 版本没有 ready 布尔字段；有该字段时最多等待 5 秒。
        const readyConfirmed = !ctx.readyKnown || ctx.ready || elapsed >= 5000;
        if (ctx.scene && canvasUsable && stableTicks >= 3 && readyConfirmed) {
          // 有 Vector3 立刻就绪；否则最多等 1.5s（仍可走无投影的 layout 兜底）
          if (THREE && typeof THREE.Vector3 === 'function') {
            resolve(ctx);
            return;
          }
          if (elapsed >= 1500) {
            console.warn('[Marker] 无 Vector3，DOM 将使用均匀布局兜底', {
              camera: !!ctx.camera,
              sceneChildren: ctx.sceneMeta && ctx.sceneMeta.childCount,
            });
            resolve(ctx);
            return;
          }
        }

        if (elapsed > timeoutMs) {
          console.error('[Marker] 等待超时 dump', {
            THREE: !!THREE,
            ready: ctx.ready,
            readyKnown: ctx.readyKnown,
            scene: !!ctx.scene,
            canvas: !!ctx.domElement,
            canvasStableTicks: stableTicks,
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

  /**
   * 业务告警类型标准化为 green | warning | urgent；CSS 颜色值原样保留。
   * 兼容旧值 normal 及 red/yellow 别名。
   */
  _markerResolveType(type) {
    const value = type == null ? '' : String(type).trim();
    if (/^(#[0-9a-f]{3,8}$|(rgb|hsl)a?\()/i.test(value)) return value;
    const map = { urgent: 'urgent', red: 'urgent', warning: 'warning', yellow: 'warning' };
    return map[value.toLowerCase()] || 'green';
  }

  /**
   * 用 CSS mask + background-color 给标注上色
   * 剪影与文字分层：mask 不裁切文案；drop-shadow 放在 mask 外层以免 WebKit 失效
   * @param {HTMLElement} el 标注外壳
   * @param {string} type 告警类型
   */
  _markerPaintDomSkin(el, type) {
    const cfg = this.markerConfig;
    const resolved = this._markerResolveType(type);
    let bg = el.querySelector('[data-marker-bg]');
    if (!bg) {
      const wrap = document.createElement('div');
      wrap.setAttribute('data-marker-bg-wrap', '1');
      wrap.style.cssText =
        'position:absolute;inset:0;pointer-events:none;filter:drop-shadow(0 2px 4px rgba(0,0,0,.28));';
      bg = document.createElement('div');
      bg.setAttribute('data-marker-bg', '1');
      bg.style.cssText =
        'position:absolute;inset:0;background-repeat:no-repeat;background-position:center;background-size:100% 100%;' +
        '-webkit-mask-repeat:no-repeat;mask-repeat:no-repeat;-webkit-mask-position:center;mask-position:center;' +
        '-webkit-mask-size:100% 100%;mask-size:100% 100%;mask-mode:alpha';
      wrap.appendChild(bg);
      el.insertBefore(wrap, el.firstChild);
    }
    const maskCss = cfg.mask ? `url("${cfg.mask}")` : 'none';
    bg.style.backgroundColor = cfg.colors[resolved] || resolved;
    bg.style.webkitMaskImage = maskCss;
    bg.style.maskImage = maskCss;
    bg.style.backgroundImage = 'none';

    let iconEl = el.querySelector('[data-marker-icon]');
    if (!iconEl) {
      iconEl = document.createElement('img');
      iconEl.setAttribute('data-marker-icon', '1');
      iconEl.alt = '';
      iconEl.draggable = false;
      iconEl.style.cssText =
        `position:absolute;left:${cfg.iconLeft}px;top:${cfg.iconTop}px;width:${cfg.iconWidth}px;` +
        `height:${cfg.iconHeight}px;display:block;object-fit:contain;pointer-events:none;user-select:none;z-index:1`;
      el.appendChild(iconEl);
    }
    if (cfg.icon) {
      iconEl.src = cfg.icon;
      iconEl.style.display = 'block';
    } else {
      iconEl.removeAttribute('src');
      iconEl.style.display = 'none';
    }
  }

  /**
   * 填充 DOM 标注文字（主文案 + >）
   * 先按源图坐标系测宽算 left%，再以设计稿 20px/500 渲染。
   * count 按接口原值显示：F1 + 1 → F1-1，F2 + 0 → F2-0
   * @param {HTMLElement} el 标注外壳节点
   * @param {string} name 厂房名称
   * @param {number|string|null} count 数量；有值则展示 name-count
   */
  _markerFillDomLabel(el, name, count) {
    const cfg = this.markerConfig;
    const label = name == null ? '' : String(name);
    const main = count == null || count === '' ? label : `${label}-${count}`;
    const { domFontFamily: ff, domLineHeight: lh, domFontWeight: fw } = cfg;
    const prevLabel = el.querySelector('[data-marker-label]');
    if (prevLabel) prevLabel.remove();

    // 用离屏 canvas 按源图固定字号测宽，再映射左偏移（字号本身不变）
    // 短文案保持 textX；长文案左移，避免「>」落到横幅淡出区外
    const measure = document.createElement('canvas').getContext('2d');
    measure.font = `${fw} ${cfg.fontSize}px ${ff}`;
    const total = measure.measureText(main).width + 6 + measure.measureText('>').width;
    const textX =
      cfg.textX + total <= cfg.textXMaxRight
        ? cfg.textX
        : Math.max(cfg.textXMin, cfg.textXMaxRight - total);
    const rightPx = Math.max(4, Math.round(cfg.domWidth * (1 - cfg.textXMaxRight / cfg.imageWidth)));

    // 24×line-height 盒子中心对齐圆形水平中线（设计稿垂直居中）
    // +1px：补偿 text-shadow 向下扩散带来的视觉上浮
    const row = document.createElement('div');
    row.setAttribute('data-marker-label', '1');
    row.style.cssText =
      `position:absolute;left:${(textX / cfg.imageWidth) * 100}%;right:${rightPx}px;top:${cfg.domTextTopPercent}%;` +
      `transform:translateY(calc(-50% + 1px));display:flex;align-items:center;height:${lh}px;line-height:${lh}px;` +
      'white-space:nowrap;z-index:1;text-align:left;font-style:normal;box-sizing:border-box';

    const textStyle =
      `font-family:${ff};font-size:${cfg.domFontSize}px;font-weight:${fw};line-height:${lh}px;height:${lh}px;` +
      `color:#FFFFFF;text-shadow:${cfg.domTextShadow};-webkit-font-smoothing:antialiased`;
    // 设计稿箭头与正文同一套样式，间距约 6px
    [main, '>'].forEach((text, i) => {
      const span = document.createElement('span');
      span.textContent = text;
      span.style.cssText = i ? `${textStyle};margin-left:6px` : textStyle;
      row.appendChild(span);
    });
    el.appendChild(row);
    el.title = main;
  }

  /** 按候选字段名依次取值，命中即返回 */
  _markerPickProp(obj, paths) {
    if (!obj) return null;
    const key = paths.find((p) => obj[p] != null);
    return key ? obj[key] : null;
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
    const seen = new WeakSet();
    const queue = [[root, 0]];

    for (let head = 0; head < queue.length; head += 1) {
      const [obj, depth] = queue[head];
      if (!obj || typeof obj !== 'object' || seen.has(obj)) continue;
      seen.add(obj);
      if (tester(obj)) return obj;
      if (depth >= maxDepth) continue;

      if (Array.isArray(obj)) {
        obj.slice(0, 30).forEach((child) => queue.push([child, depth + 1]));
        continue;
      }
      Object.keys(obj)
        .slice(0, 60)
        .forEach((key) => {
          if (key === 'parent' || key.startsWith('__')) return;
          if (key === 'children' && depth > 1) return;
          try {
            queue.push([obj[key], depth + 1]);
          } catch (e) {
            // ignore
          }
        });
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
    const canvas = ctx.domElement;
    let camera = ctx.camera;
    const markers = this._markers;
    if (!canvas || !markers.length) {
      console.warn('[Marker] DOM 叠加层跳过：缺少 canvas/markers');
      return;
    }

    if (this._markerDomLayer) this._markerDomLayer.remove();

    const parent = canvas.parentElement || document.body;
    const layer = document.createElement('div');
    layer.setAttribute('data-marker-overlay', '1');
    // 覆盖三维画布同级区域；自身不接收事件，交给子标注
    layer.style.cssText =
      'position:absolute;left:0;top:0;width:100%;height:100%;pointer-events:none;overflow:hidden;z-index:20;';
    if (getComputedStyle(parent).position === 'static') parent.style.position = 'relative';
    parent.appendChild(layer);
    this._markerDomLayer = layer;

    // 整张剪影含尖角：translate(-anchorX%, -100%) ≈ 底部箭头对准投影点
    const cfg = this.markerConfig;
    const shellStyle =
      `position:absolute;transform:translate(${-(cfg.anchorX * 100).toFixed(2)}%, -100%);` +
      `width:${cfg.domWidth}px;height:${cfg.domHeight}px;pointer-events:auto;cursor:pointer;` +
      'box-sizing:border-box;user-select:none';
    markers.forEach((marker) => {
      const el = document.createElement('div');
      const ud = marker.userData;
      el.style.cssText = shellStyle;
      this._markerPaintDomSkin(el, ud.type);
      this._markerFillDomLabel(el, ud.name, ud.count);
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        console.log('[厂房标注点击-DOM]', ud);
        // 业务：点击 X12 进入厂房场景
        if (ud.name === 'X12') this.goX12();
      });
      layer.appendChild(el);
      marker.el = el;
    });

    const canProject = !!(
      camera &&
      THREE &&
      typeof THREE.Vector3 === 'function' &&
      typeof new THREE.Vector3().project === 'function'
    );
    const tmp = canProject ? new THREE.Vector3() : null;

    /** 无相机/投影失败时：在画布中部横向均匀排布 */
    const layoutFallback = (marker, idx, rect, offsetX, offsetY) => {
      const n = markers.length || 1;
      const x = offsetX + rect.width * (0.25 + (0.5 * idx) / Math.max(n - 1, 1));
      marker.el.style.left = `${x}px`;
      marker.el.style.top = `${offsetY + rect.height * 0.42}px`;
      marker.el.style.visibility = 'visible';
    };

    let healthFrame = 0;
    const requestRemount = (reason) => {
      if (this._markerSwitchTimer) return;
      console.warn('[Marker] 检测到场景画布变化，自动重新挂载', reason);
      this._refreshMarkersAfterSceneChange();
    };

    /** 每帧把当前场景的世界坐标投影为屏幕 left/top。 */
    const tick = () => {
      this._markerRaf = requestAnimationFrame(tick);
      if (this._markerDomLayer !== layer) return;

      // 首次加载时 OpenView 可能替换 canvas 或其容器；旧叠加层会因此不可见。
      if (
        !layer.parentElement ||
        layer.parentElement !== canvas.parentElement ||
        layer.isConnected === false ||
        canvas.isConnected === false
      ) {
        requestRemount('canvas-or-layer-detached');
        return;
      }

      // 低频确认当前活动画布，覆盖“旧 canvas 仍在 DOM、但已被新画布替换”的情况。
      healthFrame += 1;
      if (healthFrame % 30 === 0) {
        const latest = this._markerGetContext();
        if (latest.domElement && latest.domElement !== canvas) {
          requestRemount('active-canvas-replaced');
          return;
        }
        if (latest.camera && latest.camera !== camera) {
          camera = latest.camera;
          ctx.camera = camera;
        }
      }

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

      markers.forEach((marker, idx) => {
        if (!camera || !tmp) {
          layoutFallback(marker, idx, rect, offsetX, offsetY);
          return;
        }
        const pos = marker.position;
        tmp.set(pos.x, pos.y, pos.z);
        try {
          tmp.project(camera);
        } catch (e) {
          layoutFallback(marker, idx, rect, offsetX, offsetY);
          return;
        }
        // NDC → 屏幕像素；z 超出 [-1,1] 视为在视锥外，隐藏
        const style = marker.el.style;
        style.left = `${((tmp.x + 1) / 2) * rect.width + offsetX}px`;
        style.top = `${((-tmp.y + 1) / 2) * rect.height + offsetY}px`;
        style.visibility = tmp.z >= -1 && tmp.z <= 1 ? 'visible' : 'hidden';
      });
    };
    tick();
    console.log('[Marker] DOM 叠加层已启用', markers.length, canProject ? 'project' : 'layout');
  }
}
