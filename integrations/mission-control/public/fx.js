/* Mission Control 动效层：数字滚动、迷你折线、协作拓扑图。颜色取自当前主题的 CSS 变量；遵循 prefers-reduced-motion。 */
export const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches

/** 当前主题色板：读 :root 上的变量，主题切换后下一帧生效。 */
function palette() {
  const css = getComputedStyle(document.documentElement), v = (k) => css.getPropertyValue(k).trim()
  return {
    dark: document.documentElement.dataset.theme === 'dark',
    ink: v('--text'), muted: v('--muted'), dim: v('--dim'), line: v('--line-strong'), panel: v('--panel'),
    accent: v('--accent'), violet: v('--violet'), blue: v('--blue'),
  }
}

/* ---------- 数字滚动 ---------- */
export function countUp(el, to, format = (v) => Math.round(v).toLocaleString()) {
  if (typeof to !== 'number' || !isFinite(to)) { el.textContent = String(to); return }
  const from = Number(el.dataset.v ?? 0)
  el.dataset.v = String(to)
  if (reduced || from === to) { el.textContent = format(to); return }
  const start = performance.now(), dur = 700
  const step = (now) => {
    const t = Math.min(1, (now - start) / dur), k = 1 - Math.pow(1 - t, 3)
    el.textContent = format(from + (to - from) * k)
    if (t < 1) requestAnimationFrame(step)
  }
  requestAnimationFrame(step)
}

/* ---------- 迷你折线 ---------- */
export function sparkline(values, color = 'var(--accent)') {
  const v = values.length > 1 ? values : [0, ...values, 0]
  const max = Math.max(1, ...v), n = v.length - 1
  const pts = v.map((y, i) => `${((i / n) * 100).toFixed(1)},${(21 - (y / max) * 18).toFixed(1)}`)
  return `<svg class="spark" viewBox="0 0 100 22" preserveAspectRatio="none" aria-hidden="true"><polyline points="${pts.join(' ')}" fill="none" style="stroke:${color}" stroke-width="1.4" stroke-opacity=".8" vector-effect="non-scaling-stroke"/></svg>`
}

