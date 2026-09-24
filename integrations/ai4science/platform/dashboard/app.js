const $ = (selector) => document.querySelector(selector)
const icons = {
  grid: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>',
  layers: '<path d="m12 3 10 6-10 6L2 9Z"/><path d="m3 14 9 5 9-5M3 18l9 5 9-5"/>',
  file: '<path d="M14 2H5v20h14V7Z"/><path d="M14 2v6h5M8 13h8M8 17h6"/>',
  refresh: '<path d="M20 10a8 8 0 0 0-14-5L3 8m0-5v5h5M4 14a8 8 0 0 0 14 5l3-3m0 5v-5h-5"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  arrow: '<path d="m8 5 7 7-7 7"/>',
  play: '<path d="m8 4 12 8-12 8Z"/>',
  check: '<path d="m5 12 4 4L19 6"/><circle cx="12" cy="12" r="10"/>',
  budget: '<path d="M3 7h18v13H3zM3 7V4h15v3M16 12h5v4h-5z"/>',
  search: '<circle cx="10" cy="10" r="6"/><path d="m15 15 6 6"/>',
  download: '<path d="M12 3v12m-5-5 5 5 5-5M4 17v4h16v-4"/>',
  flask: '<path d="M9 3h6M10 3v7l-6 9q-1 2 2 2h12q3 0 2-2l-6-9V3M8 14h8"/>',
}
const icon = (name) => `<svg viewBox="0 0 24 24" aria-hidden="true">${icons[name] || icons.layers}</svg>`
document.querySelectorAll('[data-icon]').forEach((node) => {
  node.innerHTML = icon(node.dataset.icon)
})
const escape = (value) =>
  String(value ?? '').replace(
    /[&<>"']/g,
    (x) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[x],
  )
const number = (value) => new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 }).format(value)
const compact = (value) =>
  new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(value)
const date = (value) =>
  new Intl.DateTimeFormat('en-GB', {
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value))
const stateNames = {
  registered: 'Registered',
  dispatching: 'Dispatching',
  accepted: 'Accepted',
  running: 'Running',
  succeeded: 'Completed',
  failed: 'Failed',
  cancelled: 'Cancelled',
  unknown: 'Unknown',
}
const active = (op) => ['registered', 'dispatching', 'accepted', 'running'].includes(op.state)
const status = (value) =>
  `<span class="status ${escape(value in stateNames ? value : 'unknown')}">${escape(stateNames[value] || value)}</span>`
let token = location.hash.slice(1) || sessionStorage.getItem('science-harness-token') || ''
if (location.hash) {
  sessionStorage.setItem('science-harness-token', token)
  history.replaceState(null, '', location.pathname)
}
let data = null,
  project = null,
  view = 'overview',
  filter = 'all',
  search = '',
  loading = false,
  signature = '',
  selectedRun = null,
  toastTimer
async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { Authorization: `Bearer ${token}`, ...options.headers },
  })
  if (!response.ok) {
    const body = await response.json().catch(() => ({ error: 'Request failed' }))
    throw new Error(body.error || `Request failed (${response.status})`)
  }
  return response.json()
}
const action = (value) =>
  api('/api/action', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(value),
  })
