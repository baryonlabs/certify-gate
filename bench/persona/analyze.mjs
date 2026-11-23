// 퍼소나 시뮬레이션 분석 (docs/PREREG_persona.md 의 지표·검정): node bench/persona/analyze.mjs [tag]
import fs from 'node:fs';
import path from 'node:path';
import { mcnemarExact, mean, median } from '../stats.mjs';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const TAG = process.argv[2] ?? 'main';
const DIR = path.join(HERE, 'results', 'raw', TAG);
const files = fs.readdirSync(DIR).filter((f) => /^P\d+-arm\d\.json$/.test(f)).sort();
const runs = files.map((f) => JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8')));
// 두 팔이 모두 완료된 퍼소나만 분석
const armsBy = {};
for (const r of runs) (armsBy[r.pid] ??= []).push(r.arm);
const complete = new Set(Object.entries(armsBy).filter(([, a]) => a.length === 2).map(([p]) => p));
const J = runs[0]?.judges ?? ['claude-sonnet', 'codex'];
const ARMQ = Object.fromEntries(runs.map((r) => [r.arm, { P: r.P, Q: r.Q }]));

// 기록 펼치기
const recs = [];
const hitRows = [];
for (const r of runs) {
  if (!complete.has(r.pid)) continue;
  const hitOf = {};
  for (const q of r.questions) {
    const m = J.map((j) => r.judged[j].hits[q.id] ?? [false, false, false]);
    const strict = [0, 1, 2].some((k) => m[0][k] && m[1][k]);
    const loose = m.some((x) => x.some(Boolean));
    hitOf[q.id] = { strict, loose, byJudge: m };
    hitRows.push({ pid: r.pid, arm: r.arm, item: q.id, strict, loose, m });
  }
  for (const x of r.records) {
    const s = J.map((j) => r.judged[j].scores[x.rid]);
    const a = x.answer ?? {};
    const picks = (a.picks ?? []).filter((k) => [0, 1, 2].includes(k));
    recs.push({
      pid: r.pid, group: r.group, arm: r.arm, variant: x.variant, cond: x.cond, item: x.item,
      score: mean(s.map((y) => y.score)), rules: mean(s.map((y) => y.rules)), s1: s[0].score, s2: s[1].score, r1: s[0].rules, r2: s[1].rules,
      typed: x.typed_chars, total_len: x.answer_text.length,
      picks: picks.length, none_correct: !!a.none_correct, corrected: !!(a.correction ?? '').trim(),
      hit_strict: hitOf[x.item]?.strict ?? null, hit_loose: hitOf[x.item]?.loose ?? null,
    });
  }
}

// ── 통계 도구 ─────────────────────────────────────────────────────────
let seed = 4242;
const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
function bootCI(diffs, B = 5000) {
  if (!diffs.length) return [null, null];
  const ms = [];
  for (let b = 0; b < B; b++) { let s = 0; for (let i = 0; i < diffs.length; i++) s += diffs[Math.floor(rnd() * diffs.length)]; ms.push(s / diffs.length); }
  ms.sort((a, b) => a - b);
  return [ms[Math.floor(0.025 * B)], ms[Math.floor(0.975 * B)]];
}
function wilcoxon(d) {
  const x = d.filter((v) => Math.abs(v) > 1e-12);
  const n = x.length;
  if (!n) return { n: 0, W: 0, p: 1 };
  const ab = x.map((v, i) => ({ v: Math.abs(v), s: Math.sign(v), i })).sort((a, b) => a.v - b.v);
  const ranks = new Array(n);
  let tie = 0;
  for (let i = 0; i < n;) { let j = i; while (j + 1 < n && Math.abs(ab[j + 1].v - ab[i].v) < 1e-12) j++; const rk = (i + j + 2) / 2; for (let k = i; k <= j; k++) ranks[k] = rk; const t = j - i + 1; tie += t ** 3 - t; i = j + 1; }
  const Wp = ab.reduce((s, a, k) => s + (a.s > 0 ? ranks[k] : 0), 0);
  const mu = (n * (n + 1)) / 4, sd = Math.sqrt((n * (n + 1) * (2 * n + 1)) / 24 - tie / 48);
  const z = (Wp - mu - Math.sign(Wp - mu) * 0.5) / sd;
  const p = 2 * (1 - Phi(Math.abs(z)));
  return { n, W_plus: Wp, z, p };
}
function Phi(z) { const t = 1 / (1 + 0.2316419 * z); const d = 0.3989423 * Math.exp((-z * z) / 2); return 1 - d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274)))); }
const signTest = (d) => { const pos = d.filter((v) => v > 0).length, neg = d.filter((v) => v < 0).length; return { pos, neg, ties: d.length - pos - neg, p: mcnemarExact(pos, neg) }; };
function wkappa(a, b, K = 3) { // 2점 척도 가중 카파(2차)
  const n = a.length; if (!n) return null;
  const O = Array.from({ length: K }, () => new Array(K).fill(0)); a.forEach((x, i) => O[x][b[i]]++);
  const ra = O.map((r) => r.reduce((s, v) => s + v, 0)), cb = O[0].map((_, j) => O.reduce((s, r) => s + r[j], 0));
  let num = 0, den = 0;
  for (let i = 0; i < K; i++) for (let j = 0; j < K; j++) { const w = ((i - j) ** 2) / ((K - 1) ** 2); num += w * O[i][j]; den += (w * ra[i] * cb[j]) / n; }
  return den ? 1 - num / den : null;
}
function kappa2(a, b) { const n = a.length; if (!n) return null; const po = a.filter((x, i) => x === b[i]).length / n; const pa = mean(a.map(Number)), pb = mean(b.map(Number)); const pe = pa * pb + (1 - pa) * (1 - pb); return pe === 1 ? 1 : (po - pe) / (1 - pe); }

