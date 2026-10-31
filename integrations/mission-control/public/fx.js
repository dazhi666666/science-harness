/* Mission Control 动效层：背景星网、光标辉光、卡片聚光、3D 倾斜、数字滚动、星座图。 */
export const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches

/* ---------- 背景星网 ---------- */
function cosmos() {
  const canvas = document.getElementById('cosmos')
  if (!canvas) return
  const ctx = canvas.getContext('2d')
  const mouse = { x: -1e4, y: -1e4 }
  let w = 0, h = 0, dpr = 1, dots = []
  const resize = () => {
    dpr = Math.min(devicePixelRatio || 1, 2)
    w = innerWidth; h = innerHeight
    canvas.width = w * dpr; canvas.height = h * dpr
    canvas.style.width = w + 'px'; canvas.style.height = h + 'px'
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    const n = Math.round(Math.min(110, (w * h) / 16000))
    dots = Array.from({ length: n }, () => ({
      x: Math.random() * w, y: Math.random() * h,
      vx: (Math.random() - 0.5) * 0.25, vy: (Math.random() - 0.5) * 0.25,
      r: Math.random() * 1.4 + 0.4, t: Math.random() * Math.PI * 2,
    }))
  }
  resize()
  addEventListener('resize', resize)
  addEventListener('pointermove', (e) => { mouse.x = e.clientX; mouse.y = e.clientY })
  const frame = () => {
    ctx.clearRect(0, 0, w, h)
    for (const d of dots) {
      if (!reduced) {
        d.x += d.vx; d.y += d.vy; d.t += 0.02
        const dx = mouse.x - d.x, dy = mouse.y - d.y, dist = Math.hypot(dx, dy)
        if (dist < 160) { d.x -= dx * 0.004; d.y -= dy * 0.004 }
        if (d.x < -10) d.x = w + 10; if (d.x > w + 10) d.x = -10
        if (d.y < -10) d.y = h + 10; if (d.y > h + 10) d.y = -10
      }
      ctx.beginPath()
      ctx.arc(d.x, d.y, d.r, 0, Math.PI * 2)
      ctx.fillStyle = `rgba(170,210,255,${0.35 + Math.sin(d.t) * 0.25})`
      ctx.fill()
    }
    for (let i = 0; i < dots.length; i++)
      for (let j = i + 1; j < dots.length; j++) {
        const a = dots[i], b = dots[j], dist = Math.hypot(a.x - b.x, a.y - b.y)
        if (dist > 120) continue
        ctx.strokeStyle = `rgba(91,140,255,${(1 - dist / 120) * 0.16})`
        ctx.lineWidth = 0.6
        ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke()
      }
    if (!reduced) requestAnimationFrame(frame)
  }
  frame()
}

/* ---------- 光标辉光 + 卡片聚光 + 倾斜 ---------- */
function pointerFx() {
  const glow = document.querySelector('.cursor-glow')
  let raf = 0, px = 0, py = 0
  addEventListener('pointermove', (e) => {
    px = e.clientX; py = e.clientY
    if (!raf) raf = requestAnimationFrame(() => {
      raf = 0
      if (glow) glow.style.transform = `translate(${px - 260}px, ${py - 260}px)`
    })
    const card = e.target.closest?.('.card, .kpi')
    if (card) {
      const r = card.getBoundingClientRect()
      card.style.setProperty('--mx', `${e.clientX - r.left}px`)
      card.style.setProperty('--my', `${e.clientY - r.top}px`)
    }
    const tilt = e.target.closest?.('.tilt')
    if (tilt && !reduced) {
      const r = tilt.getBoundingClientRect()
      const x = (e.clientX - r.left) / r.width - 0.5, y = (e.clientY - r.top) / r.height - 0.5
      tilt.style.transform = `perspective(900px) rotateX(${-y * 7}deg) rotateY(${x * 9}deg) translateY(-3px)`
    }
  })
  document.addEventListener('pointerout', (e) => {
    const tilt = e.target.closest?.('.tilt')
    if (tilt && !tilt.contains(e.relatedTarget)) tilt.style.transform = ''
  })
  if (glow) glow.style.transform = 'translate(-999px,-999px)'
}

