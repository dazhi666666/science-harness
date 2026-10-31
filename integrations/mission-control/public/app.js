/* Mission Control 前端：一个页面融合 AI4Science 科学执行（/science）与 Agent Router 多智能体编排（/router）。 */
import { countUp, sparkline, Constellation, reduced } from '/fx.js'

const $ = (s, root = document) => root.querySelector(s)
const $$ = (s, root = document) => [...root.querySelectorAll(s)]
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
const num = (v) => new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 1 }).format(v)
const compact = (v) => new Intl.NumberFormat('zh-CN', { notation: 'compact', maximumFractionDigits: 1 }).format(v)
const when = (v) => (v ? new Date(v).toLocaleString('zh-CN', { hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '')
const ago = (v) => {
  const s = Math.max(0, (Date.now() - new Date(v).getTime()) / 1000)
  return s < 60 ? `${Math.round(s)} 秒前` : s < 3600 ? `${Math.round(s / 60)} 分钟前` : s < 86400 ? `${Math.round(s / 3600)} 小时前` : when(v)
}

/* ---------- 图标 ---------- */
const ICONS = {
  radar: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><path d="M12 12 19 5"/><circle cx="12" cy="12" r="1"/>',
  flask: '<path d="M9 3h6M10 3v7l-6 9q-1 2 2 2h12q3 0 2-2l-6-9V3M8 14h8"/>',
  layers: '<path d="m12 3 10 6-10 6L2 9Z"/><path d="m3 14 9 5 9-5"/>',
  file: '<path d="M14 2H5v20h14V7Z"/><path d="M14 2v6h5M8 13h8M8 17h6"/>',
  nodes: '<circle cx="12" cy="5" r="2.5"/><circle cx="5" cy="19" r="2.5"/><circle cx="19" cy="19" r="2.5"/><path d="M12 7.5v4M12 11.5 6.5 17M12 11.5l5.5 5.5"/>',
  cpu: '<rect x="6" y="6" width="12" height="12" rx="2"/><path d="M9 2v4M15 2v4M9 18v4M15 18v4M2 9h4M2 15h4M18 9h4M18 15h4"/><rect x="9.5" y="9.5" width="5" height="5"/>',
  search: '<circle cx="10" cy="10" r="6"/><path d="m15 15 6 6"/>',
  refresh: '<path d="M20 10a8 8 0 0 0-14-5L3 8m0-5v5h5M4 14a8 8 0 0 0 14 5l3-3m0 5v-5h-5"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
  play: '<path d="m8 4 12 8-12 8Z"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
  budget: '<path d="M3 7h18v13H3zM3 7V4h15v3M16 12h5v4h-5z"/>',
  download: '<path d="M12 3v12m-5-5 5 5 5-5M4 17v4h16v-4"/>',
  bolt: '<path d="M13 2 4 14h7l-1 8 9-12h-7Z"/>',
  mail: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 7 9 6 9-6"/>',
  thread: '<path d="M4 5h16v11H8l-4 4Z"/><path d="M8 9h8M8 12h5"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="2"/>',
  arrow: '<path d="m8 5 7 7-7 7"/>',
  terminal: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="m7 9 3 3-3 3M13 15h4"/>',
  users: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0"/><circle cx="17" cy="9" r="2.5"/><path d="M16 14.5a5 5 0 0 1 5.5 5"/>',
}
const icon = (n) => `<svg viewBox="0 0 24 24" aria-hidden="true">${ICONS[n] || ICONS.layers}</svg>`
const paintIcons = (root = document) => $$('[data-icon]', root).forEach((el) => { if (!el.firstChild) el.innerHTML = icon(el.dataset.icon) })
paintIcons()

/* ---------- 常量 ---------- */
const MEMBERS = {
  claude: { label: 'Claude', c1: '#f59e6b', c2: '#d9663a', mode: 'stream-json 常驻主线程（事件即时注入）' },
  zcode: { label: 'ZCode', c1: '#38e1ff', c2: '#2563eb', mode: '回合串联（每条消息一次 headless 运行续链）' },
  'zcode-oss': { label: 'ZCode OSS', c1: '#22d3ee', c2: '#0e7490', mode: '回合串联（开源 ZCode CLI）' },
  devin: { label: 'Devin', c1: '#34d399', c2: '#047857', mode: 'ACP 常驻（需已 devin auth login）' },
  codex: { label: 'Codex', c1: '#e5e7eb', c2: '#4b5563', mode: '回合串联（OpenAI Codex CLI）' },
  opencode: { label: 'OpenCode', c1: '#fbbf24', c2: '#b45309', mode: '回合串联（SST OpenCode CLI）' },
  antigravity: { label: 'Antigravity', c1: '#60a5fa', c2: '#7c3aed', mode: 'stream-json 常驻（Google Antigravity CLI）' },
  dsh: { label: 'DSH', c1: '#9b6bff', c2: '#ec4899', mode: '回合串联（science-harness，headless profile）' },
}
const OP_STATE = { registered: '已登记', dispatching: '派发中', accepted: '已接受', running: '运行中', succeeded: '已完成', failed: '失败', cancelled: '已取消', unknown: '未知' }
const TASK_STATE = { pending: '待执行', in_progress: '执行中', done: '已完成', failed: '失败' }
const opActive = (o) => ['registered', 'dispatching', 'accepted', 'running'].includes(o.state)
const opBadge = (s) => `<span class="status ${esc(s in OP_STATE ? s : 'unknown')}">${esc(OP_STATE[s] || s)}</span>`
const runBadge = (r) => (r.live ? '<span class="status live">进行中</span>' : `<span class="status ${r.status === 'failed' ? 'failed' : 'finished'}">${r.status === 'failed' ? '失败' : '已结束'}</span>`)

/* ---------- 状态 ---------- */
const state = {
  view: 'overview',
  link: { science: false, router: false, scienceError: null },
  sci: null,
  sciSig: '',
  project: null,
  sciFilter: 'all',
  sciSearch: '',
  selectedOp: null,
  health: null,
  runs: [],
  runsSig: '',
  run: null,
  openId: null,
  es: null,
  lastEventIds: {},
  consoleFilter: 'all',
  paused: false,
  threads: [],
  logFiles: [],
  modalThread: null,
  modalLog: null,
  threadPending: [],
  threadStick: true,
  agMode: 'direct',
  agPicked: new Set(['claude', 'zcode']),
  hist: {},
}
const track = (key, value) => {
  const h = (state.hist[key] ??= [])
  h.push(value)
  if (h.length > 30) h.shift()
  return h
}

/* ---------- 连接 / API ---------- */
let token = location.hash.slice(1) || sessionStorage.getItem('mission-control-token') || ''
if (location.hash) {
  sessionStorage.setItem('mission-control-token', token)
  history.replaceState(null, '', location.pathname)
}
class Locked extends Error {}
async function api(path, options = {}) {
  const r = await fetch(path, { ...options, credentials: 'same-origin', headers: { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...options.headers } })
  if (r.status === 401) { lock(true); throw new Locked('需要启动链接') }
  const body = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(body.error || `请求失败（${r.status}）`)
  return body
}
const sci = (p, o) => api('/science' + p, o)
const rt = (p, o) => api('/router' + p, o)
const sciAction = (value) => sci('/api/action', { method: 'POST', body: JSON.stringify(value) })

async function connect() {
  if (token) {
    const r = await fetch('/session', { method: 'POST', headers: { Authorization: `Bearer ${token}` } }).catch(() => null)
    if (!r?.ok) { token = ''; sessionStorage.removeItem('mission-control-token') }
  }
  try {
    state.link = await api('/mc/status')
    lock(false)
    paintLinks()
    return true
  } catch { return false }
}
function lock(on) { $('#lock').hidden = !on }
$('#lock-form').onsubmit = async (e) => {
  e.preventDefault()
  token = $('#lock-token').value.trim().replace(/^.*#/, '')
  sessionStorage.setItem('mission-control-token', token)
  if (await connect()) { toast('链路已建立'); boot() }
  else toast('令牌无效', true)
}
function paintLinks() {
  $$('[data-link]').forEach((el) => { el.className = 'link-dot ' + (state.link[el.dataset.link] ? 'on' : 'off') })
  const both = state.link.science && state.link.router
  $('.rail-foot .pulse').className = 'pulse ' + (both ? 'ok' : state.link.science || state.link.router ? '' : 'bad')
  $('#uplink-text').textContent = both ? '双链路在线' : state.link.router ? '编排在线 · 科学离线' : state.link.science ? '科学在线 · 编排离线' : '链路离线'
}

/* ---------- 提示 ---------- */
function toast(message, err = false) {
  const el = document.createElement('div')
  el.className = 'toast' + (err ? ' err' : '')
  el.textContent = message
  $('#toasts').append(el)
  setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 400) }, 4200)
}

/* ---------- 数据加载 ---------- */
async function loadScience(force = false) {
  if (!state.link.science) return
  try {
    const next = await sci('/api/state' + (state.project ? '?project=' + encodeURIComponent(state.project) : ''))
    state.project = next.selectedProject
    const sig = JSON.stringify({ ...next, observedAt: undefined })
    state.sci = next
    if (force || sig !== state.sciSig) { state.sciSig = sig; renderProjects(); refresh('sci') }
  } catch (e) { if (!(e instanceof Locked)) state.sciError = e.message }
}
async function loadHealth() {
  if (!state.link.router) return
  try { state.health = await rt('/api/health'); refresh('health') } catch {}
}
async function loadRuns(force = false) {
  if (!state.link.router) return
  try {
    const runs = await rt('/api/runs')
    const sig = JSON.stringify(runs)
    state.runs = runs
    if (force || sig !== state.runsSig) { state.runsSig = sig; refresh('runs') }
  } catch {}
}
const refresh = (kind) => views[state.view]?.update?.(kind)

