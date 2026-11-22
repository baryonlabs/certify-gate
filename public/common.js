// 공통: API 호출, 토큰, 아이콘
export const qs = new URLSearchParams(location.search);
export function token() {
  return qs.get('token') || localStorage.getItem('cg_token') || 'human-dev-token';
}
export async function api(method, path, body) {
  const r = await fetch(path, {
    method,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token()}` },
    body: body ? JSON.stringify(body) : undefined,
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(j.message || r.statusText), { code: j.error, status: r.status });
  return j;
}
export const icon = (n) => `<span class="ic" style="--i:url(/icons/${n}.svg)" aria-hidden="true"></span>`;
export const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
export const STATUS_KO = { draft: '초안', verified: '확인됨', certified: '인증됨' };
export function statusBadge(s) {
  const ic = { draft: 'file-text', verified: 'robot', certified: 'user-check' }[s] || 'file-text';
  return `<span class="badge ${s}" data-status="${s}">${icon(ic)}${STATUS_KO[s] ?? s}</span>`;
}
export async function header() {
  const me = await api('GET', '/api/me');
  const el = document.createElement('header');
  el.className = 'top';
  el.innerHTML = `<a href="/">${icon('list-check')} certify-gate</a><span class="muted" style="color:#9fb0c3">AI 생성 지식의 사람 인증</span><span class="sp"></span>
    <span>${icon(me.role === 'agent' ? 'robot' : 'user-check')} ${esc(me.name ?? '로그인 안 됨')} (${esc(me.role ?? '-')})</span>`;
  document.body.prepend(el);
  return me;
}
