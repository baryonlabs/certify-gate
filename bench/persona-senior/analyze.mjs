// 시니어 기술직 페르소나 간극 시뮬레이션 v2 분석 (docs/PREREG_senior.md)
// 사용: node bench/persona-senior/analyze.mjs [tag=main]
// 출력: results/summary-<tag>.json, results/tables-<tag>.md
import fs from 'node:fs';
import path from 'node:path';
import { mean } from '../stats.mjs';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const TAG = process.argv[2] ?? 'main';
// 두 번째 판정 모델을 바꿔 다시 분석할 수 있다: node analyze.mjs main claude-haiku → summary-main-haiku.json
const D2 = process.argv[3] ?? 'gemini-agy', SUF = D2 === 'gemini-agy' ? '' : '-haiku';
const RAW = path.join(HERE, 'results', 'raw', TAG);
const data = JSON.parse(fs.readFileSync(path.join(HERE, 'data', 'personas.json'), 'utf8'));
const PERS = Object.fromEntries([...data.personas, ...data.calibration].map((p) => [p.pid, p]));
const DETM = ['codex', D2], DET_EXTRA = D2 === 'gemini-agy' ? ['claude-haiku'] : [], METHODS = ['a', 'b', 'd'], JQ = ['gemini-agy', 'claude-sonnet'], JQ_STAGE = 'jq2', JR = ['gemini-agy', 'codex'];
const rd = (pid, st) => { const f = path.join(RAW, pid, `${st}.json`); return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null; };
const B = 5000;

// ── 통계 도구 ─────────────────────────────────────────────────────────
function mkRnd(seed) { let s = seed; return () => ((s = (s * 1103515245 + 12345) % 2 ** 31) / 2 ** 31); }
const pct = (a, q) => a[Math.min(a.length - 1, Math.max(0, Math.floor(q * a.length)))];
/** 페르소나 묶음 재표집: stat(units) → 숫자 또는 숫자 객체 */
function clusterBoot(units, stat, seed = 4242) {
  const r = mkRnd(seed), out = [];
  for (let b = 0; b < B; b++) { const s = []; for (let i = 0; i < units.length; i++) s.push(units[Math.floor(r() * units.length)]); out.push(stat(s)); }
  return out;
}
const ci = (arr) => { const a = arr.filter((x) => x != null && !Number.isNaN(x)).sort((x, y) => x - y); return a.length ? [pct(a, 0.025), pct(a, 0.975)] : [null, null]; };
function Phi(z) { const t = 1 / (1 + 0.2316419 * z); const d = 0.3989423 * Math.exp((-z * z) / 2); return 1 - d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274)))); }
function wilcoxon(d) {
  const x = d.filter((v) => Math.abs(v) > 1e-12), n = x.length;
  if (!n) return { n: 0, p: 1 };
  const ab = x.map((v) => ({ v: Math.abs(v), s: Math.sign(v) })).sort((a, b) => a.v - b.v);
  const ranks = new Array(n); let tie = 0;
  for (let i = 0; i < n;) { let j = i; while (j + 1 < n && Math.abs(ab[j + 1].v - ab[i].v) < 1e-12) j++; const rk = (i + j + 2) / 2; for (let k = i; k <= j; k++) ranks[k] = rk; const t = j - i + 1; tie += t ** 3 - t; i = j + 1; }
  const Wp = ab.reduce((s, a, k) => s + (a.s > 0 ? ranks[k] : 0), 0);
  const mu = (n * (n + 1)) / 4, sd = Math.sqrt((n * (n + 1) * (2 * n + 1)) / 24 - tie / 48);
  const z = (Wp - mu - Math.sign(Wp - mu) * 0.5) / sd;
  return { n, W_plus: Wp, z, p: 2 * (1 - Phi(Math.abs(z))) };
}
/** Friedman 검정(k=3, 동순위 보정), 카이제곱 df=2의 p = exp(-Q/2) */
function friedman(rows) {
  const n = rows.length, k = rows[0].length, R = new Array(k).fill(0); let T = 0;
  for (const r of rows) {
    const idx = r.map((v, i) => ({ v, i })).sort((a, b) => a.v - b.v), rk = new Array(k);
    for (let i = 0; i < k;) { let j = i; while (j + 1 < k && idx[j + 1].v === idx[i].v) j++; for (let q = i; q <= j; q++) rk[idx[q].i] = (i + j + 2) / 2; const t = j - i + 1; T += t ** 3 - t; i = j + 1; }
    rk.forEach((v, i) => (R[i] += v));
  }
  const Q0 = (12 / (n * k * (k + 1))) * R.reduce((s, x) => s + x * x, 0) - 3 * n * (k + 1);
  const Q = Q0 / (1 - T / (n * (k ** 3 - k)));
  return { n, rank_sums: R, Q, df: k - 1, p: k === 3 ? Math.exp(-Q / 2) : null };
}
function holm(ps) { const o = ps.map((p, i) => ({ p, i })).sort((a, b) => a.p - b.p); const adj = new Array(ps.length); let mx = 0; o.forEach((x, r) => { mx = Math.max(mx, Math.min(1, (ps.length - r) * x.p)); adj[x.i] = mx; }); return adj; }
function wkappa(a, b, K = 3) {
  const n = a.length; if (!n) return null;
  const O = Array.from({ length: K }, () => new Array(K).fill(0)); a.forEach((x, i) => O[x][b[i]]++);
  const ra = O.map((r) => r.reduce((s, v) => s + v, 0)), cb = O[0].map((_, j) => O.reduce((s, r) => s + r[j], 0));
  let num = 0, den = 0;
  for (let i = 0; i < K; i++) for (let j = 0; j < K; j++) { const w = ((i - j) ** 2) / ((K - 1) ** 2); num += w * O[i][j]; den += (w * ra[i] * cb[j]) / n; }
  return den ? 1 - num / den : null;
}
function kappa2(a, b) { const n = a.length; if (!n) return null; const po = a.filter((x, i) => x === b[i]).length / n; const pa = mean(a.map(Number)), pb = mean(b.map(Number)); const pe = pa * pb + (1 - pa) * (1 - pb); return pe === 1 ? 1 : (po - pe) / (1 - pe); }
const f3 = (x) => (x == null || Number.isNaN(x) ? '–' : x.toFixed(3));
const f2 = (x) => (x == null || Number.isNaN(x) ? '–' : x.toFixed(2));
const pc = (x) => (x == null || Number.isNaN(x) ? '–' : `${(100 * x).toFixed(0)}%`);
const fci = (c, f = f2) => `[${f(c[0])}, ${f(c[1])}]`;
const fp = (p) => (p == null ? '–' : p < 0.001 ? '<0.001' : p.toFixed(3));

