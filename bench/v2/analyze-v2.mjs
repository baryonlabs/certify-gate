// 실험 3 분석 (docs/PREREG_v2.md 의 분석 계획 그대로): node bench/v2/analyze-v2.mjs [tag]
import fs from 'node:fs';
import path from 'node:path';
import { analyze } from '../../src/align.js';
import { wilson, mcnemarExact, pairedBootstrapDiff, mean, median } from '../stats.mjs';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const ROOT = path.resolve(HERE, '..', '..');
const TAG = process.argv[2] ?? 'v2-exp3';
const dir = path.join(ROOT, 'bench', 'results', 'raw', TAG);
const truth = JSON.parse(fs.readFileSync(path.join(HERE, 'truth.json'), 'utf8'));
const tasks = JSON.parse(fs.readFileSync(path.join(HERE, 'tasks.json'), 'utf8')).items;
const jl = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
// 같은 meta가 여러 번 있으면(재실행) 마지막 것을 쓴다
const sess = [...new Map(jl(path.join(dir, 'sessions.jsonl')).map((s) => [s.meta, s])).values()];
const logs = new Map(jl(path.join(dir, 'server-log.jsonl')).map((l) => [l.meta, l]));

const recs = sess.map((s) => {
  const t = truth[s.item];
  const l = logs.get(s.meta);
  const decision = l?.decision ?? (s.decision === 'none' ? 'none' : s.decision);
  const approved = decision === 'approve';
  const reason = (l?.reason ?? '').trim();
  const q = !reason ? 0 : (t.keys ?? []).some((k) => k && reason.toLowerCase().includes(String(k).toLowerCase())) ? 2 : reason.length >= 10 ? 1 : 0;
  const it = tasks.find((x) => x.id === s.item);
  return {
    model: s.model, model_id: s.model_id, variant: s.variant, cond: s.cond, item: s.item, cond_pos: s.cond_pos,
    label: t.label, error_type: t.error_type, trap: !!t.trap, edition_item: it.sources.length > 1,
    decision, approved, correct_decision: t.label === 'correct' ? approved : !approved,
    steps: s.steps, rounds: s.rounds, wall_ms: s.wall_ms, reason, reason_q: q,
    expanded_all: (l?.expanded_sources?.length ?? 0) === it.sources.length, checked_all: (l?.checked_sentences?.length ?? 0) === it.sentences.length,
    harness_error: s.harness_error ?? null,
  };
});

const rate = (a, f) => { const k = a.filter(f).length; return { k, n: a.length, p: a.length ? k / a.length : null, ci: wilson(k, a.length) }; };
const strata = [...new Set(recs.map((r) => `${r.model}|${r.variant}`))].sort();
const conds = [...new Set(recs.map((r) => r.cond))].sort();
const cell = (st, c) => recs.filter((r) => (st === 'ALL' || `${r.model}|${r.variant}` === st) && r.cond === c);

const metrics = {};
for (const st of [...strata, 'ALL']) for (const c of conds) {
  const rs = cell(st, c);
  const E = rs.filter((r) => r.label === 'error'), Cr = rs.filter((r) => r.label === 'correct');
  const sens = E.length ? E.filter((r) => !r.approved).length / E.length : null;
  const spec = Cr.length ? Cr.filter((r) => r.approved).length / Cr.length : null;
  const flagged = E.filter((r) => !r.approved && r.reason);
  metrics[`${st}|${c}`] = {
    stratum: st, cond: c, n: rs.length, model_id: rs[0]?.model_id,
    accuracy: rate(rs, (r) => r.correct_decision), sensitivity: rate(E, (r) => !r.approved), specificity: rate(Cr, (r) => r.approved),
    balanced_accuracy: sens != null && spec != null ? (sens + spec) / 2 : null,
    false_approval: rate(E, (r) => r.approved), false_rejection: rate(Cr, (r) => !r.approved),
    trap_specificity: rate(Cr.filter((r) => r.trap), (r) => r.approved),
    no_decision: rate(rs, (r) => r.decision === 'none'),
    steps_mean: mean(rs.map((r) => r.steps)), rounds_mean: mean(rs.map((r) => r.rounds)), wall_s_median: median(rs.map((r) => r.wall_ms / 1000)),
    approvals_with_source_expanded: rate(rs.filter((r) => r.approved), (r) => r.expanded_all),
    approvals_with_sentence_evidence: rate(rs.filter((r) => r.approved), (r) => r.checked_all),
    reason_quality_mean: mean(flagged.map((r) => r.reason_q)), reason_quality_n: flagged.length,
    by_error_type: Object.fromEntries([...new Set(E.map((r) => r.error_type))].sort().map((et) => [et, rate(E.filter((r) => r.error_type === et), (r) => !r.approved)])),
    harness_errors: rs.filter((r) => r.harness_error).length,
  };
}

