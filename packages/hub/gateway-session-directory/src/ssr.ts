import type { Page } from './index.ts'
const escape = (value: string | number): string => String(value).replace(/[&<>"']/g, c => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[c] ?? c))
/** Mount only behind the gateway's existing single-operator authorization. */
export function renderDirectory(page: Page): string {
  const rows = page.entries.map(row => `<tr><td>${row.sessionUrl
    ? `<a href="${escape(row.sessionUrl)}" rel="noreferrer">${escape(row.title ?? row.sessionId)}</a>`
    : `${escape(row.title ?? row.sessionId)} <small>Native session link unavailable</small>`}</td>
<td><a href="${escape(row.nodeUrl)}" rel="noreferrer">Open node: ${escape(row.nodeName)}</a>
<small>${escape(row.nodeId)} / ${escape(row.runtimeId)} / ${escape(row.sessionId)}</small></td>
<td>${escape(row.updatedAt)}</td><td>${row.running ? 'Running' : row.agentAvailable ? 'Idle' : 'No live agent'}</td></tr>`).join('')
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<link rel="stylesheet" href="/hub.css"><title>Session directory experiment</title><body><main class="directory"><nav><a href="/">Nodes</a><a href="/sessions">Refresh directory</a></nav><h1>Session directory experiment</h1>
<p>Live metadata only. Paging can shift when activity changes. Session links open the full native DSH client on the owning node.</p>
<ul>${page.nodes.map(n => `<li>${escape(n.nodeId)} / ${escape(n.runtimeId)}: ${n.state}; ${n.count} sessions${n.truncated ? '; truncated' : ''}${n.cached ? '; briefly cached' : ''}</li>`).join('')}</ul>
<table><thead><tr><th>Session</th><th>Node / Runtime / Session ID</th><th>Activity (Unix ms)</th><th>Status</th></tr></thead><tbody>${rows}</tbody></table>
<p>${page.total} retained sessions</p><nav>${page.offset > 0 ? `<a href="?offset=${Math.max(0, page.offset - page.limit)}&amp;limit=${page.limit}">Previous</a>` : ''}
${page.nextOffset !== null ? `<a href="?offset=${page.nextOffset}&amp;limit=${page.limit}">Next</a>` : ''}</nav></main></body></html>`
}
export function directoryResponse(page: Page): Response {
  return new Response(renderDirectory(page), { headers: {
    'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer',
    'content-security-policy': "default-src 'none'; style-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
    'x-content-type-options': 'nosniff',
  } })
}