/* ---------- 路由 / 视图切换 ---------- */
const views = {}
function go(view, { quiet = false } = {}) {
  if (!views[view]) view = 'overview'
  const leaving = state.view
  state.view = view
  if (leaving === 'agents' && view !== 'agents') disconnectSse()
  $$('.nav-item').forEach((b) => b.classList.toggle('active', b.dataset.view === view))
  moveIndicator()
  $('#crumb-a').textContent = views[view].section
  $('#crumb-b').textContent = views[view].title
  const primary = $('#primary-action span:last-child')
  primary.textContent = ['science', 'providers', 'artifacts'].includes(view) ? '新建实验' : '新建编排'
  const stage = $('#stage')
  stage.innerHTML = ''
  stage.className = ''
  stage.scrollTop = 0
  views[view].mount(stage)
  paintIcons(stage)
  if (!quiet) { void stage.offsetWidth; stage.classList.add('view-enter') }
  views[view].update?.('all')
  $('.rail').classList.remove('open')
  try { sessionStorage.setItem('mission-control-view', view) } catch {}
}
function moveIndicator() {
  const active = $('.nav-item.active'), ind = $('.nav-indicator')
  if (!active) { ind.style.opacity = 0; return }
  ind.style.opacity = 1
  ind.style.height = active.offsetHeight + 'px'
  ind.style.transform = `translateY(${active.offsetTop}px)`
}
addEventListener('resize', moveIndicator)
$$('.nav-item').forEach((b) => (b.onclick = () => go(b.dataset.view)))
$$('[data-go]').forEach((b) => (b.onclick = (e) => { e.preventDefault(); go(b.dataset.go) }))
$('#menu').onclick = () => $('.rail').classList.toggle('open')
$('#refresh').onclick = async () => {
  const b = $('#refresh')
  b.classList.remove('spinning'); void b.offsetWidth; b.classList.add('spinning')
  await Promise.all([loadScience(true), loadRuns(true), loadHealth()])
  if (state.view === 'agents' && state.openId) openRun(state.openId)
}
$('#primary-action').onclick = () => (['science', 'providers', 'artifacts'].includes(state.view) ? openScienceRun() : openAgentRun())

/* ---------- 侧栏项目 ---------- */
function renderProjects() {
  const box = $('#project-list'), d = state.sci
  if (!d) { box.innerHTML = `<div class="muted" style="padding:6px 12px;font-size:12px">${state.link.science ? '加载中…' : '科学引擎离线'}</div>`; return }
  box.innerHTML = d.projects.length
    ? d.projects.map((p) => `<button class="project-item ${p.id === state.project ? 'selected' : ''}" data-project="${esc(p.id)}">${esc(p.id)}</button>`).join('')
    : '<div class="muted" style="padding:6px 12px;font-size:12px">还没有项目</div>'
  $$('[data-project]', box).forEach((b) => (b.onclick = () => {
    state.project = b.dataset.project
    state.sciFilter = 'all'; state.sciSearch = ''
    closeDrawer()
    loadScience(true).then(() => go(['science', 'providers', 'artifacts'].includes(state.view) ? state.view : 'science', { quiet: state.view !== 'overview' }))
  }))
}
$('#add-project').onclick = () => openProject()

/* =====================================================================
 * 总览
 * ===================================================================== */
let constellation = null
let typerTimer = 0
views.overview = {
  section: 'Mission Control',
  title: '总览',
  mount(stage) {
    stage.innerHTML = `
      <section class="hero">
        <div><div class="eyebrow">SCIENCE × AGENTS · LIVE</div>
          <h1>欢迎回到 <span class="grad">Mission Control</span></h1>
          <p class="typing" id="typer"></p></div>
        <div class="hero-links" id="hero-links"></div>
      </section>
      <div class="kpis" id="kpis">${[
        ['k-active', '进行中实验', 'play', '#38e1ff', 'SCIENCE'],
        ['k-done', '已完成实验', 'check', '#34d399', 'SCIENCE'],
        ['k-artifacts', '研究产物', 'file', '#9b6bff', 'SCIENCE'],
        ['k-runs', '编排运行', 'nodes', '#5b8cff', 'AGENTS'],
        ['k-members', '在线成员', 'users', '#38e1ff', 'AGENTS'],
        ['k-tasks', '任务完成', 'bolt', '#f472b6', 'AGENTS'],
      ].map(([id, label, ic, c, tag]) => `<div class="kpi" style="--c:${c}" id="${id}"><div class="kpi-top"><span>${label}</span><span class="kpi-icon">${icon(ic)}</span></div><div class="kpi-value">–</div><div class="kpi-note">&nbsp;</div><div class="kpi-spark"></div><span class="kpi-tag">${tag}</span></div>`).join('')}</div>
      <div class="ov-grid">
        <section class="card constellation"><div class="card-head"><span class="card-title">融合星座</span><span class="card-sub">内环 · 智能体成员　外环 · 科学 Provider</span><span class="spacer"></span><span id="constel-live" class="status idle">待命</span></div>
          <canvas id="constel"></canvas>
          <div class="legend"><span><i style="background:#38e1ff;box-shadow:0 0 6px #38e1ff"></i>在线成员</span><span><i style="background:#787ea0"></i>未就绪</span><span><i style="background:#9b6bff;box-shadow:0 0 6px #9b6bff"></i>Provider</span><span>流光 = 正在派发</span></div></section>
        <div class="side-col">
          <section class="card"><div class="card-head"><span class="card-title">项目预算</span><span class="spacer"></span><span class="tag" id="budget-proj">—</span></div><div class="budget" id="budget"></div></section>
          <section class="card"><div class="card-head"><span class="card-title">实时脉搏</span><span class="card-sub">实验 + 编排统一时间线</span><span class="spacer"></span><span class="count" id="feed-count">0</span></div><div class="feed stagger" id="feed"></div></section>
        </div>
      </div>
      <div class="ov-grid even">
        <section class="card"><div class="card-head">${icon('flask')}<span class="card-title">最近实验</span><span class="spacer"></span><button class="btn small ghost" data-jump="science">全部 ${icon('arrow')}</button></div><div id="recent-ops"></div></section>
        <section class="card"><div class="card-head">${icon('nodes')}<span class="card-title">最近编排</span><span class="spacer"></span><button class="btn small ghost" data-jump="agents">全部 ${icon('arrow')}</button></div><div id="recent-runs"></div></section>
      </div>`
    $$('[data-jump]', stage).forEach((b) => (b.onclick = () => go(b.dataset.jump)))
    constellation = new Constellation($('#constel'), constellationModel())
    typer($('#typer'), ['科学执行与多智能体编排，汇于一屏。', '每一次运行都有身份，每一份产物都可溯源。', '主代理派发、成员协作、实验落盘 —— 实时可见。'])
  },
  update() {
    if (!$('#kpis')) return
    const d = state.sci, ops = d?.operations ?? []
    const active = ops.filter(opActive).length, done = ops.filter((o) => o.state === 'succeeded').length
    const runs = state.runs, live = runs.filter((r) => r.live).length
    const members = Object.keys(MEMBERS), online = members.filter((m) => state.health?.[m]).length
    const tTotal = runs.reduce((a, r) => a + (r.summary?.total || 0), 0), tDone = runs.reduce((a, r) => a + (r.summary?.done || 0), 0)
    kpi('k-active', active, state.link.science ? `${ops.length} 条执行记录` : '科学引擎离线', track('active', active))
    kpi('k-done', done, ops.length ? `成功率 ${Math.round((done / ops.length) * 100)}%` : '等待第一次运行', track('done', done), '#34d399')
    kpi('k-artifacts', d?.artifacts.length ?? 0, '带来源与哈希的产物', track('art', d?.artifacts.length ?? 0), '#9b6bff')
    kpi('k-runs', runs.length, live ? `${live} 个正在进行` : '当前空闲', track('runs', live), '#5b8cff')
    kpi('k-members', online, `共 ${members.length} 名可调度成员`, track('online', online), '#38e1ff', (v) => `${Math.round(v)}/${members.length}`)
    kpi('k-tasks', tDone, tTotal ? `${tTotal} 个任务 · ${Math.round((tDone / tTotal) * 100)}%` : '暂无任务', track('tasks', tDone), '#f472b6')

    $('#hero-links').innerHTML = `
      <span class="link-pill"><i class="link-dot ${state.link.science ? 'on' : 'off'}"></i>科学引擎 <b>${state.link.science ? esc(d?.baseline?.slice(0, 7) || '在线') : '离线'}</b></span>
      <span class="link-pill"><i class="link-dot ${state.link.router ? 'on' : 'off'}"></i>Agent Router <b>${state.link.router ? (live ? `${live} 运行中` : '待命') : '离线'}</b></span>`
    const liveEl = $('#constel-live')
    liveEl.className = 'status ' + (live || active ? 'live' : 'idle')
    liveEl.textContent = live || active ? `派发中 · ${live + active}` : '待命'
    constellation?.set(constellationModel())

    // 预算
    const p = d?.projects.find((x) => x.id === state.project)
    $('#budget-proj').textContent = p?.id ?? '—'
    if (p) {
      const pct = p.budgetLimit ? Math.min(100, (p.budgetUsed / p.budgetLimit) * 100) : 0, C = 2 * Math.PI * 48
      const box = $('#budget')
      if (!box.querySelector('.ring')) box.innerHTML = `<svg class="ring" viewBox="0 0 112 112"><defs><linearGradient id="ring-grad" x1="0" x2="1"><stop offset="0" stop-color="#38e1ff"/><stop offset=".6" stop-color="#5b8cff"/><stop offset="1" stop-color="#9b6bff"/></linearGradient></defs><circle class="track" cx="56" cy="56" r="48"/><circle class="bar" cx="56" cy="56" r="48" stroke-dasharray="${C}" stroke-dashoffset="${C}"/></svg><div><div class="budget-num"><span id="b-used">0</span> <small>/ ${num(p.budgetLimit)} 单位</small></div><div class="muted" id="b-pct"></div><div class="kpi-note">预留在完成或取消后仍计入。</div></div>`
      requestAnimationFrame(() => { $('.ring .bar', box).style.strokeDashoffset = String(C * (1 - pct / 100)) })
      countUp($('#b-used'), p.budgetUsed, num)
      $('#b-pct').textContent = `已预留 ${pct.toFixed(0)}% · 剩余 ${compact(Math.max(0, p.budgetLimit - p.budgetUsed))}`
    } else $('#budget').innerHTML = `<div class="muted">${state.link.science ? '选择或创建一个科学项目' : esc(state.link.scienceError || '科学引擎离线')}</div>`

    // 统一时间线
    const items = [
      ...ops.map((o) => ({ t: o.updatedAt || o.createdAt, kind: 'sci', title: o.requestKey, meta: `${o.providerId} · ${OP_STATE[o.state] || o.state}`, badge: opBadge(o.state), go: () => { go('science'); openOp(o.id) } })),
      ...runs.map((r) => ({ t: r.mtime, kind: 'agent', title: r.goal || r.id, meta: `${MEMBERS[r.settings?.main]?.label || r.settings?.main || 'Claude'} 主导 · ${r.summary.done}/${r.summary.total} 任务`, badge: runBadge(r), go: () => { state.openId = r.id; go('agents') } })),
    ].filter((x) => x.t).sort((a, b) => new Date(b.t) - new Date(a.t)).slice(0, 14)
    $('#feed-count').textContent = items.length
    const feed = $('#feed')
    feed.innerHTML = items.length
      ? items.map((x, i) => `<div class="feed-item" style="--i:${i}" data-i="${i}"><span class="feed-icon ${x.kind}">${icon(x.kind === 'sci' ? 'flask' : 'nodes')}</span><div class="feed-main"><div class="feed-title">${esc(x.title)}</div><div class="feed-meta">${esc(x.meta)} · ${ago(x.t)}</div></div>${x.badge}</div>`).join('')
      : `<div class="empty"><div class="glyph">${icon('radar')}</div><p>还没有活动。发起一次实验或编排运行吧。</p></div>`
    $$('.feed-item', feed).forEach((el) => (el.onclick = () => items[el.dataset.i].go()))

    $('#recent-ops').innerHTML = !state.link.science
      ? `<div class="empty"><div class="glyph">${icon('flask')}</div><p>${esc(state.link.scienceError || '科学引擎离线')}</p></div>`
      : ops.length
        ? `<table><tbody>${ops.toReversed().slice(0, 5).map((o) => `<tr data-op="${esc(o.id)}"><td><div class="run-label">${esc(o.requestKey)}</div><div class="run-id">${esc(o.providerId)} · ${esc(o.id.slice(0, 8))}</div>${opActive(o) ? '<div class="progress-line"><i></i></div>' : ''}</td><td>${opBadge(o.state)}</td></tr>`).join('')}</tbody></table>`
        : `<div class="empty"><div class="glyph">${icon('flask')}</div><p>${state.project ? '这个项目还没有运行。' : '先创建一个科学项目。'}</p><button class="btn small primary" id="ov-new-sci">${state.project ? '发起实验' : '创建项目'}</button></div>`
    $$('[data-op]', $('#recent-ops')).forEach((tr) => (tr.onclick = () => { go('science'); openOp(tr.dataset.op) }))
    if ($('#ov-new-sci')) $('#ov-new-sci').onclick = () => (state.project ? openScienceRun() : openProject())

    $('#recent-runs').innerHTML = !state.link.router
      ? `<div class="empty"><div class="glyph">${icon('nodes')}</div><p>Agent Router 未挂载</p></div>`
      : runs.length
        ? `<table><tbody>${runs.slice(0, 5).map((r) => `<tr data-run="${esc(r.id)}"><td><div class="run-label">${esc(r.goal || r.id)}</div><div class="run-id">${esc(MEMBERS[r.settings?.main]?.label || r.settings?.main || 'Claude')} 主导 · ${r.summary.done}/${r.summary.total} 任务</div>${r.live ? '<div class="progress-line"><i></i></div>' : ''}</td><td>${runBadge(r)}</td></tr>`).join('')}</tbody></table>`
        : `<div class="empty"><div class="glyph">${icon('nodes')}</div><p>还没有编排运行。</p><button class="btn small primary" id="ov-new-run">启动编排</button></div>`
    $$('[data-run]', $('#recent-runs')).forEach((tr) => (tr.onclick = () => { state.openId = tr.dataset.run; go('agents') }))
    if ($('#ov-new-run')) $('#ov-new-run').onclick = openAgentRun
  },
}
function kpi(id, value, note, hist, color = '#38e1ff', format) {
  const el = $('#' + id)
  if (!el) return
  countUp($('.kpi-value', el), value, format)
  $('.kpi-note', el).textContent = note
  $('.kpi-spark', el).innerHTML = sparkline(hist, color)
}
function constellationModel() {
  const live = state.runs.filter((r) => r.live)
  const busy = new Set(live.flatMap((r) => [...(r.settings?.agents || []), r.settings?.main]))
  const opsBusy = new Set((state.sci?.operations || []).filter(opActive).map((o) => o.providerId))
  return {
    core: 'HARNESS',
    inner: Object.entries(MEMBERS).map(([id, m]) => ({ id, label: m.label, ok: !!state.health?.[id], active: busy.has(id) })),
    outer: (state.sci?.providers || []).map((p) => ({ id: p.id, label: p.id, active: opsBusy.has(p.id) })),
  }
}
function typer(el, lines) {
  clearTimeout(typerTimer)
  if (reduced) { el.textContent = lines[0]; return }
  let li = 0, ci = 0, del = false
  const tick = () => {
    if (!el.isConnected) return
    const line = lines[li]
    ci += del ? -1 : 1
    el.textContent = line.slice(0, ci)
    let wait = del ? 28 : 70
    if (!del && ci >= line.length) { del = true; wait = 2600 }
    else if (del && ci <= 0) { del = false; li = (li + 1) % lines.length; wait = 400 }
    typerTimer = setTimeout(tick, wait)
  }
  tick()
}

