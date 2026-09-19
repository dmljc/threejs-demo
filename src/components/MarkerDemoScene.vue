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
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js'
import {
  createMarkerFromItem,
  bindMarkerPointerEvents,
  updateMarkers,
  createMockAlertWebSocket,
  DEMO1_MARKER_SEED,
  DEMO2_MARKER_SEED,
} from '../markers'

const props = defineProps({
  /** @type {'name' | 'nameCount'} */
  mode: { type: String, default: 'name' },
})

const emit = defineEmits(['marker-click'])
const containerRef = ref(null)

/** 概览页 → overview.fbx；X12厂房 → X12.fbx */
const MODEL_URL_BY_MODE = {
  name: '/overview.fbx',
  nameCount: '/X12.fbx',
}

let renderer
let scene
let camera
let controls
let animationId
let resizeObserver
let markerPointer
let mockWs
let sceneModel
let ground
const markers = []

function getSeed() {
  return props.mode === 'name' ? DEMO1_MARKER_SEED : DEMO2_MARKER_SEED
}

function getModelUrl() {
  return MODEL_URL_BY_MODE[props.mode] || MODEL_URL_BY_MODE.name
}

function createGround(size = 40) {
  const geo = new THREE.PlaneGeometry(size, size)
  const mat = new THREE.MeshStandardMaterial({
    color: 0x6b7280,
    roughness: 0.92,
    metalness: 0.05,
  })
  const mesh = new THREE.Mesh(geo, mat)
  mesh.rotation.x = -Math.PI / 2
  mesh.receiveShadow = true
  return mesh
}

function enableModelShadows(root) {
  root.traverse((child) => {
    if (!child.isMesh) return
    child.castShadow = true
    child.receiveShadow = true
    const materials = Array.isArray(child.material) ? child.material : [child.material]
    materials.forEach((mat) => {
      if (mat?.map) mat.map.colorSpace = THREE.SRGBColorSpace
    })
  })
}

/**
 * 将 FBX 缩放到合适尺寸，底面贴地、XZ 居中
 * @returns {{ size: THREE.Vector3, height: number }}
 */
function fitModelToGround(object, targetSize = 12) {
  object.position.set(0, 0, 0)
  object.rotation.set(0, 0, 0)
  object.scale.set(1, 1, 1)
  object.updateMatrixWorld(true)

  const box = new THREE.Box3().setFromObject(object)
  const size = box.getSize(new THREE.Vector3())
  const maxDim = Math.max(size.x, size.y, size.z, 1e-6)
  object.scale.setScalar(targetSize / maxDim)
  object.updateMatrixWorld(true)

  box.setFromObject(object)
  const center = box.getCenter(new THREE.Vector3())
  box.getSize(size)
  object.position.set(-center.x, -box.min.y, -center.z)
  object.updateMatrixWorld(true)

  return { size, height: size.y }
}

function frameCameraToModel(size) {
  if (!camera || !controls) return
  const span = Math.max(size.x, size.z, size.y * 0.6, 4)
  const dist = span * 1.35
  camera.position.set(dist * 0.55, dist * 0.75, dist * 0.95)
  camera.near = Math.max(0.01, dist / 200)
  camera.far = Math.max(100, dist * 20)
  camera.updateProjectionMatrix()
  controls.target.set(0, size.y * 0.25, 0)
  controls.minDistance = span * 0.35
  controls.maxDistance = span * 4
  controls.update()

  const dir = scene?.children.find((c) => c.isDirectionalLight)
  if (dir) {
    const extent = Math.max(span, 8)
    dir.position.set(extent * 0.8, extent * 1.4, extent * 0.5)
    dir.shadow.camera.near = 0.5
    dir.shadow.camera.far = extent * 6
    dir.shadow.camera.left = -extent
    dir.shadow.camera.right = extent
    dir.shadow.camera.top = extent
    dir.shadow.camera.bottom = -extent
    dir.shadow.camera.updateProjectionMatrix()
  }
}

async function loadSceneModel() {
  if (sceneModel && scene) {
    scene.remove(sceneModel)
    sceneModel = null
  }

  const loader = new FBXLoader()
  const model = await loader.loadAsync(getModelUrl())
  enableModelShadows(model)

  const targetSize = props.mode === 'name' ? 14 : 10
  const { size } = fitModelToGround(model, targetSize)

  if (ground) {
    const groundSize = Math.max(size.x, size.z) * 2.5
    ground.geometry.dispose()
    ground.geometry = new THREE.PlaneGeometry(groundSize, groundSize)
  }

  scene.add(model)
  sceneModel = model
  frameCameraToModel(size)
  return model
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
  sceneModel?.updateMatrixWorld(true)
  const list = getSeed().map((item) => ({
    ...item,
    // seed 保存的是 FBX 模型本地坐标，模型缩放/居中后需转成场景世界坐标
    position: sceneModel
      ? sceneModel.localToWorld(new THREE.Vector3().fromArray(item.position)).toArray()
      : [...item.position],
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
  ground = createGround()
  scene.add(ground)

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
  if (sceneModel && scene) scene.remove(sceneModel)
  sceneModel = null
  ground = null
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
  try {
    await loadSceneModel()
  } catch (err) {
    console.error(`[fbx:${props.mode}] load failed`, err)
  }
  await loadMarkers()
  startMockWs()
})

watch(
  () => props.mode,
  async () => {
    if (!scene) return
    try {
      await loadSceneModel()
    } catch (err) {
      console.error(`[fbx:${props.mode}] load failed`, err)
    }
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