// ── 데이터 적재 ───────────────────────────────────────────────────────
const mainIds = data.personas.map((p) => p.pid), calibIds = data.calibration.map((p) => p.pid);
const G = Object.fromEntries([...mainIds, ...calibIds].map((pid) => [pid, rd(pid, 'gen')]).filter(([, g]) => g));
const isPos = (t) => t !== 'explained';

// ── 방법 (c) 임계값: 보정 표본 ────────────────────────────────────────
function lexRows(ids) { return ids.flatMap((pid) => (G[pid] ? G[pid].items.map((it) => ({ pid, id: it.id, type: G[pid].gold[it.id].type, max: G[pid].retrieval[it.id].max })) : [])); }
const calRows = lexRows(calibIds.filter((pid) => G[pid]));
function f1At(rows, tau) { let tp = 0, fpn = 0, fn = 0; for (const r of rows) { const pred = r.max < tau; const pos = isPos(r.type); if (pred && pos) tp++; else if (pred && !pos) fpn++; else if (!pred && pos) fn++; } return (2 * tp) / (2 * tp + fpn + fn || 1); }
const cands = [...new Set(calRows.map((r) => r.max))].sort((a, b) => a - b).map((v, i, a) => (i + 1 < a.length ? (v + a[i + 1]) / 2 : v + 1e-6));
let tau = null, bestF = -1;
for (const t of cands) { const f = f1At(calRows, t); if (f > bestF) { bestF = f; tau = t; } }
function auc(rows) { // 점수 = -max (작을수록 간극)
  const pos = rows.filter((r) => isPos(r.type)).map((r) => -r.max), neg = rows.filter((r) => !isPos(r.type)).map((r) => -r.max);
  let s = 0; for (const a of pos) for (const b of neg) s += a > b ? 1 : a === b ? 0.5 : 0; return pos.length && neg.length ? s / (pos.length * neg.length) : null;
}

