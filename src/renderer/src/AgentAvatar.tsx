import { memo, useEffect, useRef } from 'react'
import * as voice from './voice'
import * as THREE from 'three'
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js'
import type { Cli, PersonaId } from '@shared/types'
import { PROVIDERS } from './avatarTheme'

const HATS: Record<PersonaId, string> = {
  strategist: 'STRATEGY',
  engineer: 'ENGINEER',
  researcher: 'RESEARCH',
  designer: 'DESIGN',
  skeptic: 'SKEPTIC',
  customer: 'CUSTOMER'
}

export type Presence = 'idle' | 'listening' | 'reading' | 'responding' | 'failed'
// voiceId: the member whose audio drives this mascot's mouth (voices on)
type Props = { cli: Cli; persona: PersonaId; model?: string; presence: Presence; voiceId?: string }

function AgentAvatar({ cli, persona, model, presence, voiceId }: Props): React.JSX.Element {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const presenceRef = useRef(presence)
  const voiceRef = useRef(voiceId)
  const provider = PROVIDERS[cli]
  useEffect(() => {
    presenceRef.current = presence
    voiceRef.current = voiceId
  }, [presence, voiceId])

  useEffect(() => {
    const host = hostRef.current
    if (!host) return undefined
    let renderer: THREE.WebGLRenderer
    try {
      renderer = new THREE.WebGLRenderer({
        alpha: true,
        antialias: true,
        powerPreference: 'low-power'
      })
    } catch {
      host.dataset.ready = 'false'
      return undefined
    }
    host.dataset.ready = 'true'
    renderer.setPixelRatio(Math.min(Math.max(window.devicePixelRatio, 2), 2.5))
    renderer.outputColorSpace = THREE.SRGBColorSpace
    renderer.toneMapping = THREE.ACESFilmicToneMapping
    renderer.toneMappingExposure = 1.35
    renderer.shadowMap.enabled = true
    renderer.shadowMap.type = THREE.PCFShadowMap
    const canvas = renderer.domElement
    canvas.setAttribute(
      'aria-label',
      `${provider.name} 3D agent. Hat: ${HATS[persona]}. Model: ${model || 'Model not reported'}. Drag or use arrow keys to rotate. Press Home to reset.`
    )
    canvas.setAttribute('role', 'img')
    canvas.tabIndex = 0
    host.appendChild(canvas)
    const scene = new THREE.Scene()
    const camera = new THREE.PerspectiveCamera(34, 1, 0.1, 30)
    camera.position.set(0, 1.6, 5.9)
    camera.lookAt(0, 1.15, 0)
    const rig = new THREE.Group()
    scene.add(rig)
    const body = new THREE.Group()
    rig.add(body)
    const head = new THREE.Group()
    head.position.y = 1.75
    body.add(head)
    const textures: THREE.Texture[] = []
    const geometries = new Set<THREE.BufferGeometry>()
    const materials = new Set<THREE.Material>()
    const material = (
      color: string,
      roughness = 0.65,
      metalness = 0.05
    ): THREE.MeshStandardMaterial => {
      const mat = new THREE.MeshStandardMaterial({ color, roughness, metalness })
      materials.add(mat)
      return mat
    }
    const shell = material(provider.shell, 0.28, 0.15)
    const cloth = material(provider.suit, 0.85)
    const capMat = material(provider.color, 0.8)
    const dark = material('#242a34', 0.3, 0.15)
    const joint = material('#4a5058', 0.6, 0.25)
    const visor = material('#182b30', 0.2, 0.4)
    const glow = new THREE.MeshStandardMaterial({
      color: provider.color,
      emissive: provider.color,
      emissiveIntensity: 0.8,
      roughness: 0.2
    })
    materials.add(glow)
    function mesh(
      geometry: THREE.BufferGeometry,
      mat: THREE.Material,
      parent: THREE.Object3D,
      x: number,
      y: number,
      z: number
    ): THREE.Mesh {
      geometries.add(geometry)
      const obj = new THREE.Mesh(geometry, mat)
      obj.position.set(x, y, z)
      obj.castShadow = true
      obj.receiveShadow = true
      parent.add(obj)
      return obj
    }
    function box(
      w: number,
      h: number,
      d: number,
      radius: number,
      mat: THREE.Material,
      parent: THREE.Object3D,
      x: number,
      y: number,
      z: number
    ): THREE.Mesh {
      return mesh(new RoundedBoxGeometry(w, h, d, 3, radius), mat, parent, x, y, z)
    }
    function sphere(
      radius: number,
      mat: THREE.Material,
      parent: THREE.Object3D,
      x: number,
      y: number,
      z: number
    ): THREE.Mesh {
      return mesh(new THREE.SphereGeometry(radius, 24, 16), mat, parent, x, y, z)
    }
    function label(
      width: number,
      height: number,
      draw: (ctx: CanvasRenderingContext2D) => void
    ): THREE.MeshBasicMaterial {
      const surface = document.createElement('canvas')
      surface.width = width
      surface.height = height
      const ctx = surface.getContext('2d')!
      draw(ctx)
      const texture = new THREE.CanvasTexture(surface)
      texture.colorSpace = THREE.SRGBColorSpace
      texture.anisotropy = renderer.capabilities.getMaxAnisotropy()
      textures.push(texture)
      const mat = new THREE.MeshBasicMaterial({
        map: texture,
        transparent: true,
        side: THREE.FrontSide,
        toneMapped: false
      })
      materials.add(mat)
      return mat
    }
    function fitText(
      ctx: CanvasRenderingContext2D,
      text: string,
      y: number,
      max: number,
      initial: number,
      color: string
    ): void {
      let size = initial
      do {
        ctx.font = `700 ${size--}px Arial, sans-serif`
      } while (ctx.measureText(text).width > max && size > 10)
      ctx.fillStyle = color
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillText(text, 512, y)
    }

    // A tailored jumpsuit, articulated limbs, and small weighted boots.
    box(1.04, 1.04, 0.67, 0.2, cloth, body, 0, 0.7, 0)
    mesh(new THREE.CylinderGeometry(0.28, 0.34, 0.11, 32), dark, body, 0, 1.22, 0)
    mesh(new THREE.CylinderGeometry(0.16, 0.16, 0.21, 24), joint, body, 0, 1.34, 0)
    const arms: THREE.Group[] = []
    for (const side of [-1, 1]) {
      const arm = new THREE.Group()
      arm.position.set(side * 0.63, 1.0, 0)
      body.add(arm)
      arms.push(arm)
      sphere(0.2, cloth, arm, 0, 0, 0)
      const sleeve = mesh(
        new THREE.CapsuleGeometry(0.155, 0.35, 6, 16),
        cloth,
        arm,
        side * 0.04,
        -0.29,
        0.015
      )
      sleeve.rotation.z = side * 0.12
      mesh(
        new THREE.CylinderGeometry(0.158, 0.158, 0.08, 20),
        capMat,
        arm,
        side * 0.07,
        -0.57,
        0.015
      )
      sphere(0.17, shell, arm, side * 0.07, -0.7, 0.015)
      box(0.27, 0.33, 0.32, 0.09, cloth, body, side * 0.26, 0.04, 0)
      box(0.33, 0.22, 0.49, 0.08, dark, body, side * 0.26, -0.16, 0.07)
    }
    // Keep the zipper entirely below the raised name badge.
    box(0.055, 0.29, 0.017, 0.01, capMat, body, 0, 0.425, 0.343)
    for (const side of [-1, 1])
      box(0.22, 0.14, 0.035, 0.025, capMat, body, side * 0.28, 0.41, 0.345)

    // Branding and selected model are actual texture decals attached to the suit.
    const badge = label(1024, 512, (ctx) => {
      ctx.fillStyle = provider.shell
      ctx.beginPath()
      ctx.roundRect(10, 10, 1004, 492, 60)
      ctx.fill()
      ctx.strokeStyle = `${provider.ink}30`
      ctx.lineWidth = 5
      ctx.stroke()
      fitText(ctx, provider.name, 112, 880, 116, provider.ink)
      const modelName = model || 'CONNECTING'
      ctx.font = '700 116px Arial, sans-serif'
      if (ctx.measureText(modelName).width <= 880) {
        fitText(ctx, modelName, 330, 880, 116, provider.ink)
      } else {
        // Keep long model IDs legible on two lines, preferably at a separator.
        const middle = Math.ceil(modelName.length / 2)
        const breaks = Array.from(modelName.matchAll(/[-_ /]/g), (match) => match.index! + 1)
        const split =
          breaks.sort((a, b) => Math.abs(a - middle) - Math.abs(b - middle))[0] ?? middle
        fitText(ctx, modelName.slice(0, split), 282, 880, 102, provider.ink)
        fitText(ctx, modelName.slice(split), 404, 880, 102, provider.ink)
      }
    })
    box(0.96, 0.51, 0.035, 0.045, shell, body, 0, 0.87, 0.35)
    const frontLabel = mesh(new THREE.PlaneGeometry(0.94, 0.49), badge, body, 0, 0.87, 0.371)
    frontLabel.castShadow = false
    frontLabel.receiveShadow = false
    const backLabel = label(1024, 512, (ctx) => {
      fitText(ctx, provider.name, 170, 880, 105, provider.ink)
      fitText(ctx, HATS[persona], 310, 850, 70, provider.ink)
    })
    const back = mesh(new THREE.PlaneGeometry(0.8, 0.4), backLabel, body, 0, 0.85, -0.344)
    back.rotation.y = Math.PI

    // Soft robot shell and emissive screen expressions.
    box(1.25, 0.94, 0.8, 0.24, shell, head, 0, 0, 0)
    box(1.04, 0.61, 0.08, 0.18, visor, head, 0, -0.015, 0.4)
    for (const side of [-1, 1]) {
      const ear = mesh(
        new THREE.CylinderGeometry(0.18, 0.18, 0.1, 24),
        capMat,
        head,
        side * 0.64,
        -0.02,
        0
      )
      ear.rotation.z = Math.PI / 2
      sphere(0.045, glow, head, side * 0.698, -0.02, 0.025)
    }
    const eyes: THREE.Mesh[] = []
    for (const side of [-1, 1]) {
      const eye = box(0.12, 0.19, 0.025, 0.052, glow, head, side * 0.23, 0.045, 0.455)
      eyes.push(eye)
      box(0.12, 0.025, 0.02, 0.01, capMat, head, side * 0.23, -0.16, 0.457)
    }
    // built around its own centre so it can open (scale) in place while the seat's voice plays
    const mouthCurve = new THREE.QuadraticBezierCurve3(
      new THREE.Vector3(-0.11, 0.055, 0),
      new THREE.Vector3(0, -0.055, 0),
      new THREE.Vector3(0.11, 0.055, 0)
    )
    const mouth = mesh(
      new THREE.TubeGeometry(mouthCurve, 16, 0.013, 6, false),
      glow,
      head,
      0,
      -0.175,
      0.466
    )

    // A real cap: dome, band, curved visor, top button, and role patch.
    mesh(
      new THREE.SphereGeometry(0.65, 32, 16, 0, Math.PI * 2, 0, Math.PI / 2),
      capMat,
      head,
      0,
      0.39,
      0
    ).scale.set(1, 0.6, 0.76)
    mesh(new THREE.CylinderGeometry(0.642, 0.642, 0.17, 32), capMat, head, 0, 0.425, 0).scale.z =
      0.76
    const brim = mesh(new THREE.SphereGeometry(0.56, 32, 12), capMat, head, 0, 0.34, 0.42)
    brim.scale.set(1.1, 0.065, 0.74)
    sphere(0.055, cloth, head, 0, 0.79, 0)
    const rolePatch = label(1024, 512, (ctx) => {
      ctx.fillStyle = provider.ink
      ctx.beginPath()
      ctx.roundRect(12, 28, 1000, 456, 74)
      ctx.fill()
      fitText(ctx, HATS[persona], 261, 880, 155, '#fff4e4')
    })
    mesh(new THREE.PlaneGeometry(0.87, 0.27), rolePatch, head, 0, 0.55, 0.497)

    // Small brand-specific geometry makes the four families recognizable in silhouette.
    if (cli === 'claude') {
      for (let i = 0; i < 10; i++) {
        const ray = box(
          0.025,
          0.13,
          0.025,
          0.008,
          capMat,
          body,
          -0.38 + Math.cos((i * Math.PI) / 5) * 0.08,
          1.12 + Math.sin((i * Math.PI) / 5) * 0.08,
          0.35
        )
        ray.rotation.z = (i * Math.PI) / 5 - Math.PI / 2
      }
    } else if (cli === 'gemini') {
      const star = new THREE.Shape()
      for (let i = 0; i < 8; i++) {
        const a = (i * Math.PI) / 4
        const r = i % 2 ? 0.035 : 0.12
        if (!i) star.moveTo(Math.cos(a) * r, Math.sin(a) * r)
        else star.lineTo(Math.cos(a) * r, Math.sin(a) * r)
      }
      star.closePath()
      mesh(
        new THREE.ExtrudeGeometry(star, { depth: 0.025, bevelEnabled: false }),
        glow,
        head,
        0.53,
        0.42,
        0.35
      )
    } else if (cli === 'codex') {
      mesh(new THREE.TorusGeometry(0.07, 0.024, 8, 24), capMat, body, -0.37, 1.12, 0.35)
    } else if (cli === 'harness') {
      // a small hexagonal bolt: our own build
      mesh(
        new THREE.CylinderGeometry(0.085, 0.085, 0.03, 6),
        capMat,
        body,
        -0.37,
        1.12,
        0.35
      ).rotation.x = Math.PI / 2
    } else {
      for (const angle of [-0.65, 0.65])
        box(0.025, 0.19, 0.025, 0.008, shell, body, -0.37, 1.1, 0.35).rotation.z = angle
    }
    const platform = mesh(
      new THREE.CylinderGeometry(1.0, 1.03, 0.07, 64),
      material('#252734', 0.7, 0.1),
      scene,
      0,
      -0.315,
      0
    )
    platform.receiveShadow = true
    const rim = mesh(new THREE.TorusGeometry(0.97, 0.012, 6, 64), glow, scene, 0, -0.272, 0)
    rim.rotation.x = -Math.PI / 2
    scene.add(new THREE.HemisphereLight('#e9e4ff', '#615973', 2.3))
    const key = new THREE.DirectionalLight('#fff0dd', 3.5)
    key.position.set(-3, 5, 5)
    key.castShadow = true
    key.shadow.mapSize.set(512, 512)
    key.shadow.camera.left = -2
    key.shadow.camera.right = 2
    key.shadow.camera.top = 3
    key.shadow.camera.bottom = -2
    key.shadow.normalBias = 0.025
    scene.add(key)
    const fill = new THREE.DirectionalLight(provider.color, 2.5)
    fill.position.set(3, 2, -2)
    scene.add(fill)
    const front = new THREE.DirectionalLight('#ffffff', 0.8)
    front.position.set(0, 2, 5)
    scene.add(front)

    let width = 0,
      height = 0,
      visible = true,
      disposed = false
    let yaw = 0,
      pitch = 0,
      dragging = false,
      lastX = 0,
      lastY = 0,
      lastFrame = 0
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)')
    const resize = new ResizeObserver(([entry]) => {
      width = entry.contentRect.width
      height = entry.contentRect.height
      if (!width || !height) return
      renderer.setSize(width, height, false)
      camera.aspect = width / height
      camera.position.z = camera.aspect < 1 ? 6.5 : 5.9
      camera.updateProjectionMatrix()
      renderer.render(scene, camera)
    })
    resize.observe(host)
    const intersection = new IntersectionObserver(([entry]) => {
      visible = entry.isIntersecting
    })
    intersection.observe(host)
    const down = (event: PointerEvent): void => {
      dragging = true
      lastX = event.clientX
      lastY = event.clientY
      canvas.setPointerCapture(event.pointerId)
    }
    const move = (event: PointerEvent): void => {
      if (!dragging) return
      yaw += (event.clientX - lastX) * 0.012
      pitch = Math.max(-0.25, Math.min(0.25, pitch + (event.clientY - lastY) * 0.004))
      lastX = event.clientX
      lastY = event.clientY
    }
    const up = (): void => {
      dragging = false
    }
    const keys = (event: KeyboardEvent): void => {
      if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home'].includes(event.key)) return
      event.preventDefault()
      if (event.key === 'Home') {
        yaw = 0
        pitch = 0
      } else if (event.key === 'ArrowLeft') yaw -= 0.18
      else if (event.key === 'ArrowRight') yaw += 0.18
      else pitch = Math.max(-0.25, Math.min(0.25, pitch + (event.key === 'ArrowUp' ? -0.05 : 0.05)))
    }
    const reset = (): void => {
      yaw = 0
      pitch = 0
    }
    const contextLost = (): void => {
      host.dataset.ready = 'false'
    }
    const contextRestored = (): void => {
      host.dataset.ready = 'true'
    }
    canvas.addEventListener('webglcontextlost', contextLost)
    canvas.addEventListener('webglcontextrestored', contextRestored)
    canvas.addEventListener('pointerdown', down)
    canvas.addEventListener('pointermove', move)
    canvas.addEventListener('pointerup', up)
    canvas.addEventListener('pointercancel', up)
    canvas.addEventListener('keydown', keys)
    canvas.addEventListener('dblclick', reset)
    renderer.setAnimationLoop((time) => {
      if (disposed || !width || !height || !visible || document.hidden || time - lastFrame < 33)
        return
      lastFrame = time
      const t = time / 1000
      const animated = !reducedMotion.matches
      const p = presenceRef.current
      // with voices, whoever is audible gestures; otherwise whoever is writing
      const audible = voice.talking()
      const talking = animated && (audible ? audible === voiceRef.current : p === 'responding')
      const reading = p === 'reading'
      const failed = p === 'failed'
      // Poses ease in, so a change of state reads as a gesture rather than a jump.
      const ease = (from: number, to: number): number => from + (to - from) * 0.12
      const loud = voiceRef.current ? voice.level(voiceRef.current) : 0
      mouth.scale.y += (1 + loud * 2.4 - mouth.scale.y) * 0.5 // fast: it follows syllables
      mouth.scale.x += (1 - loud * 0.25 - mouth.scale.x) * 0.5
      rig.rotation.y += (yaw - rig.rotation.y) * 0.15
      rig.rotation.x += (pitch - rig.rotation.x) * 0.15
      body.position.y = animated && !failed ? Math.sin(t * 1.6) * 0.017 : ease(body.position.y, 0)
      // Listening: an attentive tilt. Reading: head down over the page. Failed: slumped.
      head.rotation.x = ease(
        head.rotation.x,
        failed ? 0.24 : reading ? 0.13 : talking ? Math.sin(t * 3.3) * 0.025 : 0
      )
      head.rotation.z = ease(
        head.rotation.z,
        failed
          ? 0.09
          : talking
            ? Math.sin(t * 2.4) * 0.04
            : (p === 'listening' ? 0.05 : 0) + (animated ? Math.sin(t * 0.8) * 0.018 : 0)
      )
      arms[0].rotation.z = ease(
        arms[0].rotation.z,
        talking ? -0.15 - Math.sin(t * 2) * 0.12 : -0.07
      )
      arms[1].rotation.z = ease(arms[1].rotation.z, talking ? 0.12 + Math.sin(t * 1.8) * 0.1 : 0.07)
      const blink = animated && t % 5.1 > 4.94 ? 0.12 : 1
      eyes.forEach((eye, i) => {
        eye.scale.y = failed ? 0.2 : reading ? 0.7 * blink : blink
        eye.position.x = (i ? 0.23 : -0.23) + (reading && animated ? Math.sin(t * 2.2) * 0.035 : 0)
      })
      glow.emissiveIntensity = failed
        ? 0.12
        : talking
          ? 0.8 + Math.sin(t * 4) * 0.15
          : reading
            ? 0.7
            : 0.55
      renderer.render(scene, camera)
    })
    return () => {
      disposed = true
      renderer.setAnimationLoop(null)
      resize.disconnect()
      intersection.disconnect()
      canvas.removeEventListener('webglcontextlost', contextLost)
      canvas.removeEventListener('webglcontextrestored', contextRestored)
      canvas.removeEventListener('pointerdown', down)
      canvas.removeEventListener('pointermove', move)
      canvas.removeEventListener('pointerup', up)
      canvas.removeEventListener('pointercancel', up)
      canvas.removeEventListener('keydown', keys)
      canvas.removeEventListener('dblclick', reset)
      geometries.forEach((geometry) => geometry.dispose())
      materials.forEach((mat) => mat.dispose())
      textures.forEach((texture) => texture.dispose())
      renderer.dispose()
      renderer.forceContextLoss()
      canvas.remove()
    }
  }, [cli, persona, model, provider])

  return (
    <div className="agent-3d" ref={hostRef}>
      {
        <div className="avatar-fallback">
          <strong>{provider.name}</strong>
          <span>
            {HATS[persona]} · {model || 'Model not reported'}
          </span>
          <small>3D is unavailable on this device.</small>
        </div>
      }
    </div>
  )
}

export default memo(AgentAvatar)