// ── 퍼소나 단위 비교 ──────────────────────────────────────────────────
const pids = [...complete].sort();
const perPersona = (filter, val) => pids.map((p) => { const xs = recs.filter((r) => r.pid === p && filter(r)).map(val); return xs.length ? mean(xs) : null; });
function compare(name, variant, val, armSel = null) {
  const f = (c) => (r) => r.cond === c && r.variant === variant && (armSel == null || r.arm === armSel);
  const A = perPersona(f('A'), val), B = perPersona(f('B'), val);
  const d = A.map((a, i) => (a == null || B[i] == null ? null : a - B[i])).filter((x) => x != null);
  return { name, variant, arm: armSel ?? 'both', n_personas: d.length, mean_A: mean(A.filter((x) => x != null)), mean_B: mean(B.filter((x) => x != null)), diff: mean(d), ci95: bootCI(d), wilcoxon: wilcoxon(d), sign: signTest(d) };
}
const variants = ['normal', 'rushed'];
const comps = [];
for (const v of variants) for (const arm of [null, 1, 2]) {
  comps.push(compare('accuracy(0-2)', v, (r) => r.score, arm));
  comps.push(compare('specificity(rules)', v, (r) => r.rules, arm));
  comps.push(compare('typed_chars', v, (r) => r.typed, arm));
  comps.push(compare('answer_len', v, (r) => r.total_len, arm));
}
const accN = comps.find((c) => c.name === 'accuracy(0-2)' && c.variant === 'normal' && c.arm === 'both');
const accR = comps.find((c) => c.name === 'accuracy(0-2)' && c.variant === 'rushed' && c.arm === 'both');
const eq = (c) => c.ci95[0] >= -0.3 && c.ci95[1] <= 0.3;

// M1 적중률
const rate = (xs) => ({ k: xs.filter(Boolean).length, n: xs.length, p: xs.length ? xs.filter(Boolean).length / xs.length : null });
const M1 = { strict: rate(hitRows.map((h) => h.strict)), loose: rate(hitRows.map((h) => h.loose)), arm1: { strict: rate(hitRows.filter((h) => h.arm === 1).map((h) => h.strict)), loose: rate(hitRows.filter((h) => h.arm === 1).map((h) => h.loose)) }, arm2: { strict: rate(hitRows.filter((h) => h.arm === 2).map((h) => h.strict)), loose: rate(hitRows.filter((h) => h.arm === 2).map((h) => h.loose)) } };