// ── 1차: 간극 탐지 ───────────────────────────────────────────────────
const detOf = {};
const detIds = mainIds.filter((pid) => {
  if (!G[pid]) return false;
  const d = {}; for (const m of METHODS) for (const M of DETM) { const x = rd(pid, `det-${m}-${M}`); if (!x) return false; d[`${m}|${M}`] = x.labels; }
  for (const m of METHODS) for (const M of DET_EXTRA) { const x = rd(pid, `det-${m}-${M}`); if (x) d[`${m}|${M}`] = x.labels; }
  detOf[pid] = d; return true;
});
// 기록: 페르소나 × 판단 × 시스템
const haikuAll = DET_EXTRA.length > 0 && detIds.every((pid) => METHODS.every((m) => detOf[pid][`${m}|claude-haiku`]));
const SYS = [...METHODS.flatMap((m) => [...DETM, ...(haikuAll ? DET_EXTRA : [])].map((M) => `${m}|${M}`)), 'c|bm25'];
const units = detIds.map((pid) => ({
  pid, group: PERS[pid].group,
  items: G[pid].items.map((it) => {
    const gt = G[pid].gold[it.id].type, pred = {};
    for (const s of SYS) pred[s] = s === 'c|bm25' ? G[pid].retrieval[it.id].max < tau : detOf[pid][s][it.id].label === 'gap';
    return { id: it.id, type: gt, k_ref: G[pid].gold[it.id].k_ref, top2: G[pid].retrieval[it.id].top2, max: G[pid].retrieval[it.id].max, pred };
  }),
}));
function metrics(us, s, excludePartial = false) {
  let tp = 0, fpn = 0, fn = 0, tn = 0; const byType = { explained: [0, 0], partial: [0, 0], gap: [0, 0] };
  for (const u of us) for (const it of u.items) {
    if (excludePartial && it.type === 'partial') continue;
    const p = it.pred[s], pos = isPos(it.type);
    byType[it.type][0] += p ? 1 : 0; byType[it.type][1]++;
    if (p && pos) tp++; else if (p) fpn++; else if (pos) fn++; else tn++;
  }
  const prec = tp / (tp + fpn || 1), rec = tp / (tp + fn || 1);
  return { tp, fp: fpn, fn, tn, precision: prec, recall: rec, f1: (2 * tp) / (2 * tp + fpn + fn || 1), accuracy: (tp + tn) / (tp + tn + fpn + fn || 1),
    gap_rate: { explained: byType.explained[0] / (byType.explained[1] || 1), partial: byType.partial[0] / (byType.partial[1] || 1), gap: byType.gap[0] / (byType.gap[1] || 1) },
    specificity: tn / (tn + fpn || 1) };
}
const detect = {};
for (const s of SYS) {
  const m = metrics(units, s), mx = metrics(units, s, true);
  const bs = clusterBoot(units, (us) => { const a = metrics(us, s); return a; });
  detect[s] = { ...m, ci: { precision: ci(bs.map((x) => x.precision)), recall: ci(bs.map((x) => x.recall)), f1: ci(bs.map((x) => x.f1)), partial_rate: ci(bs.map((x) => x.gap_rate.partial)) },
    excl_partial: { precision: mx.precision, recall: mx.recall, f1: mx.f1, f1_ci: ci(clusterBoot(units, (us) => metrics(us, s, true).f1).map((x) => x)) } };
}
// 가설 H1–H4 (대응 묶음 부트스트랩, 같은 재표집)
const hyp = {};
for (const M of DETM) {
  const a = `a|${M}`;
  const pairs = { H1: `d|${M}`, H2: 'c|bm25', H3: `b|${M}` };
  for (const [h, o] of Object.entries(pairs)) {
    const diffs = clusterBoot(units, (us) => metrics(us, a).f1 - metrics(us, o).f1, 777);
    const c = ci(diffs), d = metrics(units, a).f1 - metrics(units, o).f1;
    let verdict;
    if (h === 'H3') verdict = c[0] >= -0.05 && c[1] <= 0.05 ? '동등' : c[0] > 0 || c[1] < 0 ? '차이 있음' : '판정 불가';
    else verdict = c[0] > 0 ? '충족' : '미충족';
    hyp[`${h}|${M}`] = { compare: `${a} − ${o}`, diff: d, ci: c, verdict };
  }
  const dd = clusterBoot(units, (us) => { const x = metrics(us, a).gap_rate; return x.partial - x.gap; }, 778);
  const x = metrics(units, a).gap_rate;
  hyp[`H4|${M}`] = { compare: `부분 설명 간극 판정률 − 순수 간극 간극 판정률 (${a})`, diff: x.partial - x.gap, ci: ci(dd), verdict: ci(dd)[1] < 0 ? '충족' : '미충족' };
}
const combine = (h) => { const v = DETM.map((M) => hyp[`${h}|${M}`].verdict); return h === 'H3' ? v.join(' / ') : v.every((x) => x === '충족') ? '지지' : v.some((x) => x === '충족') ? '부분 지지' : '기각'; };
// 모델 간 일치도
const agree = Object.fromEntries(METHODS.map((m) => { const a = [], b = []; for (const u of units) for (const it of u.items) { a.push(it.pred[`${m}|${DETM[0]}`] ? 1 : 0); b.push(it.pred[`${m}|${DETM[1]}`] ? 1 : 0); } return [m, { kappa: kappa2(a, b), agree: a.filter((x, i) => x === b[i]).length / a.length }]; }));
// 검색 recall@2
const r2 = { explained: [0, 0], partial: [0, 0] };
for (const u of units) for (const it of u.items) if (it.k_ref) { r2[it.type][0] += it.top2.includes(it.k_ref) ? 1 : 0; r2[it.type][1]++; }
// 혼동 행렬(3유형 × 판정)
const confusion = Object.fromEntries(SYS.map((s) => [s, Object.fromEntries(['explained', 'partial', 'gap'].map((t) => { let g = 0, e = 0; for (const u of units) for (const it of u.items) if (it.type === t) it.pred[s] ? g++ : e++; return [t, { gap: g, explained: e }]; }))]));
// 직무군별 F1 (방법 a)
const groups = [...new Set(units.map((u) => u.group))];
const byGroup = Object.fromEntries(groups.map((gname) => { const us = units.filter((u) => u.group === gname); return [gname, { n: us.length, ...Object.fromEntries(SYS.map((s) => [s, metrics(us, s).f1])) }]; }));
// 생성 품질 점검: 판단 문장 길이 유형별
const behLen = Object.fromEntries(['explained', 'partial', 'gap'].map((t) => [t, mean(units.flatMap((u) => u.items.filter((it) => it.type === t).map((it) => G[u.pid].items.find((x) => x.id === it.id).behavior.length)))]));

