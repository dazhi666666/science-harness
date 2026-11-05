/* Mission Control 前端：一个页面融合 AI4Science 科学执行（/science）与 Agent Router 多智能体编排（/router）。 */
import { countUp, sparkline, Constellation, reduced } from '/fx.js'
import { t, lang, locale, setLang, applyStatic } from '/i18n.js'

const $ = (s, root = document) => root.querySelector(s)
const $$ = (s, root = document) => [...root.querySelectorAll(s)]
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
const num = (v) => new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(v)
const compact = (v) => new Intl.NumberFormat(locale, { notation: 'compact', maximumFractionDigits: 1 }).format(v)
const when = (v) => (v ? new Date(v).toLocaleString(locale, { hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '')
const ago = (v) => {
  const s = Math.max(0, (Date.now() - new Date(v).getTime()) / 1000)
  return s < 60 ? t('{s} 秒前', { s: Math.round(s) }) : s < 3600 ? t('{m} 分钟前', { m: Math.round(s / 60) }) : s < 86400 ? t('{h} 小时前', { h: Math.round(s / 3600) }) : when(v)
}

/* ---------- 语言 ---------- */
applyStatic()
document.title = t('任务控制中心 · science-harness')
$('.logo-text').innerHTML = lang === 'en' ? '<b>MISSION</b><span>CONTROL</span>' : '<b>Mission Control</b><span>任务控制中心</span>'
$('#lang').textContent = lang === 'en' ? '中文' : 'EN'
$('#lang').onclick = () => setLang(lang === 'en' ? 'zh' : 'en')
/* ---------- 主题：亮色为默认，暗色为科技风；切换不刷新页面 ---------- */
const THEME_KEY = 'mission-control-theme'
function setTheme(next) {
  document.documentElement.dataset.theme = next
  try { localStorage.setItem(THEME_KEY, next) } catch {}
  paintTheme()
}
function paintTheme() {
  const dark = document.documentElement.dataset.theme === 'dark'
  $('#theme').innerHTML = icon(dark ? 'sun' : 'moon')
  $('#theme').title = $('#theme').ariaLabel = t(dark ? '切换到亮色' : '切换到暗色')
}
$('#theme').onclick = () => setTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark')
$('#lock-hint').innerHTML = esc(t('请打开 dsh 启动时打印的 {code} 链接，或在下方粘贴令牌。')).replace('{code}', '<code>Mission Control: http://127.0.0.1:…/#token</code>')

/* ---------- 图标 ---------- */
const ICONS = {
  radar: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><path d="M12 12 19 5"/><circle cx="12" cy="12" r="1"/>',
  flask: '<path d="M9 3h6M10 3v7l-6 9q-1 2 2 2h12q3 0 2-2l-6-9V3M8 14h8"/>',
  layers: '<path d="m12 3 10 6-10 6L2 9Z"/><path d="m3 14 9 5 9-5"/>',
  file: '<path d="M14 2H5v20h14V7Z"/><path d="M14 2v6h5M8 13h8M8 17h6"/>',
  nodes: '<circle cx="12" cy="5" r="2.5"/><circle cx="5" cy="19" r="2.5"/><circle cx="19" cy="19" r="2.5"/><path d="M12 7.5v4M12 11.5 6.5 17M12 11.5l5.5 5.5"/>',
  cpu: '<rect x="6" y="6" width="12" height="12" rx="2"/><path d="M9 2v4M15 2v4M9 18v4M15 18v4M2 9h4M2 15h4M18 9h4M18 15h4"/><rect x="9.5" y="9.5" width="5" height="5"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  moon: '<path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5Z"/>',
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
paintTheme()

/* ---------- 常量 ---------- */
const MEMBERS = {
  claude: { label: 'Claude', c1: '#f59e6b', c2: '#d9663a', mode: 'stream-json 常驻主线程（事件即时注入）' },
  zcode: { label: 'ZCode', c1: '#38e1ff', c2: '#2563eb', mode: '回合串联（每条消息一次 headless 运行续链）' },
  'zcode-oss': { label: 'ZCode OSS', c1: '#22d3ee', c2: '#0e7490', mode: '回合串联（开源 ZCode CLI）' },
  devin: { label: 'Devin', c1: '#34d399', c2: '#047857', mode: 'ACP 常驻（需已 devin auth login）' },
  codex: { label: 'Codex', c1: '#e5e7eb', c2: '#3f3e3a', mode: '回合串联（OpenAI Codex CLI）' },
  opencode: { label: 'OpenCode', c1: '#fbbf24', c2: '#b45309', mode: '回合串联（SST OpenCode CLI）' },
  antigravity: { label: 'Antigravity', c1: '#60a5fa', c2: '#7c3aed', mode: 'stream-json 常驻（Google Antigravity CLI）' },
  dsh: { label: 'DSH', c1: '#9b6bff', c2: '#7a3f6a', mode: '回合串联（science-harness，headless profile）' },
}
const memberLabel = (id) => MEMBERS[id]?.label || id || 'Claude'
const OP_STATE = { registered: '已登记', dispatching: '派发中', accepted: '已接受', running: '运行中', succeeded: '已完成', failed: '失败', cancelled: '已取消', unknown: '未知' }
const opState = (s) => (s in OP_STATE ? t(OP_STATE[s]) : s)
const opActive = (o) => ['registered', 'dispatching', 'accepted', 'running'].includes(o.state)
const opBadge = (s) => `<span class="status ${esc(s in OP_STATE ? s : 'unknown')}">${esc(opState(s))}</span>`
const runBadge = (r) => (r.live ? `<span class="status live">${t('进行中')}</span>` : `<span class="status ${r.status === 'failed' ? 'failed' : 'finished'}">${t(r.status === 'failed' ? '失败' : '已结束')}</span>`)
const ledBy = (r) => t('{main} 主导 · {done}/{total} 任务', { main: memberLabel(r.settings?.main), done: r.summary.done, total: r.summary.total })

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
  if (r.status === 401) { lock(true); throw new Locked(t('需要启动链接')) }
  const body = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(body.error || t('请求失败（{n}）', { n: r.status }))
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
  if (await connect()) { toast(t('链路已建立')); boot() }
  else toast(t('令牌无效'), true)
}
function paintLinks() {
  $$('[data-link]').forEach((el) => { el.className = 'link-dot ' + (state.link[el.dataset.link] ? 'on' : 'off') })
  const both = state.link.science && state.link.router
  $('.rail-foot .pulse').className = 'pulse ' + (both ? 'ok' : state.link.science || state.link.router ? '' : 'bad')
  $('#uplink-text').textContent = t(both ? '双链路在线' : state.link.router ? '编排在线 · 科学离线' : state.link.science ? '科学在线 · 编排离线' : '链路离线')
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
const refresh = (kind) => { paintBusy(); views[state.view]?.update?.(kind) }
/** 任一侧有运行中的工作时，顶栏出现流动的光带。 */
function paintBusy() {
  const busy = state.runs.some((r) => r.live) || (state.sci?.operations || []).some(opActive)
  document.body.classList.toggle('busy', busy)
}

/* ---------- 路由 / 视图切换 ---------- */
const views = {}
const SCIENCE_VIEWS = ['science', 'providers', 'artifacts']
function go(view, { quiet = false } = {}) {
  if (!views[view]) view = 'overview'
  const leaving = state.view
  state.view = view
  if (leaving === 'agents' && view !== 'agents') disconnectSse()
  $$('.nav-item').forEach((b) => b.classList.toggle('active', b.dataset.view === view))
  moveIndicator()
  $('#crumb-a').textContent = t(views[view].section)
  $('#crumb-b').textContent = t(views[view].title)
  $('#primary-action span:last-child').textContent = t(SCIENCE_VIEWS.includes(view) ? '新建实验' : '新建编排')
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
$('#primary-action').onclick = () => (SCIENCE_VIEWS.includes(state.view) ? openScienceRun() : openAgentRun())

/* ---------- 侧栏项目 ---------- */
function switchProject(id) {
  state.project = id
  state.sciFilter = 'all'; state.sciSearch = ''
  closeDrawer()
  loadScience(true).then(() => go(SCIENCE_VIEWS.includes(state.view) ? state.view : 'science', { quiet: SCIENCE_VIEWS.includes(state.view) }))
}
function renderProjects() {
  const box = $('#project-list'), d = state.sci
  const hint = (text) => `<div class="muted" style="padding:6px 12px;font-size:12px">${esc(text)}</div>`
  if (!d) { box.innerHTML = hint(t(state.link.science ? '加载中…' : '科学引擎离线')); return }
  box.innerHTML = d.projects.length
    ? d.projects.map((p) => `<button class="project-item ${p.id === state.project ? 'selected' : ''}" data-project="${esc(p.id)}">${esc(p.id)}</button>`).join('')
    : hint(t('还没有项目'))
  $$('[data-project]', box).forEach((b) => (b.onclick = () => switchProject(b.dataset.project)))
}
$('#add-project').onclick = () => openProject()

/* =====================================================================
 * 总览
 * ===================================================================== */
let constellation = null
let typerTimer = 0
views.overview = {
  section: '任务控制中心',
  title: '总览',
  mount(stage) {
    stage.innerHTML = `
      <section class="hero">
        <div><div class="eyebrow">${t('科学 × 智能体 · 实时')}</div>
          <h1>${t('欢迎回到')} <span class="grad">Mission Control</span></h1>
          <p id="typer"></p></div>
        <div class="hero-links" id="hero-links"></div>
      </section>
      <div class="kpis" id="kpis">${[
        ['k-active', '进行中实验', 'play', 'var(--blue)', '科学'],
        ['k-done', '已完成实验', 'check', 'var(--green)', '科学'],
        ['k-artifacts', '研究产物', 'file', 'var(--violet)', '科学'],
        ['k-runs', '编排运行数', 'nodes', 'var(--accent)', '智能体'],
        ['k-members', '在线成员', 'users', 'var(--accent)', '智能体'],
        ['k-tasks', '任务完成', 'bolt', 'var(--amber)', '智能体'],
      ].map(([id, label, ic, c, tag]) => `<div class="kpi" style="--c:${c}" id="${id}"><div class="kpi-top"><span>${t(label)}</span><span class="kpi-icon">${icon(ic)}</span></div><div class="kpi-value">–</div><div class="kpi-note">&nbsp;</div><div class="kpi-spark"></div><span class="kpi-tag">${t(tag)}</span></div>`).join('')}</div>
      <div class="ov-grid">
        <section class="card constellation"><div class="card-head"><span class="card-title">${t('融合星座')}</span><span class="card-sub">${t('内环 · 智能体成员　外环 · 科学 Provider')}</span><span class="spacer"></span><span id="constel-live" class="status idle">${t('待命')}</span></div>
          <canvas id="constel"></canvas>
          <div class="legend"><span><i class="lg-ok"></i>${t('在线成员')}</span><span><i class="lg-off"></i>${t('未就绪')}</span><span><i class="lg-prov"></i>Provider</span><span>${t('流光 = 正在派发')}</span></div></section>
        <div class="side-col">
          <section class="card"><div class="card-head"><span class="card-title">${t('项目预算')}</span><span class="spacer"></span><span class="tag" id="budget-proj">—</span></div><div class="budget" id="budget"></div></section>
          <section class="card"><div class="card-head"><span class="card-title">${t('实时脉搏')}</span><span class="card-sub">${t('实验 + 编排统一时间线')}</span><span class="spacer"></span><span class="count" id="feed-count">0</span></div><div class="feed stagger" id="feed"></div></section>
        </div>
      </div>
      <div class="ov-grid even">
        <section class="card"><div class="card-head">${icon('flask')}<span class="card-title">${t('最近实验')}</span><span class="spacer"></span><button class="btn small ghost" data-jump="science">${t('全部')} ${icon('arrow')}</button></div><div id="recent-ops"></div></section>
        <section class="card"><div class="card-head">${icon('nodes')}<span class="card-title">${t('最近编排')}</span><span class="spacer"></span><button class="btn small ghost" data-jump="agents">${t('全部')} ${icon('arrow')}</button></div><div id="recent-runs"></div></section>
      </div>`
    $$('[data-jump]', stage).forEach((b) => (b.onclick = () => go(b.dataset.jump)))
    constellation = new Constellation($('#constel'), constellationModel())
    typer($('#typer'), [t('科学执行与多智能体编排，汇于一屏。'), t('每一次运行都有身份，每一份产物都可溯源。'), t('主代理派发、成员协作、实验落盘 —— 实时可见。')])
  },
  update() {
    if (!$('#kpis')) return
    const d = state.sci, ops = d?.operations ?? []
    const active = ops.filter(opActive).length, done = ops.filter((o) => o.state === 'succeeded').length
    const runs = state.runs, live = runs.filter((r) => r.live).length
    const members = Object.keys(MEMBERS), online = members.filter((m) => state.health?.[m]).length
    const tTotal = runs.reduce((a, r) => a + (r.summary?.total || 0), 0), tDone = runs.reduce((a, r) => a + (r.summary?.done || 0), 0)
    kpi('k-active', active, state.link.science ? t('{n} 条执行记录', { n: ops.length }) : t('科学引擎离线'), track('active', active), 'var(--blue)')
    kpi('k-done', done, ops.length ? t('成功率 {p}%', { p: Math.round((done / ops.length) * 100) }) : t('等待第一次运行'), track('done', done), 'var(--green)')
    kpi('k-artifacts', d?.artifacts.length ?? 0, t('带来源与哈希的产物'), track('art', d?.artifacts.length ?? 0), 'var(--violet)')
    kpi('k-runs', runs.length, live ? t('{n} 个正在进行', { n: live }) : t('当前空闲'), track('runs', live), 'var(--accent)')
    kpi('k-members', online, t('共 {n} 名可调度成员', { n: members.length }), track('online', online), 'var(--accent)', (v) => `${Math.round(v)}/${members.length}`)
    $('#k-active').classList.toggle('busy', active > 0)
    $('#k-runs').classList.toggle('busy', live > 0)
    kpi('k-tasks', tDone, tTotal ? t('{n} 个任务 · {p}%', { n: tTotal, p: Math.round((tDone / tTotal) * 100) }) : t('暂无任务'), track('tasks', tDone), 'var(--amber)')

    $('#hero-links').innerHTML = `
      <span class="link-pill"><i class="link-dot ${state.link.science ? 'on' : 'off'}"></i>${t('科学引擎')} <b>${state.link.science ? esc(d?.baseline?.slice(0, 7) || t('在线')) : t('离线')}</b></span>
      <span class="link-pill"><i class="link-dot ${state.link.router ? 'on' : 'off'}"></i>Agent Router <b>${state.link.router ? (live ? t('{n} 运行中', { n: live }) : t('待命')) : t('离线')}</b></span>`
    const liveEl = $('#constel-live')
    liveEl.className = 'status ' + (live || active ? 'live' : 'idle')
    liveEl.textContent = live || active ? t('派发中 · {n}', { n: live + active }) : t('待命')
    constellation?.set(constellationModel())

    // 预算
    const p = d?.projects.find((x) => x.id === state.project)
    $('#budget-proj').textContent = p?.id ?? '—'
    if (p) {
      const pct = p.budgetLimit ? Math.min(100, (p.budgetUsed / p.budgetLimit) * 100) : 0, C = 2 * Math.PI * 48
      const box = $('#budget')
      if (!box.querySelector('.ring')) box.innerHTML = `<svg class="ring" viewBox="0 0 112 112"><circle class="track" cx="56" cy="56" r="48"/><circle class="bar" cx="56" cy="56" r="48" stroke-dasharray="${C}" stroke-dashoffset="${C}"/></svg><div><div class="budget-num"><span id="b-used">0</span> <small>/ ${num(p.budgetLimit)} ${t('单位')}</small></div><div class="muted" id="b-pct"></div><div class="kpi-note">${t('预留在完成或取消后仍计入。')}</div></div>`
      requestAnimationFrame(() => { $('.ring .bar', box).style.strokeDashoffset = String(C * (1 - pct / 100)) })
      countUp($('#b-used'), p.budgetUsed, num)
      $('#b-pct').textContent = t('已预留 {p}% · 剩余 {r}', { p: pct.toFixed(0), r: compact(Math.max(0, p.budgetLimit - p.budgetUsed)) })
    } else $('#budget').innerHTML = `<div class="muted">${state.link.science ? t('选择或创建一个科学项目') : esc(state.link.scienceError || t('科学引擎离线'))}</div>`

    // 统一时间线
    const items = [
      ...ops.map((o) => ({ t: o.updatedAt || o.createdAt, kind: 'sci', title: o.requestKey, meta: `${o.providerId} · ${opState(o.state)}`, badge: opBadge(o.state), go: () => { go('science'); openOp(o.id) } })),
      ...runs.map((r) => ({ t: r.mtime, kind: 'agent', title: r.goal || r.id, meta: ledBy(r), badge: runBadge(r), go: () => { state.openId = r.id; go('agents') } })),
    ].filter((x) => x.t).sort((a, b) => new Date(b.t) - new Date(a.t)).slice(0, 14)
    $('#feed-count').textContent = items.length
    const feed = $('#feed')
    feed.innerHTML = items.length
      ? items.map((x, i) => `<div class="feed-item" style="--i:${i}" data-i="${i}"><span class="feed-icon ${x.kind}">${icon(x.kind === 'sci' ? 'flask' : 'nodes')}</span><div class="feed-main"><div class="feed-title">${esc(x.title)}</div><div class="feed-meta">${esc(x.meta)} · ${ago(x.t)}</div></div>${x.badge}</div>`).join('')
      : `<div class="empty"><div class="glyph">${icon('radar')}</div><p>${t('还没有活动。发起一次实验或编排运行吧。')}</p></div>`
    $$('.feed-item', feed).forEach((el) => (el.onclick = () => items[el.dataset.i].go()))

    $('#recent-ops').innerHTML = !state.link.science
      ? `<div class="empty"><div class="glyph">${icon('flask')}</div><p>${esc(state.link.scienceError || t('科学引擎离线'))}</p></div>`
      : ops.length
        ? `<table><tbody>${ops.toReversed().slice(0, 5).map((o) => `<tr data-op="${esc(o.id)}"><td><div class="run-label">${esc(o.requestKey)}</div><div class="run-id">${esc(o.providerId)} · ${esc(o.id.slice(0, 8))}</div>${opActive(o) ? '<div class="progress-line"><i></i></div>' : ''}</td><td>${opBadge(o.state)}</td></tr>`).join('')}</tbody></table>`
        : `<div class="empty"><div class="glyph">${icon('flask')}</div><p>${t(state.project ? '这个项目还没有运行。' : '先创建一个科学项目。')}</p><button class="btn small primary" id="ov-new-sci">${t(state.project ? '发起实验' : '创建项目')}</button></div>`
    $$('[data-op]', $('#recent-ops')).forEach((tr) => (tr.onclick = () => { go('science'); openOp(tr.dataset.op) }))
    if ($('#ov-new-sci')) $('#ov-new-sci').onclick = () => (state.project ? openScienceRun() : openProject())

    $('#recent-runs').innerHTML = !state.link.router
      ? `<div class="empty"><div class="glyph">${icon('nodes')}</div><p>${t('Agent Router 未挂载')}</p></div>`
      : runs.length
        ? `<table><tbody>${runs.slice(0, 5).map((r) => `<tr data-run="${esc(r.id)}"><td><div class="run-label">${esc(r.goal || r.id)}</div><div class="run-id">${esc(ledBy(r))}</div>${r.live ? '<div class="progress-line"><i></i></div>' : ''}</td><td>${runBadge(r)}</td></tr>`).join('')}</tbody></table>`
        : `<div class="empty"><div class="glyph">${icon('nodes')}</div><p>${t('还没有编排运行。')}</p><button class="btn small primary" id="ov-new-run">${t('启动编排')}</button></div>`
    $$('[data-run]', $('#recent-runs')).forEach((tr) => (tr.onclick = () => { state.openId = tr.dataset.run; go('agents') }))
    if ($('#ov-new-run')) $('#ov-new-run').onclick = openAgentRun
  },
}
function kpi(id, value, note, hist, color = 'var(--accent)', format) {
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
  let i = 0
  el.textContent = lines[0]
  if (reduced) return
  el.style.transition = 'opacity .5s'
  const tick = () => {
    if (!el.isConnected) return
    el.style.opacity = '0'
    typerTimer = setTimeout(() => {
      i = (i + 1) % lines.length
      el.textContent = lines[i]
      el.style.opacity = '1'
      typerTimer = setTimeout(tick, 6000)
    }, 500)
  }
  typerTimer = setTimeout(tick, 6000)
}

/* =====================================================================
 * 科学执行：实验运行 / Provider / 产物
 * ===================================================================== */
function scienceGate(stage) {
  if (!state.link.science || (state.sci && !state.project)) delete stage.dataset.ready
  if (!state.link.science) {
    stage.innerHTML = `<section class="card"><div class="empty"><div class="glyph">${icon('flask')}</div><h3>${t('科学引擎离线')}</h3><p>${esc(state.link.scienceError || t('未挂载 AI4Science 平台。'))}</p><p class="muted">${esc(t('在补丁中设置 {code} 指向平台 JSON 配置后重启。')).replace('{code}', '<code>scienceConfig</code>')}</p></div></section>`
    return false
  }
  if (state.sci && !state.project) {
    stage.innerHTML = `<section class="card"><div class="empty"><div class="glyph">${icon('layers')}</div><h3>${t('工作区从这里开始')}</h3><p>${t('创建一个已配置的项目，连接它的 Provider，第一份结果就会出现在这里。')}</p><button class="btn primary" id="first-project">${t('创建项目')}</button></div></section>`
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
    if (!d) { root.innerHTML = `<div class="empty">${t('连接科学引擎…')}</div>`; return }
    const ops = d.operations
    const visible = ops.filter((o) => (state.sciFilter === 'all' || (state.sciFilter === 'active' && opActive(o)) || (state.sciFilter === 'completed' && o.state === 'succeeded') || (state.sciFilter === 'attention' && ['unknown', 'failed'].includes(o.state))) && [o.requestKey, o.providerId, o.id].some((v) => v.toLowerCase().includes(state.sciSearch.toLowerCase()))).toReversed()
    const first = !root.dataset.ready
    if (first) {
      root.dataset.ready = '1'
      root.innerHTML = `
        <section class="hero"><div><div class="eyebrow">${esc(t('科学 · {p}', { p: state.project }))}</div><h1>${t('实验')}<span class="grad">${t('执行台')}</span></h1><p>${t('每一次运行都有清晰的状态与持久身份。')}</p></div>
          <div class="hero-links"><button class="btn" id="reconcile">${icon('refresh')} ${t('对账')}</button><button class="btn primary" id="sci-new">${icon('plus')} ${t('发起实验')}</button></div></section>
        ${d.monitorError ? `<div class="notice">${esc(t('监控需要关注：{e}', { e: d.monitorError }))}</div>` : ''}
        <section class="card"><div class="toolbar"><div class="filters">${[['all', '全部'], ['active', '进行中'], ['completed', '已完成'], ['attention', '需关注']].map(([k, l]) => `<button class="chip-btn ${state.sciFilter === k ? 'active' : ''}" data-filter="${k}">${t(l)}</button>`).join('')}</div><div class="search">${icon('search')}<input id="sci-search" placeholder="${t('查找运行…')}" value="${esc(state.sciSearch)}"></div></div>
          <div class="table-wrap" id="ops-table"></div><div class="kpi-note" id="ops-foot" style="margin-top:8px"></div></section>`
      $$('[data-filter]', root).forEach((b) => (b.onclick = () => { state.sciFilter = b.dataset.filter; $$('[data-filter]', root).forEach((x) => x.classList.toggle('active', x === b)); views.science.update('sci') }))
      $('#sci-search').oninput = (e) => { state.sciSearch = e.target.value; views.science.update('sci') }
      $('#reconcile').onclick = async () => { try { await sciAction({ action: 'reconcile', project: state.project }); toast(t('对账完成，请复核观测状态。')); loadScience(true) } catch (e) { toast(e.message, true) } }
      $('#sci-new').onclick = openScienceRun
      $('#sci-new').disabled = !d.providers.length
    }
    $('#ops-table').innerHTML = visible.length
      ? `<table><thead><tr><th>${t('运行')}</th><th>${t('状态')}</th><th>${t('创建时间')}</th><th></th></tr></thead><tbody class="${first ? 'stagger' : ''}">${visible.map((o, i) => `<tr data-op="${esc(o.id)}" style="--i:${i}" tabindex="0"><td><div class="run-label">${esc(o.requestKey)}</div><div class="run-id">${esc(o.providerId)} · ${esc(o.id.slice(0, 8))}</div>${opActive(o) ? '<div class="progress-line"><i></i></div>' : ''}</td><td>${opBadge(o.state)}</td><td class="mono">${when(o.createdAt)}</td><td style="color:var(--dim)">${icon('arrow')}</td></tr>`).join('')}</tbody></table>`
      : `<div class="empty"><div class="glyph">${icon('flask')}</div><h3>${t(ops.length ? '没有匹配的运行' : '准备好第一次运行')}</h3><p>${t(ops.length ? '换个筛选或关键词试试。' : '选择 Provider 并提交第一次操作，结果会出现在这里。')}</p></div>`
    $('#ops-foot').textContent = t('显示 {a} / {b} 条 · 自动刷新', { a: visible.length, b: ops.length })
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
    root.innerHTML = `<section class="hero"><div><div class="eyebrow">${t('能力')}</div><h1>${t('执行 ')}<span class="grad">Provider</span></h1><p>${t('当前项目可用的能力、取消语义与输入约束。')}</p></div></section>
      <div class="provider-grid stagger">${ps.map((p, i) => `<section class="card tilt provider-card" style="--i:${i}"><div class="glyph-box">${icon('layers')}</div><h3>${esc(p.id)}</h3><span class="tag">v${esc(p.version)}</span><p>${esc(p.completion)}</p><details><summary>${t('取消行为')}</summary><p class="muted">${esc(p.cancellation)}</p></details><details><summary>${t('约束与单位')}</summary><pre>${esc(JSON.stringify({ constraints: p.constraints, units: p.units }, null, 2))}</pre></details><details><summary>${t('输入 Schema')}</summary><pre>${esc(JSON.stringify(p.inputSchema, null, 2))}</pre></details></section>`).join('') || `<div class="empty">${t('没有已注册的 Provider')}</div>`}</div>`
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
    root.innerHTML = `<section class="hero"><div><div class="eyebrow">${t('证据')}</div><h1>${t('研究')}<span class="grad">${t('产物')}</span></h1><p>${t('经来源与内容完整性校验的输出。')}</p></div><div class="hero-links"><span class="link-pill">${icon('file')} ${t('{n} 份', { n: `<b>${arts.length}</b>` })}</span></div></section>
      ${arts.length ? `<div class="artifact-list ${first ? 'stagger' : ''}">${arts.map((a, i) => artifactRow(a, i)).join('')}</div>` : `<section class="card"><div class="empty"><div class="glyph">${icon('file')}</div><h3>${t('证据会出现在这里')}</h3><p>${t('完成的操作会带着来源与内容哈希发布产物。')}</p></div></section>`}`
    bindArtifacts(root)
  },
}
function artifactRow(a, i = 0) {
  const name = a.path.split(/[\\/]/).at(-1)
  return `<div class="card artifact-row" style="--i:${i}"><div class="glyph-box">${icon('file')}</div><div style="min-width:0"><div class="artifact-name">${esc(name)}</div><div class="artifact-meta">${esc(a.requestKey ?? '')}${a.requestKey ? ' · ' : ''}${num(a.bytes)} B · ${esc(a.mediaType ?? '')}${a.sha256 ? ' · ' + esc(a.sha256.slice(0, 12)) + '…' : ''}</div></div><div class="row-actions"><button class="btn small" data-preview="${esc(a.id)}">${t('预览')}</button><button class="icon-btn" data-download="${esc(a.id)}" data-name="${esc(name)}" aria-label="${t('下载')}">${icon('download')}</button></div></div>`
}
function bindArtifacts(root) {
  $$('[data-preview]', root).forEach((b) => (b.onclick = async () => {
    try {
      const r = await sci(`/api/artifact?project=${encodeURIComponent(state.project)}&id=${encodeURIComponent(b.dataset.preview)}`)
      $('#artifact-title').textContent = r.artifact.path.split(/[\\/]/).at(-1)
      $('#artifact-content').textContent = r.encoding === 'base64' ? t('二进制产物，请下载后查看。') : r.content
      $('#dlg-artifact').showModal()
    } catch (e) { toast(e.message, true) }
  }))
  $$('[data-download]', root).forEach((b) => (b.onclick = () => {
    const a = document.createElement('a')
    a.href = `/science/api/artifact?project=${encodeURIComponent(state.project)}&id=${encodeURIComponent(b.dataset.download)}&download=1`
    a.download = b.dataset.name || 'artifact'
    document.body.append(a); a.click(); a.remove()
    toast(t('已请求下载，服务端会先校验产物再发送。'))
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
    <div class="kv"><div><label>${t('状态')}</label>${opBadge(op.state)}</div><div><label>Provider</label>${esc(op.providerId)} · v${esc(op.providerVersion)}</div><div><label>${t('操作 ID')}</label><span class="mono">${esc(op.id)}</span></div><div><label>${t('预算预留')}</label>${num(op.budget)}</div><div><label>${t('资源')}</label>${esc(op.resources.join(', '))}</div><div><label>${t('创建')}</label>${when(op.createdAt)}</div></div>
    ${opActive(op) ? '<div class="progress-line" style="margin-bottom:14px"><i></i></div>' : ''}
    ${op.cancelRequested ? `<div class="notice">${t(op.state === 'cancelled' ? '已确认取消，部分结果仍可查看。' : ended ? '执行已结束，观测到的结果已保留。' : '已请求取消，尚未确认执行停止。')}</div>` : ''}
    ${op.detail ? `<p class="muted">${esc(op.detail)}</p>` : ''}
    <div class="block-title">${t('实际输入')}</div><pre>${esc(JSON.stringify(op.input, null, 2))}</pre>
    ${op.progress ? `<div class="block-title">${t('观测进度')}</div><pre>${esc(JSON.stringify(op.progress, null, 2))}</pre>` : ''}
    <div class="block-title">${t('产物')}</div>${op.artifacts.length ? `<div class="artifact-list">${op.artifacts.map((a) => artifactRow(a)).join('')}</div>` : `<p class="muted">${t('还没有发布产物。')}</p>`}
    <div class="drawer-actions"><button class="btn" id="op-query">${icon('refresh')} ${t('查询 Provider')}</button>${ended ? '' : `<button class="btn danger" id="op-cancel">${icon('stop')} ${t('请求取消')}</button>`}</div>`
  $('#op-query').onclick = async () => { try { await sciAction({ action: 'query', project: state.project, operationId: op.id }); loadScience(true) } catch (e) { toast(e.message, true) } }
  if ($('#op-cancel')) $('#op-cancel').onclick = async () => {
    try {
      const r = await sciAction({ action: 'cancel', project: state.project, operationId: op.id })
      toast(r.cancelRequested ? t('取消请求已记录，观测状态：{s}', { s: opState(r.state) }) : t('操作已{s}，无需取消。', { s: opState(r.state) }))
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
  if (!state.sci) return toast(t(state.link.science ? '请先连接科学引擎。' : '科学引擎离线'), true)
  const remaining = state.sci.allowedProjects.filter((id) => !state.sci.projects.some((p) => p.id === id))
  if (!remaining.length) return toast(t('所有已配置项目都已创建。请先在管理配置中添加新项目。'), true)
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
  if (!state.link.science) return toast(t('科学引擎离线'), true)
  if (!state.project) return openProject()
  if (!state.sci?.providers.length) return toast(t('当前项目没有可用 Provider'), true)
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
  toast(t('项目 {id} 已创建', { id }))
  await loadScience(true)
  if (SCIENCE_VIEWS.includes(state.view)) go(state.view, { quiet: true })
})
$('#form-science-run').onsubmit = (e) => submitForm(e, async () => {
  let input
  try { input = JSON.parse($('#run-input').value) } catch { throw new Error(t('输入不是合法 JSON')) }
  const r = await sciAction({ action: 'submit', project: state.project, providerId: $('#run-provider').value, requestKey: $('#request-key').value, input })
  toast(t('运行{s}', { s: opState(r.state) }))
  if (state.view !== 'science') go('science')
  await loadScience(true)
})

/* =====================================================================
 * 多智能体编排
 * ===================================================================== */
const CONSOLE_FILTERS = { manager: 'c-manager', event: 'c-event', mail: 'c-mail' }
views.agents = {
  section: '多智能体',
  title: '编排运行',
  mount(stage) {
    if (!state.link.router) {
      stage.innerHTML = `<section class="card"><div class="empty"><div class="glyph">${icon('nodes')}</div><h3>${t('Agent Router 未挂载')}</h3></div></section>`
      return
    }
    stage.innerHTML = `
      <div class="agents">
        <section class="card runs-col"><div class="card-head"><span class="card-title">${t('运行记录')}</span><span class="count" id="runs-count">0</span><span class="spacer"></span><button class="icon-btn" id="ag-new" title="${t('新建编排')}">${icon('plus')}</button></div><div class="run-list" id="run-list"></div></section>
        <div class="run-col" id="run-col">
          <section class="card run-head" id="run-head"><div class="empty" style="width:100%"><div class="glyph">${icon('nodes')}</div><h3>${t('选择一次运行')}</h3><p>${t('查看任务板、信箱与主代理的实时输出，或启动新的多智能体编排。')}</p><button class="btn primary" id="ag-new-2">${icon('play')} ${t('启动编排')}</button></div></section>
          <div id="finish"></div>
          <section class="card"><div class="card-head">${icon('bolt')}<span class="card-title">${t('任务板')}</span><span class="card-sub" id="task-summary"></span></div><div class="kanban" id="kanban">${lanes()}</div></section>
          <div class="split">
            <section class="card"><div class="card-head">${icon('mail')}<span class="card-title">${t('信箱')}</span><span class="count" id="msg-count">0</span></div><div class="mailbox" id="mailbox"><div class="empty">${t('暂无消息')}</div></div></section>
            <section class="card terminal" id="terminal"><div class="term-head"><span class="term-dots"><i></i><i></i><i></i></span><b>${t('控制台')}</b><span class="spacer"></span>${[['all', '全部'], ['manager', '主代理'], ['event', '事件'], ['mail', '信箱']].map(([k, l]) => `<button class="chip-btn ${state.consoleFilter === k ? 'active' : ''}" data-cf="${k}">${t(l)}</button>`).join('')}<button class="chip-btn" id="con-pause">${t(state.paused ? '恢复滚动' : '暂停滚动')}</button><button class="chip-btn" id="con-clear">${t('清屏')}</button></div>
              <div class="console" id="console"><div class="empty">${t('实时输出（SSE）')}</div></div>
              <div class="say-row"><input id="say" placeholder="${t('给主代理插话，回车发送（仅运行中可用）…')}" disabled /><button class="btn primary" id="say-send" disabled>${t('发送')}</button></div></section>
          </div>
        </div>
      </div>`
    $('#ag-new').onclick = openAgentRun
    $('#ag-new-2').onclick = openAgentRun
    $$('[data-cf]').forEach((b) => (b.onclick = () => { state.consoleFilter = b.dataset.cf; $$('[data-cf]').forEach((x) => x.classList.toggle('active', x === b)); applyConsoleFilter() }))
    $('#con-pause').onclick = (e) => { state.paused = !state.paused; e.target.textContent = t(state.paused ? '恢复滚动' : '暂停滚动') }
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
  return [['pending', '待执行', 'var(--amber)'], ['in_progress', '执行中', 'var(--blue)'], ['done', '已完成', 'var(--green)'], ['failed', '失败', 'var(--red)']]
    .map(([k, l, c]) => `<div class="lane" style="--c:${c}"><div class="lane-head"><i></i>${t(l)}<span class="count" data-lane-count="${k}">0</span></div><div class="lane-body" data-lane="${k}"></div></div>`).join('')
}
function renderRunList() {
  const box = $('#run-list')
  $('#runs-count').textContent = state.runs.length
  box.innerHTML = state.runs.length
    ? state.runs.map((r) => `<div class="run-item ${state.openId === r.id ? 'active' : ''} ${r.live ? 'live' : ''}" data-id="${esc(r.id)}"><div class="r-name">${r.live ? '<span class="live-dot"></span>' : ''}${esc(r.id)}</div>${r.goal ? `<div class="r-goal" title="${esc(r.goal)}">${esc(r.goal)}</div>` : ''}<div class="r-meta"><span class="chip who">${esc(t('主 {m}', { m: memberLabel(r.settings?.main) }))}</span><span class="chip">${t('{n} 任务', { n: r.summary.total })}</span><span class="chip" style="color:var(--green)">✔ ${r.summary.done}</span>${r.summary.failed ? `<span class="chip" style="color:var(--red)">✗ ${r.summary.failed}</span>` : ''}<span>${r.live ? t('进行中') : when(r.mtime)}</span></div></div>`).join('')
    : `<div class="empty"><p>${t('暂无运行记录')}</p></div>`
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
  } catch (e) { toast(t('加载运行失败：{e}', { e: e.message }), true) }
  $$('.run-item').forEach((el) => el.classList.toggle('active', el.dataset.id === id))
  updateSay()
}
function renderRunHead() {
  const d = state.run, head = $('#run-head')
  if (!d || !head) return
  const running = d.status === 'running', s = d.settings || {}
  head.innerHTML = `
    <div class="goal"><div class="eyebrow">${t('运行')} · ${esc(d.id)}</div><h2>${esc(d.goal || t('历史运行 · 目标未记录'))}</h2>
      <div class="run-chips">${running ? `<span class="status live">${t('执行中')}</span>` : `<span class="status finished">${t('历史 / 空闲')}</span>`}<span class="chip who">${esc(t('主代理 {m}', { m: memberLabel(s.main) }))}</span><span class="chip">${t(s.worktree ? 'worktree 隔离' : '直通模式')}</span>${(s.agents || []).map((a) => `<span class="chip">${esc(memberLabel(a))}</span>`).join('')}${s.repo ? `<span class="chip mono" title="${esc(s.repo)}">📁 ${esc(s.repo.split(/[\\/]/).slice(-2).join('/'))}</span>` : ''}</div></div>
    <div class="run-actions"><button class="btn" id="btn-threads">${icon('thread')} ${t('线程与日志')}</button><button class="btn danger" id="btn-stop" ${running ? '' : 'disabled'}>${icon('stop')} ${t('停止')}</button></div>
    <div class="agent-strip" id="agent-strip"></div>`
  $('#btn-threads').onclick = () => openLogModal()
  $('#btn-stop').onclick = async () => {
    if (!confirm(t('确认停止当前运行？'))) return
    try { await rt(`/api/runs/${encodeURIComponent(d.id)}/stop`, { method: 'POST' }); toast(t('已请求停止')) } catch (e) { toast(e.message, true) }
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
      appendConsole('\n' + t('[进程退出，code={c}]', { c: m.code }) + '\n', true)
      state.run.status = 'finished'
      renderAgentStrip(null); renderRunHead(); updateSay()
      toast(t('运行 {id} 已结束', { id }))
      loadHealth(); loadRuns(true)
    }
  }
}
async function loadConsoleRest(id, available) {
  const box = $('#console')
  if (!box) return
  if (!available) { box.innerHTML = `<div class="empty">${t('该运行由 CLI 启动，无控制台记录（任务板与会话日志仍可查看）')}</div>`; return }
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
// 控制台行分类依据 router 输出的固定中文标记，与界面语言无关
function lineCat(line) {
  line = String(line)
  if (line.includes('[manager]') || line.includes('[用户')) return 'c-manager'
  if (line.includes('[事件]')) return 'c-event'
  if (line.includes('[信箱]')) return 'c-mail'
  return 'c-other'
}
function applyConsoleFilter() {
  const cls = CONSOLE_FILTERS[state.consoleFilter]
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
  const cls = CONSOLE_FILTERS[state.consoleFilter]
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
  const main = memberLabel(state.run.settings?.main)
  el.innerHTML = `<span class="as-item"><span class="live-dot"></span><b>${esc(t('主代理（{m}）', { m: main }))}</b>${esc(map[s.session] ? t(map[s.session]) : s.session)}</span><span class="as-item">${t('回合')} <b>${s.turns ?? 0}</b></span>${s.cost ? `<span class="as-item">${t('花费')} <b>$${Number(s.cost).toFixed(4)}</b></span>` : ''}${s.currentTool ? `<span class="as-item">⚙ ${esc(s.currentTool)}</span>` : ''}${s.restarts ? `<span class="as-item">${t('续命 {n} 次', { n: s.restarts })}</span>` : ''}`
}
function updateSay() {
  const on = state.run?.status === 'running'
  $('#terminal')?.classList.toggle('live', on)
  if ($('#say')) { $('#say').disabled = !on; $('#say-send').disabled = !on }
}
async function sendSay() {
  const inp = $('#say'), text = inp.value.trim()
  if (!text || state.run?.status !== 'running') return
  $('#say-send').disabled = true
  try { await rt(`/api/runs/${encodeURIComponent(state.run.id)}/message`, { method: 'POST', body: JSON.stringify({ text }) }); inp.value = '' }
  catch (e) { appendConsole(t('[发送失败] {e}', { e: e.message }), true) }
  updateSay(); inp.focus()
}

/* 任务板（看板） + 信箱 */
const fmtDur = (sec) => (sec == null || isNaN(sec) ? '' : sec >= 60 ? t('{m}分{s}秒', { m: Math.floor(sec / 60), s: sec % 60 }) : t('{s}秒', { s: sec }))
const liveDur = (started) => Math.max(0, Math.round((Date.now() - new Date(started).getTime()) / 1000))
setInterval(() => $$('[data-started]').forEach((el) => (el.textContent = '⏱ ' + fmtDur(liveDur(el.dataset.started)))), 1000)
function renderBoard(board) {
  if (!$('#kanban')) return
  const tasks = board?.tasks ?? [], msgs = board?.messages ?? []
  const done = tasks.filter((x) => x.status === 'done').length, failed = tasks.filter((x) => x.status === 'failed').length
  $('#task-summary').textContent = tasks.length ? t('{d}/{t} 完成', { d: done, t: tasks.length }) + (failed ? t(' · {n} 失败', { n: failed }) : '') : ''
  const fin = board?.finished
  $('#finish').innerHTML = fin ? `<div class="finish"><div class="finish-title">${t('🏁 主代理结束总结')} <span class="mono">${esc((fin.at || '').slice(0, 19).replace('T', ' '))}</span></div><div class="finish-body">${esc(fin.summary || t('(无)'))}</div></div>` : ''
  const running = state.run?.status === 'running'
  const prev = new Map($$('.task').map((el) => [el.dataset.id, el.dataset.status]))
  for (const lane of ['pending', 'in_progress', 'done', 'failed']) {
    const list = tasks.filter((x) => (lane === 'pending' ? !['in_progress', 'done', 'failed'].includes(x.status) : x.status === lane))
    $(`[data-lane-count="${lane}"]`).textContent = list.length
    $(`[data-lane="${lane}"]`).innerHTML = list.map((x) => taskCard(x, running, prev.get(x.id) === x.status)).join('')
  }
  renderMailbox(msgs)
}
function taskCard(task, running, unchanged) {
  const logs = (state.run?.logs || []).filter((l) => l.name.startsWith(task.id + '-'))
  const threads = (state.threads || []).filter((x) => x.name.startsWith(task.id + '-'))
  const dur = task.started_at && task.updated_at ? Math.round((new Date(task.updated_at) - new Date(task.started_at)) / 1000) : null
  const links = []
  if (task.result) links.push(`<button data-res="${esc(task.id)}">${t('展开结果')}</button>`)
  for (const x of threads) links.push(`<button data-thread="${esc(x.name)}">${t('🧵 线程')}</button>`)
  for (const l of logs) links.push(`<button data-log="${esc(l.name)}">${esc(t('日志 {n}', { n: l.name.replace('.log', '') }))}</button>`)
  if (running && task.status === 'in_progress') links.push(`<button data-cancel="${esc(task.id)}">${t('✕ 取消')}</button>`)
  if (running && task.status === 'failed') links.push(`<button data-retry="${esc(task.id)}">${t('↻ 重试')}</button>`)
  return `<div class="task ${esc(task.status)}" data-id="${esc(task.id)}" data-status="${esc(task.status)}" ${unchanged ? 'style="animation:none"' : ''}>
    <div class="t-id">${esc(task.id)}</div><div class="t-title">${esc(task.title)}</div>
    <div class="t-meta"><span class="chip who">→ ${esc(memberLabel(task.assignee))}</span>${(task.blocked_by || []).map((b) => `<span class="chip warn">${esc(t('依赖 {b}', { b }))}</span>`).join('')}${task.isolated ? `<span class="chip" title="${t('独立 worktree 执行，完成后自动合并')}">${t('🔒 隔离')}</span>` : ''}${task.followup?.state === 'queued' ? `<span class="chip">${t('↻ 续派待执行')}</span>` : ''}${task.followup?.state === 'rejected' ? `<span class="chip warn" title="${esc(task.followup.reason || '')}">${t('↻ 续派被拒')}</span>` : ''}${task.continuations ? `<span class="chip">↻ ×${task.continuations}</span>` : ''}
      ${task.status === 'in_progress' && task.started_at ? `<span data-started="${esc(task.started_at)}">⏱ ${fmtDur(liveDur(task.started_at))}</span>` : task.updated_at ? `<span>${esc(task.updated_at.slice(5, 16).replace('T', ' '))}${dur ? ` · ${fmtDur(dur)}` : ''}</span>` : ''}</div>
    ${task.spec ? `<div class="t-result clamp">${esc(task.spec.length > 240 ? task.spec.slice(0, 240) + '…' : task.spec)}</div>` : ''}
    ${task.result ? `<div class="t-result clamp" id="res-${esc(task.id)}" style="color:var(--text)">${esc(task.result)}</div>` : ''}
    ${task.worktree ? `<div class="t-result mono" title="${esc(task.worktree)}">${esc(t('📁 {b} · 现场保留', { b: task.branch }))}</div>` : ''}
    ${links.length ? `<div class="t-links">${links.join('')}</div>` : ''}</div>`
}
function onTaskClick(e) {
  const b = e.target.closest('button')
  if (!b) return
  const id = state.run?.id
  if (b.dataset.res) document.getElementById('res-' + b.dataset.res)?.classList.toggle('clamp')
  else if (b.dataset.thread) openLogModal({ thread: b.dataset.thread })
  else if (b.dataset.log) openLogModal({ log: b.dataset.log })
  else if (b.dataset.cancel && id && confirm(t('确认取消任务 {id}？现场会保留。', { id: b.dataset.cancel }))) rt(`/api/runs/${encodeURIComponent(id)}/task/${encodeURIComponent(b.dataset.cancel)}/cancel`, { method: 'POST' }).catch((err) => toast(err.message, true))
  else if (b.dataset.retry && id) rt(`/api/runs/${encodeURIComponent(id)}/task/${encodeURIComponent(b.dataset.retry)}/retry`, { method: 'POST' }).catch((err) => toast(err.message, true))
}
function renderMailbox(msgs) {
  const box = $('#mailbox')
  $('#msg-count').textContent = msgs.length
  const seen = Number(box.dataset.n || 0)
  box.dataset.n = msgs.length
  box.innerHTML = msgs.length
    ? msgs.map((m, i) => `<div class="msg" ${i < seen ? 'style="animation:none"' : ''}><div class="m-head"><span class="m-from">${esc(m.from)}</span>→<span class="m-to">${esc(m.to)}</span>${m.task_id ? `<span class="chip">${esc(m.task_id)}</span>` : ''}${m.read === false ? `<span class="chip warn">${t('未读')}</span>` : ''}<span class="m-time">${esc((m.ts || '').slice(5, 19).replace('T', ' '))}</span></div><div class="m-body">${esc(m.content)}</div></div>`).reverse().join('')
    : `<div class="empty">${t('暂无消息')}</div>`
}

/* 线程 / 日志弹窗（沿用 Agent Router 控制台的事件 → 节点投影） */
function renderModalList() {
  const box = $('#log-list')
  let html = ''
  if (state.threads.length) html += `<div class="list-sec">${t('会话线程')}</div>` + state.threads.map((x) => `<div class="log-item ${state.modalThread === x.name ? 'active' : ''}" data-thread="${esc(x.name)}">🧵 ${esc(x.name.replace('.jsonl', ''))} <span class="dim">${x.size}B</span></div>`).join('')
  if (state.logFiles.length) html += `<div class="list-sec">${t('原始日志')}</div>` + state.logFiles.map((l) => `<div class="log-item ${!state.modalThread && state.modalLog === l.name ? 'active' : ''}" data-f="${esc(l.name)}">${esc(l.name)} <span class="dim">${l.size}B</span></div>`).join('')
  box.innerHTML = html || `<div class="log-item">${t('无线程与日志')}</div>`
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
  try { const d = await rt(`/api/runs/${encodeURIComponent(state.run.id)}/log/${encodeURIComponent(name)}`); c.textContent = d.text || t('(空)') }
  catch (e) { c.textContent = t('加载失败：{e}', { e: e.message }) }
}
async function showThread(name) {
  state.modalThread = name; state.modalLog = null; state.threadPending = []; state.threadStick = true
  renderModalList()
  $('#log-title').textContent = '· ' + name.replace('.jsonl', '')
  const c = $('#log-content')
  c.classList.add('thread-view')
  c.innerHTML = `<div class="empty">${t('加载中…')}</div>`
  try {
    const d = await rt(`/api/runs/${encodeURIComponent(state.run.id)}/thread/${encodeURIComponent(name)}`)
    c.innerHTML = ''
    for (const e of d.entries || []) appendThreadEntry(e)
    if (!(d.entries || []).length) c.innerHTML = `<div class="empty">${t('这个线程还没有内容')}</div>`
    c.scrollTop = c.scrollHeight
  } catch (e) { c.classList.remove('thread-view'); c.textContent = t('加载失败：{e}', { e: e.message }) }
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
    const via = d.via === 'append-system-prompt' ? t('（--append-system-prompt · 随每次请求生效）') : d.via === 'first-message' ? t('（已并入该会话第一条消息）') : ''
    el.innerHTML = `<details><summary>${t('📋 系统提示词')}${esc(via)}</summary><pre>${esc(String(d.text || ''))}</pre></details>`
  } else if (e.kind === 'user') { el.className = 'th-user'; el.innerHTML = `<div class="th-role">${t('派发 / 注入')}</div><div class="th-body">${esc(String(d.text || ''))}</div>` }
  else if (e.kind === 'assistant') { el.className = 'th-msg'; el.innerHTML = `<div class="th-body">${esc(String(d.text || ''))}</div>` }
  else if (e.kind === 'thought') { el.className = 'th-thought'; el.innerHTML = `<details><summary>${t('💭 思考')}</summary><div class="th-body">${esc(String(d.text || '').slice(0, 3000))}</div></details>` }
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
      $('.th-result', card).innerHTML = `<div class="th-role ${d.isError ? 'err' : ''}" style="margin-top:8px">${t(d.isError ? '结果（出错）' : '结果')}</div><pre>${esc(String(d.text || '').slice(0, 4000))}</pre>`
      $('details', card).open = false
      return
    }
    el.className = 'th-tool'
    el.innerHTML = `<details><summary>${t('工具结果')}${d.isError ? t('（出错）') : ''}</summary><pre>${esc(String(d.text || '').slice(0, 4000))}</pre></details>`
  } else if (e.kind === 'result') {
    el.className = 'th-final ' + (d.isError ? 'err' : 'ok')
    el.innerHTML = `<div class="th-role">${t(d.isError ? '■ 会话失败' : '■ 会话完成')}${d.cost ? esc(t(' · 累计 ${c}', { c: Number(d.cost).toFixed(4) })) : ''}</div><div class="th-body">${esc(String(d.text || '').slice(0, 2000) || t('(无文本)'))}</div>`
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
  if (!state.link.router) return toast(t('Agent Router 未挂载'), true)
  const h = state.health || {}
  for (const id of [...state.agPicked]) if (state.health && !h[id]) state.agPicked.delete(id)
  $('#ag-agents').innerHTML = Object.entries(MEMBERS).map(([id, m]) => `<button type="button" class="member-chip ${h[id] ? 'ok' : ''} ${state.agPicked.has(id) ? 'on' : ''}" data-m="${id}" ${state.health && !h[id] ? `disabled title="${t('CLI 未就绪')}"` : ''}><i></i>${esc(m.label)}<small>${esc(h.models?.[id] || '')}</small></button>`).join('')
  $$('#ag-agents .member-chip').forEach((b) => (b.onclick = () => { const id = b.dataset.m; state.agPicked.has(id) ? state.agPicked.delete(id) : state.agPicked.add(id); b.classList.toggle('on') }))
  $('#ag-main').innerHTML = Object.entries(MEMBERS).map(([id, m]) => `<option value="${id}" ${state.health && !h[id] ? 'disabled' : ''}>${esc(m.label)} — ${esc(t(m.mode))}</option>`).join('')
  const firstOk = Object.keys(MEMBERS).find((id) => !state.health || h[id])
  if (firstOk) $('#ag-main').value = firstOk
  $$('#ag-mode button').forEach((b) => (b.onclick = () => { state.agMode = b.dataset.v; $$('#ag-mode button').forEach((x) => x.classList.toggle('on', x === b)) }))
  $('#dlg-agent-run .form-error').textContent = ''
  $('#dlg-agent-run').showModal()
  $('#ag-goal').focus()
}
$('#form-agent-run').onsubmit = (e) => submitForm(e, async () => {
  const goal = $('#ag-goal').value.trim()
  if (!goal) throw new Error(t('请填写总目标'))
  const agents = [...state.agPicked]
  if (!agents.length) throw new Error(t('至少选择一名执行成员'))
  const d = await rt('/api/runs', { method: 'POST', body: JSON.stringify({ goal, repo: $('#ag-repo').value.trim() || undefined, agents, main: $('#ag-main').value, worktree: state.agMode === 'worktree' }) })
  toast(t('编排运行 {id} 已启动', { id: d.id }))
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
    stage.innerHTML = `<section class="hero"><div><div class="eyebrow">${t('舰队')}</div><h1>${t('成员')}<span class="grad">${lang === 'en' ? 'fleet' : 'Fleet'}</span></h1><p>${t('主代理可调度的全部 CLI 成员，以及对话模型提供方。')}</p></div><div class="hero-links" id="fleet-sum"></div></section>
      <div class="fleet stagger" id="fleet"></div>
      <section class="card" style="margin-top:16px"><div class="card-head">${icon('cpu')}<span class="card-title">${t('对话模型 / consult')}</span></div><div id="llm"></div></section>`
  },
  update() {
    const h = state.health, box = $('#fleet')
    if (!box) return
    if (!state.link.router) { box.innerHTML = `<div class="empty">${t('Agent Router 未挂载')}</div>`; return }
    if (!h) { box.innerHTML = `<div class="empty">${t('检测成员中…')}</div>`; return }
    const ids = Object.keys(MEMBERS), online = ids.filter((id) => h[id]).length
    $('#fleet-sum').innerHTML = `<span class="link-pill"><i class="link-dot on"></i>${t('{n} 在线', { n: `<b>${online}</b>` })}</span><span class="link-pill"><i class="link-dot off"></i>${t('{n} 未就绪', { n: `<b>${ids.length - online}</b>` })}</span>${h.busy ? `<span class="link-pill"><span class="live-dot"></span>${t('{n} 运行中', { n: `<b>${h.activeRuns.length}</b>` })}</span>` : ''}`
    box.innerHTML = ids.map((id, i) => {
      const m = MEMBERS[id]
      // 健康检查说明来自 router 后端（中文），英文界面下不再展示原文
      const note = lang === 'en' ? '' : h.checks?.[id] || ''
      return `<section class="card tilt member ${h[id] ? '' : 'off'}" style="--i:${i}"><div class="member-top"><span class="member-avatar" style="--c1:${m.c1};--c2:${m.c2}">${esc(m.label.slice(0, 2))}</span><div><div class="member-name">${esc(m.label)}</div><div class="member-model">${esc(h.models?.[id] && h.models[id] !== '客户端默认' ? h.models[id] : t('客户端默认'))}</div></div><span style="margin-left:auto" class="status ${h[id] ? 'succeeded' : 'idle'}">${t(h[id] ? '就绪' : '未就绪')}</span></div><div class="member-note">${esc(t(m.mode))}</div><div class="member-path">${esc(h.paths?.[id] || '')}</div><div class="kpi-note">${esc(note)}</div></section>`
    }).join('')
    const llm = Object.entries(h.llm || {})
    $('#llm').innerHTML = llm.length
      ? `<table><tbody>${llm.map(([k, v]) => `<tr style="cursor:default"><td><div class="run-label">${esc(v.label)}${h.consult === k ? ' <span class="chip who">consult</span>' : ''}</div><div class="run-id">${esc(v.model || '')}${v.apiKeyEnv ? ' · ' + esc(v.apiKeyEnv) : ''}</div></td><td><span class="status ${v.ready ? 'succeeded' : 'idle'}">${t(v.ready ? '可用' : '未就绪')}</span></td></tr>`).join('')}</tbody></table>`
      : `<div class="muted">${t('未配置对话模型')}</div>`
  },
}

/* =====================================================================
 * 命令面板 + 快捷键
 * ===================================================================== */
let palItems = [], palIndex = 0
const VIEW_ICONS = { overview: 'radar', science: 'flask', providers: 'layers', artifacts: 'file', agents: 'nodes', fleet: 'cpu' }
function commands() {
  const list = [
    ...Object.entries(views).map(([id, v]) => ({ label: t('前往 · {v}', { v: t(v.title) }), hint: t(v.section), icon: VIEW_ICONS[id], run: () => go(id) })),
    { label: t('发起实验运行'), hint: t('科学执行'), icon: 'flask', run: openScienceRun },
    { label: t('启动多智能体编排'), hint: t('多智能体'), icon: 'play', run: openAgentRun },
    { label: t('创建科学项目'), hint: t('科学执行'), icon: 'plus', run: openProject },
    { label: t('刷新全部数据'), hint: '', icon: 'refresh', run: () => $('#refresh').click() },
    { label: t('切换亮色 / 暗色主题'), hint: t('主题'), icon: 'moon', run: () => $('#theme').click() },
    { label: lang === 'en' ? '切换到中文' : 'Switch to English', hint: t('语言'), icon: 'radar', run: () => setLang(lang === 'en' ? 'zh' : 'en') },
  ]
  for (const p of state.sci?.projects || []) list.push({ label: t('切换项目 · {p}', { p: p.id }), hint: t('科学项目'), icon: 'layers', run: () => switchProject(p.id) })
  for (const r of state.runs.slice(0, 20)) list.push({ label: t('打开运行 · {r}', { r: r.goal || r.id }), hint: r.id, icon: 'nodes', run: () => { state.openId = r.id; state.view === 'agents' ? openRun(r.id) : go('agents') } })
  for (const o of (state.sci?.operations || []).slice(-20)) list.push({ label: t('查看实验 · {o}', { o: o.requestKey }), hint: o.providerId, icon: 'flask', run: () => { if (state.view !== 'science') go('science'); openOp(o.id) } })
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
    : `<div class="empty">${t('没有匹配的命令')}</div>`
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
setInterval(() => { $('#clock').textContent = new Date().toLocaleTimeString(locale, { hour12: false }) }, 1000)
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
