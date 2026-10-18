// index.mjs — page-struct 门面 API
//
// 给宿主（Reasonix MCP / DSH 插件 / 任何脚本）只暴露一个函数：analyzePage。
// 内部负责：启动或连接浏览器 → 等 DOM 稳定 → 注入探针 → 序列化 → 清理。
//
// 约定：日志走 stderr，返回的对象不含任何需要清理的句柄。
import { readFileSync, existsSync, writeFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { tmpdir } from 'node:os'
import {
  launchBrowser,
  connect,
  openPage,
  openExistingPage,
  evaluate,
  waitForStableDom,
  captureSnapshot,
  log,
} from './core/cdp.mjs'
import { serialize, DEFAULT_BUDGET } from './core/serialize.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const PROBE = readFileSync(join(here, 'core', 'probe', 'inpage.js'), 'utf8')

export const DEFAULT_OPTIONS = {
  budget: DEFAULT_BUDGET, // 输出字符预算
  proxy: '', // 如 http://127.0.0.1:7897（local-proxy 永不改系统代理，必须显式传）
  endpoint: '', // 如 127.0.0.1:9222，复用已有浏览器
  tab: 'new', // 'new' 新建 tab；'current' attach 现有 tab（不导航）
  targetId: '', // 精确指定现有 page target（current 模式）
  headless: true,
  port: 9222,
  exe: '', // 留空则按 BROWSERS 顺序探测
  saveSnapshot: '', // 存 MHTML 快照的路径（固定 A/B 输入用）
  includeOutline: true,
}

const BROWSERS = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
]

function pickBrowser() {
  for (const p of BROWSERS) if (existsSync(p)) return p
  throw new Error('没找到 Edge/Chrome，请用 opts.exe 指定可执行文件')
}

/** 把 URL / 本地路径 / data: 统一成可导航的 URL */
function toUrl(target) {
  if (!target) throw new Error('缺少 target（URL 或本地文件路径）')
  if (/^https?:\/\//i.test(target) || /^file:\/\//i.test(target) || target.startsWith('data:')) return target
  const abs = resolve(target)
  if (!existsSync(abs)) throw new Error(`本地文件不存在: ${abs}`)
  return pathToFileURL(abs).href
}

/** 连接一个已存在的 CDP endpoint，返回其 ws 地址 */
async function wsFromEndpoint(endpoint) {
  const [host, port] = endpoint.split(':')
  const res = await fetch(`http://${host}:${port || 9222}/json/version`)
  if (!res.ok) throw new Error(`CDP endpoint 不可用: HTTP ${res.status}`)
  const info = await res.json()
  return info.webSocketDebuggerUrl
}

/**
 * 分析一个页面，返回结构化表示。
 *
 * @param {string} target URL / 本地 .html 路径 / data: URL / .mhtml 快照
 * @param {object} [opts] 见 DEFAULT_OPTIONS
 * @returns {Promise<{text: string, bytes: number, model: object, dropped: string[], elapsedMs: number, snapshot?: string}>}
 */
export async function analyzePage(target, opts = {}) {
  const o = { ...DEFAULT_OPTIONS, ...opts }
  const wantsCurrent = o.tab === 'current' || Boolean(o.targetId)
  if (wantsCurrent && !o.endpoint) {
    throw new Error('tab=current 需要 endpoint（连接已有浏览器）')
  }
  if (!target && !wantsCurrent) {
    throw new Error('缺少 target（URL 或本地文件路径）')
  }
  const url = target ? toUrl(target) : ''
  const t0 = Date.now()

  let browser = null
  let cdp = null
  let model
  let snapshot
  let pageTarget = null

  try {
    let wsUrl
    if (o.endpoint) {
      wsUrl = await wsFromEndpoint(o.endpoint)
      log(`复用已有浏览器: ${o.endpoint}`)
    } else {
      browser = await launchBrowser({
        exe: o.exe || pickBrowser(),
        port: o.port,
        headless: o.headless,
        proxy: o.proxy,
      })
      wsUrl = browser.endpoint.webSocketDebuggerUrl
    }

    cdp = await connect(wsUrl)
    const page = wantsCurrent
      ? await openExistingPage(cdp, { targetId: o.targetId, url })
      : await openPage(cdp, url)
    pageTarget = { targetId: page.targetId, pageUrl: page.url || '' }
    const stab = await waitForStableDom(page)
    log(`DOM 稳定: ${stab.nodes} 节点`)

    model = await evaluate(page, PROBE)
    log(`探针完成: 表格 ${model.stats.tableCount} · 伪表格 ${model.stats.pseudoTableCount} · 行式块 ${model.stats.textBlockCount} · shadow ${model.stats.shadowCount} · canvas ${model.stats.canvasCount}`)

    if (o.saveSnapshot) {
      snapshot = await captureSnapshot(page)
      const outPath = resolve(o.saveSnapshot)
      mkdirSync(dirname(outPath), { recursive: true })
      writeFileSync(outPath, snapshot, 'utf8')
      log(`快照已写入: ${outPath} (${(snapshot.length / 1024).toFixed(1)} KB)`)
    }
  } finally {
    if (cdp) cdp.close()
    if (browser) await browser.close()
  }

  const out = serialize(model, { budget: o.budget, includeOutline: o.includeOutline })
  log(`序列化完成: ${out.bytes} 字符（裁剪 ${out.dropped.length} 项）总耗时 ${Date.now() - t0}ms`)

  return {
    text: out.text,
    bytes: out.bytes,
    model,
    dropped: out.dropped,
    truncated: out.truncated,
    elapsedMs: Date.now() - t0,
    ...(pageTarget ? pageTarget : {}),
    ...(snapshot ? { snapshot } : {}),
  }
}

/**
 * 只取某个区域（regionId 如 T1 / S:host / C1 / X1 / P1）。
 * 用于"预算裁掉了细节，但我现在只想看某一块"的场景。
 */
export function extractRegion(model, regionId) {
  const pick = (arr, id) => (arr || []).find((x) => x.regionId === id || ('S:' + x.host) === id)
  const t = pick(model.tables, regionId)
  if (t) return { kind: 'table', data: t }
  const p = pick(model.pseudoTables, regionId)
  if (p) return { kind: 'pseudo-table', data: p }
  const b = pick(model.textBlocks, regionId)
  if (b) return { kind: 'text-block', data: b }
  const s = pick(model.shadows, regionId)
  if (s) return { kind: 'shadow', data: s }
  const c = pick(model.canvases, regionId)
  if (c) return { kind: 'canvas', data: c }
  return null
}

export { serialize, DEFAULT_BUDGET }