/* =====================================================================
 * 科学执行：实验运行 / Provider / 产物
 * ===================================================================== */
function scienceGate(stage) {
  if (!state.link.science || (state.sci && !state.project)) delete stage.dataset.ready
  if (!state.link.science) {
    stage.innerHTML = `<section class="card"><div class="empty"><div class="glyph">${icon('flask')}</div><h3>科学引擎离线</h3><p>${esc(state.link.scienceError || '未挂载 AI4Science 平台。')}</p><p class="muted">在补丁中设置 <code>scienceConfig</code> 指向平台 JSON 配置后重启。</p></div></section>`
    return false
  }
  if (state.sci && !state.project) {
    stage.innerHTML = `<section class="card"><div class="empty"><div class="glyph">${icon('layers')}</div><h3>工作区从这里开始</h3><p>创建一个已配置的项目，连接它的 Provider，第一份结果就会出现在这里。</p><button class="btn primary glow" id="first-project">创建项目</button></div></section>`
    $('#first-project').onclick = openProject
    return false
  }
  return true
}
views.science = {
  section: '科学执行',
  title: '实验运行',
  mount(stage) {
    stage.innerHTML = `<div id="sci-root"></div>`
  },
  update(kind) {
    const root = $('#sci-root')
    if (!root || !['sci', 'all'].includes(kind)) return
    if (!scienceGate(root)) return
    const d = state.sci
    if (!d) { root.innerHTML = '<div class="empty">连接科学引擎…</div>'; return }
    const ops = d.operations
    const visible = ops.filter((o) => (state.sciFilter === 'all' || (state.sciFilter === 'active' && opActive(o)) || (state.sciFilter === 'completed' && o.state === 'succeeded') || (state.sciFilter === 'attention' && ['unknown', 'failed'].includes(o.state))) && [o.requestKey, o.providerId, o.id].some((v) => v.toLowerCase().includes(state.sciSearch.toLowerCase()))).toReversed()
    const first = !root.dataset.ready
    if (first) {
      root.dataset.ready = '1'
      root.innerHTML = `
        <section class="hero"><div><div class="eyebrow">SCIENCE · ${esc(state.project)}</div><h1>实验<span class="grad">执行台</span></h1><p>每一次运行都有清晰的状态与持久身份。</p></div>
          <div class="hero-links"><button class="btn" id="reconcile">${icon('refresh')} 对账</button><button class="btn primary glow" id="sci-new">${icon('plus')} 发起实验</button></div></section>
        ${d.monitorError ? `<div class="notice">监控需要关注：${esc(d.monitorError)}</div>` : ''}
        <section class="card"><div class="toolbar"><div class="filters">${[['all', '全部'], ['active', '进行中'], ['completed', '已完成'], ['attention', '需关注']].map(([k, l]) => `<button class="chip-btn ${state.sciFilter === k ? 'active' : ''}" data-filter="${k}">${l}</button>`).join('')}</div><div class="search">${icon('search')}<input id="sci-search" placeholder="查找运行…" value="${esc(state.sciSearch)}"></div></div>
          <div class="table-wrap" id="ops-table"></div><div class="kpi-note" id="ops-foot" style="margin-top:8px"></div></section>`
      $$('[data-filter]', root).forEach((b) => (b.onclick = () => { state.sciFilter = b.dataset.filter; $$('[data-filter]', root).forEach((x) => x.classList.toggle('active', x === b)); views.science.update() }))
      $('#sci-search').oninput = (e) => { state.sciSearch = e.target.value; views.science.update() }
      $('#reconcile').onclick = async () => { try { await sciAction({ action: 'reconcile', project: state.project }); toast('对账完成，请复核观测状态。'); loadScience(true) } catch (e) { toast(e.message, true) } }
      $('#sci-new').onclick = openScienceRun
      $('#sci-new').disabled = !d.providers.length
    }
    $('#ops-table').innerHTML = visible.length
      ? `<table><thead><tr><th>运行</th><th>状态</th><th>创建时间</th><th></th></tr></thead><tbody class="${first ? 'stagger' : ''}">${visible.map((o, i) => `<tr data-op="${esc(o.id)}" style="--i:${i}" tabindex="0"><td><div class="run-label">${esc(o.requestKey)}</div><div class="run-id">${esc(o.providerId)} · ${esc(o.id.slice(0, 8))}</div>${opActive(o) ? '<div class="progress-line"><i></i></div>' : ''}</td><td>${opBadge(o.state)}</td><td class="mono">${when(o.createdAt)}</td><td style="color:var(--dim)">${icon('arrow')}</td></tr>`).join('')}</tbody></table>`
      : `<div class="empty"><div class="glyph">${icon('flask')}</div><h3>${ops.length ? '没有匹配的运行' : '准备好第一次运行'}</h3><p>${ops.length ? '换个筛选或关键词试试。' : '选择 Provider 并提交第一次操作，结果会出现在这里。'}</p></div>`
    $('#ops-foot').textContent = `显示 ${visible.length} / ${ops.length} 条 · 自动刷新`
    $$('[data-op]', root).forEach((tr) => {
      tr.onclick = () => openOp(tr.dataset.op)
      tr.onkeydown = (e) => { if (e.key === 'Enter') openOp(tr.dataset.op) }
    })
    if (state.selectedOp && $('#drawer').classList.contains('on')) renderOp()
  },
}
views.providers = {
  section: '科学执行',
  title: '执行 Provider',
  mount(stage) { stage.innerHTML = '<div id="prov-root"></div>' },
  update(kind) {
    const root = $('#prov-root')
    if (!root || !scienceGate(root) || !state.sci) return
    if (root.dataset.ready && kind !== 'all') return
    root.dataset.ready = '1'
    const ps = state.sci.providers
    root.innerHTML = `<section class="hero"><div><div class="eyebrow">CAPABILITIES</div><h1>执行 <span class="grad">Provider</span></h1><p>当前项目可用的能力、取消语义与输入约束。</p></div></section>
      <div class="provider-grid stagger">${ps.map((p, i) => `<section class="card tilt provider-card" style="--i:${i}"><div class="glyph-box">${icon('layers')}</div><h3>${esc(p.id)}</h3><span class="tag">v${esc(p.version)}</span><p>${esc(p.completion)}</p><details><summary>取消行为</summary><p class="muted">${esc(p.cancellation)}</p></details><details><summary>约束与单位</summary><pre>${esc(JSON.stringify({ constraints: p.constraints, units: p.units }, null, 2))}</pre></details><details><summary>输入 Schema</summary><pre>${esc(JSON.stringify(p.inputSchema, null, 2))}</pre></details></section>`).join('') || '<div class="empty">没有已注册的 Provider</div>'}</div>`
  },
}
views.artifacts = {
  section: '科学执行',
  title: '研究产物',
  mount(stage) { stage.innerHTML = '<div id="art-root"></div>' },
  update(kind) {
    const root = $('#art-root')
    if (!root || !['sci', 'all'].includes(kind) || !scienceGate(root) || !state.sci) return
    const arts = state.sci.artifacts, first = !root.dataset.ready
    root.dataset.ready = '1'
    root.innerHTML = `<section class="hero"><div><div class="eyebrow">EVIDENCE</div><h1>研究<span class="grad">产物</span></h1><p>经来源与内容完整性校验的输出。</p></div><div class="hero-links"><span class="link-pill">${icon('file')} <b>${arts.length}</b> 份</span></div></section>
      ${arts.length ? `<div class="artifact-list ${first ? 'stagger' : ''}">${arts.map((a, i) => artifactRow(a, i)).join('')}</div>` : `<section class="card"><div class="empty"><div class="glyph">${icon('file')}</div><h3>证据会出现在这里</h3><p>完成的操作会带着来源与内容哈希发布产物。</p></div></section>`}`
    bindArtifacts(root)
  },
}
function artifactRow(a, i = 0) {
  const name = a.path.split(/[\\/]/).at(-1)
  return `<div class="card artifact-row" style="--i:${i}"><div class="glyph-box">${icon('file')}</div><div style="min-width:0"><div class="artifact-name">${esc(name)}</div><div class="artifact-meta">${esc(a.requestKey ?? '')}${a.requestKey ? ' · ' : ''}${num(a.bytes)} B · ${esc(a.mediaType ?? '')}${a.sha256 ? ' · ' + esc(a.sha256.slice(0, 12)) + '…' : ''}</div></div><div class="row-actions"><button class="btn small" data-preview="${esc(a.id)}">预览</button><button class="icon-btn" data-download="${esc(a.id)}" data-name="${esc(name)}" aria-label="下载">${icon('download')}</button></div></div>`
}
function bindArtifacts(root) {
  $$('[data-preview]', root).forEach((b) => (b.onclick = async () => {
    try {
      const r = await sci(`/api/artifact?project=${encodeURIComponent(state.project)}&id=${encodeURIComponent(b.dataset.preview)}`)
      $('#artifact-title').textContent = r.artifact.path.split(/[\\/]/).at(-1)
      $('#artifact-content').textContent = r.encoding === 'base64' ? '二进制产物，请下载后查看。' : r.content
      $('#dlg-artifact').showModal()
    } catch (e) { toast(e.message, true) }
  }))
  $$('[data-download]', root).forEach((b) => (b.onclick = () => {
    const a = document.createElement('a')
    a.href = `/science/api/artifact?project=${encodeURIComponent(state.project)}&id=${encodeURIComponent(b.dataset.download)}&download=1`
    a.download = b.dataset.name || 'artifact'
    document.body.append(a); a.click(); a.remove()
    toast('已请求下载，服务端会先校验产物再发送。')
  }))
}