function toast(message) {
  clearTimeout(toastTimer)
  $('#toast').textContent = message
  $('#toast').hidden = false
  toastTimer = setTimeout(() => {
    $('#toast').hidden = true
  }, 4500)
}
function notice(message) {
  $('#notice').textContent = message
  $('#notice').hidden = !message
}
async function load(force = false) {
  if (loading) return
  loading = true
  const requestedToken = token
  try {
    const next = await api('/api/state' + (project ? '?project=' + encodeURIComponent(project) : ''))
    if (requestedToken !== token) return
    project = next.selectedProject
    data = next
    $('#connection').className = 'connection live'
    $('#connection').innerHTML = '<i></i> Connected locally'
    $('#loading').hidden = true
    $('#content').hidden = false
    notice(next.monitorError ? 'Monitoring needs attention: ' + next.monitorError : '')
    const nextSignature = JSON.stringify({ ...next, observedAt: undefined })
    if (force || nextSignature !== signature) {
      signature = nextSignature
      render()
    }
    $('#updated').textContent =
      'Updated ' +
      new Date(next.observedAt).toLocaleTimeString('en-GB', {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      })
    if ($('#detail-dialog').open) renderDetail()
  } catch (error) {
    $('#loading').hidden = true
    $('#connection').className = 'connection offline'
    $('#connection').innerHTML = '<i></i> Disconnected'
    notice(error.message)
  } finally {
    loading = false
  }
}
function chooseProject(id) {
  project = id
  search = ''
  filter = 'all'
  selectedRun = null
  void load(true)
}
function render() {
  const focused = document.activeElement?.id,
    caret = focused === 'search' ? document.activeElement.selectionStart : null
  document
    .querySelectorAll('[data-view]')
    .forEach((b) => b.classList.toggle('active', b.dataset.view === view))
  $('#project-list').innerHTML = data.projects.length
    ? data.projects
        .map(
          (p) =>
            `<button class="project-item ${p.id === project ? 'selected' : ''}" data-project="${escape(p.id)}">${escape(p.id)}</button>`,
        )
        .join('')
    : '<div class="muted" style="padding:8px 12px">No projects yet</div>'
  $('#project-list')
    .querySelectorAll('[data-project]')
    .forEach((b) => (b.onclick = () => chooseProject(b.dataset.project)))
  $('#project-switcher').innerHTML =
    data.projects
      .map(
        (p) =>
          `<option value="${escape(p.id)}" ${p.id === project ? 'selected' : ''}>${escape(p.id)}</option>`,
      )
      .join('') + '<option data-action="create">+ Create project</option>'
  if (!project) $('#project-switcher').selectedIndex = -1
  $('#new-run').disabled = !project || !data.providers.length
  const titles = {
    overview: ['Project overview', 'A clear view of your work, from execution to evidence.'],
    providers: ['Execution providers', 'The capabilities available to this project.'],
    artifacts: ['Research artifacts', 'Recorded outputs with verified provenance.'],
  }
  $('#page-title').textContent = titles[view][0]
  $('#page-subtitle').textContent = titles[view][1]
  if (!project) {
    $('#content').innerHTML =
      `<section class="panel empty-state"><div class="empty-symbol">${icon('layers')}</div><h3>Your workspace starts here</h3><p>Create a configured project, connect its providers, and keep your first result in view.</p><button class="button primary" id="first-project">Create project</button></section>`
    $('#first-project').onclick = openProject
    return
  }
  if (view === 'providers') renderProviders()
  else if (view === 'artifacts') renderArtifacts()
  else renderOverview()
  if (focused === 'search') {
    const input = $('#search')
    if (input) {
      input.focus({ preventScroll: true })
      input.setSelectionRange(caret, caret)
    }
  }
}
function renderOverview() {
  const p = data.projects.find((p) => p.id === project),
    ops = data.operations,
    ongoing = ops.filter(active).length,
    done = ops.filter((o) => o.state === 'succeeded').length
  const remaining = Math.max(0, p.budgetLimit - p.budgetUsed),
    percent = p.budgetLimit ? Math.min(100, (p.budgetUsed / p.budgetLimit) * 100) : 0
  const metrics = [
    ['Active runs', ongoing, 'Currently managed', 'play'],
    ['Completed', done, 'Confirmed successful', 'check'],
    ['Artifacts', data.artifacts.length, 'Recorded outputs', 'file'],
    [
      'Budget remaining',
      compact(remaining),
      `${number(p.budgetUsed)} of ${number(p.budgetLimit)} reserved`,
      'budget',
    ],
  ]
  const visible = ops
    .filter(
      (o) =>
        (filter === 'all' ||
          (filter === 'active' && active(o)) ||
          (filter === 'completed' && o.state === 'succeeded') ||
          (filter === 'attention' && ['unknown', 'failed'].includes(o.state))) &&
        [o.requestKey, o.providerId, o.id].some((v) => v.toLowerCase().includes(search.toLowerCase())),
    )
    .toReversed()
  $('#content').innerHTML =
    `<div class="metrics">${metrics.map(([label, value, note, glyph]) => `<div class="metric"><div class="metric-top"><span>${label}</span><span class="metric-icon">${icon(glyph)}</span></div><div class="metric-value">${value}</div><div class="metric-note">${escape(note)}</div></div>`).join('')}</div>
  <div class="overview-grid"><section class="panel"><div class="panel-heading"><div><span class="panel-title">Execution activity</span><span class="count-label">${ops.length}</span><div class="panel-subtitle">Every run, with a clear state and a durable identity</div></div><button class="text-button" id="reconcile">Reconcile ${icon('refresh')}</button></div>
  <div class="toolbar"><div class="filters" aria-label="Filter runs">${[
    ['all', 'All runs'],
    ['active', 'Active'],
    ['completed', 'Completed'],
    ['attention', 'Needs attention'],
  ]
    .map(
      ([key, label]) =>
        `<button class="filter ${filter === key ? 'active' : ''}" data-filter="${key}">${label}</button>`,
    )
    .join(
      '',
    )}</div><div class="search">${icon('search')}<input id="search" aria-label="Search runs" placeholder="Find a run…" value="${escape(search)}"></div></div>
  ${visible.length ? `<div class="table-scroll"><table class="run-table"><thead><tr><th>RUN</th><th>STATUS</th><th class="date-column">CREATED</th><th aria-label="Details"></th></tr></thead><tbody>${visible.map((op) => `<tr data-run="${escape(op.id)}" tabindex="0" role="button" aria-label="Inspect ${escape(op.requestKey)}"><td><div class="run-label">${escape(op.requestKey)}</div><div class="run-id">${escape(op.providerId)} <span aria-hidden="true">·</span> ${escape(op.id.slice(0, 8))}</div></td><td>${status(op.state)}</td><td class="date date-column">${date(op.createdAt)}</td><td class="run-arrow">${icon('arrow')}</td></tr>`).join('')}</tbody></table></div>` : `<div class="empty-state"><div class="empty-symbol">${icon('flask')}</div><h3>${ops.length ? 'No matching runs' : 'Ready for your first run'}</h3><p>${ops.length ? 'Try another filter or search term.' : 'Choose a provider and submit your first operation. Results will appear here.'}</p>${!ops.length ? '<button id="first-run" class="button secondary">Start a run</button>' : ''}</div>`}
  <div class="table-footer"><span>${visible.length} ${visible.length === 1 ? 'run' : 'runs'} shown</span><span>Automatically refreshed</span></div></section>
  <aside class="side-stack"><section class="panel"><div class="panel-heading"><div class="panel-title">Project budget</div>${icon('budget')}</div><div class="budget-body"><div class="budget-number">${number(p.budgetUsed)} <small>of ${number(p.budgetLimit)} units</small></div><div class="progress-track" role="meter" aria-label="Budget reserved" aria-valuenow="${p.budgetUsed}" aria-valuemin="0" aria-valuemax="${p.budgetLimit}"><div class="progress-fill" style="width:${percent}%"></div></div><div class="budget-legend"><span>${percent.toFixed(0)}% reserved</span><span>${compact(remaining)} available</span></div><p class="budget-note">Reservations stay charged after completion or cancellation.</p></div></section>
  <section class="panel"><div class="panel-heading"><div class="panel-title">Providers</div><button class="text-button" id="view-providers">View all ${icon('arrow')}</button></div>${data.providers
    .slice(0, 3)
    .map(
      (p) =>
        `<div class="provider-mini"><div class="provider-glyph">${icon('layers')}</div><div><strong>${escape(p.id)}</strong><small>Version ${escape(p.version)}</small></div><span class="tiny-dot" title="Registered"></span></div>`,
    )
    .join('')}</section>
  <div class="note-card"><strong>Keep uncertainty visible.</strong><p>Unknown operations retain their resource reservation until their state can be confirmed.</p></div></aside></div>`
  document.querySelectorAll('[data-filter]').forEach(
    (b) =>
      (b.onclick = () => {
        filter = b.dataset.filter
        render()
      }),
  )
  $('#search').oninput = (e) => {
    search = e.target.value
    render()
  }
  document.querySelectorAll('[data-run]').forEach((row) => {
    const open = () => {
      selectedRun = row.dataset.run
      renderDetail()
      $('#detail-dialog').showModal()
    }
    row.onclick = open
    row.onkeydown = (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault()
        open()
      }
    }
  })
  $('#reconcile').onclick = async () => {
    try {
      await action({ action: 'reconcile', project })
      toast('Reconciliation finished. Review the observed states.')
      await load(true)
    } catch (e) {
      toast(e.message)
    }
  }
  $('#view-providers').onclick = () => {
    view = 'providers'
    render()
  }
  if ($('#first-run')) $('#first-run').onclick = openRun
}
function renderProviders() {
  $('#content').innerHTML =
    `<div class="provider-grid">${data.providers.map((p) => `<section class="provider-card"><div class="provider-glyph">${icon('layers')}</div><h3>${escape(p.id)}</h3><span class="provider-tag">Provider v${escape(p.version)}</span><p>${escape(p.completion)}</p><details><summary>Cancellation behavior</summary><p>${escape(p.cancellation)}</p></details><details><summary>Constraints and units</summary><pre>${escape(JSON.stringify({ constraints: p.constraints, units: p.units }, null, 2))}</pre></details><details><summary>Input schema</summary><pre>${escape(JSON.stringify(p.inputSchema, null, 2))}</pre></details></section>`).join('')}</div>`
}
function renderArtifacts() {
  $('#content').innerHTML = data.artifacts.length
    ? `<div class="artifact-list">${data.artifacts.map((a) => `<div class="artifact-row"><div class="provider-glyph">${icon('file')}</div><div><div class="artifact-name">${escape(a.path.split('/').at(-1))}</div><div class="artifact-meta">${escape(a.requestKey)} · ${number(a.bytes)} bytes · ${escape(a.mediaType)}</div></div><div class="artifact-buttons"><button class="button secondary small" data-preview="${escape(a.id)}">Preview</button><button class="icon-button" data-download="${escape(a.id)}" aria-label="Download ${escape(a.path.split('/').at(-1))}">${icon('download')}</button></div></div>`).join('')}</div>`
    : `<section class="panel empty-state"><div class="empty-symbol">${icon('file')}</div><h3>Evidence will appear here</h3><p>Completed operations publish artifacts with their source and content hash.</p></section>`
  bindArtifacts($('#content'))
}
function renderDetail() {
  const op = data.operations.find((o) => o.id === selectedRun)
  if (!op) return
  $('#detail-title').textContent = op.requestKey
  $('#detail-content').innerHTML =
    `<div class="detail-grid"><div><label>Status</label>${status(op.state)}</div><div><label>Provider</label>${escape(op.providerId)} · v${escape(op.providerVersion)}</div><div><label>Operation ID</label>${escape(op.id)}</div><div><label>Budget reserved</label>${number(op.budget)}</div><div><label>Resources</label>${escape(op.resources.join(', '))}</div><div><label>Created</label>${date(op.createdAt)}</div></div>
  ${op.cancelRequested ? `<div class="notice">${op.state === 'cancelled' ? 'Cancellation confirmed. Any partial results remain available.' : ['succeeded', 'failed'].includes(op.state) ? 'Execution has ended. The observed result is preserved.' : 'Cancellation requested. Execution has not yet been confirmed as stopped.'}</div>` : ''}${op.detail ? `<p class="muted">${escape(op.detail)}</p>` : ''}
  <div class="detail-block-title">Actual input</div><pre>${escape(JSON.stringify(op.input, null, 2))}</pre>${op.progress ? `<div class="detail-block-title">Observed progress</div><pre>${escape(JSON.stringify(op.progress, null, 2))}</pre>` : ''}
  <div class="detail-block-title">Artifacts</div>${op.artifacts.length ? op.artifacts.map((a) => `<div class="artifact-row"><div><div class="artifact-name">${escape(a.path.split('/').at(-1))}</div><div class="artifact-meta">${number(a.bytes)} bytes · SHA256 ${escape(a.sha256.slice(0, 16))}…</div></div><div class="artifact-buttons"><button class="button secondary small" data-preview="${escape(a.id)}">Preview</button><button class="icon-button" data-download="${escape(a.id)}" aria-label="Download artifact">${icon('download')}</button></div></div>`).join('') : '<p class="muted">No published artifacts yet.</p>'}
  <div class="detail-actions"><button class="button secondary" id="query-run">Query provider</button>${!['succeeded', 'cancelled', 'failed'].includes(op.state) ? '<button class="button danger" id="cancel-run">Request cancellation</button>' : ''}</div>`
  $('#query-run').onclick = async () => {
    try {
      await action({ action: 'query', project, operationId: op.id })
      await load(true)
    } catch (e) {
      toast(e.message)
    }
  }
  if ($('#cancel-run'))
    $('#cancel-run').onclick = async () => {
      try {
        const r = await action({ action: 'cancel', project, operationId: op.id })
        toast(
          r.cancelRequested
            ? `Cancellation request recorded. Observed state: ${stateNames[r.state] || r.state}.`
            : `Operation already ${stateNames[r.state]?.toLowerCase() || r.state}; no cancellation was needed.`,
        )
        await load(true)
      } catch (e) {
        toast(e.message)
      }
    }
  bindArtifacts($('#detail-content'))
}
function bindArtifacts(root) {
  root.querySelectorAll('[data-preview]').forEach(
    (b) =>
      (b.onclick = async () => {
        try {
          const r = await api(
            `/api/artifact?project=${encodeURIComponent(project)}&id=${encodeURIComponent(b.dataset.preview)}`,
          )
          $('#artifact-title').textContent = r.artifact.path.split('/').at(-1)
          $('#artifact-content').textContent =
            r.encoding === 'base64' ? 'Binary artifact. Download to inspect its contents.' : r.content
          $('#artifact-dialog').showModal()
        } catch (e) {
          toast(e.message)
        }
      }),
  )
  root.querySelectorAll('[data-download]').forEach((button) => {
    button.onclick = () => {
      const link = document.createElement('a')
      link.href = `/api/artifact?project=${encodeURIComponent(project)}&id=${encodeURIComponent(button.dataset.download)}&download=1`
      link.download =
        data.artifacts
          .find((a) => a.id === button.dataset.download)
          ?.path.split('/')
          .at(-1) || 'artifact'
      document.body.append(link)
      link.click()
      link.remove()
      toast('Download requested. The server verifies the artifact before sending it.')
    }
  })
}

