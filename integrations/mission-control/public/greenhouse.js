/* Live greenhouse view inside Mission Control; it consumes the owning runtime's authenticated snapshot. */
export function createGreenhouseView({ api, t, esc, num, available, openOperation, onSnapshot }) {
  let host, snapshot, cursor = 0, events = [], loading = false, failure = ''
  const actionNames = { light: '调节光照', temperature: '调节温控', water: '灌溉', inspect: '巡检',
    calibrate: '传感器校准', sample: '采样', assay: '检测', analyze: '分析' }
  const eventNames = { 'world-created': '温室已启动', 'environment-power': '供电变化', 'environment-sensor': '传感器异常',
    'environment-task': '新增实验需求', 'environment-range': '读数状态变化', 'operation-started': '操作已接受', 'operation-completed': '操作完成',
    'operation-failed': '操作失败', 'operation-cancelled': '操作已取消' }
  function comparisonCard(report) {
    if (!report) return ''
    const total = (run, field) => Object.values(run.perRoute).reduce((sum, route) => sum + route[field], 0)
    const rows = [
      ['试验标识', run => run.directory.split(/[\\/]/).slice(-2).join(' / ')],
      ['模型来源', run => t(run.source === 'real-model' ? '真实模型' : '脚本模型')],
      ['压缩阈值比例', run => run.compactionThresholdRatio == null ? '—' : `${num(run.compactionThresholdRatio * 100)}%`],
      ['实验完成', run => `${run.verification.completedTasks} / ${run.verification.tasks}`],
      ['任务与交付核验', run => t(run.verification.success ? '通过' : '尚未通过')],
      ['分析前参考输入', run => run.verification.referenceEvidence ? `${run.verification.referenceEvidence.filter(item => item.referenceInputObserved).length} / ${run.verification.referenceEvidence.length}` : '—'],
      ['事前直接成员消息', run => run.mode === 'single-agent' ? t('不适用') : run.verification.referenceEvidence ? `${run.verification.referenceEvidence.filter(item => item.peerMessageBeforeAnalysis).length} / ${run.verification.referenceEvidence.length}` : '—'],
      ['事前共享结果读取', run => run.verification.referenceEvidence ? `${run.verification.referenceEvidence.filter(item => item.sharedResultReadBeforeAnalysis).length} / ${run.verification.referenceEvidence.length}` : '—'],
      ['观测模拟步', run => num(run.verification.tick)],
      ['完成模拟步', run => run.allTaskCompletionTick === null ? t('尚未完成') : num(run.allTaskCompletionTick)],
      ['分析耗时（秒）', run => run.wallClock?.analysisLatencySeconds == null ? '—' : num(run.wallClock.analysisLatencySeconds)],
      ['活动记录跨度（秒）', run => run.wallClock ? num(run.wallClock.activitySpanSeconds) : '—'],
      ['输入 token', run => num(total(run, 'inputTokens'))], ['输出 token', run => num(total(run, 'outputTokens'))],
      ['模型请求', run => num(total(run, 'requests'))], ['请求重试', run => num(run.actualRequestRetries)],
      ['温度越界模拟步', run => num(run.verification.operatingMetrics.temperatureViolationTicks)],
      ['水分越界模拟步', run => num(run.verification.operatingMetrics.moistureViolationTicks)],
      ['水分越界占比', run => run.verification.tick ? `${num(run.verification.operatingMetrics.moistureViolationTicks / (3 * run.verification.tick) * 100)}%` : '—'],
      ['供电超载模拟步', run => num(run.verification.operatingMetrics.powerOverloadTicks)],
      ['人工设备提交', run => num(run.operatorSubmittedOperations)],
      ['压缩摘要', run => num(run.compactionEvents['compaction/summary'] || 0)],
      ['压缩失败', run => num(run.failedCompactions)],
      ['未闭合压缩记录', run => num(Math.max(0, (run.compactionEvents['compaction/start'] || 0) - (run.compactionEvents['compaction/end'] || 0)))],
    ]
    const checks = Object.values(report.matchingChecks)
    return `<section class="card"><div class="card-head"><span class="card-title">${t('单／多 Agent 对照')}</span><span class="spacer"></span><span class="tag">${t(report.comparisonReady ? '对照条件通过' : '对照条件尚未通过')}</span></div>
      <p class="kpi-note">${t('描述性记录，不自动判定架构优势')} · ${checks.filter(Boolean).length} / ${checks.length}</p>
      <p class="kpi-note">${t('通道计数可能重叠；共享读取不代表事前成员通信。')}</p>
      <p class="kpi-note">${t('累计用量与越界记录对应各自观测窗口，请结合观测模拟步解读。')}</p>
      <table><thead><tr><th>${t('指标')}</th><th>${t('单 Agent')}</th><th>${t('多 Agent')}</th></tr></thead><tbody>${rows.map(([label, value]) => `<tr><td>${t(label)}</td><td>${esc(value(report.single))}</td><td>${esc(value(report.multi))}</td></tr>`).join('')}</tbody></table></section>`
  }
  function render() {
    const root = host?.querySelector('#greenhouse-live')
    if (!root) return
    if (!available()) { root.innerHTML = `<div class="empty">${t('当前运行未挂载温室环境')}</div>`; return }
    if (!snapshot) { root.innerHTML = `<div class="empty">${esc(failure || t('正在读取温室状态…'))}</div>`; return }
    const { world, clock, mode, experiment } = snapshot
    if (mode === 'saved-report') {
      host.querySelector('.hero h1').textContent = t('温室对照报告')
      host.querySelector('.hero p').textContent = t('显示已保存的实验记录；此入口不启动模型、设备或环境时钟。')
      root.innerHTML = `<div class="greenhouse-notice" role="status">${t('已保存的对照报告 · 只读')}</div>${comparisonCard(snapshot.comparison)}`
      return
    }
    const running = world.activeOperations
    root.innerHTML = `<div class="greenhouse-notice" role="status">${t(mode === 'environment-only' ? '环境运行中 · 尚未启动 Agent，对照实验尚未开始' : mode === 'single-agent' ? experiment?.source === 'scripted' ? '单 Agent · 脚本模型联调，不是正式对照评测' : '单 Agent · 真实模型运行' : experiment?.source === 'scripted' ? '原生多 Agent · 脚本模型联调，不是真实书生评测' : '原生多 Agent · 真实模型运行')}
      ${failure ? `<strong>${esc(failure)}</strong>` : ''}${experiment?.phase === 'attention-required' ? `<strong>${t('运行需要处理，未判定成功')}${experiment.lastFailure ? ` · ${esc(experiment.lastFailure.actorId)}: ${esc(experiment.lastFailure.message)}` : ''}</strong>` : ''}${clock.failure ? `<strong>${esc(clock.failure)}</strong>` : ''}${experiment?.notifications?.failure ? `<strong>${t('环境通知异常：{error}', { error: esc(experiment.notifications.failure) })}</strong>` : ''}</div>
      <div class="kpis">${[
        ['模拟时刻', `${num(world.simulatedMinutes)} ${t('分钟')}`, `${t('模拟步')} ${world.tick}`],
        ['共享供电', `${num(world.requestedPower)} / ${num(world.powerCapacity)}`, t(world.requestedPower > world.powerCapacity ? '负载超出容量，实际光照已降低' : '供电正常')],
        ['共享水量', `${num(world.waterLitres)} L`, t(clock.running ? '环境独立推进中' : '环境时钟已停止')],
      ].map(([title, value, detail]) => `<div class="kpi"><div class="kpi-top">${t(title)}</div><div class="kpi-value">${esc(value)}</div><div class="kpi-note">${esc(detail)}</div></div>`).join('')}</div>
      ${experiment ? `<section class="card greenhouse-team"><div class="card-head"><span class="card-title">${t('温室协作团队')}</span><span class="spacer"></span><span class="tag">${t(experiment.source === 'scripted' ? '脚本模型' : '真实模型')}</span></div>
      <div class="greenhouse-members">${experiment.members.map(member => `<div><b>${esc(member.name)}</b><span>${esc(member.status)}</span><small>${esc(member.id)}</small></div>`).join('')}</div>
      <div class="greenhouse-run-metrics"><span>${t('模型请求：{n}', { n: experiment.metrics.requests })}</span><span>${t('输入 token：{n}', { n: experiment.metrics.inputTokens })}</span><span>${t('输出 token：{n}', { n: experiment.metrics.outputTokens })}</span><span>${t('工具错误：{n}', { n: experiment.metrics.toolErrors })}</span>${experiment.notifications ? `<span>${t('环境通知：{n}', { n: experiment.notifications.acceptedNotices })}</span>` : ''}<span>${t('模型异常：{n}', { n: experiment.metrics.modelErrors })}</span>${experiment.metrics.compactionSummaries !== undefined ? `<span>${t('压缩摘要：{n}', { n: experiment.metrics.compactionSummaries })}</span><span>${t('压缩失败：{n}', { n: experiment.metrics.compactionFailures })}</span>` : ''}</div>
      ${Object.entries(experiment.metrics.byProvider || {}).map(([provider, usage]) => `<div class="greenhouse-run-metrics"><b>${esc(provider)}</b><span>${t('模型请求：{n}', { n: usage.requests })}</span><span>${t('输入 token：{n}', { n: usage.inputTokens })}</span><span>${t('输出 token：{n}', { n: usage.outputTokens })}</span><span>${t('模型异常：{n}', { n: usage.modelErrors })}</span></div>`).join('')}</section>` : ''}
      ${comparisonCard(experiment?.comparison)}
      <div class="greenhouse-chambers">${world.chambers.map(c => `<section class="card greenhouse-chamber">
        <div class="card-head"><span class="card-title">${t('种植舱 {name}', { name: c.chamber })}</span><span class="spacer"></span><span class="tag">${t('传感器读数')}</span></div>
        <div class="greenhouse-readings"><div><span>${t('温度')}</span><b>${num(c.temperature)} °C</b></div><div><span>${t('基质水分')}</span><b>${num(c.moisture)}%</b></div>
        <div><span>${t('光照设定 / 实际')}</span><b>${num(c.lightSetting * 100)} / ${num(c.effectiveLight * 100)}%</b></div><div><span>${t('目标温度')}</span><b>${num(c.targetTemperature)} °C</b></div></div>
      </section>`).join('')}</div>
      <div class="ov-grid even"><section class="card"><div class="card-head"><span class="card-title">${t('实验任务')}</span><span class="spacer"></span><span class="tag">${world.completedTasks.length} / ${world.tasks.length}</span></div>
      ${world.tasks.map(task => `<div class="greenhouse-task"><div><b>${esc(task.id)}</b><span class="tag">${esc(task.chamber)}</span><span class="status ${world.completedTasks.includes(task.id) ? 'succeeded' : 'running'}">${t(world.completedTasks.includes(task.id) ? '已完成' : '待完成')}</span></div>
      <p>${esc(task.instructions)}</p><small>${t('所需独立检测：{n}', { n: task.requiredAssays })}${task.referenceTaskId ? ` · ${t('参考任务：{id}', { id: esc(task.referenceTaskId) })}` : ''}</small></div>`).join('')}</section>
      <section class="card"><div class="card-head"><span class="card-title">${t('设备与操作')}</span><span class="spacer"></span><span class="tag">${running.length}</span></div>
      ${running.length ? running.map(op => `<button class="greenhouse-operation" data-operation="${esc(op.id)}"><b>${t(actionNames[op.action] || op.action)}</b><span>${esc(op.resources.join(' · '))}</span><small>${t('完成模拟步：{n}', { n: op.dueTick })}</small></button>`).join('') : `<div class="empty">${t('当前没有运行中的设备操作')}</div>`}
      </section></div>
      ${experiment ? `<div class="ov-grid even"><section class="card"><div class="card-head"><span class="card-title">${t('协作任务板')}</span><span class="spacer"></span><span class="tag">${experiment.tasks.length}</span></div>
        ${experiment.tasks.length ? experiment.tasks.map(task => `<div class="greenhouse-task"><div><b>${esc(task.id)} · ${esc(task.title)}</b><span class="tag">${esc(task.assignee)}</span><span>${esc(task.status)}</span></div>${task.result ? `<p>${t('结果操作：{id}', { id: esc(task.result) })}</p>` : ''}</div>`).join('') : `<div class="empty">${t('等待负责人分派任务')}</div>`}</section>
      <section class="card"><div class="card-head"><span class="card-title">${t('成员信箱')}</span><span class="spacer"></span><span class="tag">${experiment.messages.length}</span></div>
        <div class="greenhouse-mailbox">${experiment.messages.length ? [...experiment.messages].reverse().map(message => `<div class="greenhouse-task"><div><b>${esc(message.from)} → ${esc(message.to)}</b><span>${t(message.delivery.status === 'failed' ? '投递失败' : message.read ? '已读取' : message.delivery.status === 'accepted' ? '已接受，未显式读取' : '待投递')}</span></div><p>${esc(message.content)}</p>${message.delivery.error ? `<small>${esc(message.delivery.error)}</small>` : ''}</div>`).join('') : `<div class="empty">${t('暂无成员消息')}</div>`}</div></section></div>` : ''}
      <section class="card"><div class="card-head"><span class="card-title">${t('温室事件')}</span><span class="spacer"></span><span class="tag">${t('实时')}</span></div>
      <div class="greenhouse-events">${events.length ? [...events].reverse().map(event => `<div class="greenhouse-event"><small>${t('模拟步')} ${event.tick}</small><b>${t(eventNames[event.kind] || event.kind)}</b><code>${esc(JSON.stringify(event.data))}</code></div>`).join('') : `<div class="empty">${t('暂无事件')}</div>`}</div></section>`
    root.querySelectorAll('[data-operation]').forEach(button => { button.onclick = () => openOperation(button.dataset.operation) })
  }
  async function load() {
    if (loading || !available()) return
    loading = true
    try {
      const next = await api(`/mc/greenhouse?after=${cursor}`)
      snapshot = next
      onSnapshot?.(next)
      events.push(...next.events)
      if (next.events.length) cursor = next.events[next.events.length - 1].seq
      events = events.slice(-100)
      failure = ''
    } catch (error) { failure = error.message }
    finally { loading = false; render() }
  }
  return { section: '科学执行', title: '火星温室',
    mount(stage) {
      host = stage
      stage.innerHTML = `<section class="hero"><div><div class="eyebrow">${t('虚拟实验室')}</div><h1>${t('火星温室')}</h1><p>${t('三个种植舱，共享设备与资源；状态来自正在运行的实验环境。')}</p></div></section><div id="greenhouse-live"></div>`
      render(); void load()
    }, update: render, load }
}