// M2 앵커링: 적중 없는 A 항목(주: 두 채점자 모두 일치 없음 = loose false)에서 모두틀림·교정 없이 고름
const A = recs.filter((r) => r.cond === 'A');
const anchored = (r) => r.picks > 0 && !r.none_correct && !r.corrected;
const wrongPick = (r) => r.picks > 0; // 탐색 지표: 교정과 무관하게 틀린 예상 답을 고름
const M2 = {};
for (const def of ['loose', 'strict']) for (const v of variants) for (const arm of [null, 1, 2]) {
  const pool = A.filter((r) => r.variant === v && (arm == null || r.arm === arm) && (def === 'loose' ? r.hit_loose === false : r.hit_strict === false));
  M2[`${def}|${v}|${arm ?? 'both'}`] = { anchoring: rate(pool.map(anchored)), wrong_pick: rate(pool.map(wrongPick)), none_correct: rate(pool.map((r) => r.none_correct)), corrected: rate(pool.map((r) => r.corrected)) };
}
// H-anchor: 퍼소나별 앵커링 비율 rushed − normal (주 정의 loose)
const anchorPer = (v) => pids.map((p) => { const xs = A.filter((r) => r.pid === p && r.variant === v && r.hit_loose === false); return xs.length ? mean(xs.map((r) => (anchored(r) ? 1 : 0))) : null; });
const aN = anchorPer('normal'), aR = anchorPer('rushed');
const dAnch = aN.map((x, i) => (x == null || aR[i] == null ? null : aR[i] - x)).filter((x) => x != null);
const Hanchor = { n_personas: dAnch.length, normal: mean(aN.filter((x) => x != null)), rushed: mean(aR.filter((x) => x != null)), diff_rushed_minus_normal: mean(dAnch), ci95: bootCI(dAnch), sign: signTest(dAnch) };
const wpPer = (v) => pids.map((p) => { const xs = A.filter((r) => r.pid === p && r.variant === v && r.hit_loose === false); return xs.length ? mean(xs.map((r) => (wrongPick(r) ? 1 : 0))) : null; });
const wN = wpPer('normal'), wR = wpPer('rushed');
const dWp = wN.map((x, i) => (x == null || wR[i] == null ? null : wR[i] - x)).filter((x) => x != null);
const WrongPickRushed = { normal: mean(wN.filter((x) => x != null)), rushed: mean(wR.filter((x) => x != null)), diff: mean(dWp), ci95: bootCI(dWp), sign: signTest(dWp) };

// 정확도: 적중 여부로 나눈 A
const accByHit = {};
for (const v of variants) for (const h of [true, false]) { const xs = A.filter((r) => r.variant === v && r.hit_loose === h); accByHit[`${v}|hit=${h}`] = { n: xs.length, mean_score: mean(xs.map((r) => r.score)) }; }
for (const v of variants) { const xs = recs.filter((r) => r.cond === 'B' && r.variant === v); accByHit[`${v}|B`] = { n: xs.length, mean_score: mean(xs.map((r) => r.score)) }; }

// 응답 방식별 정확도(사후 분석, 논문 표 5): A를 '선택만 / 선택+교정 / 모두 틀림(+교정)'으로 나눔. 적중은 엄격 기준(hit_strict).
const modeOf = (r) => (r.none_correct ? 'none_correct' : r.picks > 0 && r.corrected ? 'pick_corrected' : r.picks > 0 ? 'pick_only' : 'other');
const MODES = ['pick_only', 'pick_corrected', 'none_correct'];
const MODE_KO = { pick_only: '예상 답 선택만', pick_corrected: '선택 후 교정 입력', none_correct: "'모두 틀림'+직접 입력", other: '기타(선택·모두 틀림 없음)' };
const ms = (xs) => ({ n: xs.length, mean_score: xs.length ? mean(xs.map((r) => r.score)) : null });
const byMode = {};
for (const v of [...variants, 'all']) {
  const Av = A.filter((r) => v === 'all' || r.variant === v);
  const Bv = recs.filter((r) => r.cond === 'B' && (v === 'all' || r.variant === v));
  const row = { A_total: Av.length };
  for (const m of [...MODES, 'other']) row[m] = { ...ms(Av.filter((r) => modeOf(r) === m)), share_of_A: Av.length ? Av.filter((r) => modeOf(r) === m).length / Av.length : null };
  const po = Av.filter((r) => modeOf(r) === 'pick_only');
  row.pick_only_hit_strict = ms(po.filter((r) => r.hit_strict));
  row.pick_only_miss_strict = ms(po.filter((r) => !r.hit_strict));
  row.A_hit_strict = ms(Av.filter((r) => r.hit_strict));
  row.A_miss_strict = ms(Av.filter((r) => !r.hit_strict));
  row.B = ms(Bv);
  byMode[v] = row;
}

