# dsh-page-struct

**Read-only page structure for DSH, attached to the CUA browser.** Extract table coordinates, shadow-DOM fields, code blocks, and confidence labels — without screenshots or a full-page dump.

> 只读的页面结构读取器：CUA 负责浏览器和登录，page-struct 只负责把页面读成结构。不做点击、输入或页面操作。

## Architecture

```text
CUA browser (profile: %LOCALAPPDATA%\CuaDriver\BrowserProfiles\dsh-page-struct)
  │  CDP 127.0.0.1:<port>
  ├── CUA tools: browser_navigate / browser_click / browser_type
  └── dsh-page-struct: page_structure / page_region
        → same process, same cookies, same localStorage
```

The plugin **does not launch or keep a browser alive**. It reads the port that
`browser_prepare` wrote for the named CUA profile, attaches over CDP, and opens a
page in that same browser. CUA owns the browser lifecycle and the login state.

## Why

Native snapshots often lose the structure an agent needs:

- table row/column coordinates, merged cells, multi-level headers;
- shadow-DOM component fields (`等级 = Lv.42`);
- div/grid pseudo-tables that are not `<table>`;
- code/log blocks on GitHub-style pages;
- whether a region is trustworthy (`high` / `partial` / `unreliable`).

On the project's 4-page × 13-question benchmark, the structured representation made
**13/13** answers determinable versus **2/13** for a flat snapshot, with **10× fewer
characters**. See the upstream `page-struct` project for the benchmark and its caveats.

## Prerequisite: a running CUA browser

Start the named CUA profile once:

```text
browser_prepare({ profile: { mode: "isolated_named", name: "dsh-page-struct" } })
```

A visible Chrome window opens. Log in to the sites you need **in that window**.
The profile persists, so persistent cookies and localStorage survive restarts.

Then the plugin's default endpoint works:

```json
{ "url": "https://example.com" }
```

If the CUA browser is not running, the tool returns a clear error. Start it with
`browser_prepare` and retry. The plugin cannot start or keep it alive.

## Tools

| Tool | Purpose |
|---|---|
| `page_structure` | Region index, table matrices, shadow-DOM fields, code blocks, confidence evidence. |
| `page_region` | One region (`T1` / `P1` / `X1` / `S:<host>` / `C1`) after the index was truncated. Reuses the latest analysis when possible. |

Both tools are **read-only**. Use CUA/browser tools for clicks, typing, and navigation.

## Configuration

```yaml
config:
  proxy: ''
  endpoint: cua:dsh-page-struct
  cuaProfile: dsh-page-struct
  exe: ''
  cacheTtlMs: 120000
  cacheMax: 3
```

| Key | Meaning |
|---|---|
| `endpoint` | `cua:<profile>` (default), `host:port`, or `""` for a one-shot temporary browser. `auto` is an alias for `cua:<cuaProfile>`. |
| `cuaProfile` | Named CUA profile. Default `dsh-page-struct`. |
| `proxy` | **Only for `endpoint: ""`.** CUA/another browser must be configured with its own proxy at launch. |
| `exe` | Optional Edge/Chrome path for the one-shot temporary browser. |
| `cacheTtlMs` / `cacheMax` | In-memory snapshot cache used by `page_region`. |

### Endpoint modes

- `cua:dsh-page-struct` — attach to the running CUA browser. No new browser.
- `host:port` — attach to any browser already exposing CDP.
- `""` — launch a one-shot temporary browser (with `proxy` if set); useful for
  fixtures, offline snapshots, or foreign pages that need a proxy.

## Login state

CUA's `isolated_named` profile is a normal persistent Chrome profile:
persistent cookies and localStorage survive closing and re-running
`browser_prepare`. Session cookies (no `Max-Age`) still expire by design.

The plugin never touches your daily Edge/Chrome profile and never copies cookies.

## Reading the current tab

`page_structure({ tab: "current" })` attaches to an existing page in the CUA browser
**without creating a tab or navigating**. It shares cookies/login state and reads the
DOM as it is now (post-click, post-login, SPA route).

Selection order:

1. explicit `targetId`;
2. exact URL match (`url`), then URL prefix match;
3. the last non-blank page target.

CDP does not expose the "active" tab, so with multiple tabs pass `targetId` for an
exact target. The output's `页面:` line reports the URL that was actually read.

Examples:

```json
{ "tab": "current" }
{ "tab": "current", "url": "https://example.com/report" }
{ "tab": "current", "targetId": "A95662CFE231DF63DE2DAEF4049DAB6F" }
```

`page_region` accepts the same `tab`/`targetId` and reuses the analysis when the
cache key matches.

## Security and privacy

- Page content is returned to the DSH model as a tool result. The plugin does not
  send it to any third-party service of its own.
- The CUA browser is a real Chrome with a persistent profile. Treat it as a
  logged-in browser: do not expose its CDP port to untrusted local processes.
- `proxy` can route temporary-browser traffic through a proxy; CUA browser traffic
  follows the CUA browser's own launch configuration.
- The plugin runs in the DSH Host process and only reads pages; it does not click,
  type, download, or modify cookies.

## Limitations

- **Windows only.** It depends on CUA's native browser profile layout.
- **CUA must be running.** The plugin cannot start it; use `browser_prepare`.
- **Read-only.** No clicks, typing, scrolling, or navigation.
- **Tab selection heuristic.** With multiple open tabs, `tab:"current"` may pick the
  wrong one; pass `targetId` for an exact target.
- **Latency.** Reusing a warm browser is ~0.6–0.8s; a cold navigation can be
  1–2s. Large pages are truncated to the index; use `page_region` for details.
- **Unsupported content.** Closed shadow DOM, pure custom-drawn canvas, and some
  virtualized lists are marked `unreliable`.

## License

MIT. The vendored `page-struct` core (`vendor/page-struct/`) is also MIT; see its
`package.json` and upstream project for attribution.
