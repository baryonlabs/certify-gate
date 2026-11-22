// 인증 화면(그림 5): 초안 ↔ 1차 출처 나란히, 불일치 강조, 대조 체크·쟁점 검토 게이트
import { api, header, statusBadge, esc, icon, qs } from '/common.js';

const $ = (id) => document.getElementById(id);
await header();
const id = qs.get('id');
const item = await api('GET', `/api/items/${encodeURIComponent(id)}?condition=A`);
const { session_id } = await api('POST', '/api/sessions', { item_id: id, condition: 'A', meta: qs.get('meta') });
const viewed = new Set();
const checked = new Set();
let gate = { ok: false, missing: [] };
let contestDone = !item.contested;

const FLAG_SOFT = new Set(['approx', 'causal', 'weak', 'no_source']);
const splitRe = /(?<=[.!?。])\s+(?=[^\s\d)])|;\s+/;

$('hdr').innerHTML = `<h2>${icon('file-text')} ${esc(item.label)} <code class="muted">${esc(item.id)}</code> ${statusBadge(item.status)}
  ${item.contested ? '<span class="badge contested">' + icon('scale') + '쟁점</span>' : ''}</h2>
  <p class="muted">에이전트 상태 '확인됨'은 인증이 아닙니다. 각 주장 문장을 원문 해당 위치와 직접 대조하세요.</p>`;

function renderDraft() {
  $('draft').innerHTML = item.analysis
    .map((a) => {
      const hard = a.flags.filter((f) => !FLAG_SOFT.has(f.type));
      const soft = a.flags.filter((f) => FLAG_SOFT.has(f.type));
      const cls = hard.length ? 'flagged' : soft.length ? 'soft' : '';
      return `<div class="sent ${cls} ${checked.has(a.idx) ? 'done' : ''}" data-sentence="${a.idx}">
        <div><b>문장 ${a.idx + 1}.</b> ${esc(a.text)}</div>
        ${hard.map((f) => `<div class="flag" data-flag="${f.type}">${icon('alert-triangle')} 불일치 의심 — ${esc(f.message)}</div>`).join('')}
        ${soft.map((f) => `<div class="flag soft" data-flag="${f.type}">${icon('alert-triangle')} ${esc(f.message)}</div>`).join('')}
        <div class="row">
          <button data-act="view-${a.idx}" aria-label="문장 ${a.idx + 1} 원문 위치 보기">${icon('eye')} 원문 위치 보기</button>
          <label><input type="checkbox" data-act="check-${a.idx}" aria-label="문장 ${a.idx + 1} 원문 대조 완료" ${viewed.has(a.idx) ? '' : 'disabled'} ${checked.has(a.idx) ? 'checked' : ''}> 원문과 대조함</label>
          ${a.ref ? `<span class="muted">대응 위치: 출처 ${a.ref.source + 1} · 문장 ${a.ref.sentence + 1}</span>` : ''}
        </div></div>`;
    })
    .join('');
}

function renderSources(on) {
  $('sources').innerHTML = item.sources
    .map((s, si) => {
      const sents = (s.text || '').replace(/\s+/g, ' ').split(splitRe).filter((x) => x.trim().length > 1);
      return `<div class="src" data-source="${si}"><h3>출처 ${si + 1}. ${esc(s.label)}</h3>
        <div class="meta">${s.edition ? `판본: <b>${esc(s.edition)}</b> · ` : ''}${s.kind === 'reconstructed' ? '재구성 발췌 · ' : ''}${s.url ? `<a href="${esc(s.url)}" target="_blank" rel="noopener">원문 링크</a>` : esc(s.key)}</div>
        <p>${sents.length ? sents.map((t, j) => `<span class="ss ${on && on.source === si && on.sentence === j ? 'on' : ''}" id="ss-${si}-${j}">${esc(t)}</span>`).join(' ') : '<span class="muted">발췌 없음 — 원문 링크를 열어 직접 확인</span>'}</p></div>`;
    })
    .join('');
}

