// core/probe/builtin-snapshot.mjs — 内置 browser_snapshot 的 1:1 复刻（A 臂）
//
// 依据 v1.39.8 源码 internal/browser/cdp/script.go 的 bootstrapJS → W.snapshot。
// 冻结参考实现：不要"顺手优化"它，否则 A 臂就不再是真实基线了。
//
// 注：bin/compare-a1.mjs 与 tools/compare-live.mjs 里各有一份内联副本（同源），
// 新代码一律从这里 import；旧脚本待后续合并。
export const BUILTIN_SNAPSHOT = `(() => {
  const flat = (s) => (s || '').replace(/\\s+/g, ' ').trim();
  const clip = (s, n) => (s && s.length > n ? s.slice(0, n) + '…' : s || '');
  const SKIP = new Set(['script','style','noscript','template','head','meta','link','title','svg','path','br']);
  const ROLES = { a:'link', button:'button', select:'combobox', textarea:'textbox', summary:'disclosure',
    h1:'heading', h2:'heading', h3:'heading', h4:'heading', h5:'heading', h6:'heading',
    img:'image', table:'table', th:'columnheader', td:'cell', li:'listitem', form:'form' };
  const INPUT_ROLES = { text:'textbox', search:'searchbox', checkbox:'checkbox', radio:'radio',
    button:'button', submit:'button', email:'textbox', password:'textbox', number:'textbox' };
  const typeOf = (el) => flat(el.getAttribute('type') || '').toLowerCase();
  const roleOf = (el) => {
    const explicit = flat(el.getAttribute('role'));
    if (explicit) return explicit;
    const tag = el.tagName.toLowerCase();
    if (tag === 'input') return INPUT_ROLES[typeOf(el)] || 'textbox';
    return ROLES[tag] || '';
  };
  const nameOf = (el, allowText) => {
    const aria = flat(el.getAttribute('aria-label'));
    if (aria) return clip(aria, 160);
    const attr = flat(el.getAttribute('alt') || el.getAttribute('title') || el.getAttribute('placeholder'));
    if (attr) return clip(attr, 160);
    if (!allowText) return '';
    return clip(flat(el.innerText || el.textContent), 160);
  };
  const interactive = (el) => {
    const tag = el.tagName.toLowerCase();
    if (tag === 'a') return el.hasAttribute('href');
    if (tag === 'button' || tag === 'select' || tag === 'textarea' || tag === 'summary') return true;
    if (tag === 'input') return typeOf(el) !== 'hidden';
    if (el.isContentEditable) return true;
    if (el.hasAttribute('tabindex') || el.hasAttribute('onclick')) return true;
    const role = flat(el.getAttribute('role'));
    return ['button','link','checkbox','radio','tab','menuitem','switch','option','textbox','searchbox'].includes(role);
  };
  const visible = (el) => {
    if (typeof el.checkVisibility === 'function') return el.checkVisibility({ checkVisibilityCSS: true });
    return el.getClientRects().length > 0;
  };
  const attrsOf = (el) => {
    const out = [];
    if (el.disabled) out.push('disabled');
    if (el.checked) out.push('checked');
    if (el.required) out.push('required');
    if (el.getAttribute('aria-expanded') === 'true') out.push('expanded');
    if (el.tagName === 'A' && el.getAttribute('href')) out.push('href=' + clip(el.getAttribute('href'), 120));
    return out.length ? ' [' + out.join(' ') + ']' : '';
  };
  const lines = [];
  let refs = 0;
  let left = 1e9;
  const pad = (d) => '  '.repeat(Math.min(d, 20));
  const walk = (el, depth) => {
    if (left <= 0 || depth > 40) return;
    for (const node of el.childNodes) {
      if (left <= 0) return;
      if (node.nodeType === 3) {
        const text = flat(node.textContent);
        if (text) { left--; lines.push(pad(depth) + '- text: ' + clip(text, 200)); }
        continue;
      }
      if (node.nodeType !== 1 || SKIP.has(node.tagName.toLowerCase()) || !visible(node)) continue;
      const role = roleOf(node);
      const leaf = node.children.length === 0;
      if (interactive(node)) {
        const ref = 'e' + (++refs);
        left--;
        lines.push(pad(depth) + '- ' + (role || 'control') + ' ' + JSON.stringify(nameOf(node, true)) + attrsOf(node) + ' [ref=' + ref + ']');
        if (!leaf && node.tagName !== 'SELECT' && node.tagName !== 'TEXTAREA') walk(node, depth + 1);
        continue;
      }
      if (role) {
        left--;
        lines.push(pad(depth) + '- ' + role + ' ' + JSON.stringify(nameOf(node, leaf)));
        if (!leaf) walk(node, depth + 1);
        continue;
      }
      walk(node, depth);
    }
  };
  walk(document.body || document.documentElement, 0);
  return { tree: lines.join('\\n'), lineCount: lines.length, refCount: refs };
})()`
