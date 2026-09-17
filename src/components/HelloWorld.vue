<template>
  <div class="demo-page">
    <header class="demo-header">
      <h1>自定义状态标注 Demo</h1>
      <p class="demo-desc">{{ currentDesc }}</p>
      <div class="tabs">
        <button
          type="button"
          class="tab"
          :class="{ active: activeDemo === 'name' }"
          @click="activeDemo = 'name'"
        >
          Demo 1 · 图一
        </button>
        <button
          type="button"
          class="tab"
          :class="{ active: activeDemo === 'nameCount' }"
          @click="activeDemo = 'nameCount'"
        >
          Demo 2 · 图二
        </button>
      </div>
    </header>

    <div class="demo-body">
      <!-- 用 key 强制切换时重建场景，避免状态串扰 -->
      <MarkerDemoScene
        :key="activeDemo"
        :mode="activeDemo"
        @marker-click="onMarkerClick"
      />
    </div>

    <aside v-if="lastClick" class="click-toast">
      点击：{{ lastClick.code
      }}{{ lastClick.count != null ? `-${String(lastClick.count).padStart(3, '0')}` : '' }}
      · {{ lastClick.alertType }}
    </aside>
  </div>
</template>

<script setup>
import { computed, ref } from 'vue'
import MarkerDemoScene from './MarkerDemoScene.vue'

/** name = 图一；nameCount = 图二 */
const activeDemo = ref('name')
const lastClick = ref(null)

const currentDesc = computed(() =>
  activeDemo.value === 'name'
    ? '图一：厂房名称固定（如 X01），背景色随告警类型动态切换，支持点击'
    : '图二：厂房名称固定，后拼接动态数量（如 X01-015），背景色随告警类型动态切换，支持点击',
)

function onMarkerClick(payload) {
  lastClick.value = payload
  window.clearTimeout(onMarkerClick._t)
  onMarkerClick._t = window.setTimeout(() => {
    lastClick.value = null
  }, 2500)
}
</script>

<style scoped>
.demo-page {
  position: fixed;
  inset: 0;
  display: flex;
  flex-direction: column;
  background: #e8ecf1;
  font-family: 'Helvetica Neue', Arial, sans-serif;
  color: #1f2937;
}

.demo-header {
  flex: 0 0 auto;
  padding: 16px 20px 12px;
  background: rgba(255, 255, 255, 0.92);
  border-bottom: 1px solid #d1d5db;
  backdrop-filter: blur(8px);
  z-index: 2;
}

.demo-header h1 {
  margin: 0;
  font-size: 18px;
  font-weight: 600;
  letter-spacing: 0.02em;
}

.demo-desc {
  margin: 6px 0 12px;
  font-size: 13px;
  color: #6b7280;
  line-height: 1.4;
}

.tabs {
  display: flex;
  gap: 8px;
}

.tab {
  appearance: none;
  border: 1px solid #cbd5e1;
  background: #f8fafc;
  color: #334155;
  border-radius: 6px;
  padding: 7px 14px;
  font-size: 13px;
  cursor: pointer;
  transition: background 0.15s, border-color 0.15s, color 0.15s;
}

.tab:hover {
  border-color: #94a3b8;
}

.tab.active {
  background: #0f172a;
  border-color: #0f172a;
  color: #fff;
}

.demo-body {
  flex: 1 1 auto;
  min-height: 0;
  position: relative;
}

.click-toast {
  position: fixed;
  left: 50%;
  bottom: 24px;
  transform: translateX(-50%);
  z-index: 3;
  padding: 10px 16px;
  border-radius: 8px;
  background: rgba(15, 23, 42, 0.88);
  color: #f8fafc;
  font-size: 13px;
  pointer-events: none;
  white-space: nowrap;
}
</style>