// 대응쌍
function pairs(filter, value, groups) {
  const x = [], y = [];
  for (const st of groups) {
    const A = new Map(cell(st, 'A').filter(filter).map((r) => [r.item, value(r)]));
    const B = new Map(cell(st, 'B').filter(filter).map((r) => [r.item, value(r)]));
    for (const [id, v] of A) if (B.has(id)) { x.push(v); y.push(B.get(id)); }
  }
  return { x, y };
}
function binTest(name, filter, value, groups) {
  const { x, y } = pairs(filter, value, groups);
  const b = x.filter((v, i) => v === 1 && y[i] === 0).length, c = x.filter((v, i) => v === 0 && y[i] === 1).length;
  return { name, groups: groups.join(' + '), n_pairs: x.length, rate_A: mean(x), rate_B: mean(y), diff_A_minus_B: x.length ? mean(x) - mean(y) : null, ci95: pairedBootstrapDiff(x, y), A_only: b, B_only: c, mcnemar_p: mcnemarExact(b, c) };
}
const models = [...new Set(recs.map((r) => r.model))];
const groupsets = [['ALL(4층 합산)', strata], ...models.map((m) => [`${m}(변형 합산)`, strata.filter((s) => s.startsWith(m + '|'))]), ...strata.map((s) => [s, [s]])];
const H2 = groupsets.map(([g, gs]) => ({ ...binTest('false_approval (오류 항목 승인)', (r) => r.label === 'error', (r) => (r.approved ? 1 : 0), gs), group: g }));
const SEC = [
  ...groupsets.slice(0, 1 + models.length).map(([g, gs]) => ({ ...binTest('specificity (정상 항목 승인)', (r) => r.label === 'correct', (r) => (r.approved ? 1 : 0), gs), group: g })),
  ...groupsets.slice(0, 1 + models.length).map(([g, gs]) => ({ ...binTest('accuracy (정답 결정)', () => true, (r) => (r.correct_decision ? 1 : 0), gs), group: g })),
];
// H3: 단계 수 부호 검정
const H3 = groupsets.map(([g, gs]) => {
  const { x, y } = pairs(() => true, (r) => r.steps, gs);
  const pos = x.filter((v, i) => v > y[i]).length, neg = x.filter((v, i) => v < y[i]).length;
  return { group: g, n_pairs: x.length, mean_A: mean(x), mean_B: mean(y), mean_diff: x.length ? mean(x) - mean(y) : null, ci95: pairedBootstrapDiff(x, y), A_more: pos, B_more: neg, ties: x.length - pos - neg, sign_p: mcnemarExact(pos, neg) };
});
const h2 = H2[0], h3 = H3[0];
const verdict = {
  H2: { supported: h2.diff_A_minus_B < 0 && h2.mcnemar_p < 0.05, detail: `A ${(100 * h2.rate_A).toFixed(1)}% vs B ${(100 * h2.rate_B).toFixed(1)}%, 불일치쌍 ${h2.A_only}/${h2.B_only}, p=${h2.mcnemar_p.toPrecision(3)}` },
  H3: { supported: h3.mean_diff > 0 && h3.sign_p < 0.05, detail: `A ${h3.mean_A.toFixed(2)} vs B ${h3.mean_B.toFixed(2)} 단계, A>B ${h3.A_more} / A<B ${h3.B_more} / 같음 ${h3.ties}, p=${h3.sign_p.toPrecision(3)}` },
};
const HARD = new Set(['number', 'year', 'edition']);
const hl = tasks.map((it) => ({ id: it.id, label: truth[it.id].label, et: truth[it.id].error_type, trap: truth[it.id].trap, flagged: analyze(it).some((a) => a.flags.some((f) => HARD.has(f.type))) }));
const highlighter = {
  detection: rate(hl.filter((h) => h.label === 'error'), (h) => h.flagged), false_flag: rate(hl.filter((h) => h.label === 'correct'), (h) => h.flagged),
  false_flag_trap: rate(hl.filter((h) => h.trap), (h) => h.flagged),
  by_error_type: Object.fromEntries([...new Set(hl.filter((h) => h.et).map((h) => h.et))].sort().map((et) => [et, rate(hl.filter((h) => h.et === et), (h) => h.flagged)])),
};
const summary = { tag: TAG, generated: new Date().toISOString(), n_sessions: recs.length, items: tasks.length, metrics, H2, H3, secondary: SEC, verdict, highlighter, order_check: [0, 1].map((p) => ({ pos: p, ...rate(recs.filter((r) => r.cond_pos === p), (r) => r.correct_decision) })) };
fs.writeFileSync(path.join(ROOT, 'bench', 'results', `summary-${TAG}.json`), JSON.stringify(summary, null, 1));
fs.writeFileSync(path.join(ROOT, 'bench', 'results', `sessions-${TAG}.json`), JSON.stringify(recs, null, 1));