/* 运行详情抽屉 */
function openOp(id) {
  state.selectedOp = id
  renderOp()
  $('#drawer').classList.add('on')
  $('#drawer').setAttribute('aria-hidden', 'false')
  $('#scrim').classList.add('on')
}
function closeDrawer() {
  $('#drawer').classList.remove('on')
  $('#drawer').setAttribute('aria-hidden', 'true')
  $('#scrim').classList.remove('on')
  state.selectedOp = null
}
$('#scrim').onclick = closeDrawer
$('[data-close="drawer"]').onclick = closeDrawer
function renderOp() {
  const op = state.sci?.operations.find((o) => o.id === state.selectedOp)
  if (!op) return
  $('#drawer-title').textContent = op.requestKey
  const ended = ['succeeded', 'cancelled', 'failed'].includes(op.state)
  $('#drawer-body').innerHTML = `
    <div class="kv"><div><label>状态</label>${opBadge(op.state)}</div><div><label>Provider</label>${esc(op.providerId)} · v${esc(op.providerVersion)}</div><div><label>操作 ID</label><span class="mono">${esc(op.id)}</span></div><div><label>预算预留</label>${num(op.budget)}</div><div><label>资源</label>${esc(op.resources.join(', '))}</div><div><label>创建</label>${when(op.createdAt)}</div></div>
    ${opActive(op) ? '<div class="progress-line" style="margin-bottom:14px"><i></i></div>' : ''}
    ${op.cancelRequested ? `<div class="notice">${op.state === 'cancelled' ? '已确认取消，部分结果仍可查看。' : ended ? '执行已结束，观测到的结果已保留。' : '已请求取消，尚未确认执行停止。'}</div>` : ''}
    ${op.detail ? `<p class="muted">${esc(op.detail)}</p>` : ''}
    <div class="block-title">实际输入</div><pre>${esc(JSON.stringify(op.input, null, 2))}</pre>
    ${op.progress ? `<div class="block-title">观测进度</div><pre>${esc(JSON.stringify(op.progress, null, 2))}</pre>` : ''}
    <div class="block-title">产物</div>${op.artifacts.length ? `<div class="artifact-list">${op.artifacts.map((a) => artifactRow(a)).join('')}</div>` : '<p class="muted">还没有发布产物。</p>'}
    <div class="drawer-actions"><button class="btn" id="op-query">${icon('refresh')} 查询 Provider</button>${ended ? '' : `<button class="btn danger" id="op-cancel">${icon('stop')} 请求取消</button>`}</div>`
  $('#op-query').onclick = async () => { try { await sciAction({ action: 'query', project: state.project, operationId: op.id }); loadScience(true) } catch (e) { toast(e.message, true) } }
  if ($('#op-cancel')) $('#op-cancel').onclick = async () => {
    try {
      const r = await sciAction({ action: 'cancel', project: state.project, operationId: op.id })
      toast(r.cancelRequested ? `取消请求已记录，观测状态：${OP_STATE[r.state] || r.state}` : `操作已${OP_STATE[r.state] || r.state}，无需取消。`)
      loadScience(true)
    } catch (e) { toast(e.message, true) }
  }
  bindArtifacts($('#drawer-body'))
}

