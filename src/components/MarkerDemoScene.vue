<template>
  <div ref="containerRef" class="scene-host"></div>
</template>

<script setup>
/**
 * 单个标注演示场景
 * props.mode:
 *   - name：图一 — 厂房名固定，仅告警类型切背景
 *   - nameCount：图二 — 厂房名固定 + 动态数量，告警类型切背景
 */
import { onMounted, onBeforeUnmount, ref, watch } from 'vue'
import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import {
  createMarkerFromItem,
  bindMarkerPointerEvents,
  updateMarkers,
  createMockAlertWebSocket,
  DEMO1_MARKER_SEED,
  DEMO2_MARKER_SEED,
  DEMO_BUILDINGS,
} from '../markers'

const props = defineProps({
  /** @type {'name' | 'nameCount'} */
  mode: { type: String, default: 'name' },
})

const emit = defineEmits(['marker-click'])
const containerRef = ref(null)

let renderer
let scene
let camera
let controls
let animationId
let resizeObserver
let markerPointer
let mockWs
const markers = []

function getSeed() {
  return props.mode === 'name' ? DEMO1_MARKER_SEED : DEMO2_MARKER_SEED
}

function createGround() {
  const geo = new THREE.PlaneGeometry(20, 20)
  const mat = new THREE.MeshStandardMaterial({
    color: 0x6b7280,
    roughness: 0.92,
    metalness: 0.05,
  })
  const ground = new THREE.Mesh(geo, mat)
  ground.rotation.x = -Math.PI / 2
  ground.receiveShadow = true
  return ground
}

function createBuildings() {
  const group = new THREE.Group()
  // Tab1 / Tab2 均为 4 个立方体，与 4 个标注位置一一对应
  DEMO_BUILDINGS.forEach((b) => {
    const mesh = new THREE.Mesh(
      new THREE.BoxGeometry(b.w, b.h, b.d),
      new THREE.MeshStandardMaterial({
        color: b.color,
        roughness: 0.85,
        metalness: 0.1,
      }),
    )
    mesh.position.set(b.x, b.h / 2, b.z)
    mesh.castShadow = true
    mesh.receiveShadow = true
    group.add(mesh)
  })
  return group
}

function clearMarkers() {
  markers.forEach((m) => {
    scene?.remove(m.sprite)
    m.dispose()
  })
  markers.length = 0
}

async function loadMarkers() {
  clearMarkers()
  const list = getSeed().map((item) => ({
    ...item,
    position: [...item.position],
  }))
  for (const item of list) {
    const marker = createMarkerFromItem(item)
    await marker.ready
    scene.add(marker.sprite)
    markers.push(marker)
  }
}

function startMockWs() {
  mockWs?.close()
  const seed = getSeed()
  mockWs = createMockAlertWebSocket({
    seed,
    // 图一：只推告警类型；图二：同时推类型 + 数量
    updateCount: props.mode === 'nameCount',
    intervalMs: 5000,
    onOpen: () => console.log(`[mock-ws:${props.mode}] connected`),
    onClose: () => console.log(`[mock-ws:${props.mode}] closed`),
    onMessage: (payload) => {
      if (payload?.type === 'alert_update') {
        updateMarkers(markers, payload.data)
      }
    },
  })
}

function initScene(el) {
  const width = el.clientWidth
  const height = el.clientHeight

  scene = new THREE.Scene()
  scene.background = new THREE.Color(0xd6dce4)

  camera = new THREE.PerspectiveCamera(45, width / height, 0.1, 100)
  camera.position.set(0, 8, 10)

  renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true })
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
  renderer.setSize(width, height)
  renderer.outputColorSpace = THREE.SRGBColorSpace
  renderer.shadowMap.enabled = true
  el.appendChild(renderer.domElement)

  controls = new OrbitControls(camera, renderer.domElement)
  controls.target.set(0, 0.5, 0.4)
  controls.enableDamping = true
  controls.maxPolarAngle = Math.PI * 0.48
  controls.minDistance = 4
  controls.maxDistance = 24

  const ambient = new THREE.AmbientLight(0xffffff, 0.75)
  const dir = new THREE.DirectionalLight(0xffffff, 1.1)
  dir.position.set(6, 12, 4)
  dir.castShadow = true
  dir.shadow.mapSize.set(1024, 1024)
  scene.add(ambient, dir)
  scene.add(createGround())
  scene.add(createBuildings())

  markerPointer = bindMarkerPointerEvents({
    renderer,
    getCamera: () => camera,
    getMarkers: () => markers,
    onClick: (payload) => {
      console.log(`[marker-click:${props.mode}]`, payload)
      emit('marker-click', { ...payload, demo: props.mode })
    },
  })

  const animate = () => {
    animationId = requestAnimationFrame(animate)
    controls.update()
    renderer.render(scene, camera)
  }
  animate()

  resizeObserver = new ResizeObserver(() => {
    if (!containerRef.value || !renderer || !camera) return
    const w = containerRef.value.clientWidth
    const h = containerRef.value.clientHeight
    camera.aspect = w / h
    camera.updateProjectionMatrix()
    renderer.setSize(w, h)
  })
  resizeObserver.observe(el)
}

function disposeScene() {
  mockWs?.close()
  mockWs = null
  markerPointer?.unbind()
  markerPointer = null
  if (animationId) cancelAnimationFrame(animationId)
  animationId = null
  resizeObserver?.disconnect()
  resizeObserver = null
  clearMarkers()
  controls?.dispose()
  controls = null
  renderer?.dispose()
  if (renderer?.domElement?.parentNode) {
    renderer.domElement.parentNode.removeChild(renderer.domElement)
  }
  renderer = null
  scene = null
  camera = null
}

onMounted(async () => {
  if (!containerRef.value) return
  initScene(containerRef.value)
  await loadMarkers()
  startMockWs()
})

watch(
  () => props.mode,
  async () => {
    if (!scene) return
    await loadMarkers()
    startMockWs()
  },
)

onBeforeUnmount(() => {
  disposeScene()
})
</script>

<style scoped>
.scene-host {
  width: 100%;
  height: 100%;
  min-height: 420px;
  overflow: hidden;
  background: #d6dce4;
}

.scene-host :deep(canvas) {
  display: block;
  width: 100% !important;
  height: 100% !important;
}
</style>