// ── 1차: 질문 겨냥 ───────────────────────────────────────────────────
const qRecs = [];
for (const pid of detIds) {
  const q = rd(pid, 'questions'), j = JQ.map((J) => rd(pid, `${JQ_STAGE}-${J}`));
  if (!q || j.some((x) => !x || !x.items)) continue;
  for (const id of q.ids) {
    const s = j.map((x) => x.items[id]);
    if (s.some((x) => !x)) continue;
    const type = G[pid].gold[id].type;
    qRecs.push({ pid, id, type, group: PERS[pid].group, tp_a_codex: type !== 'explained' && detOf[pid][`a|codex`][id].label === 'gap',
      t1: s[0].target, t2: s[1].target, target: (s[0].target + s[1].target) / 2,
      strict: [0, 1, 2].some((k) => s[0].match[k] && s[1].match[k]), loose: s.some((x) => x.match.some(Boolean)), m1: s[0].match, m2: s[1].match });
  }
}
const qPids = [...new Set(qRecs.map((r) => r.pid))];
function qSummary(filter) {
  const rs = qRecs.filter(filter), us = qPids.map((pid) => rs.filter((r) => r.pid === pid)).filter((a) => a.length);
  const st = (arr) => ({ target: mean(arr.map((r) => r.target)), two: mean(arr.map((r) => (r.target === 2 ? 1 : 0))), strict: mean(arr.map((r) => (r.strict ? 1 : 0))), loose: mean(arr.map((r) => (r.loose ? 1 : 0))) });
  const bs = clusterBoot(us, (s) => st(s.flat()), 991);
  return { n: rs.length, ...st(rs), ci: { target: ci(bs.map((x) => x.target)), two: ci(bs.map((x) => x.two)), strict: ci(bs.map((x) => x.strict)), loose: ci(bs.map((x) => x.loose)) } };
}
const qTarget = {
  positive: qSummary((r) => r.type !== 'explained'), gap: qSummary((r) => r.type === 'gap'), partial: qSummary((r) => r.type === 'partial'),
  tp_a_codex: qSummary((r) => r.tp_a_codex), fp_explained: qSummary((r) => r.type === 'explained'),
  kappa_target: wkappa(qRecs.map((r) => r.t1), qRecs.map((r) => r.t2)), exact_target: mean(qRecs.map((r) => (r.t1 === r.t2 ? 1 : 0))),
  kappa_match: kappa2(qRecs.flatMap((r) => r.m1.map(Number)), qRecs.flatMap((r) => r.m2.map(Number))),
  by_judge: Object.fromEntries(JQ.map((J, i) => [J, { target: mean(qRecs.filter((r) => r.type !== 'explained').map((r) => (i ? r.t2 : r.t1))), hit: mean(qRecs.filter((r) => r.type !== 'explained').map((r) => ((i ? r.m2 : r.m1).some(Boolean) ? 1 : 0))) }])),
};

