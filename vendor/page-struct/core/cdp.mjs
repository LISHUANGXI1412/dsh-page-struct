// core/cdp.mjs — 零依赖 CDP 客户端
//
// 设计约束（见 DESIGN.zh-CN.md §2.5 决策）：
//   - 不依赖 npm 包，只用 Node 22 内置的 fetch 与 WebSocket
//   - 能接「任意 CDP 会话」：自己拉起的浏览器、外部已开的 Chrome/Edge、将来 DSH 内置浏览器
//   - 日志一律走 stderr，stdout 留给数据
import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const log = (...a) => console.error('[cdp]', ...a)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 轮询 /json/version 直到浏览器就绪，返回其内容 */
async function waitForEndpoint(port, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs
  let lastErr = ''
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`)
      if (res.ok) return await res.json()
      lastErr = `HTTP ${res.status}`
    } catch (e) {
      lastErr = e.message
    }
    await sleep(200)
  }
  throw new Error(`CDP endpoint 未就绪（port=${port}, ${timeoutMs}ms）: ${lastErr}`)
}

/**
 * 自己拉起一个浏览器。
 * @param {object} opts
 * @param {string} opts.exe        浏览器可执行文件路径
 * @param {number} [opts.port]     调试端口，0 表示由系统分配（不可用于轮询，故默认固定）
 * @param {boolean} [opts.headless]
 * @returns {Promise<{child, profileDir, endpoint, close}>}
 */
export async function launchBrowser({ exe, port = 9222, headless = true, windowSize = '1280,900', proxy = '' } = {}) {
  if (!exe) throw new Error('launchBrowser 需要 opts.exe')
  const profileDir = mkdtempSync(join(tmpdir(), 'pagestruct-profile-'))
  const args = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profileDir}`,
    `--window-size=${windowSize}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-features=Translate,MediaRouter,OptimizationHints',
  ]
  // 走代理：local-proxy 自管 127.0.0.1:7897 且永不改系统代理，
  // 所以浏览器不会自动跟随，必须显式传 --proxy-server。
  if (proxy) {
    args.push(`--proxy-server=${proxy}`)
    log(`proxy: ${proxy}`)
  }
  args.push('about:blank')
  if (headless) args.unshift('--headless=new')

  log(`launch: ${exe} port=${port} headless=${headless}`)
  log(`profile: ${profileDir}`)
  const child = spawn(exe, args, { stdio: ['ignore', 'pipe', 'pipe'] })

  child.on('error', (e) => log('spawn error:', e.message))
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (d) => {
    const s = String(d).trim()
    // Chrome 会把大量内部日志打到 stderr，只保留有用的
    if (s && /DevTools listening|ERROR|error/i.test(s)) log('stderr:', s.slice(0, 200))
  })

  const endpoint = await waitForEndpoint(port)
  log(`ready: ${endpoint.Browser} | ${endpoint.webSocketDebuggerUrl}`)

  const close = async () => {
    // Windows 上 child.kill() 只杀主进程，renderer/GPU 子进程会变成孤儿，
    // 而且 stdio 管道不关闭会让 Node 事件循环一直挂着 → 进程退不出来（实测多花 30 秒）。
    // 用 taskkill /T 杀整棵进程树，并显式销毁管道。
    try {
      child.stderr?.destroy()
      child.stdout?.destroy()
    } catch {}
    try {
      if (process.platform === 'win32' && child.pid) {
        spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
      } else {
        child.kill('SIGKILL')
      }
    } catch (e) {
      log('kill 失败（可忽略）:', e.message)
    }

    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 3000)
      child.once('exit', () => {
        clearTimeout(timer)
        resolve()
      })
    })

    try {
      rmSync(profileDir, { recursive: true, force: true })
      log('profile 已清理')
    } catch (e) {
      log('profile 清理失败（可忽略）:', e.message)
    }
  }

  return { child, profileDir, endpoint, close }
}

/**
 * 连接一个浏览器级 CDP 会话。
 * 也可直接传入现有浏览器的 ws 地址（外部 Chrome / 将来的 DSH 内置浏览器）。
 */
export async function connect(webSocketDebuggerUrl) {
  const ws = new WebSocket(webSocketDebuggerUrl)
  let nextId = 1
  const pending = new Map()

  await new Promise((resolve, reject) => {
    ws.addEventListener('open', () => resolve(), { once: true })
    ws.addEventListener('error', (e) => reject(new Error(`WS 连接失败: ${e?.message ?? 'unknown'}`)), { once: true })
  })
  log('WS 已连接')

  ws.addEventListener('message', (ev) => {
    let msg
    try {
      msg = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data))
    } catch {
      return
    }
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id)
      pending.delete(msg.id)
      if (msg.error) reject(new Error(`${msg.error.message} (code ${msg.error.code})`))
      else resolve(msg.result)
    }
    // 事件回调（目前只需要 load 等待，用轮询替代，故不派发）
  })

  /**
   * 发一条 CDP 命令。
   * @param {string} method
   * @param {object} [params]
   * @param {string} [sessionId] 目标会话（null 表示浏览器级）
   */
  const send = (method, params = {}, sessionId) => {
    const id = nextId++
    const payload = { id, method, params }
    if (sessionId) payload.sessionId = sessionId
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject })
      try {
        ws.send(JSON.stringify(payload))
      } catch (e) {
        pending.delete(id)
        reject(e)
      }
      setTimeout(() => {
        if (pending.has(id)) {
          pending.delete(id)
          reject(new Error(`CDP 超时: ${method}`))
        }
      }, 30000)
    })
  }

  const close = () => {
    try {
      ws.close()
    } catch {}
  }

  return { send, close, ws }
}

/**
 * 新建一个 tab 并 attach，返回可发页面级命令的句柄。
 */
export async function openPage(browser, url) {
  const { targetId } = await browser.send('Target.createTarget', { url: 'about:blank' })
  const { sessionId } = await browser.send('Target.attachToTarget', { targetId, flatten: true })
  log(`target 已创建 targetId=${targetId} sessionId=${sessionId}`)

  await browser.send('Page.enable', {}, sessionId)
  await browser.send('Runtime.enable', {}, sessionId)

  const page = {
    targetId,
    sessionId,
    send: (method, params) => browser.send(method, params, sessionId),
  }

  if (url) await navigate(page, url)
  return page
}

/**
 * Attach to an existing page target without creating a tab or navigating.
 * Selection: explicit targetId > exact URL match > last non-blank page.
 * CDP does not expose the "active" tab, so the last-page heuristic is explicit.
 */
export async function openExistingPage(browser, { targetId = '', url = '' } = {}) {
  const { targetInfos = [] } = await browser.send('Target.getTargets')
  const pages = targetInfos.filter((target) => target.type === 'page')
  if (pages.length === 0) throw new Error('没有可读的标签页')

  const norm = (value) => String(value || '').replace(/#.*$/, '')
  let chosen
  if (targetId) {
    chosen = pages.find((target) => target.targetId === targetId)
    if (!chosen) throw new Error(`找不到 targetId=${targetId} 的标签页`)
  } else if (url) {
    const wanted = norm(url)
    const exact = pages.filter((target) => norm(target.url) === wanted)
    chosen = exact[exact.length - 1]
    if (!chosen) {
      const prefixed = pages.filter((target) => norm(target.url).startsWith(wanted))
      chosen = prefixed[prefixed.length - 1]
    }
  }
  if (!chosen) {
    const usable = pages.filter((target) => target.url && target.url !== 'about:blank')
    chosen = usable[usable.length - 1] || pages[pages.length - 1]
  }

  const { sessionId } = await browser.send('Target.attachToTarget', {
    targetId: chosen.targetId,
    flatten: true,
  })
  log(`attach 现有标签页 targetId=${chosen.targetId} url=${chosen.url || '(blank)'}`)

  await browser.send('Page.enable', {}, sessionId)
  await browser.send('Runtime.enable', {}, sessionId)

  return {
    targetId: chosen.targetId,
    sessionId,
    url: chosen.url,
    send: (method, params) => browser.send(method, params, sessionId),
  }
}

/** 导航并等 load（用 readyState 轮询，避免依赖事件时序） */
export async function navigate(page, url, timeoutMs = 20000) {
  log(`navigate -> ${url}`)
  await page.send('Page.navigate', { url })
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const { result } = await page.send('Runtime.evaluate', {
      expression: 'document.readyState',
      returnByValue: true,
    })
    // interactive 就够：剩余渲染完成度交给 waitForStableDom 判断。
    // 硬等 complete 会让有长连接资源的页面白等满超时（实测 runoob 白等 20s）。
    if (result?.value && result.value !== 'loading') {
      log(`readyState=${result.value}`)
      return
    }
    await sleep(100)
  }
  log('load 等待超时，继续（可能仍在加载）')
}

/**
 * 等 DOM 稳定：连续 consecutive 次采样（间隔 intervalMs）节点数都不变才算稳定。
 *
 * 为什么需要：SPA 的 readyState=complete 早于渲染结束。实测同一个 Ant Design 页面，
 * 固定等待会得到 18 区 / 73 区两种结果——这是不可复现的根源，必须用稳定检测。
 */
export async function waitForStableDom(page, { intervalMs = 150, consecutive = 3, timeoutMs = 15000 } = {}) {
  const deadline = Date.now() + timeoutMs
  let last = -1
  let same = 0
  let samples = 0
  while (Date.now() < deadline) {
    const { result } = await page.send('Runtime.evaluate', {
      expression: 'document.querySelectorAll("*").length',
      returnByValue: true,
    })
    const n = result?.value ?? 0
    samples++
    if (n === last) {
      same++
      if (same >= consecutive) {
        log(`DOM 稳定: ${n} 节点（采样 ${samples} 次，连续 ${same} 次不变）`)
        return { stable: true, nodes: n, samples }
      }
    } else {
      same = 0
      last = n
    }
    await sleep(intervalMs)
  }
  log(`DOM 稳定等待超时（最后 ${last} 节点，采样 ${samples} 次），继续采集`)
  return { stable: false, nodes: last, samples }
}

/**
 * 在页面里执行一段函数体字符串，返回其返回值（by value）。
 * 这是本层唯一的"注入"入口：纯读取，不产生 ref、不改页面。
 */
export async function evaluate(page, expression) {
  const { result, exceptionDetails } = await page.send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
    allowUnsafeEvalBlockedByCSP: false,
  })
  if (exceptionDetails) {
    const msg = exceptionDetails.exception?.description || exceptionDetails.text || 'unknown'
    throw new Error(`页面执行异常: ${msg}`)
  }
  return result?.value
}

/**
 * 把当前页面存成自包含的 MHTML 快照（CDP 会内联 CSS / 图片等资源）。
 *
 * 用途：固定 A/B 的输入。活页面内容会变（价格、排序、新闻流），
 * 两臂看到的可能根本不是同一个页面状态，统计就没有可比性。
 */
export async function captureSnapshot(page) {
  const { data } = await page.send('Page.captureSnapshot', { format: 'mhtml' })
  log(`快照已采集: ${data.length} 字符`)
  return data
}

export { log }