// 채점자 일치
const agreement = { score_weighted_kappa: wkappa(recs.map((r) => r.s1), recs.map((r) => r.s2)), score_exact_agree: mean(recs.map((r) => (r.s1 === r.s2 ? 1 : 0))), rules_mean_abs_diff: mean(recs.map((r) => Math.abs(r.r1 - r.r2))), hits_kappa: kappa2(hitRows.flatMap((h) => h.m[0]), hitRows.flatMap((h) => h.m[1])), hits_agree: mean(hitRows.flatMap((h) => h.m[0].map((x, k) => (x === h.m[1][k] ? 1 : 0)))) };
// 채점자별 주 비교(자기 계열 편향 점검)
const byJudge = {};
for (const [j, key] of [[J[0], 's1'], [J[1], 's2']]) for (const v of variants) byJudge[`${j}|${v}`] = compare(`accuracy by ${j}`, v, (r) => r[key]);

const status = JSON.parse(fs.readFileSync(path.join(DIR, 'run-status.json'), 'utf8'));
const summary = { tag: TAG, label: 'LLM 시뮬레이션 — 사람 증거 아님', personas_complete: pids.length, records: recs.length, run_status: status, M1_hit_rate: M1, M2_anchoring: M2, H_anchor: Hanchor, exploratory_wrong_pick_rushed: WrongPickRushed, H_acc: { normal: { ...accN, equivalent_within_0_3: eq(accN) }, rushed: { ...accR, equivalent_within_0_3: eq(accR) } }, comparisons: comps, accuracy_by_hit: accByHit, judge_agreement: agreement, accuracy_by_judge: byJudge, accuracy_by_response_mode: byMode };
fs.mkdirSync(path.join(HERE, 'results'), { recursive: true });
fs.writeFileSync(path.join(HERE, 'results', `summary-${TAG}.json`), JSON.stringify(summary, null, 1));
fs.writeFileSync(path.join(HERE, 'results', `records-${TAG}.json`), JSON.stringify(recs, null, 1));