// ── 2차: 응답 ────────────────────────────────────────────────────────
function respAnalysis(variant) {
  const recs = [];
  for (const pid of qPids) {
    const r = rd(pid, `resp-${variant}`), j = JR.map((J) => rd(pid, `jr-${variant}-${J}`));
    if (!r || j.some((x) => !x || !x.items)) continue;
    for (const x of r.records) {
      const s = j.map((y) => y.items[x.rid]); if (s.some((y) => !y)) continue;
      const qr = qRecs.find((z) => z.pid === pid && z.id === x.id);
      recs.push({ pid, group: PERS[pid].group, id: x.id, cond: x.cond, score: (s[0].score + s[1].score) / 2, s1: s[0].score, s2: s[1].score, rules: (s[0].rules + s[1].rules) / 2,
        novel: s[0].novel && s[1].novel ? 1 : 0, novel_any: s[0].novel || s[1].novel ? 1 : 0, typed: x.typed_chars, none: x.none_correct, picked: x.picks.length > 0, hit: qr?.strict ?? null, hit_loose: qr?.loose ?? null });
    }
  }
  const pids = [...new Set(recs.map((r) => r.pid))].filter((pid) => ['B', 'A', 'A+'].every((c) => recs.some((r) => r.pid === pid && r.cond === c)));
  if (!pids.length) return null;
  const per = (c, f = (r) => r.score) => pids.map((pid) => mean(recs.filter((r) => r.pid === pid && r.cond === c).map(f)));
  const C = ['B', 'A', 'A+'];
  const stat = (f) => Object.fromEntries(C.map((c) => [c, mean(per(c, f))]));
  const acc = Object.fromEntries(C.map((c) => [c, per(c)]));
  const fr = friedman(pids.map((_, i) => C.map((c) => acc[c][i])));
  const pairs = [['A+', 'B'], ['A', 'B'], ['A+', 'A']];
  const pw = pairs.map(([x, y]) => { const d = acc[x].map((v, i) => v - acc[y][i]); const r = mkRnd(31 + x.length); const bs = []; for (let b = 0; b < B; b++) { let s = 0; for (let i = 0; i < d.length; i++) s += d[Math.floor(r() * d.length)]; bs.push(s / d.length); } return { pair: `${x} − ${y}`, diff: mean(d), ci: ci(bs), wilcoxon: wilcoxon(d) }; });
  const adj = holm(pw.map((x) => x.wilcoxon.p)); pw.forEach((x, i) => (x.p_holm = adj[i]));
  const h5 = pw[0], h6 = pw[2];
  const verdictH5 = h5.ci[0] >= -0.3 && h5.ci[1] <= 0.3 ? '동등' : h5.ci[1] < -0.3 ? 'B 우위' : '판정 불가';
  const verdictH6 = h6.ci[0] > 0 ? '충족' : '미충족';
  const cell = (f) => Object.fromEntries(C.map((c) => { const rs = recs.filter((r) => pids.includes(r.pid) && r.cond === c && f(r)); return [c, { n: rs.length, score: mean(rs.map((r) => r.score)) }]; }));
  const anch = (c) => { const rs = recs.filter((r) => pids.includes(r.pid) && r.cond === c && r.hit === false); return { n: rs.length, accept_rate: mean(rs.map((r) => (r.picked && !r.none ? 1 : 0))), none_rate: mean(rs.map((r) => (r.none ? 1 : 0))) }; };
  const modes = (c) => { const rs = recs.filter((r) => pids.includes(r.pid) && r.cond === c); return { picked: { n: rs.filter((r) => r.picked && !r.none).length, score: mean(rs.filter((r) => r.picked && !r.none).map((r) => r.score)) }, none: { n: rs.filter((r) => r.none).length, score: mean(rs.filter((r) => r.none).map((r) => r.score)) } }; };
  const byJudge = Object.fromEntries(JR.map((J, i) => [J, Object.fromEntries(C.map((c) => [c, mean(pids.map((pid) => mean(recs.filter((r) => r.pid === pid && r.cond === c).map((r) => (i ? r.s2 : r.s1)))))]))]));
  const grp = {};
  for (const gname of [...new Set(recs.map((r) => r.group))]) { const gp = pids.filter((pid) => PERS[pid].group === gname); if (gp.length >= 10) grp[gname] = { n: gp.length, ...Object.fromEntries(C.map((c) => [c, mean(gp.map((pid) => mean(recs.filter((r) => r.pid === pid && r.cond === c).map((r) => r.score))))])) }; }
  return { n_personas: pids.length, n_records: recs.filter((r) => pids.includes(r.pid)).length, accuracy: stat((r) => r.score), rules: stat((r) => r.rules), novel: stat((r) => r.novel), novel_any: stat((r) => r.novel_any), typed: stat((r) => r.typed),
    friedman: fr, pairwise: pw, H5: { ...h5, verdict: verdictH5 }, H6: { ...h6, verdict: verdictH6 },
    by_hit: { hit: cell((r) => r.hit === true), miss: cell((r) => r.hit === false) }, anchoring: { A: anch('A'), 'A+': anch('A+') }, modes: { A: modes('A'), 'A+': modes('A+') },
    kappa_score: wkappa(recs.map((r) => r.s1), recs.map((r) => r.s2)), exact_score: mean(recs.map((r) => (r.s1 === r.s2 ? 1 : 0))), by_judge: byJudge, by_group: grp };
}
const resp = { normal: respAnalysis('normal'), rushed: respAnalysis('rushed') };

