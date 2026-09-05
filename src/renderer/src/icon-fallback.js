/**
 * 图标加载失败兜底：把 <img> 换成品牌色圆角块 + 首字母的 data-URI，
 * 避免 CDN 偶发失败时出现裂图。同一次失败只兜底一次，防止 data-URI 再触发 error 死循环。
 */
export function iconFallback(e, name = '?', color = '#2d6a4f') {
  const img = e?.target
  if (!img || img.dataset.fallback) return
  img.dataset.fallback = '1'
  const letter = String(name || '?').trim().charAt(0).toUpperCase() || '?'
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48">` +
    `<rect width="48" height="48" rx="12" fill="${color}"/>` +
    `<text x="24" y="32" font-family="system-ui,sans-serif" font-size="22" font-weight="700" fill="#fff" text-anchor="middle">${letter}</text>` +
    `</svg>`
  img.src = 'data:image/svg+xml;utf8,' + encodeURIComponent(svg)
}