/* ---------- 协作拓扑：中心 harness，内环智能体成员，外环科学 Provider ---------- */
export class Constellation {
  constructor(canvas, model) {
    this.canvas = canvas
    this.ctx = canvas.getContext('2d')
    this.model = model
    this.t = 0
    this.dots = []
    this.ro = new ResizeObserver(() => this.resize())
    this.ro.observe(canvas)
    this.resize()
    this.loop = this.loop.bind(this)
    requestAnimationFrame(this.loop)
  }
  set(model) { this.model = model; if (reduced) this.draw() }
  resize() {
    const dpr = Math.min(devicePixelRatio || 1, 2), r = this.canvas.getBoundingClientRect()
    this.w = r.width; this.h = r.height
    this.canvas.width = r.width * dpr; this.canvas.height = r.height * dpr
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    if (reduced) this.draw()
  }
  loop() {
    if (!this.canvas.isConnected) { this.ro.disconnect(); return }
    this.draw()
    if (!reduced) { this.t += 1; requestAnimationFrame(this.loop) }
  }
  draw() {
    const { ctx, w, h, t } = this, m = this.model || { inner: [], outer: [] }
    const cx = w / 2, cy = h / 2 + 10
    const R1 = Math.min(w * 0.26, h * 0.28), R2 = Math.min(w * 0.42, h * 0.4)
    if (!this.pal || this.pal.dark !== (document.documentElement.dataset.theme === 'dark')) this.pal = palette()
    const { ink: INK, muted: MUTED, dim: DIM, line: LINE, panel: PANEL, accent: ACCENT, violet: VIOLET, blue: BLUE, dark } = this.pal
    ctx.clearRect(0, 0, w, h)
    ctx.font = '500 11px Inter, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif'
    ctx.textAlign = 'center'

    // 暗色：雷达扫描扇区 + 刻度环
    if (dark) {
      const a = t * 0.012
      ctx.save()
      ctx.translate(cx, cy); ctx.scale(1, 0.6)
      const sweep = ctx.createConicGradient ? ctx.createConicGradient(a - 0.9, 0, 0) : null
      if (sweep) {
        sweep.addColorStop(0, 'transparent'); sweep.addColorStop(0.14, ACCENT + '24'); sweep.addColorStop(0.145, 'transparent'); sweep.addColorStop(1, 'transparent')
        ctx.fillStyle = sweep
        ctx.beginPath(); ctx.arc(0, 0, R2 + 18, 0, Math.PI * 2); ctx.fill()
      }
      ctx.strokeStyle = ACCENT + '55'; ctx.lineWidth = 1
      ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(Math.cos(a) * (R2 + 18), Math.sin(a) * (R2 + 18)); ctx.stroke()
      ctx.strokeStyle = LINE; ctx.globalAlpha = 0.5
      for (let i = 0; i < 72; i++) {
        const b = (i / 72) * Math.PI * 2, r0 = R2 + 14, r1 = r0 + (i % 6 ? 3 : 7)
        ctx.beginPath(); ctx.moveTo(Math.cos(b) * r0, Math.sin(b) * r0); ctx.lineTo(Math.cos(b) * r1, Math.sin(b) * r1); ctx.stroke()
      }
      ctx.globalAlpha = 1
      ctx.restore()
    }

    // 轨道（虚线缓慢流动）
    ctx.lineWidth = 1
    ctx.strokeStyle = LINE
    for (const [i, r] of [R1, R2].entries()) {
      ctx.setLineDash([2, 5]); ctx.lineDashOffset = (i ? 1 : -1) * t * 0.08
      ctx.beginPath(); ctx.ellipse(cx, cy, r, r * 0.6, 0, 0, Math.PI * 2); ctx.stroke()
    }
    ctx.setLineDash([]); ctx.lineDashOffset = 0

    const place = (list, R, speed, phase) => list.map((n, i) => {
      const a = phase + (i / Math.max(1, list.length)) * Math.PI * 2 + t * speed
      return { ...n, x: cx + Math.cos(a) * R, y: cy + Math.sin(a) * R * 0.6 }
    })
    const inner = place(m.inner, R1, 0.0006, -Math.PI / 2).map((n) => ({ ...n, ring: 1 }))
    const outer = place(m.outer, R2, -0.0004, -Math.PI / 3).map((n) => ({ ...n, ring: 2 }))
    const nodes = [...inner, ...outer]

    // 连线：活跃链路是向外流动的虚线（同 AI4Science 原界面的 atlas-flow）
    for (const n of nodes) {
      ctx.strokeStyle = n.active ? (n.ring === 1 ? ACCENT : VIOLET) : LINE
      ctx.globalAlpha = n.active ? 0.85 : n.ring === 1 && !n.ok ? 0.5 : dark ? 0.6 : 1
      ctx.lineWidth = n.active ? 1.4 : 1
      if (n.active) { ctx.setLineDash([7, 8]); ctx.lineDashOffset = -t * 0.5 }
      ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(n.x, n.y); ctx.stroke()
      ctx.setLineDash([]); ctx.lineDashOffset = 0
      ctx.globalAlpha = 1
      if (n.active && !reduced && t % 40 === 0) this.dots.push({ id: n.id, ring: n.ring, p: 0 })
    }
    // 派发中的小点沿连线移动
    this.dots = this.dots.filter((d) => d.p < 1)
    for (const d of this.dots) {
      const n = nodes.find((x) => x.id === d.id && x.ring === d.ring)
      if (!n) { d.p = 1; continue }
      d.p += 0.012
      ctx.fillStyle = BLUE
      ctx.beginPath(); ctx.arc(cx + (n.x - cx) * d.p, cy + (n.y - cy) * d.p, 2.2, 0, Math.PI * 2); ctx.fill()
    }

    // 中心
    if (dark && !reduced) {
      const k = (t % 120) / 120
      ctx.strokeStyle = ACCENT; ctx.globalAlpha = 0.6 * (1 - k); ctx.lineWidth = 1
      ctx.beginPath(); ctx.arc(cx, cy, 15 + k * 26, 0, Math.PI * 2); ctx.stroke()
      ctx.globalAlpha = 1
    }
    ctx.fillStyle = PANEL; ctx.strokeStyle = dark ? ACCENT : INK; ctx.lineWidth = 1.5
    ctx.beginPath(); ctx.arc(cx, cy, 15, 0, Math.PI * 2); ctx.fill(); ctx.stroke()
    ctx.fillStyle = ACCENT; ctx.beginPath(); ctx.arc(cx, cy, 5, 0, Math.PI * 2); ctx.fill()
    ctx.fillStyle = INK; ctx.font = '600 10px Inter, "Segoe UI", sans-serif'
    ctx.fillText(m.core || 'HARNESS', cx, cy + 32)
    ctx.font = '500 11px Inter, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif'

    // 节点
    for (const n of nodes) {
      const color = n.ring === 1 ? ACCENT : VIOLET
      if (n.active && !reduced) {
        const k = (t % 90) / 90
        ctx.strokeStyle = color; ctx.globalAlpha = 1 - k; ctx.lineWidth = 1
        ctx.beginPath(); ctx.arc(n.x, n.y, 6 + k * 10, 0, Math.PI * 2); ctx.stroke()
        ctx.globalAlpha = 1
      }
      ctx.lineWidth = 1.5
      if (n.ring === 1) {
        ctx.beginPath(); ctx.arc(n.x, n.y, 5.5, 0, Math.PI * 2)
        if (n.ok) { ctx.fillStyle = color; ctx.fill() }
        else { ctx.fillStyle = PANEL; ctx.fill(); ctx.strokeStyle = LINE; ctx.stroke() }
      } else {
        ctx.fillStyle = PANEL; ctx.strokeStyle = color
        ctx.beginPath(); ctx.rect(n.x - 5, n.y - 5, 10, 10); ctx.fill(); ctx.stroke()
      }
      ctx.fillStyle = n.ring === 1 && !n.ok ? DIM : n.active ? INK : MUTED
      ctx.fillText(n.label, n.x, n.y + 19)
    }
  }
}
