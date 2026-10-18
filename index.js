import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { analyzePage, extractRegion } from './vendor/page-struct/index.mjs'

export const name = 'page-struct'
export const inject = ['tools']

const DEFAULT_CACHE_TTL_MS = 120_000
const DEFAULT_CACHE_MAX = 3
const DEFAULT_CUA_PROFILE = 'dsh-page-struct'

function numberOr(value, fallback) {
  const n = Number(value)
  return Number.isFinite(n) && n >= 0 ? n : fallback
}

function integerOr(value, fallback) {
  const n = Math.floor(Number(value))
  return Number.isFinite(n) && n >= 1 ? n : fallback
}

/** Cache key: same page + same tab target + same browser. */
function keyOf(rawUrl, endpoint, tab, targetId) {
  let url = String(rawUrl ?? '')
  if (url && !/^(https?|file|data):/i.test(url)) {
    const abs = resolve(url)
    url = existsSync(abs) ? pathToFileURL(abs).href : abs
  }
  return `${url}\n${endpoint}\n${tab}\n${targetId}`
}

/** Read the random CDP port browser_prepare wrote for a named CUA profile. */
function cuaPort(name) {
  const root = process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local')
  const portFile = join(root, 'CuaDriver', 'BrowserProfiles', name, 'DevToolsActivePort')
  if (!existsSync(portFile)) return undefined
  const port = String(readFileSync(portFile, 'utf8')).split(/\r?\n/)[0].trim()
  return /^\d+$/.test(port) ? port : undefined
}

/** Turn a raw failure into an actionable message without hiding the original. */
function explain(error) {
  const message = String(error?.message ?? error)
  if (/本地文件不存在/.test(message)) {
    return `${message}。请传绝对路径或 file:// URL。`
  }
  if (/没找到 Edge\/Chrome/.test(message)) {
    return `${message}。请安装 Edge/Chrome，或在插件配置里设置 exe。`
  }
  if (/CUA 浏览器/.test(message)) {
    return `${message}。先用 browser_prepare 启动 isolated_named profile，或传 endpoint="host:port"；本地测试可用 endpoint=""。`
  }
  if (/CDP endpoint 不可用|ECONNREFUSED|fetch failed/i.test(message)) {
    return `${message}。确认目标浏览器已开启 --remote-debugging-port，且端口可达。`
  }
  if (/ERR_|net::|proxy|tunnel/i.test(message)) {
    return `${message}。注意：proxy 只对 endpoint="" 的临时浏览器生效；CUA/已有浏览器要在它自己启动时配代理。`
  }
  return message
}

