/* Joint laboratory views share the live, authenticated physical execution records. */
export function createLaboratoryView({ api, t, esc, num, available, onSnapshot }) {
  const operationActors = new Map()
  let host, snapshot, panel = 'overview', loading = false, failure = '', cursor = 0, events = []
  const labels = { overview: '实验室总览', devices: '设备状态', samples: '样品流转', projects: '项目依赖', records: '异常与操作', team: '协作记录' }
  const states = { available: '可用', quarantined: '已隔离', running: '进行中', succeeded: '已完成', failed: '失败', cancelled: '已取消', recalled: '已召回' }
  const kinds = { 'liquid-handler': '液体处理', centrifuge: '离心机', heater: '加热模块', screen: '快速筛查仪', confirm: '确认检测仪',
    robot: '转运机器人', 'cold-store': '冷藏设备', freezer: '冷冻设备', incubator: '培养舱', imager: '成像设备', 'water-module': '水路模块', analysis: '分析工作站' }
  const text = value => esc(value ?? '—')
  const status = value => esc(t(states[value] || value))
  const table = (headers, rows) => `<div class="lab-table"><table><thead><tr>${headers.map(label => `<th>${t(label)}</th>`).join('')}</tr></thead><tbody>${rows.join('')}</tbody></table></div>`
  const row = cells => `<tr>${cells.map(cell => `<td>${cell}</td>`).join('')}</tr>`
  const id = value => `<span class="lab-id">${text(value)}</span>`
  function overview(world) {
    const valid = world.deliveries.filter(delivery => delivery.valid)
    const pendingActors = world.operations.some(operation => !operationActors.has(operation.id))
    const interventions = world.operations.filter(operation => operationActors.get(operation.id) === 'laboratory-operator').length
    return `<div class="kpis lab-kpis">${[
      ['逻辑模拟步', num(world.tick)], ['已发布任务', num(world.tasks.length)], ['有效交付', `${num(valid.length)} / ${num(world.tasks.length)}`],
      ['运行中操作', num(world.operations.filter(operation => operation.state === 'running').length)],
    ].map(([label, value]) => `<section class="kpi"><div class="kpi-label">${t(label)}</div><div class="kpi-value">${value}</div>${label === '有效交付' ? `<p class="kpi-note">${t('已发布任务完成率')} ${world.tasks.length ? num(valid.length / world.tasks.length * 100) : '—'}%</p>` : ''}</section>`).join('')}</div>
      <p class="kpi-note">${t('人工介入次数')} ${pendingActors ? `— · ${t('执行者信息待核验')}` : num(interventions)}</p>
      <section class="card"><div class="card-head"><span class="card-title">${t('公共设施')}</span></div>${table(['指标', '当前值'], [
        row([t('共享供电'), `${num(snapshot.utilities.powerDemand)} / ${num(world.facilities.powerCapacity)}`]),
        row([t('水箱余量（微升）'), `${num(world.facilities.waterUl)} / ${num(world.facilities.waterCapacityUl)}`]),
        row([t('水路状态'), t(snapshot.utilities.waterAvailable ? '可用' : '需要处理')]),
        row([t('累计超温（样品×模拟步）'), num(world.facilityMetrics.unsafeSampleTicks)]),
      ])}</section>
      <section class="card"><div class="card-head"><span class="card-title">${t('耗材与物流')}</span></div>${table(['批次', '种类', '数量', '状态'], world.batches.map(batch => row([id(batch.id), text(batch.kind), num(batch.units), status(batch.disposition)])))}
      ${world.shipments.filter(shipment => !shipment.delivered).map(shipment => `<p>${id(shipment.id)} · ${text(shipment.kind)} · ${t('到货模拟步')} ${num(shipment.arrivesAt)}</p>`).join('')}</section>`
  }
  function devices(world) {
    return `<div class="lab-device-grid">${world.devices.map(device => {
      const operation = world.operations.find(operation => operation.state === 'running' && operation.command.deviceId === device.id)
      return `<section class="card"><div class="card-head"><span class="card-title">${text(device.id)}</span><span class="tag">${t(kinds[device.kind] || device.kind)}</span></div>
        <p>${t(device.broken ? '故障' : !device.enabled ? '已停用' : operation ? '进行中' : '空闲')} · ${t(device.dirty ? '需要清洗' : '清洁')}</p>
        ${device.temperature == null ? '' : `<p>${t('实测温度')} ${num(device.temperature)} · ${t('目标温度')} ${num(device.targetTemperature)}</p>`}
        <p>${t('位置占用')} ${world.samples.filter(sample => sample.location === device.id && sample.volumeUl > 0).length} / ${device.capacity}</p>
        <p>${t('兼容容器')} ${device.containers.map(text).join(' · ')}</p>
        <p>${t('每批样品上限')} ${num(device.maximumBatchSamples ?? 1)} · ${t('配平数量倍数')} ${num(device.batchMultiple ?? 1)}</p>
        <p>${t('支持方法')} ${device.methods.map(text).join(' · ') || '—'}</p>
        ${device.calibrationId ? `<p>${t('校准有效至模拟步')} ${num(device.calibratedUntil)}</p>` : ''}
        ${operation ? `<p>${id(operation.id)} · ${text(operation.stage)} · ${t('下一事件模拟步')} ${num(operation.nextTick)}</p>` : ''}</section>`
    }).join('')}</div>`
  }
  function samples(world) {
    return `<section class="card">${table(['样品', '项目', '剩余体积（微升）', '当前位置', '处理状态', '保存状态'], world.samples.filter(sample => sample.volumeUl > 0).map(sample => row([
      `<details><summary>${id(sample.id)}</summary><p>${t('父样品')} ${id(sample.parentId)}</p><p>${t('累计超温模拟步')} ${num(sample.exposureTicks)}</p><p>${t('到期模拟步')} ${num(sample.expiresAt)}</p><p>${t('接触批次')} ${sample.batchIds.map(id).join(' · ') || '—'}</p></details>`,
      text(sample.projectId), num(sample.volumeUl), text(sample.location), text(sample.state), status(sample.disposition),
    ])))}</section>`
  }
  function projects(world) {
    return snapshot.projects.map(project => `<section class="card"><div class="card-head"><span class="card-title">${text(project.id)} · ${text(project.title)}</span></div>
      ${table(['阶段任务', '所需方法', '前置交付', '状态'], world.tasks.filter(task => task.projectId === project.id).map(task => {
        const delivery = world.deliveries.find(delivery => delivery.taskId === task.id && delivery.valid)
        return row([`<details><summary>${text(task.title)}</summary><p>${id(task.id)}</p><p>${task.rootSampleIds.map(id).join(' · ')}</p>
          ${delivery ? delivery.resultIds.map(resultId => `<p>${id(resultId)}</p>`).join('') : ''}
          ${delivery?.referenceResultIds?.length ? `<p>${t('跨项目参考')}</p>${delivery.referenceResultIds.map(resultId => `<p>${id(resultId)}</p>`).join('')}` : ''}</details>`,
        `${text(task.methodId)} v${task.methodVersion}`, task.prerequisites.map(id).join('<br>') || '—', t(delivery ? '有效交付' : '待处理')])
      }))}</section>`).join('')
  }
  function records(world) {
    const operations = world.operations.slice().reverse()
    return `<section class="card"><div class="card-head"><span class="card-title">${t('已提交事件')}</span></div>${table(['序号', '逻辑模拟步', '事件'], events.slice(-40).reverse().map(event => row([num(event.seq), num(event.tick), `<details><summary>${text(event.kind)}</summary><pre>${text(JSON.stringify(event.payload, null, 2))}</pre></details>`])))}</section>
      <section class="card"><div class="card-head"><span class="card-title">${t('实际设备操作')}</span></div>${table(['操作', '项目', '执行者', '设备', '状态', '已消耗'], operations.map(operation => row([
        `<details><summary>${id(operation.id)}</summary><pre>${text(JSON.stringify(operation.command, null, 2))}</pre><p>${text(operation.detail)}</p></details>`,
        text(operation.projectId), operationActors.get(operation.id) === 'laboratory-operator' ? t('操作者辅助') : id(operationActors.get(operation.id) ?? t('执行者信息待核验')), text(operation.command.deviceId), status(operation.state), `${num(operation.consumedUl)} μL · ${num(operation.consumedWaterUl)} ${t('用水微升')}`,
      ])))}</section>`
  }
  function team() {
    const experiment = snapshot.experiment
    if (!experiment) return `<section class="card"><p>${t('环境已挂载，Agent 尚未启动。')}</p></section>`
    const roles = { lead: '协调员', facilities: '设施与设备成员', experiments: '样品与实验成员', quality: '数据与质量成员' }
    const metrics = experiment.metrics
    const taskState = { pending: '待分派', in_progress: '进行中', done: '有效交付', failed: '失败' }
    const memberState = { running: '进行中', idle: '空闲', inactive: '未激活' }
    const receiptState = { accepted: '原生投递已接受', pending: '等待原生投递', failed: '原生投递失败' }
    return `<section class="card"><div class="card-head"><span class="card-title">${t('原生成员')}</span><span class="tag">${t(experiment.source === 'scripted' ? '脚本模型' : '真实模型')} · ${text(experiment.model.model)}</span></div>
      ${experiment.lastFailure ? `<p role="alert">${text(experiment.lastFailure)}</p>` : ''}
      ${table(['成员', '原生会话', '父会话', '状态'], experiment.members.map(member => row([
        t(roles[member.name] || member.name), id(member.id), id(member.parentId), t(memberState[member.status] || member.status),
      ])))}</section>
      <section class="card"><div class="card-head"><span class="card-title">${t('模型与压缩记录')}</span></div>
      ${table(['指标', '当前值'], [row([t('模型请求'), num(metrics.requests)]), row([t('输入 token'), num(metrics.inputTokens)]),
        row([t('输出 token'), num(metrics.outputTokens)]), row([t('原生上下文摘要'), num(metrics.compactionSummaries)]),
        row([t('摘要失败'), num(metrics.compactionFailures)]), row([t('工具错误'), num(metrics.toolErrors)])])}
      ${table(['模型路由', '请求次数', '输入 token', '输出 token'], Object.entries(metrics.byProvider).map(([provider, usage]) => row([
        text(provider), num(usage.requests), num(usage.inputTokens), num(usage.outputTokens),
      ])))}</section>
      <section class="card"><div class="card-head"><span class="card-title">${t('Router 分派与交付')}</span></div>
      ${table(['分派', '阶段任务', '负责人', '状态', '交付引用'], experiment.tasks.map(task => {
        let delivery
        try { delivery = task.result ? JSON.parse(task.result) : null } catch { delivery = null }
        return row([id(task.id), id(task.title), t(roles[task.assignee] || task.assignee), t(taskState[task.status] || task.status),
          delivery?.resultIds ? delivery.resultIds.map(id).join('<br>') + (delivery.referenceResultIds?.length ? `<details><summary>${t('跨项目参考')}</summary>${delivery.referenceResultIds.map(id).join('<br>')}</details>` : '') : text(task.result)])
      }))}</section>
      <section class="card"><div class="card-head"><span class="card-title">${t('成员消息与回执')}</span></div>
      ${table(['消息', '发送方', '接收方', '关联分派', '投递回执', '信箱读取'], experiment.messages.slice().reverse().map(message => row([
        `<details><summary>${id(message.id)}</summary><pre>${text(message.content)}</pre></details>`,
        t(roles[message.from] || message.from), t(roles[message.to] || message.to), id(message.task_id),
        t(receiptState[message.delivery.status] || message.delivery.status), t(message.read ? '已读取' : '待读取'),
      ])))}</section>`
  }

  function comparison(report) {
    const total = (run, field) => Object.values(run.perRoute).reduce((sum, route) => sum + route[field], 0)
    const summaries = run => Object.values(run.compactionEventsByRole).reduce((sum, count) => sum + count.summary, 0)
    const metrics = [
      ['模型来源', run => t(run.source === 'scripted' ? '脚本模型' : '真实模型')],
      ['任务与交付核验', run => t(run.success ? '通过' : '尚未通过')],
      ['任务完成率', run => run.tasks ? `${num(run.validDeliveries / run.tasks * 100)}%` : '—'],
      ['有效交付', run => `${num(run.validDeliveries)} / ${num(run.tasks)}`],
      ['逻辑模拟步', run => num(run.tick)], ['完成模拟步', run => run.allTaskCompletionTick == null ? '—' : num(run.allTaskCompletionTick)],
      ['任务平均延迟（模拟步）', run => run.meanTaskLatencyTicks == null ? '—' : num(run.meanTaskLatencyTicks)],
      ['实际设备操作', run => num(run.operations)], ['检测记录', run => num(run.measurements)],
      ['模型请求', run => num(total(run, 'requests'))], ['输入 token', run => num(total(run, 'inputTokens'))],
      ['输出 token', run => num(total(run, 'outputTokens'))], ['原生上下文摘要', run => num(summaries(run))],
      ['压缩后待办续接核验', run => run.compactionContinuity ? `${num(run.compactionContinuity.verifiedPendingTaskClosures)} / ${num(run.compactionContinuity.pendingTaskOpportunities)}` : '—'],
      ['累计超温（样品×模拟步）', run => num(run.operatingMetrics.unsafeSampleTicks)],
      ['供电过载模拟步', run => num(run.operatingMetrics.powerOverloadTicks)],
      ['水路不可用模拟步', run => num(run.operatingMetrics.waterUnavailableTicks)],
      ['人工介入次数', run => num(run.operatorSubmittedOperations)],
      ['多操作并行模拟步', run => run.resources ? num(run.resources.twoOrMoreOperationsBusyTicks) : '—'],
      ['峰值并行操作', run => run.resources ? num(run.resources.peakConcurrentOperations) : '—'],
      ['同来源同方法版本额外检测', run => run.repeats ? num(run.repeats.additionalSameRootMethodVersionMeasurements) : '—'],
      ['重复动作工具调用', run => run.repeats ? num(run.repeats.identicalActionToolCallRepeats) : '—'],
    ]
    const checks = Object.values(report.matchingChecks)
    return `<section class="card"><div class="card-head"><span class="card-title">${t('单／多 Agent 对照')}</span><span class="tag">${t(report.comparisonReady ? '对照条件通过' : '对照条件尚未通过')} · ${checks.filter(Boolean).length} / ${checks.length}</span></div>
      <p class="kpi-note">${t('时间基准：虚拟实验室模拟步；本机时间不参与评测。')}</p>
      <p class="kpi-note">${t('模型生成与可执行决策期间虚拟时间保持不动；模拟步不衡量推理吞吐。')}</p>
      <p class="kpi-note">${t('累计用量与越界记录对应各自观测窗口，请结合观测模拟步解读。')}</p>
      ${table(['指标', '单 Agent', '多 Agent'], metrics.map(([label, value]) => row([t(label), text(value(report.single)), text(value(report.multi))])))}</section>`
  }
  function render() {
    const root = host?.querySelector('#laboratory-live')
    if (!root) return
    if (!available()) { root.innerHTML = `<p class="empty">${t('当前运行未挂载联合实验室')}</p>`; return }
    if (!snapshot) { root.innerHTML = `<p class="empty">${esc(failure || t('正在读取实验室状态…'))}</p>`; return }
    if (snapshot.mode === 'saved-report') {
      host.querySelector('.hero h1').textContent = t('联合实验室对照报告')
      host.querySelector('.hero p').textContent = t('已保存的对照报告 · 只读')
      root.innerHTML = comparison(snapshot.comparison)
      return
    }
    const openDetails = new Set([...root.querySelectorAll('details[open]')].map(detail => detail.querySelector('summary').textContent))
    const panels = { overview, devices, samples, projects, records, team }
    root.innerHTML = `<div class="greenhouse-notice" role="status">${snapshot.mode === 'environment-only' ? t('实验室环境联调 · Agent 尚未启动') : `${t(snapshot.mode === 'single-agent' ? '单 Agent' : '多 Agent')} · ${t(snapshot.experiment.source === 'scripted' ? '脚本模型' : '真实模型')}`}${failure ? ` · ${text(failure)}` : ''}${snapshot.clock.failure ? ` · ${text(snapshot.clock.failure)}` : ''}</div>
      <div class="lab-tabs" role="group" aria-label="${t('实验室视图')}">${Object.entries(labels).map(([key, label]) => `<button class="btn ${panel === key ? 'primary' : ''}" data-lab-panel="${key}" aria-pressed="${panel === key}">${t(label)}</button>`).join('')}</div>
      ${panels[panel](snapshot.world)}`
    root.querySelectorAll('details').forEach(detail => { detail.open = openDetails.has(detail.querySelector('summary').textContent) })
    root.querySelectorAll('[data-lab-panel]').forEach(button => { button.onclick = () => { panel = button.dataset.labPanel; render() } })
  }
  async function load() {
    if (loading || !available()) return
    loading = true
    try {
      const next = await api(`/mc/laboratory?after=${cursor}`)
      if (snapshot?.scenarioHash && snapshot.scenarioHash !== next.scenarioHash) { events = []; cursor = 0; operationActors.clear() }
      if (next.world) {
        const projects = [...new Set(next.world.operations.filter(operation => !operationActors.has(operation.id)).map(operation => operation.projectId))]
        const states = await Promise.all(projects.map(project => api(`/science/api/state?project=${encodeURIComponent(project)}`).catch(() => null)))
        for (const state of states) for (const operation of state?.operations ?? []) operationActors.set(operation.id, operation.actorId)
      }
      events = [...events, ...next.events].slice(-500)
      cursor = events.at(-1)?.seq || cursor
      snapshot = next; failure = ''; onSnapshot?.(snapshot); render()
    } catch (error) { failure = error.message; render() }
    finally { loading = false }
  }
  return { title: '联合实验室', section: '科学执行',
    mount(stage) {
      host = stage
      stage.innerHTML = `<div class="hero"><h1>${t('联合实验室')}</h1><p>${t('设备、样品、项目依赖与异常处置')}</p></div><div id="laboratory-live"></div>`
      render(); load()
    }, update() { render() }, selectPanel(next) { panel = next; render() }, load }
}