// ── 표 ────────────────────────────────────────────────────────────────
const pc = (r) => (r.p == null ? '–' : `${(100 * r.p).toFixed(0)}% (${r.k}/${r.n})`);
const f = (x, d = 2) => (x == null || Number.isNaN(x) ? '–' : x.toFixed(d));
const pv = (p) => (p == null ? '–' : p < 0.001 ? '<0.001' : p.toFixed(3));
let md = `> **LLM 시뮬레이션 — 사람 증거 아님.** 합성 퍼소나 ${pids.length}명(완료 기준), 기록 ${recs.length}개.\n\n`;
md += `### M1 예상 답 적중률(A 항목, 예상 이유 3개 중 하나라도 숨은 이유와 일치)\n\n| 기준 | 전체 | 팔1(Q=${ARMQ[1]?.Q}) | 팔2(Q=${ARMQ[2]?.Q}) |\n|---|---|---|---|\n| 엄격(두 채점자 모두 같은 보기 일치) | ${pc(M1.strict)} | ${pc(M1.arm1.strict)} | ${pc(M1.arm2.strict)} |\n| 느슨(한 채점자 이상) | ${pc(M1.loose)} | ${pc(M1.arm1.loose)} | ${pc(M1.arm2.loose)} |\n`;
md += `\n### M2 앵커링(적중 없는 A 항목 = 두 채점자 모두 일치 보기 없음)\n\n| 변형 | 팔 | 앵커링(골랐고 교정·모두틀림 없음) | 틀린 보기를 고름(교정 포함, 탐색) | 모두 틀림 | 교정 입력 |\n|---|---|---|---|---|---|\n`;
for (const v of variants) for (const arm of ['both', 1, 2]) { const m = M2[`loose|${v}|${arm}`]; md += `| ${v} | ${arm === 'both' ? '전체' : `팔${arm}(P=${ARMQ[arm]?.P})`} | ${pc(m.anchoring)} | ${pc(m.wrong_pick)} | ${pc(m.none_correct)} | ${pc(m.corrected)} |\n`; }
md += `\nH-anchor(퍼소나 단위 rushed − normal 앵커링): ${f(Hanchor.normal)} → ${f(Hanchor.rushed)}, 차이 ${f(Hanchor.diff_rushed_minus_normal)} [${f(Hanchor.ci95[0])}, ${f(Hanchor.ci95[1])}], 부호 검정 +${Hanchor.sign.pos}/−${Hanchor.sign.neg}/0 ${Hanchor.sign.ties}, p=${pv(Hanchor.sign.p)}\n`;
md += `\n탐색(틀린 보기 고름) rushed − normal: ${f(WrongPickRushed.normal)} → ${f(WrongPickRushed.rushed)}, 차이 ${f(WrongPickRushed.diff)} [${f(WrongPickRushed.ci95[0])}, ${f(WrongPickRushed.ci95[1])}], p=${pv(WrongPickRushed.sign.p)}\n`;
md += `\n### A vs B 퍼소나 단위 대응 비교\n\n| 지표 | 변형 | 팔 | 퍼소나 | A | B | A−B [95% 부트스트랩] | 윌콕슨 p | 부호(+/−/0) |\n|---|---|---|---|---|---|---|---|---|\n`;
for (const c of comps) md += `| ${c.name} | ${c.variant} | ${c.arm} | ${c.n_personas} | ${f(c.mean_A)} | ${f(c.mean_B)} | ${f(c.diff)} [${f(c.ci95[0])}, ${f(c.ci95[1])}] | ${pv(c.wilcoxon.p)} | ${c.sign.pos}/${c.sign.neg}/${c.sign.ties} |\n`;
md += `\nH-acc(동등성 여유 ±0.3): normal ${eq(accN) ? '비슷함(CI가 ±0.3 안)' : '비슷하다고 할 수 없음'}, rushed ${eq(accR) ? '비슷함' : '비슷하다고 할 수 없음'}\n`;
md += `\n### 적중 여부별 A 정확도(평균 0–2)\n\n| 변형 | A 적중 있음 | A 적중 없음 | B |\n|---|---|---|---|\n`;
for (const v of variants) md += `| ${v} | ${f(accByHit[`${v}|hit=true`].mean_score)} (n=${accByHit[`${v}|hit=true`].n}) | ${f(accByHit[`${v}|hit=false`].mean_score)} (n=${accByHit[`${v}|hit=false`].n}) | ${f(accByHit[`${v}|B`].mean_score)} (n=${accByHit[`${v}|B`].n}) |\n`;
const VK = { normal: '보통', rushed: '바쁨', all: '합산' };
md += `\n### 응답 방식별 정확도(사후 분석, 평균 0–2, 괄호는 건수; 적중은 엄격 기준)\n\n| 응답 방식 | ${['normal', 'rushed', 'all'].map((v) => VK[v]).join(' | ')} | A 중 비율(합산) |\n|---|---|---|---|---|\n`;
const cell = (x) => `${f(x.mean_score)} (${x.n})`;
for (const m of MODES) md += `| ${MODE_KO[m]} | ${['normal', 'rushed', 'all'].map((v) => cell(byMode[v][m])).join(' | ')} | ${f(100 * byMode.all[m].share_of_A, 0)}% |\n`;
if (byMode.all.other.n) md += `| ${MODE_KO.other} | ${['normal', 'rushed', 'all'].map((v) => cell(byMode[v].other)).join(' | ')} | ${f(100 * byMode.all.other.share_of_A, 0)}% |\n`;
md += `| ↳ 선택만 중 적중 | ${['normal', 'rushed', 'all'].map((v) => cell(byMode[v].pick_only_hit_strict)).join(' | ')} | – |\n`;
md += `| ↳ 선택만 중 비적중 | ${['normal', 'rushed', 'all'].map((v) => cell(byMode[v].pick_only_miss_strict)).join(' | ')} | – |\n`;
md += `| A 전체 중 적중 | ${['normal', 'rushed', 'all'].map((v) => cell(byMode[v].A_hit_strict)).join(' | ')} | – |\n`;
md += `| A 전체 중 비적중 | ${['normal', 'rushed', 'all'].map((v) => cell(byMode[v].A_miss_strict)).join(' | ')} | – |\n`;
md += `| (B) 직접 서술 | ${['normal', 'rushed', 'all'].map((v) => cell(byMode[v].B)).join(' | ')} | – |\n`;
md += `\n### 채점자 일치·채점자별 결과\n\n- 정확도 점수: 가중 κ ${f(agreement.score_weighted_kappa)}, 완전 일치 ${f(100 * agreement.score_exact_agree, 0)}%; 규칙 수 평균 절대차 ${f(agreement.rules_mean_abs_diff)}\n- 예상 이유 적중: κ ${f(agreement.hits_kappa)}, 일치 ${f(100 * agreement.hits_agree, 0)}%\n`;
for (const [k, c] of Object.entries(byJudge)) md += `- ${k}: A ${f(c.mean_A)} vs B ${f(c.mean_B)}, 차이 ${f(c.diff)} [${f(c.ci95[0])}, ${f(c.ci95[1])}], 윌콕슨 p=${pv(c.wilcoxon.p)}\n`;
fs.writeFileSync(path.join(HERE, 'results', `tables-${TAG}.md`), md);
console.log(md);