export function apply(ctx, config = {}) {
  const defaultProxy = typeof config.proxy === 'string' ? config.proxy : ''
  const configuredEndpoint = typeof config.endpoint === 'string' ? config.endpoint.trim() : ''
  const defaultEndpoint = configuredEndpoint || `cua:${DEFAULT_CUA_PROFILE}`
  const cuaProfile = typeof config.cuaProfile === 'string' && config.cuaProfile.trim()
    ? config.cuaProfile.trim()
    : DEFAULT_CUA_PROFILE
  const browserExe = typeof config.exe === 'string' ? config.exe : ''
  const cacheTtlMs = numberOr(config.cacheTtlMs, DEFAULT_CACHE_TTL_MS)
  const cacheMax = integerOr(config.cacheMax, DEFAULT_CACHE_MAX)

  const cache = new Map()
  let queue = Promise.resolve()

  async function cdpAlive(port) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`, {
        signal: AbortSignal.timeout(1000),
      })
      return response.ok
    } catch {
      return false
    }
  }

  /**
   * The CUA browser owns the process, profile, and login state. This plugin only
   * resolves the CDP port; it never launches or keeps a browser alive.
   * `auto` is kept as an alias for `cua:<cuaProfile>`.
   */
  async function resolveEndpoint(raw) {
    const value = String(raw ?? '').trim()
    if (!value) return ''
    if (value.toLowerCase() === 'auto') return resolveEndpoint(`cua:${cuaProfile}`)

    const match = /^cua(?::(.+))?$/i.exec(value)
    if (!match) return value

    const name = (match[1] || cuaProfile).trim()
    const port = cuaPort(name)
    if (!port) {
      throw new Error(`CUA 浏览器未运行：找不到 profile "${name}"`)
    }
    if (!(await cdpAlive(port))) {
      throw new Error(`CUA 浏览器未运行：profile "${name}" 的端口 ${port} 无响应`)
    }
    return `127.0.0.1:${port}`
  }

  const endpointOf = (args) => resolveEndpoint(args.endpoint ?? defaultEndpoint)
  const tabOf = (args) => (args.tab === 'current' || args.targetId ? 'current' : 'new')
  const keyFor = (args, endpoint) => keyOf(args.url, endpoint, tabOf(args), args.targetId ?? '')

  const lookup = async (args) => {
    const endpoint = await endpointOf(args)
    const key = keyFor(args, endpoint)
    const entry = cache.get(key)
    if (!entry) return undefined
    if (Date.now() - entry.at > cacheTtlMs) {
      cache.delete(key)
      return undefined
    }
    return entry
  }

  const remember = (args, endpoint, result) => {
    const key = keyFor(args, endpoint)
    cache.delete(key)
    cache.set(key, {
      at: Date.now(),
      model: result.model,
      text: result.text,
      bytes: result.bytes,
    })
    while (cache.size > cacheMax) {
      const oldest = cache.keys().next().value
      if (oldest === undefined) break
      cache.delete(oldest)
    }
  }

  // CUA drives one browser; serialize our calls so we never race its CDP port.
  const exclusive = (task) => {
    const run = queue.then(task, task)
    queue = run.then(() => undefined, () => undefined)
    return run
  }

  const analyze = (args, budget) => exclusive(async () => {
    const endpoint = await endpointOf(args)
    const result = await analyzePage(args.url, {
      ...(budget ? { budget } : {}),
      ...(endpoint ? { endpoint } : { proxy: args.proxy ?? defaultProxy }),
      ...(args.tab ? { tab: args.tab } : {}),
      ...(args.targetId ? { targetId: args.targetId } : {}),
      ...(browserExe ? { exe: browserExe } : {}),
    })
    remember(args, endpoint, result)
    return result
  })

  ctx.tools.register({
      name: 'page_structure',
      description:
        '读取网页的结构化表示：区域索引、表格坐标矩阵（行列数与表头层数）、shadow DOM 内部字段、代码/日志块，' +
        '并标注哪块内容读不到（high / partial / unreliable）。适用于取表格精确值、读 Web Components 内部状态、' +
        '判断页面结构是否可靠。**只读，不操作页面；需要点击/输入时用其他工具。** ' +
        '依赖 CUA 浏览器：默认 endpoint=cua:dsh-page-struct，需先用 browser_prepare 启动 isolated_named profile ' +
        'dsh-page-struct，并在那个可见窗口登录。默认新开标签页；tab="current" 读现有标签页（不新建、不导航）。' +
        'CUA 没开时会明确报错；本地测试/国外临时页可传 endpoint=""。',
      parameters: {
        type: 'object',
        properties: {
          url: {
            type: 'string',
            description: '页面 URL、file:// 地址，或本地 .html/.mhtml 绝对路径；tab="current" 时可省略',
          },
          budget: {
            type: 'number',
            description: '输出字符预算，默认 6000；超预算时保留索引与不可靠标记，细节用 page_region 取',
          },
          proxy: {
            type: 'string',
            description: '仅对 endpoint="" 的临时浏览器生效；CUA/已有浏览器需在启动时自行配代理',
          },
          endpoint: {
            type: 'string',
            description: 'cua:<profile>（默认）/ host:port / ""（一次性临时浏览器）',
          },
          tab: {
            type: 'string',
            description: '"new"（默认，新开标签页）或 "current"（读现有标签页，不导航）',
          },
          targetId: {
            type: 'string',
            description: '可选，精确指定现有 page target；用于 tab="current"',
          },
        },
      },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: value }],
      },
      timeoutMs: 60000,
      isConcurrencySafe: () => false,
      async execute(args) {
        try {
          if (!args.url && args.tab !== 'current' && !args.targetId) {
            throw new Error('需要 url，或传 tab="current"')
          }
          const result = await analyze(args, args.budget)
          return result.text
        } catch (error) {
          throw new Error(`page_structure 读取失败：${explain(error)}`)
        }
      },
  })

  ctx.tools.register({
      name: 'page_region',
      description:
        '按 regionId 取 page_structure 索引里某个区域的完整明细（预算裁剪后仍想看某一块时用）。' +
        '会优先复用同一 URL 最近一次分析，不重新连接浏览器；缓存过期或首次调用才重新读取。' +
        'regionId 规则：T* 表格 / P* 伪表格 / X* 行式内容块 / S:<host> shadow / C* canvas。' +
        '**只读，不操作页面；需要点击/输入时用其他工具。**',
      parameters: {
        type: 'object',
        properties: {
          url: {
            type: 'string',
            description: '与之前 page_structure 调用相同的页面 URL 或本地路径；tab="current" 时可省略',
          },
          regionId: {
            type: 'string',
            description: '索引表第一列的 id，如 T1 / P1 / X1 / S:user-card#card / C1',
          },
          proxy: {
            type: 'string',
            description: '仅对 endpoint="" 的临时浏览器生效；CUA/已有浏览器需在启动时自行配代理',
          },
          endpoint: {
            type: 'string',
            description: 'cua:<profile> / host:port / ""；省略时用插件配置值',
          },
          tab: {
            type: 'string',
            description: '"new" 或 "current"；与 page_structure 保持一致才能命中缓存',
          },
          targetId: {
            type: 'string',
            description: '可选，精确指定现有 page target；与 page_structure 保持一致',
          },
        },
        required: ['regionId'],
      },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: value }],
      },
      timeoutMs: 60000,
      isConcurrencySafe: () => false,
      async execute(args) {
        try {
          if (!args.url && args.tab !== 'current' && !args.targetId) {
            throw new Error('需要 url，或传 tab="current"')
          }
          const cached = await lookup(args)
          const result = cached ?? await analyze(args, 6000)
          const region = extractRegion(result.model, args.regionId)
          if (!region) {
            const ids = [
              ...(result.model.tables || []).map((x) => x.regionId),
              ...(result.model.pseudoTables || []).map((x) => x.regionId),
              ...(result.model.textBlocks || []).map((x) => x.regionId),
              ...(result.model.shadows || []).map((x) => 'S:' + x.host),
              ...(result.model.canvases || []).map((x) => x.regionId),
            ]
            return `找不到区域 ${args.regionId}；可用区域：${ids.join(', ')}`
          }
          return JSON.stringify(region.data, null, 2)
        } catch (error) {
          throw new Error(`page_region 读取失败：${explain(error)}`)
        }
      },
  })
}