// ── 저장 ─────────────────────────────────────────────────────────────
const groupDist = (ids) => ids.reduce((o, pid) => ((o[PERS[pid].group] = (o[PERS[pid].group] ?? 0) + 1), o), {});
const summary = {
  tag: TAG, generated: new Date().toISOString(), note: 'LLM 시뮬레이션, 사람 증거 아님',
  n: { sampled: mainIds.length, generated: mainIds.filter((p) => G[p]).length, detection: detIds.length, questions: qPids.length, responses_normal: resp.normal?.n_personas ?? 0, responses_rushed: resp.rushed?.n_personas ?? 0, calibration: calibIds.filter((p) => G[p]).length },
  group_dist_detection: groupDist(detIds),
  lexical: { tau, calib_f1: bestF, auc_main: auc(units.flatMap((u) => u.items)), auc_calib: auc(calRows) },
  detection: detect, hypotheses: hyp, hypotheses_combined: Object.fromEntries(['H1', 'H2', 'H3', 'H4'].map((h) => [h, combine(h)])), model_agreement: agree,
  retrieval_recall2: { explained: r2.explained[0] / (r2.explained[1] || 1), partial: r2.partial[0] / (r2.partial[1] || 1) }, confusion, detection_by_group: byGroup, behavior_len: behLen,
  question_targeting: qTarget, responses: resp,
};
fs.writeFileSync(path.join(HERE, 'results', `summary-${TAG}${SUF}.json`), JSON.stringify(summary, null, 1));
fs.writeFileSync(path.join(HERE, 'results', `records-${TAG}${SUF}.json`), JSON.stringify({ detection_units: units, question_records: qRecs }, null, 0));

