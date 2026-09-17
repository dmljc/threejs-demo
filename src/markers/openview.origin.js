class LowcodeComponent extends Component {
    state = {
      btnClass1: 'bottom-btn btn-background-click',
      /**
       * 当前场景索引（枚举）
       * 0 = 首页 / 大屏概览页
       * 1 = X12 厂房
       */
      sceneIndex: 0,
      // 警告统计
      alarmStats: {},
      // 处置统计
      disposalStats: {},
      // 流出物
      effluentList: {
        X12: [],
        X03: [],
      },
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
    };
  
    componentDidMount() {
      this.handleWss();
  
      console.error('-=-----window----', window)
    }
  
    /**
     * 页面只负责 WebSocket 连接与按字段分发。
     * 列表覆盖、监测卡折线合并、QTC 增量拼接 / 裁窗均在对应自定义组件内维护。
     */
    handleWss() {
      // const url = 'ws://192.168.1.2:8088';
      const url = 'ws://10.137.162.120:8088';
      this.ws = new WebSocket(`${url}/api/ws/realtime`);
  
      this.ws.onopen = () => {
        console.log('✅ WebSocket 连接已建立');
      };
  
      this.ws.onmessage = (e) => {
        try {
          const msg = JSON.parse(e.data);
          if (!msg || !msg.data) {
            return;
          }
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
  
    goX12(e, params) {
      if (params && params.key === 1) {
        this.setState({
          btnClass1: 'bottom-btn btn-background-click',
          sceneIndex: 1,
        });
  
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
          this.ws.send(JSON.stringify({
            topic: 'subscribe',
            buildingId: 12
          }));
        }
      }
    }
  
    goHome() {
      this.setState({
        btnClass1: 'bottom-btn btn-background-click',
        sceneIndex: 0,
      });
  
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({
          topic: 'unsubscribe'
        }));
      }
    }
  
    // X12 厂房分层动画
    runX12Open() {
      this.$('devanimation-95339045').runAnimation();
    }
  
    // X12 厂房分层合并动画
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
    }
  
    applyWsData(data) {
      const payload = this.asObject(data);
      if (!Object.keys(payload).length) {
        return;
      }
  
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
        if (this.hasOwn(payload, key)) {
          next[key] = payload[key];
        }
      });
  
      if (Object.keys(next).length) {
        this.setState(next);
      }
    }
  
    componentWillUnmount() {
      if (this.ws) {
        this.ws.onopen = null;
        this.ws.onmessage = null;
        this.ws.onerror = null;
        this.ws.onclose = null;
        this.ws.close();
        this.ws = null;
      }
    }
  }
  