// core/probe/inpage.js — 页面内探针（纯读取，不产生 ref、不改页面）
//
// 用法：把整个文件内容作为 Runtime.evaluate 的 expression 注入。
// 约定：返回一个普通对象（可 JSON 序列化），由宿主侧做可信度裁定与序列化。
//
// 与 Reasonix 内置 browser_snapshot 的关键差异（见 DESIGN §2.1）：
//   1. 穿透 open shadow DOM（内置实现只走 childNodes）
//   2. 表格展开成坐标矩阵（内置实现只把 td 压成 "- text: …"）
//   3. canvas 主动探测图表库实例（内置实现零表示）
(() => {
  const flat = (s) => (s || '').replace(/\s+/g, ' ').trim()
  const clip = (s, n) => (s && s.length > n ? s.slice(0, n) + '…' : s || '')
  const MAX_TEXT = 200

  const notes = []
  const pushNote = (regionId, reason, fallback) => notes.push({ regionId, reason, fallback })

  // ---------- 1. 表格：展开 rowspan/colspan 成坐标矩阵 ----------

  function expandTable(table) {
    const rows = Array.from(table.rows) // 含 thead + tbody + tfoot
    const grid = []
    const merges = []
    const occupied = new Set()
    // owner[r][c] = 覆盖该格的单元格文本，用于拍平表头时回溯被 colspan/rowspan 覆盖的父级
    const owner = []

    rows.forEach((tr, r) => {
      if (!grid[r]) grid[r] = []
      let c = 0
      for (const cell of Array.from(tr.cells)) {
        while (occupied.has(r + ',' + c)) c++
        const rs = cell.rowSpan || 1
        const cs = cell.colSpan || 1
        const text = flat(cell.innerText || cell.textContent)
        grid[r][c] = text
        if (rs > 1 || cs > 1) {
          merges.push({ r, c, rowSpan: rs, colSpan: cs, text: clip(text, 40) })
        }
        for (let dr = 0; dr < rs; dr++) {
          const rr = r + dr
          if (!grid[rr]) grid[rr] = []
          if (!owner[rr]) owner[rr] = []
          for (let dc = 0; dc < cs; dc++) {
            owner[rr][c + dc] = text
            if (dr === 0 && dc === 0) continue
            grid[rr][c + dc] = null
            occupied.add(rr + ',' + (c + dc))
          }
        }
        c += cs
      }
    })

    const headerLevels = table.tHead ? table.tHead.rows.length : 0
    const cols = Math.max(0, ...grid.map((row) => row.length))

    // 把多级表头拍平成每列的完整路径："收入 / 现金"
    const headerPaths = []
    for (let c = 0; c < cols; c++) {
      const parts = []
      for (let r = 0; r < headerLevels; r++) {
        const raw = grid[r] ? grid[r][c] : null
        // 被合并覆盖的格子（null）回溯到所属单元格，否则会丢掉父级像 "收入"
        const v = raw != null ? raw : owner[r] ? owner[r][c] : null
        if (v && v !== parts[parts.length - 1]) parts.push(v)
      }
      headerPaths.push(parts.join(' / '))
    }

    const id = table.id ? '#' + table.id : ''
    const caption = clip(flat(table.caption ? table.caption.textContent : ''), 60)
    return {
      id,
      caption,
      rows: grid.length,
      cols,
      headerLevels,
      headerPaths,
      grid,
      merges,
    }
  }

  // 证据裁定：全部支持 → high；有反对但仍有支持 → partial；几乎无支持 → unreliable
  function judge(evidence) {
    if (!evidence.length) return 'unreliable'
    const against = evidence.filter((e) => !e.supports)
    const forIt = evidence.filter((e) => e.supports)
    if (against.length === 0) return 'high'
    if (forIt.length === 0) return 'unreliable'
    if (against.length >= forIt.length) return 'unreliable'
    return 'partial'
  }

  function collectTables() {
    const out = []
    const tables = Array.from(document.querySelectorAll('table'))
    tables.forEach((t, i) => {
      const et = expandTable(t)
      et.regionId = 'T' + (i + 1)

      // ---- 多源证据：标签 / 一致性 / 渲染 ----
      const evidence = []
      const hasThead = !!t.tHead
      const thCount = t.querySelectorAll('th').length

      if (hasThead) evidence.push({ kind: 'label', detail: '有 <thead>', supports: true })
      if (thCount > 0) evidence.push({ kind: 'label', detail: `${thCount} 个 <th>`, supports: true })
      if (!hasThead && thCount === 0) {
        // 关键：GitHub 等站点用 <table> 做代码块/布局，没有表头语义
        evidence.push({ kind: 'label', detail: '没有 <thead> 也没有 <th>（可能是布局表格）', supports: false })
      }

      const ragged = et.grid.some((row) => row.length !== et.cols && row.length > 0)
      if (ragged) {
        evidence.push({ kind: 'consistency', detail: '行宽不一致', supports: false })
      } else if (et.rows > 0) {
        evidence.push({ kind: 'consistency', detail: `${et.rows} 行 × ${et.cols} 列，行宽一致`, supports: true })
      }

      const cells = Array.from(t.querySelectorAll('td,th'))
      if (cells.length) {
        const longCells = cells.filter((c) => flat(c.textContent).length > 80).length
        const mostlyLong = longCells > cells.length * 0.3
        evidence.push({
          kind: 'render',
          detail: mostlyLong
            ? `${longCells}/${cells.length} 个单元格文本超长（更像代码/正文容器）`
            : '单元格文本短且规整',
          supports: !mostlyLong,
        })
      }

      et.evidence = evidence
      et.confidence = judge(evidence)

      const against = evidence.filter((e) => !e.supports)
      if (against.length) {
        pushNote(
          et.regionId,
          '证据冲突：' + against.map((e) => e.detail).join('；'),
          et.confidence === 'unreliable'
            ? '当布局容器读取，不要假定它是数据表格或表头语义'
            : '仍按坐标矩阵读取，但行列语义存疑'
        )
      }
      out.push(et)
    })
    return out
  }

  // ---------- 1b. 伪表格：div/grid 布局但结构像表格（GitLab / 自定义 DOM）----------

  function detectPseudoTables(limit = 5) {
    const out = []
    const candidates = document.querySelectorAll('div, ul, section, dl')
    for (const el of candidates) {
      if (out.length >= limit) break
      if (el.closest('table')) continue // 真表格内部，跳过
      if (el.querySelector('table')) continue

      const cs = getComputedStyle(el)
      if (!/grid|table/.test(cs.display)) continue

      const kids = Array.from(el.children)
      if (kids.length < 3) continue

      // 子元素结构一致性：tagName 序列相同，才像是"行"
      const sig = (n) => Array.from(n.children).map((c) => c.tagName).join('>')
      const sigs = kids.map(sig).filter(Boolean)
      if (sigs.length < 3) continue
      const same = sigs.filter((s) => s === sigs[0]).length
      if (same / sigs.length < 0.8) continue

      const cellCount = kids[0].children.length
      if (cellCount < 2) continue

      const regionId = 'P' + (out.length + 1)
      const evidence = [
        { kind: 'label', detail: '没有 <table> 标签', supports: false },
        { kind: 'render', detail: `display:${cs.display}，${kids.length} 个同构子元素`, supports: true },
        {
          kind: 'consistency',
          detail: `${same}/${sigs.length} 个子元素结构一致，每个 ${cellCount} 个单元`,
          supports: true,
        },
      ]

      out.push({
        regionId,
        confidence: judge(evidence),
        evidence,
        childCount: kids.length,
        cellCount,
        sample: clip(flat(kids[0].textContent), 120),
      })
      pushNote(
        regionId,
        '疑似 grid/flex 布局的表格（自定义 DOM），列语义无法可靠推断',
        '按行文本读取；需要精确字段请提供站点适配器或改用接口数据'
      )
    }
    return out
  }

  // ---------- 1c. 行式内容块：代码 / 日志 / 自定义行列表 ----------
  //
  // 为什么需要：GitHub 的代码既不是 <pre> 也不是 <code>，而是带哈希 class 的
  // .react-code-lines（14k 字符）。class 名改版就变，所以只能靠**渲染特征**识别：
  //   同质子元素多 + 各行文本量接近 + 等宽字体 + 无交互元素
  function collectTextBlocks(limit = 4) {
    const out = []
    const picked = [] // 已选中的元素，用于剔除嵌套重复
    const cands = document.querySelectorAll('div, section, article, pre')

    let checked = 0
    for (const el of cands) {
      if (out.length >= limit || checked >= 200) break
      // 便宜预筛：子元素数不够直接跳过。
      // 大页面有几千个 div，逐个调 getComputedStyle 会把耗时从 2s 推到 30s+。
      const isPre = el.tagName === 'PRE'
      const childCount = el.children.length
      if (!isPre && (childCount < 8 || childCount > 300)) continue
      checked++
      if (el.closest('table')) continue
      if (el.parentElement && el.parentElement.closest('table')) continue
      // 嵌套的容器会被重复捕获（外层包内层），只保留最合适的那个
      if (picked.some((p) => p.contains(el) || el.contains(p))) continue

      const kids = Array.from(el.children)
      // 注意：这里只取 length，不调用 flat()。
      // flat(el.textContent) 会对整个子树做正则替换，是上一版 31s 卡顿的真正原因。
      if (el.textContent.length < 400) continue
      const textLen = el.textContent.length

      const cs = getComputedStyle(el)
      // 行内元素文本量应接近（同质行），否则更像普通布局容器。
      // 同样只取 length，不做正则替换。
      const lens = kids.map((k) => k.textContent.length)
      const avg = lens.length ? lens.reduce((a, b) => a + b, 0) / lens.length : 0
      let cv = 0
      if (avg > 3) {
        const variance = lens.reduce((a, b) => a + (b - avg) ** 2, 0) / lens.length
        cv = Math.sqrt(variance) / avg
      }
      if (!isPre && (avg < 3 || cv > 1.5)) continue

      // 等宽字体通常在行元素而不是外层容器上（GitHub 的容器是 Mona Sans，行才是等宽），
      // 所以要往下探 2 层再判定。
      const MONO_RE = /mono|consolas|courier|menlo|source code/i
      let mono = false
      for (const probe of [el, ...kids.slice(0, 2)]) {
        if (MONO_RE.test(getComputedStyle(probe).fontFamily)) {
          mono = true
          break
        }
        const gc = probe.firstElementChild
        if (gc && MONO_RE.test(getComputedStyle(gc).fontFamily)) {
          mono = true
          break
        }
      }
      const interactive = el.querySelectorAll('a[href],button,input,select,textarea').length

      // 交互元素过多 → 这是导航 / 工具栏 / 卡片列表，不是代码或日志。
      // 之前只把它当"反对证据"降级，结果 runoob 的导航区被误报成行式内容块。
      if (interactive > Math.max(3, kids.length * 0.5)) continue

      // 嵌套在更外层同质容器里时跳过（避免把外层包装器也算一遍）
      if (el.querySelector('pre')) continue

      const lineCount = isPre ? (el.textContent.match(/\n/g) || []).length + 1 : kids.length
      const evidence = [
        {
          kind: 'render',
          detail: isPre
            ? `<pre> 容器，${lineCount} 行`
            : `${kids.length} 个同质子元素（文本量变异系数 ${cv.toFixed(2)}）`,
          supports: true,
        },
        {
          kind: 'render',
          detail: mono ? '等宽字体' : `非等宽字体（${cs.fontFamily.split(',')[0]}）`,
          supports: mono,
        },
        {
          kind: 'label',
          detail: interactive ? `内部含 ${interactive} 个交互元素` : '无交互元素',
          supports: interactive === 0,
        },
      ]

      const regionId = 'X' + (out.length + 1)
      // 样本：只在最后对前 30 行做 flat（此处才值得付正则成本）
      const allLines = isPre
        ? el.textContent.split('\n').filter((l) => l.trim())
        : kids.map((k) => flat(k.textContent))
      const sampleLines = allLines.slice(0, 30).map((l) => clip(l, 160))
      out.push({
        regionId,
        kind: mono ? 'code' : 'lines',
        lineCount,
        charCount: textLen,
        sampleLines,
        truncated: allLines.length > 30,
        confidence: judge(evidence),
        evidence,
      })
      picked.push(el)

      if (evidence.some((e) => !e.supports)) {
        pushNote(
          regionId,
          '行式内容块，证据不完全一致：' + evidence.filter((e) => !e.supports).map((e) => e.detail).join('；'),
          '按行文本读取；若需精确语义（这是代码还是日志）请结合上下文判断'
        )
      }
    }
    return out
  }

  // ---------- 2. Shadow DOM：递归 open shadow root ----------

  // 取可见文本：排除 style/script 自身的源码。
  // 注意：ShadowRoot 不可 cloneNode（"ShadowRoot nodes are not clonable."，Edge 实测），
  // 所以只能手工遍历 childNodes 过滤，不能抄 Element 的 clone-remove 写法。
  function visibleText(node) {
    const acc = []
    const walk = (n) => {
      if (!n) return
      if (n.nodeType === 3) {
        acc.push(n.textContent)
        return
      }
      if (n.nodeType !== 1 && n.nodeType !== 11) return
      const tag = n.tagName ? n.tagName.toUpperCase() : ''
      if (tag === 'STYLE' || tag === 'SCRIPT' || tag === 'NOSCRIPT') return
      for (const k of n.childNodes) walk(k)
    }
    try {
      walk(node)
    } catch {
      return flat(node.textContent)
    }
    return flat(acc.join(' '))
  }

  // 提取 shadow 内部的键值对（dl/dt/dd 结构）。
  // 否则字段会被拍成一行文本（"姓名 木 等级 Lv.42"），模型无法可靠区分键和值。
  function shadowFields(root) {
    const out = []
    for (const dl of Array.from(root.querySelectorAll('dl'))) {
      for (const dt of Array.from(dl.querySelectorAll('dt'))) {
        const dd = dt.nextElementSibling
        if (dd && dd.tagName === 'DD') {
          out.push({ key: clip(flat(dt.textContent), 40), value: clip(flat(dd.textContent), 80) })
        }
      }
    }
    return out
  }

  function collectShadows(maxDepth = 12) {
    const found = []
    const visit = (root, hostLabel, path, depth) => {
      if (depth > maxDepth) return
      const hosts = root.querySelectorAll('*')
      for (const el of hosts) {
        const sr = el.shadowRoot // closed 模式这里为 null，页面脚本拿不到
        if (!sr) continue
        const tag = el.tagName.toLowerCase()
        const label = tag + (el.id ? '#' + el.id : '')
        const childPath = path ? path + ' > ' + label : label
        const text = visibleText(sr)
        const inner = Array.from(sr.querySelectorAll('*')).filter(
          (n) => !/^(STYLE|SCRIPT|NOSCRIPT)$/.test(n.tagName)
        )
        found.push({
          host: label,
          path: childPath,
          depth,
          mode: 'open',
          elementCount: inner.length,
          headings: inner
            .filter((n) => /^H[1-6]$/.test(n.tagName))
            .map((n) => clip(flat(n.textContent), 80)),
          // 只要内部有 table，就把它的结构也取出来——这是内置快照完全看不到的
          tables: Array.from(sr.querySelectorAll('table')).length,
          fields: shadowFields(sr),
          textSample: clip(text, MAX_TEXT),
        })
        visit(sr, childPath, childPath, depth + 1)
      }
    }
    visit(document, '', '', 0)
    return found
  }

  // ---------- 3. Canvas：优先读图表库实例 ----------

  function collectCanvases() {
    const out = []
    const canvases = Array.from(document.querySelectorAll('canvas'))
    canvases.forEach((el, i) => {
      const regionId = 'C' + (i + 1)
      const info = {
        regionId,
        id: el.id ? '#' + el.id : '',
        width: el.width,
        height: el.height,
        detectedLibrary: 'unknown',
        series: null,
        confidence: 'unreliable',
      }
      // ECharts：实例上有完整 option，这是最可靠的来源
      try {
        const ec = window.echarts
        const inst = ec && typeof ec.getInstanceByDom === 'function' ? ec.getInstanceByDom(el) : null
        if (inst && typeof inst.getOption === 'function') {
          const opt = inst.getOption()
          info.detectedLibrary = 'echarts'
          info.confidence = 'high'
          info.series = (opt.series || []).map((s) => ({
            name: s.name,
            type: s.type,
            data: Array.isArray(s.data) ? s.data.slice(0, 200) : undefined,
          }))
          info.xAxis = (opt.xAxis || []).map((a) => a.data).filter(Boolean)
        }
      } catch (e) {
        info.probeError = 'echarts: ' + e.message
      }
      // Chart.js
      if (info.detectedLibrary === 'unknown') {
        try {
          const Chart = window.Chart
          const inst = Chart && typeof Chart.getChart === 'function' ? Chart.getChart(el) : null
          if (inst && inst.data) {
            info.detectedLibrary = 'chartjs'
            info.confidence = 'high'
            info.series = (inst.data.datasets || []).map((d) => ({
              name: d.label,
              data: Array.isArray(d.data) ? d.data.slice(0, 200) : undefined,
            }))
            info.labels = inst.data.labels
          }
        } catch (e) {
          info.probeError = 'chartjs: ' + e.message
        }
      }
      if (info.confidence === 'unreliable') {
        pushNote(
          regionId,
          'canvas 无 DOM 表示，且未检出已知图表库实例',
          '截图后用视觉模型读取，或让页面暴露数据接口'
        )
      }
      out.push(info)
    })
    return out
  }

  // ---------- 4. 语义大纲 + 虚拟滚动嫌疑 ----------

  function collectOutline() {
    const heads = Array.from(document.querySelectorAll('h1,h2,h3,h4,h5,h6')).map((h) => ({
      level: Number(h.tagName[1]),
      text: clip(flat(h.textContent), 100),
    }))

    const interactive = document.querySelectorAll(
      'a[href],button,input,select,textarea,summary,[role],[tabindex]'
    ).length

    // 虚拟滚动嫌疑：容器可滚动但子元素数量明显偏少
    const virtualSuspects = []
    const scrollables = document.querySelectorAll('div,ul,ol,section,main')
    for (const el of scrollables) {
      const cs = getComputedStyle(el)
      const scrollable = /(auto|scroll)/.test(cs.overflowY)
      if (!scrollable) continue
      const visibleRows = el.children.length
      if (el.scrollHeight > el.clientHeight * 3 && visibleRows > 0 && visibleRows < 60) {
        const id = 'V' + (virtualSuspects.length + 1)
        virtualSuspects.push({
          regionId: id,
          visibleChildren: visibleRows,
          scrollHeight: el.scrollHeight,
          clientHeight: el.clientHeight,
        })
        pushNote(
          id,
          `疑似虚拟滚动：容器可滚动（scrollHeight ${el.scrollHeight} / clientHeight ${el.clientHeight}），仅 ${visibleRows} 个直接子元素`,
          '需滚动采样才能取全量，当前结果只覆盖可视区'
        )
      }
    }

    return {
      headings: heads,
      interactiveCount: interactive,
      linkCount: document.querySelectorAll('a[href]').length,
      formCount: document.querySelectorAll('form').length,
      virtualSuspects,
    }
  }

  // ---------- 汇总 ----------

  const tables = collectTables()
  const pseudoTables = detectPseudoTables()
  const textBlocks = collectTextBlocks()
  const shadows = collectShadows()
  const canvases = collectCanvases()
  const outline = collectOutline()

  return {
    meta: {
      url: location.href,
      title: document.title,
      readyState: document.readyState,
      // 供宿主做去重/缓存：DOM 指纹（不含时间戳，保证同页稳定）
      fingerprint:
        document.title +
        '|' +
        document.querySelectorAll('*').length +
        '|' +
        (document.body ? document.body.childElementCount : 0),
    },
    tables,
    pseudoTables,
    textBlocks,
    shadows,
    canvases,
    outline,
    notes,
    stats: {
      nodeCount: document.querySelectorAll('*').length,
      tableCount: tables.length,
      pseudoTableCount: pseudoTables.length,
      textBlockCount: textBlocks.length,
      shadowCount: shadows.length,
      canvasCount: canvases.length,
    },
  }
})()
