// core/serialize.mjs — StructureModel → 模型可读的「双段」文本
//
// 设计依据见 DESIGN.zh-CN.md §3.4 / §3.5：
//   1. 先给章节化索引（模型不用读完全文就能建立地图）
//   2. 再给区域细节（按需/按预算取舍）
//   3. 把「读不到的地方」显式写出来 —— 这是本层最容易被低估的价值
//
// 预算策略：索引与不可靠标记【必留】，细节按优先级吃剩余预算，
// 被丢弃的区域必须在输出里显式说明，不能让模型误以为不存在。

const DEFAULT_BUDGET = 6000

const CONF_MARK = { high: 'high', partial: 'partial', unreliable: 'unreliable' }

const esc = (s) => String(s ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ')
const clip = (s, n) => {
  const t = String(s ?? '')
  return t.length > n ? t.slice(0, n) + '…' : t
}

// ---------- 区域清单（索引表的行）----------

function regionRows(model) {
  const rows = []

  for (const t of model.tables || []) {
    const merges = t.merges.length
    const scale = `${t.rows} 行 × ${t.cols} 列` +
      (t.headerLevels > 1 ? `（${t.headerLevels} 层表头` : '（') +
      (merges ? `，${merges} 处合并）` : '）')
    rows.push({
      id: t.regionId,
      kind: 'table',
      label: t.caption || t.id || '(无标题表格)',
      scale,
      confidence: t.confidence,
      priority: 1,
    })
  }

  for (const s of model.shadows || []) {
    rows.push({
      id: 'S:' + s.host,
      kind: 'shadow',
      label: s.path,
      scale: `${s.elementCount} 元素${s.tables ? `，内部 ${s.tables} 个表格` : ''}`,
      confidence: 'high',
      priority: 2,
    })
  }

  for (const c of model.canvases || []) {
    rows.push({
      id: c.regionId,
      kind: 'canvas',
      label: c.id || '(无 id canvas)',
      scale: `${c.width}×${c.height}，${c.detectedLibrary === 'unknown' ? '未检出图表库' : c.detectedLibrary}`,
      confidence: c.confidence,
      priority: 3,
    })
  }

  for (const v of (model.outline && model.outline.virtualSuspects) || []) {
    rows.push({
      id: v.regionId,
      kind: 'list(疑似虚拟滚动)',
      label: `可滚动容器`,
      scale: `可视 ${v.visibleChildren} 子元素 / scrollHeight ${v.scrollHeight}`,
      confidence: 'unreliable',
      priority: 4,
    })
  }

  for (const p of model.pseudoTables || []) {
    rows.push({
      id: p.regionId,
      kind: 'pseudo-table(疑似)',
      label: '自定义 DOM 表格',
      scale: `${p.childCount} 行 × ${p.cellCount} 单元`,
      confidence: p.confidence,
      priority: 5,
    })
  }

  for (const b of model.textBlocks || []) {
    rows.push({
      id: b.regionId,
      kind: b.kind === 'code' ? 'code(行式)' : 'lines(行式)',
      label: b.kind === 'code' ? '代码/等宽内容块' : '行式内容块',
      scale: `${b.lineCount} 行 / ${b.charCount} 字符${b.truncated ? '（样本截断）' : ''}`,
      confidence: b.confidence,
      priority: 6,
    })
  }

  // 按优先级排序；同优先级内按区域编号的数字排序（避免 T10 排在 T2 前面）
  const idNum = (id) => {
    const m = String(id).match(/(\d+)/)
    return m ? Number(m[1]) : 9999
  }
  return rows.sort((a, b) => a.priority - b.priority || idNum(a.id) - idNum(b.id))
}

// ---------- 各段渲染 ----------

function renderHeader(model) {
  const rows = regionRows(model)
  const unreliable = rows.filter((r) => r.confidence === 'unreliable').length
  const usable = rows.length - unreliable
  const lines = []
  lines.push(`## 页面结构索引 (${rows.length} 区，${usable} 可用 / ${unreliable} 不可读)`)
  lines.push('')
  lines.push(`页面: ${model.meta.title || '(无标题)'}  ·  ${model.meta.url}`)
  lines.push('')
  lines.push('| # | 区域 | 类型 | 规模 | 可信度 |')
  lines.push('|---|---|---|---|---|')
  for (const r of rows) {
    lines.push(`| ${r.id} | ${esc(clip(r.label, 40))} | ${r.kind} | ${esc(r.scale)} | ${CONF_MARK[r.confidence]} |`)
  }
  return lines.join('\n')
}

function renderNotes(model) {
  const notes = model.notes || []
  if (!notes.length) return ''
  const lines = ['', '⚠ 不可靠区域（不要基于这些区域下结论）']
  for (const n of notes) {
    lines.push(`- **${n.regionId}** ${n.reason}`)
    lines.push(`  兜底：${n.fallback}`)
  }
  return lines.join('\n')
}

function renderTableDetail(t) {
  const lines = [`### ${t.regionId} ${t.caption || t.id || '表格'}（table / ${t.confidence}）`]
  if (t.headerLevels > 1) {
    lines.push(`多级表头已拍平为列路径：`)
    lines.push('')
    lines.push('| ' + t.headerPaths.map((h, i) => esc(h || `c${i}`)).join(' | ') + ' |')
    lines.push('|' + t.headerPaths.map(() => '---').join('|') + '|')
    for (let r = t.headerLevels; r < t.grid.length; r++) {
      const row = t.grid[r] || []
      const cells = []
      for (let c = 0; c < t.headerPaths.length; c++) {
        const v = row[c]
        cells.push(v === null || v === undefined ? '·' : esc(clip(v, 60)))
      }
      lines.push('| ' + cells.join(' | ') + ' |')
    }
  } else {
    lines.push('')
    lines.push('| ' + (t.grid[0] || []).map((v, i) => esc(clip(v ?? `c${i}`, 40))).join(' | ') + ' |')
    lines.push('|' + (t.grid[0] || []).map(() => '---').join('|') + '|')
    for (let r = 1; r < t.grid.length; r++) {
      const row = t.grid[r] || []
      lines.push('| ' + row.map((v) => (v === null || v === undefined ? '·' : esc(clip(v, 60)))).join(' | ') + ' |')
    }
  }
  if (t.merges.length) {
    lines.push('')
    lines.push(
      '合并信息：' +
        t.merges.map((m) => `r${m.r}c${m.c} 跨 ${m.rowSpan}×${m.colSpan}${m.text ? `("${clip(m.text, 20)}")` : ''}`).join('；')
    )
  }
  appendEvidence(lines, t)
  return lines.join('\n')
}

/** 只在结论不是 high 时输出证据，避免给确定的结果增加噪音和预算 */
function appendEvidence(lines, region) {
  if (!region.evidence || !region.evidence.length) return
  if (region.confidence === 'high') return
  lines.push('')
  lines.push('证据（✗ 表示与该结论相反）：')
  for (const e of region.evidence) {
    lines.push(`- ${e.supports ? '✓' : '✗'} [${e.kind}] ${e.detail}`)
  }
}

function renderPseudoTableDetail(p) {
  const lines = [`### ${p.regionId} 自定义 DOM 表格（pseudo-table / ${p.confidence}）`]
  lines.push(`结构：${p.childCount} 个同构行，每行 ${p.cellCount} 个单元`)
  lines.push(`首行样本：${clip(p.sample, 200)}`)
  lines.push('')
  lines.push('注意：这**不是** <table>，是 grid/flex 布局。列的语义只能靠位置推断，不可靠。')
  appendEvidence(lines, p)
  return lines.join('\n')
}

function renderTextBlockDetail(b) {
  const lines = [
    `### ${b.regionId} ${b.kind === 'code' ? '代码/等宽内容块' : '行式内容块'}（${b.kind} / ${b.confidence}）`,
  ]
  lines.push(`共 ${b.lineCount} 行 / ${b.charCount} 字符${b.truncated ? '；以下只列前 30 行样本' : ''}`)
  lines.push('')
  // 用缩进块而不是 ``` 围栏：内容本身可能含反引号，围栏会被破坏
  for (const l of b.sampleLines) lines.push('    ' + l)
  appendEvidence(lines, b)
  return lines.join('\n')
}

function renderShadowDetail(s) {
  const lines = [`### ${s.path}（shadow / open / high）`]
  lines.push(`元素 ${s.elementCount} 个${s.tables ? `，内部表格 ${s.tables} 个（已计入上方表格清单之外）` : ''}`)
  if (s.headings && s.headings.length) lines.push(`内部标题：${s.headings.map((h) => `「${clip(h, 40)}」`).join(' ')}`)
  // 键值对优先于自由文本：模型能直接取字段，不用从一行字里猜边界
  if (s.fields && s.fields.length) {
    lines.push('')
    lines.push('| 字段 | 值 |')
    lines.push('|---|---|')
    for (const f of s.fields) lines.push(`| ${esc(f.key)} | ${esc(f.value)} |`)
  }
  lines.push('')
  lines.push(`文本：${clip(s.textSample, 300)}`)
  return lines.join('\n')
}

function renderCanvasDetail(c) {
  const lines = [`### ${c.regionId} ${c.id || 'canvas'}（canvas / ${c.confidence}）`]
  lines.push(`尺寸 ${c.width}×${c.height}，来源 ${c.detectedLibrary}`)
  if (c.series && c.series.length) {
    lines.push('series（来自图表库实例，可信）：')
    for (const s of c.series) {
      const data = Array.isArray(s.data) ? s.data.slice(0, 12) : s.data
      lines.push(`- ${s.name || '(未命名)'} [${s.type || '?'}] = ${JSON.stringify(data)}`)
    }
    if (c.xAxis) lines.push(`xAxis: ${JSON.stringify(c.xAxis.slice(0, 12))}`)
  } else {
    lines.push('无可读数据：canvas 本身没有 DOM 表示，且未检出图表库实例。')
  }
  return lines.join('\n')
}

function renderOutline(model) {
  const o = model.outline || {}
  const lines = ['', '### 页面大纲（可靠，可作导航）']
  if (o.headings && o.headings.length) {
    lines.push(o.headings.map((h) => `${'  '.repeat(Math.max(0, h.level - 1))}- h${h.level} ${clip(h.text, 60)}`).join('\n'))
  }
  lines.push(
    `交互元素 ${o.interactiveCount ?? '?'} 个 · 链接 ${o.linkCount ?? '?'} · 表单 ${o.formCount ?? '?'}`
  )
  return lines.join('\n')
}

// ---------- 主入口 ----------

/**
 * @param {object} model 探针返回的原始结构
 * @param {object} [opts]
 * @param {number} [opts.budget] 字符预算，默认 6000
 * @param {boolean} [opts.includeOutline] 是否附页面大纲，默认 true
 */
export function serialize(model, opts = {}) {
  const budget = opts.budget ?? DEFAULT_BUDGET
  const includeOutline = opts.includeOutline !== false

  // 1) 必留段：索引 + 不可靠标记
  const head = renderHeader(model)
  const notes = renderNotes(model)
  let used = head.length + notes.length
  const parts = [head, notes]
  const dropped = []
  const truncatedDetails = []

  // 2) 细节段：按优先级吃剩余预算
  const details = []
  for (const t of model.tables || []) details.push({ id: t.regionId, priority: 1, render: () => renderTableDetail(t) })
  for (const s of model.shadows || []) details.push({ id: 'S:' + s.host, priority: 2, render: () => renderShadowDetail(s) })
  for (const c of model.canvases || []) details.push({ id: c.regionId, priority: 3, render: () => renderCanvasDetail(c) })
  for (const p of model.pseudoTables || []) details.push({ id: p.regionId, priority: 5, render: () => renderPseudoTableDetail(p) })
  for (const b of model.textBlocks || []) details.push({ id: b.regionId, priority: 6, render: () => renderTextBlockDetail(b) })
  details.sort((a, b) => a.priority - b.priority)

  for (const d of details) {
    const text = '\n\n' + d.render()
    if (used + text.length <= budget) {
      parts.push(text)
      used += text.length
    } else {
      dropped.push(d.id)
    }
  }

  // 3) 大纲（可选，最后吃预算）
  if (includeOutline) {
    const o = renderOutline(model)
    if (used + o.length <= budget) {
      parts.push(o)
      used += o.length
    } else {
      truncatedDetails.push('大纲')
    }
  }

  // 4) 自报家底：任何被裁掉的东西都要说出来
  const meta = []
  if (dropped.length) meta.push(`因预算限制省略细节：${dropped.join('、')}（索引里仍有规模与可信度）`)
  if (truncatedDetails.length) meta.push(`因预算限制省略：${truncatedDetails.join('、')}`)
  meta.push(`统计：节点 ${model.stats.nodeCount} · 表格 ${model.stats.tableCount} · 伪表格 ${model.stats.pseudoTableCount ?? 0} · shadow ${model.stats.shadowCount} · canvas ${model.stats.canvasCount} · 输出 ${used} 字符 / 预算 ${budget}`)
  parts.push('\n---\n' + meta.join('\n'))

  const text = parts.filter(Boolean).join('\n').trim() + '\n'
  return {
    text,
    bytes: text.length,
    budget,
    dropped,
    truncated: dropped.length > 0 || truncatedDetails.length > 0,
  }
}

export { DEFAULT_BUDGET }