/* 科学对话框 */
function sample(schema, depth = 0) {
  if (depth > 4 || !schema) return null
  if (schema.default !== undefined) return schema.default
  if (schema.enum?.length) return schema.enum[0]
  if (schema.type === 'object') { const v = {}; for (const k of schema.required || []) v[k] = sample(schema.properties?.[k], depth + 1); return v }
  if (schema.type === 'array') return Array.from({ length: Math.min(3, Math.max(1, schema.minItems || 1)) }, () => sample(schema.items, depth + 1))
  if (schema.type === 'string') return 'Example input'
  if (schema.type === 'boolean') return false
  if (schema.type === 'number' || schema.type === 'integer') return Math.max(schema.minimum ?? 0, Math.min(schema.maximum ?? 1, 1))
  return null
}
function openProject() {
  if (!state.sci) return toast(state.link.science ? '请先连接科学引擎。' : '科学引擎离线', true)
  const remaining = state.sci.allowedProjects.filter((id) => !state.sci.projects.some((p) => p.id === id))
  if (!remaining.length) return toast('所有已配置项目都已创建。请先在管理配置中添加新项目。', true)
  $('#project-name').innerHTML = remaining.map((id) => `<option>${esc(id)}</option>`).join('')
  $('#dlg-project .form-error').textContent = ''
  $('#dlg-project').showModal()
}
function updateRunInput() {
  const p = state.sci.providers.find((x) => x.id === $('#run-provider').value)
  $('#run-input').value = JSON.stringify(sample(p.inputSchema), null, 2)
  $('#input-schema').textContent = JSON.stringify(p.inputSchema, null, 2)
}
function openScienceRun() {
  if (!state.link.science) return toast('科学引擎离线', true)
  if (!state.project) return openProject()
  if (!state.sci?.providers.length) return toast('当前项目没有可用 Provider', true)
  $('#run-provider').innerHTML = state.sci.providers.map((p) => `<option>${esc(p.id)}</option>`).join('')
  $('#request-key').value = 'run-' + crypto.randomUUID().slice(0, 8)
  updateRunInput()
  $('#dlg-science-run .form-error').textContent = ''
  $('#dlg-science-run').showModal()
}
$('#run-provider').onchange = updateRunInput
async function submitForm(e, fn) {
  e.preventDefault()
  const form = e.currentTarget, btn = $('[type=submit]', form)
  if (btn.disabled) return
  btn.disabled = true
  $('.form-error', form).textContent = ''
  try { await fn(); form.closest('dialog').close() }
  catch (err) { $('.form-error', form).textContent = err.message }
  finally { btn.disabled = false }
}
$('#form-project').onsubmit = (e) => submitForm(e, async () => {
  const id = $('#project-name').value
  await sciAction({ action: 'create', project: id, budget: Number($('#project-budget').value) })
  state.project = id
  toast(`项目 ${id} 已创建`)
  await loadScience(true)
  if (['science', 'providers', 'artifacts'].includes(state.view)) go(state.view, { quiet: true })
})
$('#form-science-run').onsubmit = (e) => submitForm(e, async () => {
  let input
  try { input = JSON.parse($('#run-input').value) } catch { throw new Error('输入不是合法 JSON') }
  const r = await sciAction({ action: 'submit', project: state.project, providerId: $('#run-provider').value, requestKey: $('#request-key').value, input })
  toast(`运行${OP_STATE[r.state] || r.state}`)
  if (state.view !== 'science') go('science')
  await loadScience(true)
})

/* =====================================================================
 * 多智能体编排
 * ===================================================================== */
views.agents = {
  section: '多智能体',
  title: '编排运行',
  mount(stage) {
    if (!state.link.router) {
      stage.innerHTML = `<section class="card"><div class="empty"><div class="glyph">${icon('nodes')}</div><h3>Agent Router 未挂载</h3></div></section>`
      return
    }
    stage.innerHTML = `
      <div class="agents">
        <section class="card runs-col"><div class="card-head"><span class="card-title">运行记录</span><span class="count" id="runs-count">0</span><span class="spacer"></span><button class="icon-btn" id="ag-new" title="新建编排">${icon('plus')}</button></div><div class="run-list" id="run-list"></div></section>
        <div class="run-col" id="run-col">
          <section class="card run-head" id="run-head"><div class="empty" style="width:100%"><div class="glyph">${icon('nodes')}</div><h3>选择一次运行</h3><p>查看任务板、信箱与主代理的实时输出，或启动新的多智能体编排。</p><button class="btn primary glow" id="ag-new-2">${icon('play')} 启动编排</button></div></section>
          <div id="finish"></div>
          <section class="card"><div class="card-head">${icon('bolt')}<span class="card-title">任务板</span><span class="card-sub" id="task-summary"></span></div><div class="kanban" id="kanban">${lanes()}</div></section>
          <div class="split">
            <section class="card"><div class="card-head">${icon('mail')}<span class="card-title">信箱</span><span class="count" id="msg-count">0</span></div><div class="mailbox" id="mailbox"><div class="empty">暂无消息</div></div></section>
            <section class="card terminal"><div class="term-head"><span class="term-dots"><i></i><i></i><i></i></span><b>控制台</b><span class="spacer"></span>${[['all', '全部'], ['manager', '主代理'], ['event', '事件'], ['mail', '信箱']].map(([k, l]) => `<button class="chip-btn ${state.consoleFilter === k ? 'active' : ''}" data-cf="${k}">${l}</button>`).join('')}<button class="chip-btn" id="con-pause">${state.paused ? '恢复滚动' : '暂停滚动'}</button><button class="chip-btn" id="con-clear">清屏</button></div>
              <div class="console" id="console"><div class="empty">实时输出（SSE）</div></div>
              <div class="say-row"><input id="say" placeholder="给主代理插话，回车发送（仅运行中可用）…" disabled /><button class="btn primary" id="say-send" disabled>发送</button></div></section>
          </div>
        </div>
      </div>`
    $('#ag-new').onclick = openAgentRun
    $('#ag-new-2').onclick = openAgentRun
    $$('[data-cf]').forEach((b) => (b.onclick = () => { state.consoleFilter = b.dataset.cf; $$('[data-cf]').forEach((x) => x.classList.toggle('active', x === b)); applyConsoleFilter() }))
    $('#con-pause').onclick = (e) => { state.paused = !state.paused; e.target.textContent = state.paused ? '恢复滚动' : '暂停滚动' }
    $('#con-clear').onclick = () => { $('#console').innerHTML = '' }
    $('#say-send').onclick = sendSay
    $('#say').onkeydown = (e) => { if (e.key === 'Enter') sendSay() }
    $('#run-list').onclick = (e) => { const el = e.target.closest('.run-item'); if (el) openRun(el.dataset.id) }
    $('#kanban').onclick = onTaskClick
    if (state.openId) openRun(state.openId)
  },
  update(kind) {
    if (!$('#run-list')) return
    if (kind === 'runs' || kind === 'all') renderRunList()
    if (kind === 'health' && state.run) renderRunHead()
  },
}
function lanes() {
  return [['pending', '待执行', '#fbbf24'], ['in_progress', '执行中', '#38e1ff'], ['done', '已完成', '#34d399'], ['failed', '失败', '#fb7185']]
    .map(([k, l, c]) => `<div class="lane" style="--c:${c}"><div class="lane-head"><i></i>${l}<span class="count" data-lane-count="${k}">0</span></div><div class="lane-body" data-lane="${k}"></div></div>`).join('')
}
function renderRunList() {
  const box = $('#run-list')
  $('#runs-count').textContent = state.runs.length
  box.innerHTML = state.runs.length
    ? state.runs.map((r) => `<div class="run-item ${state.openId === r.id ? 'active' : ''}" data-id="${esc(r.id)}"><div class="r-name">${r.live ? '<span class="live-dot"></span>' : ''}${esc(r.id)}</div>${r.goal ? `<div class="r-goal" title="${esc(r.goal)}">${esc(r.goal)}</div>` : ''}<div class="r-meta"><span class="chip who">主 ${esc(MEMBERS[r.settings?.main]?.label || r.settings?.main || 'Claude')}</span><span class="chip">${r.summary.total} 任务</span><span class="chip" style="color:var(--green)">✔ ${r.summary.done}</span>${r.summary.failed ? `<span class="chip" style="color:var(--red)">✗ ${r.summary.failed}</span>` : ''}<span>${r.live ? '进行中' : when(r.mtime)}</span></div></div>`).join('')
    : `<div class="empty"><p>暂无运行记录</p></div>`
}

