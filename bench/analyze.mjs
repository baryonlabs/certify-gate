// 벤치 결과 집계: node bench/analyze.mjs [tag ...]  (기본: main)
// 출력: bench/results/summary-<tag>.json, bench/results/tables-<tag>.md
import fs from 'node:fs';
import path from 'node:path';
import { analyze } from '../src/align.js';
import { wilson, mcnemarExact, pairedBootstrapDiff, mean, median } from './stats.mjs';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const tags = process.argv.slice(2).length ? process.argv.slice(2) : ['main'];
const truth = JSON.parse(fs.readFileSync(path.join(ROOT, 'bench', 'truth.json'), 'utf8'));
const tasks = JSON.parse(fs.readFileSync(path.join(ROOT, 'bench', 'tasks.json'), 'utf8')).items;
const HARD = new Set(['number', 'year', 'edition']);

for (const tag of tags) {
  const dir = path.join(ROOT, 'bench', 'results', 'raw', tag);
  const sessions = fs.readFileSync(path.join(dir, 'sessions.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const serverLog = fs.existsSync(path.join(dir, 'server-log.jsonl')) ? fs.readFileSync(path.join(dir, 'server-log.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
  const byMeta = new Map(serverLog.map((r) => [r.meta, r]));
  // 세션 레코드 정리
  const recs = sessions.map((s) => {
    const t = truth[s.item];
    const log = byMeta.get(s.meta);
    const decision = log?.decision ?? (s.decision === 'none' ? 'none' : s.decision);
    const approved = decision === 'approve';
    const reason = log?.reason ?? '';
    const lc = reason.toLowerCase();
    const q = !reason.trim() ? 0 : (t.keys ?? []).some((k) => lc.includes(k.toLowerCase())) ? 2 : reason.trim().length >= 10 ? 1 : 0;
    return {
      model: s.model, model_id: s.model_id, variant: s.variant, cond: s.cond, item: s.item, cond_pos: s.cond_pos,
      label: t.label, error_type: t.error_type ?? null, origin: t.origin,
      decision, approved, explicit: !approved && decision !== 'none' && (decision !== 'skip' || reason.trim().length > 0),
      reason, reason_q: q, steps: s.steps, rounds: s.rounds, wall_ms: s.wall_ms, llm_ms: s.llm_ms, server_ms: log?.duration_ms ?? null,
      n_checked: log?.checked_sentences?.length ?? 0, n_sent: t.n_sentences,
      contest_choice: log?.contest?.choice ?? null, contest_reason: log?.contest?.reason ?? '',
      harness_error: s.harness_error ?? null, llm_errors: s.llm_errors,
    };
  });

  const strata = [...new Set(recs.map((r) => `${r.model}|${r.variant}`))].sort();
  const conds = [...new Set(recs.map((r) => r.cond))].sort();
  const cell = (st, c) => recs.filter((r) => `${r.model}|${r.variant}` === st && r.cond === c);
  const rate = (arr, f) => { const k = arr.filter(f).length; return { k, n: arr.length, p: arr.length ? k / arr.length : null, ci: wilson(k, arr.length) }; };

  const metrics = {};
  for (const st of strata) for (const c of conds) {
    const rs = cell(st, c);
    const E = rs.filter((r) => r.label === 'error'), Cr = rs.filter((r) => r.label === 'correct'), Ct = rs.filter((r) => r.label === 'contested');
    const flagged = E.filter((r) => !r.approved && r.reason.trim());
    metrics[`${st}|${c}`] = {
      stratum: st, cond: c, n: rs.length,
      model_id: rs[0]?.model_id,
      detection: rate(E, (r) => !r.approved),
      explicit_flag: rate(E, (r) => r.explicit),
      false_approval: rate(E, (r) => r.approved),
      false_rejection: rate(Cr, (r) => !r.approved),
      false_rejection_by_origin: { scifact: rate(Cr.filter((r) => r.origin === 'scifact'), (r) => !r.approved), ontology: rate(Cr.filter((r) => r.origin === 'ontology'), (r) => !r.approved) },
      detection_by_origin: { scifact: rate(E.filter((r) => r.origin === 'scifact'), (r) => !r.approved), ontology: rate(E.filter((r) => r.origin === 'ontology'), (r) => !r.approved) },
      no_decision: rate(rs, (r) => r.decision === 'none'),
      contested_collapsed: rate(Ct, (r) => r.approved && !r.contest_choice && !r.contest_reason),
      steps_mean: mean(rs.map((r) => r.steps)), rounds_mean: mean(rs.map((r) => r.rounds)),
      wall_s_median: median(rs.map((r) => r.wall_ms / 1000)), llm_s_mean: mean(rs.map((r) => r.llm_ms / 1000)),
      reason_quality_mean: mean(flagged.map((r) => r.reason_q)), reason_quality_n: flagged.length,
      reason_q2_rate: rate(flagged, (r) => r.reason_q === 2),
      by_error_type: Object.fromEntries([...new Set(E.map((r) => r.error_type))].sort().map((et) => [et, rate(E.filter((r) => r.error_type === et), (r) => !r.approved)])),
      harness_errors: rs.filter((r) => r.harness_error).length,
    };
  }

  // 대응 비교 (항목 단위 쌍) — 지표: 승인 여부
  const pairs = [['A', 'B'], ['A', 'C'], ['B', 'C']].filter(([x, y]) => conds.includes(x) && conds.includes(y));
  const tests = [];
  const pairUp = (st, x, y, label) => {
    const X = new Map(cell(st, x).filter((r) => r.label === label).map((r) => [r.item, r.approved ? 1 : 0]));
    const Y = new Map(cell(st, y).filter((r) => r.label === label).map((r) => [r.item, r.approved ? 1 : 0]));
    const ids = [...X.keys()].filter((i) => Y.has(i));
    return { ids, x: ids.map((i) => X.get(i)), y: ids.map((i) => Y.get(i)) };
  };
  for (const label of ['error', 'correct']) {
    const metric = label === 'error' ? 'false_approval' : 'approval_of_correct';
    for (const [x, y] of pairs) {
      let B = 0, C = 0, allx = [], ally = [];
      for (const st of [...strata, 'POOLED']) {
        let px, py;
        if (st === 'POOLED') { px = allx; py = ally; } else { const p = pairUp(st, x, y, label); px = p.x; py = p.y; allx.push(...px); ally.push(...py); }
        const b = px.filter((v, i) => v === 1 && py[i] === 0).length;
        const c = px.filter((v, i) => v === 0 && py[i] === 1).length;
        if (st !== 'POOLED') { B += b; C += c; }
        tests.push({
          metric, compare: `${x} vs ${y}`, stratum: st, n_pairs: px.length,
          rate_x: px.length ? mean(px) : null, rate_y: py.length ? mean(py) : null,
          diff: px.length ? mean(px) - mean(py) : null,
          diff_ci95: pairedBootstrapDiff(px, py),
          discordant: { x_only: b, y_only: c },
          mcnemar_p: mcnemarExact(b, c),
          note: st === 'POOLED' ? '층(모델×변형)을 합친 것: 같은 항목이 여러 층에 반복되므로 독립 가정이 약함' : undefined,
        });
      }
    }
  }

  // 강조기 단독(기계) 기준: 강한 플래그(숫자·연도·판본)가 있으면 '걸러냄'
  const hl = tasks.map((it) => ({ id: it.id, label: truth[it.id].label, error_type: truth[it.id].error_type, flagged: analyze(it).some((a) => a.flags.some((f) => HARD.has(f.type))) }));
  const highlighter = {
    detection: rate(hl.filter((h) => h.label === 'error'), (h) => h.flagged),
    false_flag: rate(hl.filter((h) => h.label === 'correct'), (h) => h.flagged),
    by_error_type: Object.fromEntries([...new Set(hl.filter((h) => h.error_type).map((h) => h.error_type))].sort().map((et) => [et, rate(hl.filter((h) => h.error_type === et), (h) => h.flagged)])),
  };

  // 오류 항목을 강조기가 잡는 것/못 잡는 것으로 나눠 조건별 탐지율
  const hlSet = new Set(hl.filter((h) => h.flagged).map((h) => h.id));
  const splitByHl = {};
  for (const st of strata) for (const c of conds) {
    const E = cell(st, c).filter((r) => r.label === 'error');
    splitByHl[`${st}|${c}`] = { highlighted: rate(E.filter((r) => hlSet.has(r.item)), (r) => !r.approved), not_highlighted: rate(E.filter((r) => !hlSet.has(r.item)), (r) => !r.approved) };
  }

  // 조건 순서 효과 점검(세션은 독립 호출이므로 효과가 없어야 정상)
  const orderCheck = [0, 1, 2].map((pos) => ({ pos, ...rate(recs.filter((r) => r.cond_pos === pos && r.label === 'error'), (r) => !r.approved) }));

  const summary = { tag, generated: new Date().toISOString(), n_sessions: recs.length, items: { total: tasks.length, ...Object.values(truth).reduce((a, t) => ((a[t.label] = (a[t.label] ?? 0) + 1), a), {}) }, metrics, tests, highlighter, split_by_highlighter: splitByHl, order_check: orderCheck };
  fs.writeFileSync(path.join(ROOT, 'bench', 'results', `summary-${tag}.json`), JSON.stringify(summary, null, 1));
  fs.writeFileSync(path.join(ROOT, 'bench', 'results', `sessions-${tag}.json`), JSON.stringify(recs, null, 1));

  // 마크다운 표
  const pc = (r) => (r.p == null ? '–' : `${(100 * r.p).toFixed(0)}% (${r.k}/${r.n})`);
  const ci = (r) => (r.p == null ? '' : ` [${(100 * r.ci[0]).toFixed(0)}–${(100 * r.ci[1]).toFixed(0)}]`);
  const f1 = (x) => (x == null ? '–' : x.toFixed(1));
  let md = `### 조건별 지표 (${tag})\n\n| 모델 | 변형 | 조건 | 오류 검출률 | 잘못된 승인 | 정상 오거부 | 쟁점 소실 | 미결정 | 단계/항목 | LLM 호출/항목 | 시간 중앙값(s) | 사유 품질(0–2) |\n|---|---|---|---|---|---|---|---|---|---|---|---|\n`;
  for (const st of strata) for (const c of conds) {
    const m = metrics[`${st}|${c}`];
    const [mo, va] = st.split('|');
    md += `| ${mo} (${m.model_id}) | ${va} | ${c} | ${pc(m.detection)}${ci(m.detection)} | ${pc(m.false_approval)} | ${pc(m.false_rejection)}${ci(m.false_rejection)} | ${pc(m.contested_collapsed)} | ${pc(m.no_decision)} | ${f1(m.steps_mean)} | ${f1(m.rounds_mean)} | ${f1(m.wall_s_median)} | ${m.reason_quality_mean == null ? '–' : m.reason_quality_mean.toFixed(2)} (n=${m.reason_quality_n}) |\n`;
  }
  md += `\n### 대응 비교: 잘못된 승인(오류 항목) / 정상 승인율(정상 항목)\n\n| 지표 | 비교 | 층 | 쌍 | x 비율 | y 비율 | 차이 x−y [95% 부트스트랩] | 불일치쌍 (x만/y만) | 맥니마 p |\n|---|---|---|---|---|---|---|---|---|\n`;
  for (const t of tests) {
    md += `| ${t.metric} | ${t.compare} | ${t.stratum.replace('|', ' · ')} | ${t.n_pairs} | ${(100 * t.rate_x).toFixed(0)}% | ${(100 * t.rate_y).toFixed(0)}% | ${(100 * t.diff).toFixed(0)}%p [${(100 * t.diff_ci95[0]).toFixed(0)}, ${(100 * t.diff_ci95[1]).toFixed(0)}] | ${t.discordant.x_only}/${t.discordant.y_only} | ${t.mcnemar_p < 0.001 ? '<0.001' : t.mcnemar_p.toFixed(3)} |\n`;
  }
  md += `\n### 오류 유형별 검출률\n\n| 모델 | 변형 | 조건 | ${Object.keys(highlighter.by_error_type).join(' | ')} |\n|---|---|---|${Object.keys(highlighter.by_error_type).map(() => '---').join('|')}|\n`;
  for (const st of strata) for (const c of conds) {
    const m = metrics[`${st}|${c}`]; const [mo, va] = st.split('|');
    md += `| ${mo} | ${va} | ${c} | ${Object.keys(highlighter.by_error_type).map((et) => (m.by_error_type[et] ? pc(m.by_error_type[et]) : '–')).join(' | ')} |\n`;
  }
  md += `| 강조기 단독(기계) | – | – | ${Object.keys(highlighter.by_error_type).map((et) => pc(highlighter.by_error_type[et])).join(' | ')} |\n`;
  md += `\n강조기 단독: 오류 검출 ${pc(highlighter.detection)}, 정상 항목 오경고 ${pc(highlighter.false_flag)}\n`;
  md += `\n### 강조기가 표시한/못 한 오류 항목별 검출률\n\n| 모델 | 변형 | 조건 | 강조된 오류 | 강조 안 된 오류 |\n|---|---|---|---|---|\n`;
  for (const st of strata) for (const c of conds) {
    const s = splitByHl[`${st}|${c}`]; const [mo, va] = st.split('|');
    md += `| ${mo} | ${va} | ${c} | ${pc(s.highlighted)} | ${pc(s.not_highlighted)} |\n`;
  }
  md += `\n### 출처 유형별 정상 오거부율 / 오류 검출률\n\n| 모델 | 변형 | 조건 | 오거부: SciFact 정상 | 오거부: ontology 정상 | 검출: SciFact 오류 | 검출: ontology 오류 |\n|---|---|---|---|---|---|---|\n`;
  for (const st of strata) for (const c of conds) {
    const m = metrics[`${st}|${c}`]; const [mo, va] = st.split('|');
    md += `| ${mo} | ${va} | ${c} | ${pc(m.false_rejection_by_origin.scifact)} | ${pc(m.false_rejection_by_origin.ontology)} | ${pc(m.detection_by_origin.scifact)} | ${pc(m.detection_by_origin.ontology)} |\n`;
  }
  md += `\n조건 제시 순서별 오류 검출률(독립 호출이므로 차이 없음이 기대값): ${orderCheck.map((o) => `${o.pos + 1}번째 ${pc(o)}`).join(', ')}\n`;
  fs.writeFileSync(path.join(ROOT, 'bench', 'results', `tables-${tag}.md`), md);
  console.log(md);
}