function sample(schema, depth = 0) {
  if (depth > 4 || !schema) return null
  if (schema.default !== undefined) return schema.default
  if (schema.enum?.length) return schema.enum[0]
  if (schema.type === 'object') {
    const v = {}
    for (const key of schema.required || []) v[key] = sample(schema.properties?.[key], depth + 1)
    return v
  }
  if (schema.type === 'array')
    return Array.from({ length: Math.min(3, Math.max(1, schema.minItems || 1)) }, () =>
      sample(schema.items, depth + 1),
    )
  if (schema.type === 'string') return 'Example input'
  if (schema.type === 'boolean') return false
  if (schema.type === 'number' || schema.type === 'integer')
    return Math.max(schema.minimum ?? 0, Math.min(schema.maximum ?? 1, 1))
  return null
}
function openProject() {
  if (!data) return toast('Connect to the local server first.')
  const remaining = data.allowedProjects.filter((id) => !data.projects.some((p) => p.id === id))
  if (!remaining.length)
    return toast('All configured projects exist. Add another project to your management configuration first.')
  $('#project-name').innerHTML = remaining.map((id) => `<option>${escape(id)}</option>`).join('')
  $('#project-dialog .form-error').textContent = ''
  $('#project-dialog').showModal()
}
function updateInput() {
  const provider = data.providers.find((p) => p.id === $('#run-provider').value)
  $('#run-input').value = JSON.stringify(sample(provider.inputSchema), null, 2)
  $('#input-schema').textContent = JSON.stringify(provider.inputSchema, null, 2)
}
function openRun() {
  if (!project || !data.providers.length) return
  $('#run-provider').innerHTML = data.providers.map((p) => `<option>${escape(p.id)}</option>`).join('')
  $('#request-key').value = 'run-' + crypto.randomUUID().slice(0, 8)
  updateInput()
  $('#run-dialog .form-error').textContent = ''
  $('#run-dialog').showModal()
}
async function formSubmit(event, fn) {
  event.preventDefault()
  const form = event.currentTarget,
    button = form.querySelector('[type=submit]')
  if (button.disabled) return
  button.disabled = true
  form.querySelector('.form-error').textContent = ''
  try {
    await fn()
    form.closest('dialog').close()
    await load(true)
  } catch (error) {
    form.querySelector('.form-error').textContent = error.message
  } finally {
    button.disabled = false
  }
}
$('#project-form').onsubmit = (e) =>
  formSubmit(e, async () => {
    const id = $('#project-name').value
    await action({ action: 'create', project: id, budget: Number($('#project-budget').value) })
    project = id
    toast('Project created.')
  })