function disconnectSse() { if (state.es) { state.es.close(); state.es = null } }
async function openRun(id) {
  state.openId = id
  disconnectSse()
  if (!$('#console')) return
  $('#console').innerHTML = ''
  state.run = null
  try {
    const d = await rt(`/api/runs/${encodeURIComponent(id)}`)
    if (state.openId !== id || !$('#console')) return
    state.run = d
    state.threads = d.threads || []
    state.logFiles = d.logs || []
    renderRunHead()
    renderBoard(d.board)
    renderAgentStrip(d.agentStatus)
    if (d.status === 'running') connectSse(id)
    else loadConsoleRest(id, d.consoleAvailable)
  } catch (e) { toast('加载运行失败：' + e.message, true) }
  $$('.run-item').forEach((el) => el.classList.toggle('active', el.dataset.id === id))
  updateSay()
}
function renderRunHead() {
  const d = state.run, head = $('#run-head')
  if (!d || !head) return
  const running = d.status === 'running', s = d.settings || {}
  head.innerHTML = `
    <div class="goal"><div class="eyebrow">RUN · ${esc(d.id)}</div><h2>${esc(d.goal || '历史运行 · 目标未记录')}</h2>
      <div class="run-chips">${running ? '<span class="status live">执行中</span>' : '<span class="status finished">历史 / 空闲</span>'}<span class="chip who">主代理 ${esc(MEMBERS[s.main]?.label || s.main || 'Claude')}</span><span class="chip">${s.worktree ? 'worktree 隔离' : '直通模式'}</span>${(s.agents || []).map((a) => `<span class="chip">${esc(MEMBERS[a]?.label || a)}</span>`).join('')}${s.repo ? `<span class="chip mono" title="${esc(s.repo)}">📁 ${esc(s.repo.split(/[\\/]/).slice(-2).join('/'))}</span>` : ''}</div></div>
    <div class="run-actions"><button class="btn" id="btn-threads">${icon('thread')} 线程与日志</button><button class="btn danger" id="btn-stop" ${running ? '' : 'disabled'}>${icon('stop')} 停止</button></div>
    <div class="agent-strip" id="agent-strip"></div>`
  $('#btn-threads').onclick = () => openLogModal()
  $('#btn-stop').onclick = async () => {
    if (!confirm('确认停止当前运行？')) return
    try { await rt(`/api/runs/${encodeURIComponent(d.id)}/stop`, { method: 'POST' }); toast('已请求停止') } catch (e) { toast(e.message, true) }
    setTimeout(() => { loadRuns(true); loadHealth() }, 800)
  }
  renderAgentStrip(state.agentStatus)
}
function connectSse(id) {
  const es = new EventSource('/router/api/events?runId=' + encodeURIComponent(id))
  state.es = es
  es.onopen = () => { if (state.run?.id === id) loadConsoleRest(id, true) }
  es.onmessage = (ev) => {
    let m
    try { m = JSON.parse(ev.data) } catch { return }
    if (state.run?.id !== id || (m.runId && m.runId !== id)) return
    if (m.eventId && m.eventId <= (state.lastEventIds[id] || 0)) return
    if (m.eventId) state.lastEventIds[id] = m.eventId
    if (m.type === 'snapshot') { state.run = { ...state.run, ...m.run }; renderRunHead(); updateSay() }
    else if (m.type === 'console') appendConsole(m.line, true)
    else if (m.type === 'board') { state.run.board = m.board; renderBoard(m.board) }
    else if (m.type === 'status') renderAgentStrip(m.status)
    else if (m.type === 'threads') { state.threads = m.threads; if ($('#dlg-logs').open) renderModalList() }
    else if (m.type === 'thread') { if (state.modalThread === m.name && $('#dlg-logs').open) for (const e of m.entries) appendThreadEntry(e) }
    else if (m.type === 'exit') {
      appendConsole(`\n[进程退出，code=${m.code}]\n`, true)
      state.run.status = 'finished'
      renderAgentStrip(null); renderRunHead(); updateSay()
      toast(`运行 ${id} 已结束`)
      loadHealth(); loadRuns(true)
    }
  }
}
async function loadConsoleRest(id, available) {
  const box = $('#console')
  if (!box) return
  if (!available) { box.innerHTML = '<div class="empty">该运行由 CLI 启动，无控制台记录（任务板与会话日志仍可查看）</div>'; return }
  try {
    const d = await rt(`/api/runs/${encodeURIComponent(id)}/console`)
    box.innerHTML = (d.text || '').split('\n').map((l) => `<div class="ln ${lineCat(l)}">${ansi(l)}</div>`).join('')
    applyConsoleFilter()
    box.scrollTop = box.scrollHeight
  } catch {}
}
function ansi(text) {
  const map = { 1: '<span class="b">', 2: '<span class="dim">', 31: '<span class="red">', 32: '<span class="green">', 33: '<span class="yellow">', 36: '<span class="cyan">' }
  return esc(text).replace(/\x1b\[([0-9;]*)m/g, (_, code) => (['0', '', '22', '39'].includes(code) ? '</span>' : map[code.split(';')[0]] || ''))
}
function lineCat(t) {
  t = String(t)
  if (t.includes('[manager]') || t.includes('[用户')) return 'c-manager'
  if (t.includes('[事件]')) return 'c-event'
  if (t.includes('[信箱]')) return 'c-mail'
  return 'c-other'
}
function applyConsoleFilter() {
  const cls = { manager: 'c-manager', event: 'c-event', mail: 'c-mail' }[state.consoleFilter]
  for (const el of $('#console')?.children ?? []) el.classList.toggle('hide', !!cls && !el.classList.contains(cls))
}
function appendConsole(line, fresh = false) {
  const box = $('#console')
  if (!box) return
  if (box.querySelector('.empty')) box.innerHTML = ''
  const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 40
  const div = document.createElement('div')
  div.className = 'ln ' + lineCat(line) + (fresh ? ' fresh' : '')
  div.innerHTML = ansi(line)
  const cls = { manager: 'c-manager', event: 'c-event', mail: 'c-mail' }[state.consoleFilter]
  if (cls && !div.classList.contains(cls)) div.classList.add('hide')
  box.append(div)
  while (box.childNodes.length > 6000) box.firstChild.remove()
  if (!state.paused && atBottom) box.scrollTop = box.scrollHeight
}
function renderAgentStrip(s) {
  state.agentStatus = s
  const el = $('#agent-strip')
  if (!el) return
  if (state.run?.status !== 'running' || !s) { el.innerHTML = ''; return }
  const map = { starting: '启动中', online: '在线', restarting: '重启续命中', dead: '已停止' }
  const main = MEMBERS[state.run.settings?.main]?.label || state.run.settings?.main || 'Claude'
  el.innerHTML = `<span class="as-item"><span class="live-dot"></span><b>主代理（${esc(main)}）</b>${esc(map[s.session] || s.session)}</span><span class="as-item">回合 <b>${s.turns ?? 0}</b></span>${s.cost ? `<span class="as-item">花费 <b>$${Number(s.cost).toFixed(4)}</b></span>` : ''}${s.currentTool ? `<span class="as-item">⚙ ${esc(s.currentTool)}</span>` : ''}${s.restarts ? `<span class="as-item">续命 ${s.restarts} 次</span>` : ''}`
}
function updateSay() {
  const on = state.run?.status === 'running'
  if ($('#say')) { $('#say').disabled = !on; $('#say-send').disabled = !on }
}
async function sendSay() {
  const inp = $('#say'), text = inp.value.trim()
  if (!text || state.run?.status !== 'running') return
  $('#say-send').disabled = true
  try { await rt(`/api/runs/${encodeURIComponent(state.run.id)}/message`, { method: 'POST', body: JSON.stringify({ text }) }); inp.value = '' }
  catch (e) { appendConsole(`[发送失败] ${e.message}`, true) }
  updateSay(); inp.focus()
}

/* 任务板（看板） + 信箱 */
const fmtDur = (sec) => (sec == null || isNaN(sec) ? '' : sec >= 60 ? `${Math.floor(sec / 60)}分${sec % 60}秒` : `${sec}秒`)
const liveDur = (t) => Math.max(0, Math.round((Date.now() - new Date(t).getTime()) / 1000))
setInterval(() => $$('[data-started]').forEach((el) => (el.textContent = '⏱ ' + fmtDur(liveDur(el.dataset.started)))), 1000)
function renderBoard(board) {
  if (!$('#kanban')) return
  const tasks = board?.tasks ?? [], msgs = board?.messages ?? []
  const done = tasks.filter((t) => t.status === 'done').length, failed = tasks.filter((t) => t.status === 'failed').length
  $('#task-summary').textContent = tasks.length ? `${done}/${tasks.length} 完成${failed ? ` · ${failed} 失败` : ''}` : ''
  const fin = board?.finished
  $('#finish').innerHTML = fin ? `<div class="finish"><div class="finish-title">🏁 主代理结束总结 <span class="mono">${esc((fin.at || '').slice(0, 19).replace('T', ' '))}</span></div><div class="finish-body">${esc(fin.summary || '(无)')}</div></div>` : ''
  const running = state.run?.status === 'running'
  const prev = new Map($$('.task').map((el) => [el.dataset.id, el.dataset.status]))
  for (const lane of ['pending', 'in_progress', 'done', 'failed']) {
    const list = tasks.filter((t) => (lane === 'pending' ? !['in_progress', 'done', 'failed'].includes(t.status) : t.status === lane))
    $(`[data-lane-count="${lane}"]`).textContent = list.length
    $(`[data-lane="${lane}"]`).innerHTML = list.map((t) => taskCard(t, running, prev.get(t.id) === t.status)).join('')
  }
  renderMailbox(msgs)
}
function taskCard(t, running, unchanged) {
  const logs = (state.run?.logs || []).filter((l) => l.name.startsWith(t.id + '-'))
  const threads = (state.threads || []).filter((x) => x.name.startsWith(t.id + '-'))
  const dur = t.started_at && t.updated_at ? Math.round((new Date(t.updated_at) - new Date(t.started_at)) / 1000) : null
  const links = []
  if (t.result) links.push(`<button data-res="${esc(t.id)}">展开结果</button>`)
  for (const x of threads) links.push(`<button data-thread="${esc(x.name)}">🧵 线程</button>`)
  for (const l of logs) links.push(`<button data-log="${esc(l.name)}">日志 ${esc(l.name.replace('.log', ''))}</button>`)
  if (running && t.status === 'in_progress') links.push(`<button data-cancel="${esc(t.id)}">✕ 取消</button>`)
  if (running && t.status === 'failed') links.push(`<button data-retry="${esc(t.id)}">↻ 重试</button>`)
  return `<div class="task ${esc(t.status)}" data-id="${esc(t.id)}" data-status="${esc(t.status)}" ${unchanged ? 'style="animation:none"' : ''}>
    <div class="t-id">${esc(t.id)}</div><div class="t-title">${esc(t.title)}</div>
    <div class="t-meta"><span class="chip who">→ ${esc(MEMBERS[t.assignee]?.label || t.assignee)}</span>${(t.blocked_by || []).map((b) => `<span class="chip warn">依赖 ${esc(b)}</span>`).join('')}${t.isolated ? '<span class="chip" title="独立 worktree 执行，完成后自动合并">🔒 隔离</span>' : ''}${t.followup?.state === 'queued' ? '<span class="chip">↻ 续派待执行</span>' : ''}${t.followup?.state === 'rejected' ? `<span class="chip warn" title="${esc(t.followup.reason || '')}">↻ 续派被拒</span>` : ''}${t.continuations ? `<span class="chip">↻ ×${t.continuations}</span>` : ''}
      ${t.status === 'in_progress' && t.started_at ? `<span data-started="${esc(t.started_at)}">⏱ ${fmtDur(liveDur(t.started_at))}</span>` : t.updated_at ? `<span>${esc(t.updated_at.slice(5, 16).replace('T', ' '))}${dur ? ` · ${fmtDur(dur)}` : ''}</span>` : ''}</div>
    ${t.spec ? `<div class="t-result clamp">${esc(t.spec.length > 240 ? t.spec.slice(0, 240) + '…' : t.spec)}</div>` : ''}
    ${t.result ? `<div class="t-result clamp" id="res-${esc(t.id)}" style="color:var(--text)">${esc(t.result)}</div>` : ''}
    ${t.worktree ? `<div class="t-result mono" title="${esc(t.worktree)}">📁 ${esc(t.branch)} · 现场保留</div>` : ''}
    ${links.length ? `<div class="t-links">${links.join('')}</div>` : ''}</div>`
}
function onTaskClick(e) {
  const b = e.target.closest('button')
  if (!b) return
  const id = state.run?.id
  if (b.dataset.res) document.getElementById('res-' + b.dataset.res)?.classList.toggle('clamp')
  else if (b.dataset.thread) openLogModal({ thread: b.dataset.thread })
  else if (b.dataset.log) openLogModal({ log: b.dataset.log })
  else if (b.dataset.cancel && id && confirm(`确认取消任务 ${b.dataset.cancel}？现场会保留。`)) rt(`/api/runs/${encodeURIComponent(id)}/task/${encodeURIComponent(b.dataset.cancel)}/cancel`, { method: 'POST' }).catch((err) => toast(err.message, true))
  else if (b.dataset.retry && id) rt(`/api/runs/${encodeURIComponent(id)}/task/${encodeURIComponent(b.dataset.retry)}/retry`, { method: 'POST' }).catch((err) => toast(err.message, true))
}
function renderMailbox(msgs) {
  const box = $('#mailbox')
  $('#msg-count').textContent = msgs.length
  const seen = Number(box.dataset.n || 0)
  box.dataset.n = msgs.length
  box.innerHTML = msgs.length
    ? msgs.map((m, i) => `<div class="msg" ${i < seen ? 'style="animation:none"' : ''}><div class="m-head"><span class="m-from">${esc(m.from)}</span>→<span class="m-to">${esc(m.to)}</span>${m.task_id ? `<span class="chip">${esc(m.task_id)}</span>` : ''}${m.read === false ? '<span class="chip warn">未读</span>' : ''}<span class="m-time">${esc((m.ts || '').slice(5, 19).replace('T', ' '))}</span></div><div class="m-body">${esc(m.content)}</div></div>`).reverse().join('')
    : '<div class="empty">暂无消息</div>'
}

/* 线程 / 日志弹窗（沿用 Agent Router 控制台的事件 → 节点投影） */
function renderModalList() {
  const box = $('#log-list')
  let html = ''
  if (state.threads.length) html += '<div class="list-sec">会话线程</div>' + state.threads.map((t) => `<div class="log-item ${state.modalThread === t.name ? 'active' : ''}" data-thread="${esc(t.name)}">🧵 ${esc(t.name.replace('.jsonl', ''))} <span class="dim">${t.size}B</span></div>`).join('')
  if (state.logFiles.length) html += '<div class="list-sec">原始日志</div>' + state.logFiles.map((l) => `<div class="log-item ${!state.modalThread && state.modalLog === l.name ? 'active' : ''}" data-f="${esc(l.name)}">${esc(l.name)} <span class="dim">${l.size}B</span></div>`).join('')
  box.innerHTML = html || '<div class="log-item">无线程与日志</div>'
  $$('[data-thread]', box).forEach((el) => (el.onclick = () => showThread(el.dataset.thread)))
  $$('[data-f]', box).forEach((el) => (el.onclick = () => showLog(el.dataset.f)))
}
async function openLogModal(pick = {}) {
  if (!state.run) return
  $('#dlg-logs').showModal()
  renderModalList()
  if (pick.thread) await showThread(pick.thread)
  else if (pick.log) await showLog(pick.log)
}
async function showLog(name) {
  state.modalThread = null; state.modalLog = name
  renderModalList()
  $('#log-title').textContent = '· ' + name
  const c = $('#log-content')
  c.classList.remove('thread-view')
  try { const d = await rt(`/api/runs/${encodeURIComponent(state.run.id)}/log/${encodeURIComponent(name)}`); c.textContent = d.text || '(空)' }
  catch (e) { c.textContent = '加载失败：' + e.message }
}
async function showThread(name) {
  state.modalThread = name; state.modalLog = null; state.threadPending = []; state.threadStick = true
  renderModalList()
  $('#log-title').textContent = '· ' + name.replace('.jsonl', '')
  const c = $('#log-content')
  c.classList.add('thread-view')
  c.innerHTML = '<div class="empty">加载中…</div>'
  try {
    const d = await rt(`/api/runs/${encodeURIComponent(state.run.id)}/thread/${encodeURIComponent(name)}`)
    c.innerHTML = ''
    for (const e of d.entries || []) appendThreadEntry(e)
    if (!(d.entries || []).length) c.innerHTML = '<div class="empty">这个线程还没有内容</div>'
    c.scrollTop = c.scrollHeight
  } catch (e) { c.classList.remove('thread-view'); c.textContent = '加载失败：' + e.message }
}
function toolSummary(input) {
  try {
    if (input == null) return ''
    if (typeof input === 'string') return input.slice(0, 90)
    for (const k of ['command', 'file_path', 'title', 'query']) if (input[k]) return String(input[k]).replace(/\s+/g, ' ').slice(0, 90)
    const s = JSON.stringify(input)
    return s.length > 90 ? s.slice(0, 90) + '…' : s
  } catch { return '' }
}
function appendThreadEntry(e) {
  const box = $('#log-content'), el = document.createElement('div'), d = e.data || {}
  if (e.kind === 'system') {
    el.className = 'th-system'
    const via = d.via === 'append-system-prompt' ? '（--append-system-prompt · 随每次请求生效）' : d.via === 'first-message' ? '（已并入该会话第一条消息）' : ''
    el.innerHTML = `<details><summary>📋 系统提示词${esc(via)}</summary><pre>${esc(String(d.text || ''))}</pre></details>`
  } else if (e.kind === 'user') { el.className = 'th-user'; el.innerHTML = `<div class="th-role">派发 / 注入</div><div class="th-body">${esc(String(d.text || ''))}</div>` }
  else if (e.kind === 'assistant') { el.className = 'th-msg'; el.innerHTML = `<div class="th-body">${esc(String(d.text || ''))}</div>` }
  else if (e.kind === 'thought') { el.className = 'th-thought'; el.innerHTML = `<details><summary>💭 思考</summary><div class="th-body">${esc(String(d.text || '').slice(0, 3000))}</div></details>` }
  else if (e.kind === 'tool_use') {
    el.className = 'th-tool'
    el.dataset.tid = d.id || `seq-${e.seq}`
    el.innerHTML = `<details open><summary>⚙ ${esc(d.name || 'tool')}<span class="th-sum">${esc(toolSummary(d.input))}</span><span class="th-run">⏳</span></summary><pre>${esc(JSON.stringify(d.input ?? d.raw ?? {}, null, 1).slice(0, 4000))}</pre><div class="th-result"></div></details>`
    state.threadPending.push(el)
  } else if (e.kind === 'tool_result') {
    let idx = state.threadPending.findIndex((c) => c.dataset.tid === (d.id || ''))
    if (idx === -1) idx = 0
    const card = state.threadPending.splice(idx, 1)[0]
    if (card) {
      const run = $('.th-run', card)
      if (run) { run.textContent = d.isError ? '✗' : '✓'; run.classList.add(d.isError ? 'err' : 'ok') }
      $('.th-result', card).innerHTML = `<div class="th-role ${d.isError ? 'err' : ''}" style="margin-top:8px">${d.isError ? '结果（出错）' : '结果'}</div><pre>${esc(String(d.text || '').slice(0, 4000))}</pre>`
      $('details', card).open = false
      return
    }
    el.className = 'th-tool'
    el.innerHTML = `<details><summary>工具结果${d.isError ? '（出错）' : ''}</summary><pre>${esc(String(d.text || '').slice(0, 4000))}</pre></details>`
  } else if (e.kind === 'result') {
    el.className = 'th-final ' + (d.isError ? 'err' : 'ok')
    el.innerHTML = `<div class="th-role">${d.isError ? '■ 会话失败' : '■ 会话完成'}${d.cost ? ` · 累计 $${Number(d.cost).toFixed(4)}` : ''}</div><div class="th-body">${esc(String(d.text || '').slice(0, 2000) || '(无文本)')}</div>`
  } else return
  box.append(el)
  if (state.threadStick) box.scrollTop = box.scrollHeight
}
$('#log-content').addEventListener('scroll', () => {
  const b = $('#log-content')
  state.threadStick = b.scrollHeight - b.scrollTop - b.clientHeight < 60
})

/* 启动编排对话框 */
function openAgentRun() {
  if (!state.link.router) return toast('Agent Router 未挂载', true)
  const h = state.health || {}
  for (const id of [...state.agPicked]) if (state.health && !h[id]) state.agPicked.delete(id)
  $('#ag-agents').innerHTML = Object.entries(MEMBERS).map(([id, m]) => `<button type="button" class="member-chip ${h[id] ? 'ok' : ''} ${state.agPicked.has(id) ? 'on' : ''}" data-m="${id}" ${state.health && !h[id] ? 'disabled title="CLI 未就绪"' : ''}><i></i>${esc(m.label)}<small>${esc(h.models?.[id] || '')}</small></button>`).join('')
  $$('#ag-agents .member-chip').forEach((b) => (b.onclick = () => { const id = b.dataset.m; state.agPicked.has(id) ? state.agPicked.delete(id) : state.agPicked.add(id); b.classList.toggle('on') }))
  $('#ag-main').innerHTML = Object.entries(MEMBERS).map(([id, m]) => `<option value="${id}" ${state.health && !h[id] ? 'disabled' : ''}>${esc(m.label)} — ${esc(m.mode)}</option>`).join('')
  const firstOk = Object.keys(MEMBERS).find((id) => !state.health || h[id])
  if (firstOk) $('#ag-main').value = firstOk
  $$('#ag-mode button').forEach((b) => (b.onclick = () => { state.agMode = b.dataset.v; $$('#ag-mode button').forEach((x) => x.classList.toggle('on', x === b)) }))
  $('#dlg-agent-run .form-error').textContent = ''
  $('#dlg-agent-run').showModal()
  $('#ag-goal').focus()
}
$('#form-agent-run').onsubmit = (e) => submitForm(e, async () => {
  const goal = $('#ag-goal').value.trim()
  if (!goal) throw new Error('请填写总目标')
  const agents = [...state.agPicked]
  if (!agents.length) throw new Error('至少选择一名执行成员')
  const d = await rt('/api/runs', { method: 'POST', body: JSON.stringify({ goal, repo: $('#ag-repo').value.trim() || undefined, agents, main: $('#ag-main').value, worktree: state.agMode === 'worktree' }) })
  toast(`编排运行 ${d.id} 已启动`)
  $('#ag-goal').value = ''
  state.openId = d.id
  await loadRuns(true)
  if (state.view !== 'agents') go('agents')
  else openRun(d.id)
  loadHealth()
})

/* =====================================================================
 * 成员舰队
 * ===================================================================== */
views.fleet = {
  section: '多智能体',
  title: '成员舰队',
  mount(stage) {
    stage.innerHTML = `<section class="hero"><div><div class="eyebrow">FLEET</div><h1>成员<span class="grad">舰队</span></h1><p>主代理可调度的全部 CLI 成员，以及对话模型提供方。</p></div><div class="hero-links" id="fleet-sum"></div></section>
      <div class="fleet stagger" id="fleet"></div>
      <section class="card" style="margin-top:16px"><div class="card-head">${icon('cpu')}<span class="card-title">对话模型 / consult</span></div><div id="llm"></div></section>`
  },
  update() {
    const h = state.health, box = $('#fleet')
    if (!box) return
    if (!state.link.router) { box.innerHTML = '<div class="empty">Agent Router 未挂载</div>'; return }
    if (!h) { box.innerHTML = '<div class="empty">检测成员中…</div>'; return }
    const ids = Object.keys(MEMBERS), online = ids.filter((id) => h[id]).length
    $('#fleet-sum').innerHTML = `<span class="link-pill"><i class="link-dot on"></i><b>${online}</b> 在线</span><span class="link-pill"><i class="link-dot off"></i><b>${ids.length - online}</b> 未就绪</span>${h.busy ? `<span class="link-pill"><span class="live-dot"></span><b>${h.activeRuns.length}</b> 运行中</span>` : ''}`
    box.innerHTML = ids.map((id, i) => {
      const m = MEMBERS[id]
      return `<section class="card tilt member ${h[id] ? '' : 'off'}" style="--i:${i}"><div class="member-top"><span class="member-avatar" style="--c1:${m.c1};--c2:${m.c2}">${esc(m.label.slice(0, 2))}</span><div><div class="member-name">${esc(m.label)}</div><div class="member-model">${esc(h.models?.[id] || '客户端默认')}</div></div><span style="margin-left:auto" class="status ${h[id] ? 'succeeded' : 'idle'}">${h[id] ? '就绪' : '未就绪'}</span></div><div class="member-note">${esc(m.mode)}</div><div class="member-path">${esc(h.paths?.[id] || '')}</div><div class="kpi-note">${esc(h.checks?.[id] || '')}</div></section>`
    }).join('')
    const llm = Object.entries(h.llm || {})
    $('#llm').innerHTML = llm.length
      ? `<table><tbody>${llm.map(([k, v]) => `<tr style="cursor:default"><td><div class="run-label">${esc(v.label)}${h.consult === k ? ' <span class="chip who">consult</span>' : ''}</div><div class="run-id">${esc(v.model || '')}${v.apiKeyEnv ? ' · ' + esc(v.apiKeyEnv) : ''}</div></td><td><span class="status ${v.ready ? 'succeeded' : 'idle'}">${v.ready ? '可用' : '未就绪'}</span></td></tr>`).join('')}</tbody></table>`
      : '<div class="muted">未配置对话模型</div>'
  },
}

/* =====================================================================
 * 命令面板 + 快捷键
 * ===================================================================== */
let palItems = [], palIndex = 0
function commands() {
  const list = [
    ...Object.entries(views).map(([id, v]) => ({ label: `前往 · ${v.title}`, hint: v.section, icon: { overview: 'radar', science: 'flask', providers: 'layers', artifacts: 'file', agents: 'nodes', fleet: 'cpu' }[id], run: () => go(id) })),
    { label: '发起实验运行', hint: '科学执行', icon: 'flask', run: openScienceRun },
    { label: '启动多智能体编排', hint: '多智能体', icon: 'play', run: openAgentRun },
    { label: '创建科学项目', hint: '科学执行', icon: 'plus', run: openProject },
    { label: '刷新全部数据', hint: 'Ctrl R', icon: 'refresh', run: () => $('#refresh').click() },
  ]
  for (const p of state.sci?.projects || []) list.push({ label: `切换项目 · ${p.id}`, hint: '科学项目', icon: 'layers', run: () => { state.project = p.id; closeDrawer(); loadScience(true).then(() => go(['science', 'providers', 'artifacts'].includes(state.view) ? state.view : 'science', { quiet: true })) } })
  for (const r of state.runs.slice(0, 20)) list.push({ label: `打开运行 · ${r.goal || r.id}`, hint: r.id, icon: 'nodes', run: () => { state.openId = r.id; state.view === 'agents' ? openRun(r.id) : go('agents') } })
  for (const o of (state.sci?.operations || []).slice(-20)) list.push({ label: `查看实验 · ${o.requestKey}`, hint: o.providerId, icon: 'flask', run: () => { if (state.view !== 'science') go('science'); openOp(o.id) } })
  return list
}
function openPalette() {
  $('#palette').hidden = false
  $('#palette-q').value = ''
  renderPalette()
  $('#palette-q').focus()
}
const closePalette = () => { $('#palette').hidden = true }
function renderPalette() {
  const q = $('#palette-q').value.trim().toLowerCase()
  palItems = commands().filter((c) => !q || (c.label + ' ' + c.hint).toLowerCase().includes(q)).slice(0, 40)
  palIndex = Math.min(palIndex, Math.max(0, palItems.length - 1))
  $('#palette-list').innerHTML = palItems.length
    ? palItems.map((c, i) => `<div class="pal-item ${i === palIndex ? 'on' : ''}" data-i="${i}" role="option">${icon(c.icon)}<span>${esc(c.label)}</span><small>${esc(c.hint)}</small></div>`).join('')
    : '<div class="empty">没有匹配的命令</div>'
  $$('.pal-item').forEach((el) => {
    el.onclick = () => { closePalette(); palItems[el.dataset.i].run() }
    el.onmousemove = () => { if (palIndex !== +el.dataset.i) { palIndex = +el.dataset.i; $$('.pal-item').forEach((x, j) => x.classList.toggle('on', j === palIndex)) } }
  })
  $('.pal-item.on')?.scrollIntoView({ block: 'nearest' })
}
$('#palette-open').onclick = openPalette
$('#palette-q').oninput = () => { palIndex = 0; renderPalette() }
$('#palette-q').onkeydown = (e) => {
  if (e.key === 'ArrowDown') { e.preventDefault(); palIndex = Math.min(palItems.length - 1, palIndex + 1); renderPalette() }
  else if (e.key === 'ArrowUp') { e.preventDefault(); palIndex = Math.max(0, palIndex - 1); renderPalette() }
  else if (e.key === 'Enter' && palItems[palIndex]) { closePalette(); palItems[palIndex].run() }
}
$('#palette').onclick = (e) => { if (e.target.id === 'palette') closePalette() }
addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); $('#palette').hidden ? openPalette() : closePalette(); return }
  if (e.key === 'Escape') { if (!$('#palette').hidden) closePalette(); else if ($('#drawer').classList.contains('on')) closeDrawer(); return }
  const typing = /INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName) || document.querySelector('dialog[open]')
  if (typing || e.ctrlKey || e.metaKey || e.altKey) return
  const order = ['overview', 'science', 'providers', 'artifacts', 'agents', 'fleet']
  if (/^[1-6]$/.test(e.key)) go(order[Number(e.key) - 1])
})
$$('[data-dismiss]').forEach((b) => (b.onclick = () => b.closest('dialog').close()))

/* ---------- 时钟 + 启动 ---------- */
setInterval(() => { $('#clock').textContent = new Date().toLocaleTimeString('zh-CN', { hour12: false }) }, 1000)
let timers = []
function boot() {
  timers.forEach(clearInterval)
  renderProjects()
  let initial = 'overview'
  try { initial = sessionStorage.getItem('mission-control-view') || 'overview' } catch {}
  go(initial)
  loadScience(true); loadRuns(true); loadHealth()
  timers = [
    setInterval(() => { if (!document.hidden) loadScience() }, 2000),
    setInterval(() => { if (!document.hidden) loadRuns() }, 4000),
    setInterval(() => { if (!document.hidden) loadHealth() }, 15000),
  ]
}
if (await connect()) boot()