function renderContest() {
  if (!item.contested) return;
  const c = $('contest');
  c.hidden = false;
  c.innerHTML = `<h2>${icon('scale')} [쟁점] 검토 — 출처가 서로 다른 해석을 지지합니다</h2>
    <p class="muted">두 해석은 모두 보존됩니다. 인증하려면 채택할 해석을 고르거나, 고를 수 없으면 보류 사유를 적으세요.</p>
    ${(item.interpretations || []).map((x) => `<label class="radio"><input type="radio" name="interp" value="${x.id}" data-act="interp-${x.id}" aria-label="해석 ${x.id}"> <span><b>${x.id}</b> ${esc(x.text)}</span></label>`).join('')}
    <label for="creason">해석 선택 불가 시 사유</label>
    <textarea id="creason" data-act="contest-reason" aria-label="쟁점 보류 사유"></textarea>
    <div class="row"><button class="primary" data-act="contest-submit">${icon('check')} 쟁점 검토 완료</button><span id="cmsg" class="muted"></span></div>`;
}

function renderGate() {
  const n = item.sentences.length;
  const allChecked = checked.size === n;
  $('gate').innerHTML = `<b>서명 조건</b>
    <span class="step ${allChecked ? 'ok' : 'todo'}" data-step="check">${icon(allChecked ? 'check' : 'clock')} ① 원문 대조 ${checked.size}/${n}</span>
    ${item.contested ? `<span class="step ${contestDone ? 'ok' : 'todo'}" data-step="contest">${icon(contestDone ? 'check' : 'clock')} ② 쟁점 검토 ${contestDone ? '완료' : '미완료'}</span>` : ''}
    <span class="muted">${gate.ok ? '서명 가능' : '서명 버튼 비활성'}</span>`;
  $('approve').disabled = !gate.ok;
}

function showErr(e) {
  $('err').textContent = e ? `${e.message}` : '';
}

document.addEventListener('click', async (ev) => {
  const t = ev.target.closest('[data-act]');
  if (!t || t.disabled) return;
  const act = t.dataset.act;
  try {
    if (act.startsWith('view-')) {
      const i = Number(act.slice(5));
      await api('POST', `/api/sessions/${session_id}/view`, { idx: i });
      viewed.add(i);
      const ref = item.analysis[i].ref;
      renderDraft(); renderSources(ref);
      if (ref) $(`ss-${ref.source}-${ref.sentence}`)?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    } else if (act.startsWith('check-')) {
      const i = Number(act.slice(6));
      const r = await api('POST', `/api/sessions/${session_id}/check`, { idx: i, checked: t.checked });
      t.checked ? checked.add(i) : checked.delete(i);
      gate = r.gate; renderDraft(); renderGate();
    } else if (act === 'contest-submit') {
      const choice = document.querySelector('input[name=interp]:checked')?.value ?? null;
      const reason = document.getElementById('creason').value;
      const r = await api('POST', `/api/sessions/${session_id}/contest`, { choice, reason });
      gate = r.gate;
      contestDone = !gate.missing.includes('contest');
      $('cmsg').textContent = contestDone ? (choice ? `해석 ${choice} 채택(다른 해석도 보존)` : '보류 사유 기록') : '해석을 고르거나 사유(5자 이상)를 적으세요';
      renderGate();
    } else if (['approve', 'hold', 'reject'].includes(act)) {
      const reason = $('reason').value;
      if (act !== 'approve' && reason.trim().length < 5) throw new Error('보류·거부는 사유(5자 이상)가 필요합니다');
      const r = await api('POST', `/api/sessions/${session_id}/decision`, { decision: act, reason });
      const ko = { approve: '승인(인증)', hold: '보류', reject: '거부' }[act];
      $('done').hidden = false;
      $('done').innerHTML = `${icon('check')} 결정이 기록되었습니다: <b data-decision="${act}">${ko}</b> → 상태 ${statusBadge(r.to_status)} · 기록 ID <code>${r.log_id}</code> <a href="/">목록으로</a>`;
      $('decision').querySelectorAll('button,textarea').forEach((b) => (b.disabled = true));
    }
    showErr(null);
  } catch (e) {
    showErr(e);
  }
});

$('rule').textContent = `승인(인증)은 ① 모든 주장 문장의 원문 대조 체크${item.contested ? ' ② [쟁점] 검토' : ''}를 마쳐야 활성화됩니다. 보류·거부는 언제든 가능하지만 사유가 필요하며, 항목은 초안으로 돌아갑니다.`;
renderDraft(); renderSources(null); renderContest(); renderGate();
document.body.dataset.ready = '1';