// ── 표 ───────────────────────────────────────────────────────────────
const L = [];
const NAME = { a: '(a) 검색→판정(논문)', b: '(b) 전체 지식 판정', c: '(c) 단어 일치(BM25)', d: '(d) 지식 없음' };
L.push(`# 결과 표 (${TAG}) — LLM 시뮬레이션, 사람 증거 아님\n`);
L.push(`페르소나: 탐지 ${detIds.length}명, 질문 ${qPids.length}명, 응답(normal) ${resp.normal?.n_personas ?? 0}명. 보정 표본 ${summary.n.calibration}명 → τ = ${f3(tau)} (보정 F1 ${f3(bestF)}), 본 표본 BM25 AUC ${f3(summary.lexical.auc_main)}\n`);
L.push('## 간극 탐지 (양성 = 간극 + 부분 설명, 페르소나 묶음 부트스트랩 95% CI)\n');
L.push('| 방법 | 판정 모델 | 정밀도 | 재현율 | F1 [95% CI] | 특이도(설명됨 정답률) | 부분 설명 간극 판정률 | 순수 간극 판정률 | F1(부분 제외) |');
L.push('|---|---|---|---|---|---|---|---|---|');
for (const s of SYS) { const [m, M] = s.split('|'); const x = detect[s]; L.push(`| ${NAME[m]} | ${M} | ${f3(x.precision)} | ${f3(x.recall)} | ${f3(x.f1)} ${fci(x.ci.f1, f3)} | ${pc(x.specificity)} | ${pc(x.gap_rate.partial)} | ${pc(x.gap_rate.gap)} | ${f3(x.excl_partial.f1)} |`); }
L.push('\n## 가설 판정\n');
L.push('| 가설 | 비교 | 차이 | 95% CI | 판정 |'); L.push('|---|---|---|---|---|');
for (const [k, v] of Object.entries(hyp)) L.push(`| ${k} | ${v.compare} | ${f3(v.diff)} | ${fci(v.ci, f3)} | ${v.verdict} |`);
L.push(`\n종합: ${Object.entries(summary.hypotheses_combined).map(([h, v]) => `${h} ${v}`).join(', ')}\n`);
L.push(`모델 간 일치(codex vs ${D2}): ${METHODS.map((m) => `(${m}) κ ${f2(agree[m].kappa)}, 일치 ${pc(agree[m].agree)}`).join('; ')}. 검색 recall@2: 설명됨 ${pc(summary.retrieval_recall2.explained)}, 부분 설명 ${pc(summary.retrieval_recall2.partial)}. 판단 문장 평균 길이: 설명됨 ${f2(behLen.explained)}, 부분 ${f2(behLen.partial)}, 간극 ${f2(behLen.gap)}자\n`);
L.push('### 혼동 행렬 (정답 유형 × 간극 판정 수/전체)\n');
L.push('| 방법|모델 | 설명됨 | 부분 설명 | 간극 |'); L.push('|---|---|---|---|');
for (const s of SYS) { const c = confusion[s]; L.push(`| ${s} | ${c.explained.gap}/${c.explained.gap + c.explained.explained} | ${c.partial.gap}/${c.partial.gap + c.partial.explained} | ${c.gap.gap}/${c.gap.gap + c.gap.explained} |`); }
L.push('\n### 직무군별 F1\n');
L.push(`| 직무군 | n | ${SYS.join(' | ')} |`); L.push(`|---|---|${SYS.map(() => '---').join('|')}|`);
for (const [gname, v] of Object.entries(byGroup)) L.push(`| ${gname} | ${v.n} | ${SYS.map((s) => f2(v[s])).join(' | ')} |`);
L.push('\n## 질문 겨냥 (질문 생성 Q = codex, 채점 J-q = gemini-agy + claude-sonnet 평균, 기준 jq2)\n');
L.push('| 대상 | 항목 수 | 겨냥 점수(0–2) [CI] | 겨냥 2점 비율 | 예상 답 적중(엄격) [CI] | 적중(느슨) |'); L.push('|---|---|---|---|---|---|');
for (const [k, lab] of [['positive', '정답 양성(간극+부분)'], ['gap', '순수 간극'], ['partial', '부분 설명'], ['tp_a_codex', '(a)-codex 진양성'], ['fp_explained', '(a)-codex 오탐(설명됨)']]) { const x = qTarget[k]; L.push(`| ${lab} | ${x.n} | ${f2(x.target)} ${fci(x.ci.target)} | ${pc(x.two)} | ${pc(x.strict)} ${fci(x.ci.strict.map((v) => v * 100), (v) => v.toFixed(0))} | ${pc(x.loose)} |`); }
L.push(`\n채점자 일치: 겨냥 가중 κ ${f2(qTarget.kappa_target)} (완전 일치 ${pc(qTarget.exact_target)}), 적중 κ ${f2(qTarget.kappa_match)}. 채점자별(양성): ${JQ.map((J) => `${J} 겨냥 ${f2(qTarget.by_judge[J].target)}, 적중 ${pc(qTarget.by_judge[J].hit)}`).join('; ')}\n`);
for (const v of ['normal', 'rushed']) {
  const R = resp[v]; if (!R) continue;
  L.push(`\n## 응답 (${v}, P = claude-sonnet, 채점 J-r = gemini-agy + codex, ${R.n_personas}명 × 6항목)\n`);
  L.push('| 지표 | B | A | A+ |'); L.push('|---|---|---|---|');
  L.push(`| 정확도(0–2) | ${f2(R.accuracy.B)} | ${f2(R.accuracy.A)} | ${f2(R.accuracy['A+'])} |`);
  L.push(`| 판단 규칙 수 | ${f2(R.rules.B)} | ${f2(R.rules.A)} | ${f2(R.rules['A+'])} |`);
  L.push(`| 새 기준 포함(두 채점자 모두) | ${pc(R.novel.B)} | ${pc(R.novel.A)} | ${pc(R.novel['A+'])} |`);
  L.push(`| 직접 입력 글자 수 | ${f2(R.typed.B)} | ${f2(R.typed.A)} | ${f2(R.typed['A+'])} |`);
  L.push(`| 정확도, 예상 답 적중 항목 | ${f2(R.by_hit.hit.B.score)} (${R.by_hit.hit.B.n}) | ${f2(R.by_hit.hit.A.score)} (${R.by_hit.hit.A.n}) | ${f2(R.by_hit.hit['A+'].score)} (${R.by_hit.hit['A+'].n}) |`);
  L.push(`| 정확도, 비적중 항목 | ${f2(R.by_hit.miss.B.score)} (${R.by_hit.miss.B.n}) | ${f2(R.by_hit.miss.A.score)} (${R.by_hit.miss.A.n}) | ${f2(R.by_hit.miss['A+'].score)} (${R.by_hit.miss['A+'].n}) |`);
  L.push(`\nFriedman χ²(2) = ${f2(R.friedman.Q)}, p = ${fp(R.friedman.p)} (n = ${R.friedman.n})\n`);
  L.push('| 비교 | 차이 | 95% CI | Wilcoxon p | Holm p |'); L.push('|---|---|---|---|---|');
  for (const x of R.pairwise) L.push(`| ${x.pair} | ${f2(x.diff)} | ${fci(x.ci)} | ${fp(x.wilcoxon.p)} | ${fp(x.p_holm)} |`);
  L.push(`\nH5(A+ ≈ B, ±0.3): ${R.H5.verdict}. H6(A+ > A): ${R.H6.verdict}.`);
  L.push(`앵커링(엄격 비적중 항목에서 '모두 틀림' 없이 예상 답 수용): A ${pc(R.anchoring.A.accept_rate)} (n=${R.anchoring.A.n}), A+ ${pc(R.anchoring['A+'].accept_rate)} (n=${R.anchoring['A+'].n}). '모두 틀림' 비율: A ${pc(R.anchoring.A.none_rate)}, A+ ${pc(R.anchoring['A+'].none_rate)}.`);
  L.push(`응답 방식: A 선택 ${R.modes.A.picked.n}건 ${f2(R.modes.A.picked.score)}, 모두 틀림 ${R.modes.A.none.n}건 ${f2(R.modes.A.none.score)}; A+ 선택+보충 ${R.modes['A+'].picked.n}건 ${f2(R.modes['A+'].picked.score)}, 모두 틀림+직접 ${R.modes['A+'].none.n}건 ${f2(R.modes['A+'].none.score)}.`);
  L.push(`채점자 일치: 가중 κ ${f2(R.kappa_score)}, 완전 일치 ${pc(R.exact_score)}. 채점자별: ${JR.map((J) => `${J} B ${f2(R.by_judge[J].B)} / A ${f2(R.by_judge[J].A)} / A+ ${f2(R.by_judge[J]['A+'])}`).join('; ')}`);
  if (Object.keys(R.by_group).length) { L.push('\n| 직무군 | n | B | A | A+ |'); L.push('|---|---|---|---|---|'); for (const [gname, x] of Object.entries(R.by_group)) L.push(`| ${gname} | ${x.n} | ${f2(x.B)} | ${f2(x.A)} | ${f2(x['A+'])} |`); }
}
fs.writeFileSync(path.join(HERE, 'results', `tables-${TAG}${SUF}.md`), L.join('\n') + '\n');
console.log(L.join('\n'));