/* ---------- 数字滚动 ---------- */
export function countUp(el, to, format = (v) => Math.round(v).toLocaleString('zh-CN')) {
  if (typeof to !== 'number' || !isFinite(to)) { el.textContent = String(to); return }
  const from = Number(el.dataset.v ?? 0)
  el.dataset.v = String(to)
  if (reduced || from === to) { el.textContent = format(to); return }
  const start = performance.now(), dur = 900
  const step = (now) => {
    const t = Math.min(1, (now - start) / dur), k = 1 - Math.pow(1 - t, 4)
    el.textContent = format(from + (to - from) * k)
    if (t < 1) requestAnimationFrame(step)
  }
  requestAnimationFrame(step)
}

/* ---------- 迷你折线 ---------- */
export function sparkline(values, color = '#38e1ff') {
  const v = values.length > 1 ? values : [0, ...values, 0]
  const max = Math.max(1, ...v), n = v.length - 1
  const pts = v.map((y, i) => `${((i / n) * 100).toFixed(1)},${(24 - (y / max) * 20).toFixed(1)}`)
  const id = 'sg' + Math.random().toString(36).slice(2, 8)
  return `<svg class="spark" viewBox="0 0 100 26" preserveAspectRatio="none" aria-hidden="true"><defs><linearGradient id="${id}" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="${color}" stop-opacity=".35"/><stop offset="1" stop-color="${color}" stop-opacity="0"/></linearGradient></defs><path d="M0,26 L${pts.join(' L')} L100,26 Z" fill="url(#${id})" stroke="none"/><polyline points="${pts.join(' ')}" fill="none" stroke="${color}" stroke-width="1.6" vector-effect="non-scaling-stroke"/></svg>`
}

