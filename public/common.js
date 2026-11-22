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

// 출처 원문: 기본 접힘(앞 약 140자 요약), '원문 펼치기'로 연다. A·B 동일.
export const SUMMARY_CHARS = 140;
export const SPLIT_RE = /(?<=[.!?。])\s+(?=[^\s\d)])|;\s+/;
export function sourceSentences(s) {
  return (s.text || '').replace(/\s+/g, ' ').split(SPLIT_RE).filter((x) => x.trim().length > 1);
}
export function sourceHtml(s, si, { expanded, on = null, seen = [] }) {
  const meta = `<div class="meta">${s.edition ? `판본: <b>${esc(s.edition)}</b> · ` : ''}${s.kind === 'reconstructed' ? '재구성 발췌 · ' : ''}${s.url ? `<a href="${esc(s.url)}" target="_blank" rel="noopener">원문 링크</a>` : esc(s.key ?? '')}</div>`;
  const sents = sourceSentences(s);
  let body;
  if (!sents.length) body = '<p class="muted">발췌 없음 — 원문 링크를 열어 직접 확인</p>';
  else if (!expanded) {
    const flat = sents.join(' ');
    body = `<p class="summary" data-collapsed="1">${esc(flat.slice(0, SUMMARY_CHARS))}${flat.length > SUMMARY_CHARS ? '…' : ''}</p>
      <button data-act="expand-${si}" aria-label="출처 ${si + 1} 원문 펼치기">원문 펼치기 (${flat.length}자)</button>`;
  } else {
    body = `<p>${sents.map((t, j) => {
      const cls = on && on.source === si && on.sentence === j ? 'on' : seen.some((r) => r && r.source === si && r.sentence === j) ? 'seen' : '';
      return `<span class="ss ${cls}" id="ss-${si}-${j}">${esc(t)}</span>`;
    }).join(' ')}</p>`;
  }
  return `<div class="src" data-source="${si}"><h3>출처 ${si + 1}. ${esc(s.label)}</h3>${meta}${body}</div>`;
}
