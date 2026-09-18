/**
 * ============================================================================
 * OpenView 低代码源码（index.js）· 整份复制到平台即可运行
 * ============================================================================
 *
 * 【与 StatusMarker.js 的关系】
 * - StatusMarker.js：标准 Three.js + Sprite 方案（本地 Demo）
 * - 本文件：OpenView 环境 DOM-only 方案（平台页面脚本常无 window.THREE）
 * - 告警色、文案格式、textX 安全区、字体 16px/500 等约定应对齐
 *
 * 【标注架构 · DOM-only】
 *   1. 虚拟锚点：只存 position / userData，不创建 THREE.Sprite
 *   2. HTML 叠加层：single.png 作 CSS mask + 告警色填充 + 白字，用 Vector3.project 跟 3D 点
 *   3. 点击：DOM click（如点 X12 → goX12）
 *
 * 【文件分区】
 *   - 生命周期 / 标注对外入口
 *   - _marker* 内部实现（场景探测、DOM 样式、投影）
 *   - WebSocket / 业务场景切换
 *
 * 排查要点（基于 window.coreMgr 实测）：
 *   - OpenView 会丢弃除 state 外的 class 字段 → markerConfig 必须在方法里赋值
 *   - webglPlayer 在 coreMgr.sceneMgr.webglPlayer（不是 window.webglPlayer）
 *   - sceneList/sceneNode 常有 2 个场景，需选 children 最多的那个
 *   - DOM 叠加层负责显示与点击；投影只需 Vector3.project
 *
 * ============================================================================
 * 使用案例（OpenView 低代码）
 * ============================================================================
 *
 * ----- 1. 接入方式 -----
 *
 *   将本文件全文粘贴到 OpenView 页面「源码 / index.js」。
 *   平台会实例化 LowcodeComponent，componentDidMount 内自动：
 *     _ensureMarkerRuntime() → handleWss() → initStatusMarkers()
 *   无需再手动 new；卸载时 componentWillUnmount 会销毁标注并关闭 WS。
 *
 * ----- 2. 配置厂房标注（搜索 TODO / overviewAlarmList） -----
 *
 *   在 _ensureMarkerRuntime() 的 this.markerConfig 中修改：
 *
 *   mask: 'https://openview.czy3d.com/.../single.png',  // 白色剪影，全类型共用
 *   colors: {
 *     normal:  '#1f9d55',  // 正常 → 绿
 *     warning: '#d4a017',  // 注意 → 黄
 *     urgent:  '#e11d2e',  // 紧急 → 红
 *   }
 *
 *   overviewAlarmList: [
 *     // 无 count → 只显示厂房名，如 "X01 >"；name 为唯一键
 *     { type: 'green', name: 'X01', position: [0, 0, 0] },
 *     // 有 count → 厂房名 + 数量，如 "X12-012 >"（count 补零到 3 位）
 *     {
 *       type: 'urgent',
 *       name: 'X12',
 *       count: 12,
 *       position: [-30, 0, 0],   // 世界坐标；autoFit=true 时会相对场景中心抬高
 *     },
 *   ]
 *
 *   常用开关：
 *     autoFit: true        // 按场景包围盒抬高 position，便于投影落在建筑上方
 *     mountDelayMs: 800    // 等播放器/场景就绪的延迟
 *     domFontSize: 16      // 设计稿固定字号，勿改
 *     domFontWeight: 500
 *
 * ----- 3. 初始化流程（已内置，一般不用手写） -----
 *
 *   async initStatusMarkers() {
 *     // 1. 等待 coreMgr.sceneMgr / camera / canvas
 *     // 2. autoFit 调整 overviewAlarmList.position（可选）
 *     // 3. _markerMountVirtualMarkers 创建虚拟锚点
 *     // 4. _markerMountDomOverlay 挂 HTML 层并每帧投影
 *     // 5. syncMarkerVisibleByScene 按 sceneIndex 显隐
 *   }
 *
 * ----- 4. 点击交互 -----
 *
 *   DOM 标注 click 已绑定：点击 name === 'X12' 时调用
 *     this.goX12(null, { key: 1 })
 *   → 切到厂房页（sceneIndex=1）并 WS subscribe；首页标注自动隐藏。
 *   返回大屏调用 this.goHome() → sceneIndex=0，标注重新显示。
 *
 * ----- 5. WebSocket 更新标注 -----
 *
 *   // 服务端推送 init_data / ws_data 中可带：
 *   // buildingMarkers: [{ name: 'X12', type: 'urgent', count: 28 }]
 *   // 本组件会调用 applyBuildingMarkers，按 name 更新数量与背景色：
 *
 *   this.applyBuildingMarkers([
 *     { name: 'X12', type: 'urgent', count: 28 },
 *     { name: 'X01', type: 'warning' },
 *   ])
 *
 * ----- 6. 手动显隐 / 销毁 -----
 *
 *   this.syncMarkerVisibleByScene()  // 按 this.state.sceneIndex 控制 DOM 层
 *   this.destroyStatusMarkers()      // 停 RAF、移除 DOM、清空 _markers
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

    /** 确保标注运行时字段存在（OpenView 不会保留 class 字段上的 markerConfig = {}） */
    _ensureMarkerRuntime() {
        if (!this.markerConfig) {
            this.markerConfig = {
                /** 标注外形剪影（白色实心 + 透明底），全类型共用 */
                mask:
                    'https://openview.czy3d.com/czybucket/czy/tenant/openview/7738F2879717420B962C32CE221C69C9/2026/09/single.png',
                /** 告警类型 → CSS 背景色（与 StatusMarker.js ALERT_COLORS 对齐） */
                colors: {
                    normal: '#1f9d55',
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
                /** 是否按场景包围盒抬高 overviewAlarmList.position */
                autoFit: true,
                /** 等场景/播放器就绪的延迟（ms），OpenView 启动较慢时可加大 */
                mountDelayMs: 800,
                /**
                 * TODO: 按实际厂房世界坐标填写 position
                 * 有 count → "X12-012 >"；无 count → "X01 >"
                 */
                // 大屏概览报警列表数据
                overviewAlarmList: [
                    { type: 'green', name: 'X01', position: [0, 0, 0] },
                    { type: 'warning', name: 'X06', position: [30, 0, 0] },
                    {
                        type: 'urgent',
                        name: 'X12',
                        position: [-30, 0, 0],
                    },
                ],
                // x12 厂房报警列表数据
                x12AlarmList: [
                    { type: 'green', name: '101', count: 11, position: [0, 0, 0] },
                    { type: 'warning', name: '104', count: 12, position: [30, 0, 0] },
                    {
                        type: 'urgent',
                        name: '107',
                        count: 13,
                        position: [-30, 0, 0],
                    },
                ],
            };
            console.log('[Marker] 已在运行时初始化 markerConfig（class 字段被平台丢弃）');
        }
        // 以下运行时字段也不能写在 class 上，统一在此兜底初始化
        if (!this._markers) this._markers = []; // 标注实例列表
        if (this._markerCtx === undefined) this._markerCtx = null; // 场景上下文缓存
        if (this._markerDomLayer === undefined) this._markerDomLayer = null; // DOM 叠加层根节点
        if (this._markerRaf === undefined) this._markerRaf = 0; // 投影 RAF id
        return this.markerConfig;
    }

    /** 组件挂载：先连 WS，再初始化标注 */
    componentDidMount() {
        console.log('[Marker] componentDidMount 开始');
        this._ensureMarkerRuntime();
        this.handleWss();
        this.initStatusMarkers();
    }

    /** 组件卸载：销毁标注与 WebSocket */
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

    /**
     * 初始化并挂载标注（DOM-only）
     * 流程：等场景就绪 →（可选）autoFit 抬高坐标 → 虚拟锚点 → DOM 叠加层 → 按场景显隐
     */
    async initStatusMarkers() {
        const cfg = this._ensureMarkerRuntime();
        this._markers = [];
        const delay = (cfg && cfg.mountDelayMs) || 0;
        // OpenView 场景/播放器可能晚于页面脚本就绪，先短暂等待
        if (delay > 0) {
            await new Promise((r) => setTimeout(r, delay));
        }

        try {
            const ctx = await this._markerWhenReady(30000);
            this._markerCtx = ctx;
            const THREE = ctx.THREE || this._markerGetTHREE();

            console.log('[Marker] 场景上下文就绪', {
                hasTHREE: !!THREE,
                hasVector3: !!(THREE && THREE.Vector3),
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

            // 把相对偏移变成落在建筑上方的世界坐标，便于投影可见
            if (this.markerConfig.autoFit && ctx.scene) {
                this._markerAutoFit(ctx);
            }

            this._markerMountVirtualMarkers(ctx);
            this._markerMountDomOverlay(ctx);
            this.syncMarkerVisibleByScene();
            console.log('[Marker] 已挂载', this._markers.length, '个标注 (DOM-only)');
            this._markers.forEach((m) => {
                const p = m.sprite && m.sprite.position;
                console.log(
                    '[Marker] marker',
                    m.sprite && m.sprite.userData && m.sprite.userData.name,
                    p && (p.toArray ? p.toArray() : [p.x, p.y, p.z]),
                );
            });
        } catch (err) {
            console.error('[Marker] 挂载失败:', err);
            this._markerDebugContext();
            // 最后兜底：屏幕中央固定排布，证明页面脚本生命周期已跑通
            try {
                this._markerMountDomFallbackFixed();
            } catch (e2) {
                console.error('[Marker] 固定 DOM 兜底也失败', e2);
            }
        }
    }

    /**
     * 无 Box3 时的轻量 autoFit：遍历场景子节点世界坐标估包围范围，抬高 overviewAlarmList.position
     * @param {{ scene?: object, THREE?: object }} ctx
     */
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
        const liftY = Math.max(sizeY * 0.15, fitted * 0.8);
        console.log('[Marker] lightAutoFit', { maxDim, fitted, liftY, center: [cx, cy, cz], count });

        this._markerSetAlarmList(this._markerGetAlarmList().map((item, idx) => {
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
        }));
    }


    /**
     * 当前用于挂载/autoFit 的报警列表（大屏概览）
     * name 为唯一键；兼容旧字段 items
     */
    _markerGetAlarmList() {
        const cfg = this.markerConfig || {};
        return cfg.overviewAlarmList || cfg.items || [];
    }

    /** 写回 autoFit 后的坐标 */
    _markerSetAlarmList(list) {
        if (!this.markerConfig) return;
        if (this.markerConfig.overviewAlarmList) {
            this.markerConfig.overviewAlarmList = list;
        } else {
            this.markerConfig.items = list;
        }
    }

    /**
     * 创建虚拟标注锚点（DOM-only 核心数据源）
     * - 不创建真实 THREE.Sprite，只用 { position, userData } 结构兼容后续投影代码
     * - updateCount / updateType 会同步刷新对应 DOM 节点
     * @param {object} [_ctx] 场景上下文（当前未直接使用，保留参数便于扩展）
     */
    _markerMountVirtualMarkers(ctx) {
        const items = this._markerGetAlarmList();
        this._markers = items.map((item) => {
            const pos = item.position || [0, 0, 0];
            const type = this._markerResolveType(item.type);
            const userData = {
                type,
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
                ready: Promise.resolve(sprite),
                /** WS 推送数量时重绘 DOM 文案 */
                updateCount: (nextCount) => {
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
                    userData.type = this._markerResolveType(nextType);
                    if (sprite._domEl) {
                        this._markerPaintDomSkin(sprite._domEl, userData.type);
                    }
                    return Promise.resolve(userData.type);
                },
                dispose: () => { },
            };
        });
        console.log('[Marker] 虚拟标注已创建', this._markers.length);
    }

    /**
     * 挂载失败时的固定 DOM 兜底（屏幕中央横排）
     * 用于确认页面脚本生命周期可用；坐标不跟 3D，仅联调/容灾
     */
    _markerMountDomFallbackFixed() {
        if (this._markerDomLayer && this._markerDomLayer.parentNode) {
            this._markerDomLayer.parentNode.removeChild(this._markerDomLayer);
        }
        const layer = document.createElement('div');
        layer.setAttribute('data-marker-overlay', 'fixed');
        layer.style.cssText =
            'position:fixed;left:50%;top:42%;transform:translate(-50%,-50%);z-index:9999;pointer-events:none;display:flex;gap:12px;';
        this._markerGetAlarmList().forEach((item) => {
            const el = document.createElement('div');
            el.style.cssText = `${this._markerDomShellStyle()};position:relative;transform:none;`;
            this._markerPaintDomSkin(el, item.type);
            this._markerFillDomLabel(el, item.name, item.count);
            layer.appendChild(el);
        });
        document.body.appendChild(layer);
        this._markerDomLayer = layer;
        console.warn('[Marker] 已启用固定 DOM 兜底（说明 THREE/scene 未解析成功）');
    }

    /**
     * 根据场景包围盒把 overviewAlarmList.position 相对场景中心抬高，便于 DOM 投影落在建筑上方
     * 无 Box3 时回退到 _markerAutoFitLight
     * @param {{ scene?: object, THREE?: object }} ctx
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
            const fitted = Math.min(300, Math.max(20, maxDim * 0.05));
            const liftY = Math.max(size.y * 0.15, fitted * 0.8);

            console.log('[Marker] autoFit', { maxDim, fitted, liftY, center: center.toArray() });

            this._markerSetAlarmList(this._markerGetAlarmList().map((item, idx) => {
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
            }));
        } catch (e) {
            console.warn('[Marker] autoFit 失败，保留原始 position', e);
        }
    }

    /** 按首页(sceneIndex=0) / 厂房页切换 DOM 标注显隐 */
    syncMarkerVisibleByScene() {
        const show = this.state.sceneIndex === 0;
        if (this._markerDomLayer) {
            this._markerDomLayer.style.display = show ? 'block' : 'none';
        }
    }

    /**
     * WS 推送同步标注数量 / 告警色（按 name 匹配）
     * @param {Array<{ name: string, type?: string, count?: number|string }>} list
     */
    applyBuildingMarkers(list) {
        if (!Array.isArray(list) || !list.length || !this._markers.length) return;
        list.forEach((item) => {
            const target = this._markers.find((m) => m.sprite.userData.name === item.name);
            if (!target) return;
            if (item.count != null) target.updateCount(item.count);
            if (item.type != null) target.updateType(item.type);
        });
    }

    /** 销毁标注：停 RAF、移除 DOM 层、清空实例 */
    destroyStatusMarkers() {
        if (this._markerRaf) {
            cancelAnimationFrame(this._markerRaf);
            this._markerRaf = 0;
        }
        if (this._markerDomLayer && this._markerDomLayer.parentNode) {
            this._markerDomLayer.parentNode.removeChild(this._markerDomLayer);
        }
        this._markerDomLayer = null;
        this._markers.forEach((m) => {
            if (m.dispose) m.dispose();
        });
        this._markers = [];
        this._markerCtx = null;
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

    /** 告警类型对应填充色（urgent 红 / warning 黄 / normal 绿） */
    _markerAlertColor(type) {
        const key = this._markerResolveType(type);
        const colors = (this.markerConfig && this.markerConfig.colors) || {};
        if (colors[key]) return { fill: colors[key], edge: colors[key] };
        if (key === 'urgent') return { fill: '#e11d2e', edge: '#ff6b6b' };
        if (key === 'warning') return { fill: '#d4a017', edge: '#f5d76e' };
        return { fill: '#1f9d55', edge: '#6ee7a8' };
    }

    /**
     * 业务告警类型 → 内部标准：normal | warning | urgent
     * 兼容 red/yellow/green 别名
     */
    _markerResolveType(type) {
        const map = {
            urgent: 'urgent',
            red: 'urgent',
            warning: 'warning',
            yellow: 'warning',
            green: 'normal',
            normal: 'normal',
        };
        if (type == null || type === '') return 'normal';
        return map[String(type).trim().toLowerCase()] || 'normal';
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

        /** 每帧：按 sceneIndex 显隐，并把世界坐标投影为屏幕 left/top */
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
                btnClass1: 'bottom-btn btn-background-click',
                sceneIndex: 1,
            });
            if (this.ws && this.ws.readyState === WebSocket.OPEN) {
                this.ws.send(JSON.stringify({ topic: 'subscribe', buildingId: 12 }));
            }
            this.syncMarkerVisibleByScene();
        }
    }

    /** 返回首页大屏，取消厂房订阅并重新显示标注 */
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

    /** 触发 X12 开门动画（平台动画组件 id） */
    runX12Open() {
        this.$('devanimation-95339045').runAnimation();
    }

    /** 触发 X12 关门动画 */
    runX12Close() {
        this.$('devanimation-464782d2').runAnimation();
    }

    /** 安全转普通对象，非 object 返回 {} */
    asObject(value) {
        return Object.prototype.toString.call(value) === '[object Object]' ? value : {};
    }

    hasOwn(obj, key) {
        return Object.prototype.hasOwnProperty.call(obj, key);
    }

    /** 处理 WS 全量初始化数据，并同步 buildingMarkers */
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
        // buildingMarkers: [{ name, type, count }]
        this.applyBuildingMarkers(payload.buildingMarkers);
    }

    /** 处理 WS 增量推送：只更新 payload 中出现的字段，并同步标注 */
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