/* ---------- 星座图：中心 harness，内环智能体成员，外环科学 Provider ---------- */
export class Constellation {
  constructor(canvas, model) {
    this.canvas = canvas
    this.ctx = canvas.getContext('2d')
    this.model = model
    this.t = 0
    this.sparks = []
    this.ro = new ResizeObserver(() => this.resize())
    this.ro.observe(canvas)
    this.resize()
    this.loop = this.loop.bind(this)
    requestAnimationFrame(this.loop)
  }
  set(model) { this.model = model }
  resize() {
    const dpr = Math.min(devicePixelRatio || 1, 2), r = this.canvas.getBoundingClientRect()
    this.w = r.width; this.h = r.height
    this.canvas.width = r.width * dpr; this.canvas.height = r.height * dpr
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  }
  loop() {
    if (!this.canvas.isConnected) { this.ro.disconnect(); return }
    this.draw()
    if (!reduced) { this.t += 1; requestAnimationFrame(this.loop) }
  }
  draw() {
    const { ctx, w, h } = this, m = this.model || { inner: [], outer: [] }
    const cx = w / 2, cy = h / 2 + 14, t = this.t
    const R1 = Math.min(w * 0.3, h * 0.3), R2 = Math.min(w * 0.44, h * 0.42)
    ctx.clearRect(0, 0, w, h)

    // 雷达扫描
    const sweep = (t * 0.012) % (Math.PI * 2)
    const g = ctx.createConicGradient ? ctx.createConicGradient(sweep, cx, cy) : null
    if (g) {
      g.addColorStop(0, 'rgba(56,225,255,0.20)'); g.addColorStop(0.08, 'rgba(56,225,255,0)'); g.addColorStop(1, 'rgba(56,225,255,0)')
      ctx.fillStyle = g
      ctx.beginPath(); ctx.ellipse(cx, cy, R2 * 1.08, R2 * 0.62 * 1.08, 0, 0, Math.PI * 2); ctx.fill()
    }
    // 轨道
    for (const [r, c] of [[R1, 'rgba(56,225,255,0.22)'], [R2, 'rgba(155,107,255,0.2)']]) {
      ctx.setLineDash([3, 6]); ctx.strokeStyle = c; ctx.lineWidth = 1
      ctx.beginPath(); ctx.ellipse(cx, cy, r, r * 0.62, 0, 0, Math.PI * 2); ctx.stroke()
    }
    ctx.setLineDash([])

    const place = (list, R, speed, phase) => list.map((n, i) => {
      const a = phase + (i / Math.max(1, list.length)) * Math.PI * 2 + t * speed
      return { ...n, x: cx + Math.cos(a) * R, y: cy + Math.sin(a) * R * 0.62, depth: Math.sin(a) }
    })
    const inner = place(m.inner, R1, 0.0016, -Math.PI / 2)
    const outer = place(m.outer, R2, -0.0009, -Math.PI / 3)
    const nodes = [...inner.map((n) => ({ ...n, ring: 1 })), ...outer.map((n) => ({ ...n, ring: 2 }))].sort((a, b) => a.depth - b.depth)

    // 连线 + 流动粒子
    for (const n of nodes) {
      const on = n.active || (n.ring === 1 && n.ok)
      ctx.strokeStyle = n.ring === 1 ? `rgba(56,225,255,${n.active ? 0.5 : on ? 0.16 : 0.05})` : `rgba(155,107,255,${n.active ? 0.5 : 0.12})`
      ctx.lineWidth = n.active ? 1.4 : 0.8
      ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(n.x, n.y); ctx.stroke()
      if (n.active && !reduced && Math.random() < 0.06) this.sparks.push({ id: n.id, ring: n.ring, p: 0, v: 0.012 + Math.random() * 0.012 })
    }
    this.sparks = this.sparks.filter((s) => s.p < 1)
    for (const s of this.sparks) {
      const n = nodes.find((x) => x.id === s.id && x.ring === s.ring)
      if (!n) { s.p = 1; continue }
      s.p += s.v
      const x = cx + (n.x - cx) * s.p, y = cy + (n.y - cy) * s.p
      const col = s.ring === 1 ? '56,225,255' : '196,160,255'
      const rg = ctx.createRadialGradient(x, y, 0, x, y, 7)
      rg.addColorStop(0, `rgba(${col},0.95)`); rg.addColorStop(1, `rgba(${col},0)`)
      ctx.fillStyle = rg; ctx.beginPath(); ctx.arc(x, y, 7, 0, Math.PI * 2); ctx.fill()
    }

    // 核心
    const pulse = 1 + Math.sin(t * 0.05) * 0.06
    for (let i = 3; i > 0; i--) {
      ctx.beginPath(); ctx.arc(cx, cy, (18 + i * 10) * pulse, 0, Math.PI * 2)
      ctx.fillStyle = `rgba(91,140,255,${0.05 * i})`; ctx.fill()
    }
    const core = ctx.createRadialGradient(cx - 6, cy - 6, 2, cx, cy, 24)
    core.addColorStop(0, '#ffffff'); core.addColorStop(0.3, '#38e1ff'); core.addColorStop(0.7, '#5b8cff'); core.addColorStop(1, '#4b1f9a')
    ctx.fillStyle = core; ctx.beginPath(); ctx.arc(cx, cy, 22 * pulse, 0, Math.PI * 2); ctx.fill()
    ctx.font = '600 10px Inter, Segoe UI, sans-serif'; ctx.textAlign = 'center'
    ctx.fillStyle = 'rgba(232,237,255,0.9)'; ctx.fillText(m.core || 'HARNESS', cx, cy + 44)

    // 节点
    for (const n of nodes) {
      const s = 0.75 + (n.depth + 1) * 0.2
      const base = n.ring === 1 ? (n.ok ? '56,225,255' : '120,128,160') : '155,107,255'
      const r = (n.ring === 1 ? 9 : 7) * s * (n.active ? 1 + Math.sin(t * 0.12) * 0.15 : 1)
      if (n.active || (n.ring === 1 && n.ok) || n.ring === 2) {
        const halo = ctx.createRadialGradient(n.x, n.y, 0, n.x, n.y, r * 3)
        halo.addColorStop(0, `rgba(${base},${n.active ? 0.55 : 0.25})`); halo.addColorStop(1, `rgba(${base},0)`)
        ctx.fillStyle = halo; ctx.beginPath(); ctx.arc(n.x, n.y, r * 3, 0, Math.PI * 2); ctx.fill()
      }
      ctx.fillStyle = `rgba(${base},${0.5 + s * 0.4})`
      ctx.beginPath(); ctx.arc(n.x, n.y, r, 0, Math.PI * 2); ctx.fill()
      ctx.strokeStyle = 'rgba(255,255,255,0.5)'; ctx.lineWidth = 0.8; ctx.stroke()
      ctx.fillStyle = `rgba(232,237,255,${0.45 + s * 0.4})`
      ctx.font = `${n.active ? 600 : 500} ${Math.round(10.5 * s)}px Inter, Segoe UI, sans-serif`
      ctx.fillText(n.label, n.x, n.y + r + 13)
    }
  }
}

cosmos()
pointerFx()