$('#run-form').onsubmit = (e) =>
  formSubmit(e, async () => {
    const result = await action({
      action: 'submit',
      project,
      providerId: $('#run-provider').value,
      requestKey: $('#request-key').value,
      input: JSON.parse($('#run-input').value),
    })
    toast(`Run ${stateNames[result.state]?.toLowerCase() || result.state}.`)
    view = 'overview'
  })
$('#run-provider').onchange = updateInput
$('#new-run').onclick = openRun
$('#add-project').onclick = openProject
$('#refresh').onclick = () => load(true)
$('#project-switcher').onchange = (e) => {
  if (e.target.selectedOptions[0]?.dataset.action === 'create') {
    e.target.value = project ?? ''
    openProject()
  } else chooseProject(e.target.value)
}
document.querySelectorAll('[data-view]').forEach(
  (b) =>
    (b.onclick = () => {
      view = b.dataset.view
      if (data) render()
    }),
)
document.querySelectorAll('.close-dialog').forEach((b) => (b.onclick = () => b.closest('dialog').close()))
$('.brand').onclick = (e) => {
  e.preventDefault()
  view = 'overview'
  if (data) render()
}
window.addEventListener('hashchange', () => {
  if (!location.hash) return
  token = location.hash.slice(1)
  sessionStorage.setItem('science-harness-token', token)
  history.replaceState(null, '', location.pathname)
  signature = ''
  project = null
  data = null
  view = 'overview'
  $('#content').hidden = true
  $('#loading').hidden = false
  void load(true)
})
void load(true)
setInterval(() => {
  if (!document.hidden) void load()
}, 1500)