// ── 보조: 경로 간 일치(opencode gemini-argon vs agy gemini-4-argon-low), 원 겨냥 기준(jq) 일치도 ─────
{
  const sup = { route_agreement: {}, jq_v1: null };
  for (const m of METHODS) {
    const a = [], b = [];
    for (const u of units) { const o = rd(u.pid, `det-${m}-gemini-argon`); if (!o) continue; for (const it of u.items) { a.push(o.labels[it.id].label === 'gap' ? 1 : 0); b.push(it.pred[`${m}|gemini-agy`] ? 1 : 0); } }
    sup.route_agreement[m] = { n_items: a.length, kappa: kappa2(a, b), agree: a.length ? a.filter((x, i) => x === b[i]).length / a.length : null };
  }
  const t1 = [], t2 = [];
  for (const pid of detIds) { const x = rd(pid, 'jq-gemini-argon'), y = rd(pid, 'jq-claude-sonnet'); if (!x?.items || !y?.items) continue; for (const id of Object.keys(x.items)) if (y.items[id]) { t1.push(x.items[id].target); t2.push(y.items[id].target); } }
  sup.jq_v1 = { n_items: t1.length, kappa_target: wkappa(t1, t2), exact: mean(t1.map((v, i) => (v === t2[i] ? 1 : 0))), mean_gemini: mean(t1), mean_sonnet: mean(t2) };
  summary.supplementary = sup;
  fs.writeFileSync(path.join(HERE, 'results', `summary-${TAG}${SUF}.json`), JSON.stringify(summary, null, 1));
  const S = `\n## 보조\n\n- gemini 경로 간 일치(opencode gemini-4-argon vs agy gemini-4-argon-low, 한도 전 끝난 페르소나): ${METHODS.map((m) => `(${m}) ${sup.route_agreement[m].n_items}건 κ ${f2(sup.route_agreement[m].kappa)}, 일치 ${pc(sup.route_agreement[m].agree)}`).join('; ')}\n- 원 겨냥 기준(jq, gemini-argon[opencode] + claude-sonnet): ${sup.jq_v1.n_items}건, 가중 κ ${f2(sup.jq_v1.kappa_target)}, 완전 일치 ${pc(sup.jq_v1.exact)}, 평균 ${f2(sup.jq_v1.mean_gemini)} vs ${f2(sup.jq_v1.mean_sonnet)}\n`;
  fs.appendFileSync(path.join(HERE, 'results', `tables-${TAG}${SUF}.md`), S);
  console.log(S);
}