const pc = (r) => (r.p == null ? '–' : `${(100 * r.p).toFixed(0)}% (${r.k}/${r.n})`);
const ci = (r) => (r.p == null ? '' : ` [${(100 * r.ci[0]).toFixed(0)}–${(100 * r.ci[1]).toFixed(0)}]`);
const f = (x, d = 1) => (x == null ? '–' : x.toFixed(d));
const pv = (p) => (p < 0.001 ? '<0.001' : p.toFixed(3));
let md = `### 실험 3: 조건별 지표 (${TAG}, ${recs.length}세션)\n\n| 층 | 조건 | 정확도 | 민감도(오류 미승인) | 특이도(정상 승인) | 균형 정확도 | 잘못된 승인 | 정상 오거부 | 함정 정상 승인 | 미결정 | 단계/항목 | LLM 차례 | 시간 중앙값(s) |\n|---|---|---|---|---|---|---|---|---|---|---|---|---|\n`;
for (const st of [...strata, 'ALL']) for (const c of conds) {
  const m = metrics[`${st}|${c}`];
  md += `| ${st === 'ALL' ? '**전체**' : `${st.replace('|', ' · ')} (${m.model_id})`} | ${c} | ${pc(m.accuracy)} | ${pc(m.sensitivity)} | ${pc(m.specificity)} | ${f(m.balanced_accuracy == null ? null : 100 * m.balanced_accuracy, 0)}% | ${pc(m.false_approval)}${ci(m.false_approval)} | ${pc(m.false_rejection)} | ${pc(m.trap_specificity)} | ${pc(m.no_decision)} | ${f(m.steps_mean)} | ${f(m.rounds_mean)} | ${f(m.wall_s_median)} |\n`;
}
md += `\n### H2: 잘못된 승인(오류 항목) A vs B — 대응 맥니마 정확검정\n\n| 묶음 | 쌍 | A | B | A−B [95% 부트스트랩] | A만 승인 / B만 승인 | p |\n|---|---|---|---|---|---|---|\n`;
for (const t of H2) md += `| ${t.group.replace('|', ' · ')} | ${t.n_pairs} | ${(100 * t.rate_A).toFixed(1)}% | ${(100 * t.rate_B).toFixed(1)}% | ${(100 * t.diff_A_minus_B).toFixed(1)}%p [${(100 * t.ci95[0]).toFixed(1)}, ${(100 * t.ci95[1]).toFixed(1)}] | ${t.A_only}/${t.B_only} | ${pv(t.mcnemar_p)} |\n`;
md += `\n### H3: 항목당 조작 단계 A vs B — 부호 검정\n\n| 묶음 | 쌍 | A 평균 | B 평균 | 차이 [95% 부트스트랩] | A>B / A<B / 같음 | p |\n|---|---|---|---|---|---|---|\n`;
for (const t of H3) md += `| ${t.group.replace('|', ' · ')} | ${t.n_pairs} | ${f(t.mean_A, 2)} | ${f(t.mean_B, 2)} | ${f(t.mean_diff, 2)} [${f(t.ci95[0], 2)}, ${f(t.ci95[1], 2)}] | ${t.A_more}/${t.B_more}/${t.ties} | ${pv(t.sign_p)} |\n`;
md += `\n### 부 분석: 특이도·정확도 A vs B\n\n| 지표 | 묶음 | 쌍 | A | B | A−B [95%] | 불일치 A만/B만 | p |\n|---|---|---|---|---|---|---|---|\n`;
for (const t of SEC) md += `| ${t.name} | ${t.group.replace('|', ' · ')} | ${t.n_pairs} | ${(100 * t.rate_A).toFixed(1)}% | ${(100 * t.rate_B).toFixed(1)}% | ${(100 * t.diff_A_minus_B).toFixed(1)}%p [${(100 * t.ci95[0]).toFixed(1)}, ${(100 * t.ci95[1]).toFixed(1)}] | ${t.A_only}/${t.B_only} | ${pv(t.mcnemar_p)} |\n`;
const ets = Object.keys(highlighter.by_error_type);
md += `\n### 오류 유형별 검출률(민감도)\n\n| 층 | 조건 | ${ets.join(' | ')} |\n|---|---|${ets.map(() => '---').join('|')}|\n`;
for (const st of [...strata, 'ALL']) for (const c of conds) { const m = metrics[`${st}|${c}`]; md += `| ${st.replace('|', ' · ')} | ${c} | ${ets.map((e) => (m.by_error_type[e] ? pc(m.by_error_type[e]) : '–')).join(' | ')} |\n`; }
md += `| 강조기 단독(기계) | – | ${ets.map((e) => pc(highlighter.by_error_type[e])).join(' | ')} |\n`;
md += `\n강조기 단독: 오류 표시 ${pc(highlighter.detection)}, 정상 오경고 ${pc(highlighter.false_flag)} (함정 정상 항목 오경고 ${pc(highlighter.false_flag_trap)})\n`;
md += `\n승인 기록의 증거(전체): A 승인 중 문장별 대조 증거 ${pc(metrics['ALL|A'].approvals_with_sentence_evidence)}, B 승인 중 원문 펼침 ${pc(metrics['ALL|B'].approvals_with_source_expanded)}, B 승인 중 문장별 증거 ${pc(metrics['ALL|B'].approvals_with_sentence_evidence)}\n`;
md += `\n**판정**: H2 ${verdict.H2.supported ? '채택' : '기각'} — ${verdict.H2.detail}. H3 ${verdict.H3.supported ? '채택' : '기각'} — ${verdict.H3.detail}.\n`;
md += `\n조건 제시 순서별 정확도: ${summary.order_check.map((o) => `${o.pos + 1}번째 ${pc(o)}`).join(', ')}\n`;
fs.writeFileSync(path.join(ROOT, 'bench', 'results', `tables-${TAG}.md`), md);
console.log(md);
