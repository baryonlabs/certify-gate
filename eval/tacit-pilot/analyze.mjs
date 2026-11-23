// 저자 1인 파일럿 분석(논문 4장 표 4): node eval/tacit-pilot/analyze.mjs
// 입력: eval/tacit-pilot/responses.json, items.json  출력: 표준 출력 + eval/tacit-pilot/summary.json
// 의존성 없음. 탐색적 관찰이며, 참여자는 설계자 1명이다.
import fs from 'node:fs';
import path from 'node:path';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const { responses } = JSON.parse(fs.readFileSync(path.join(HERE, 'responses.json'), 'utf8'));
const { items } = JSON.parse(fs.readFileSync(path.join(HERE, 'items.json'), 'utf8'));

const median = (xs) => { const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
const sec = (r) => r.ms / 1000;

const A = responses.filter((r) => r.cond === 'A');
const B = responses.filter((r) => r.cond === 'B');
const tA = A.map(sec), tB = B.map(sec);

// 정확 맨-휘트니 U 검정(양측, 동점 없음 가정 → 동점 있으면 경고). 모든 배정을 열거.
function mannWhitneyExact(x, y) {
  const all = [...x, ...y];
  if (new Set(all).size !== all.length) console.warn('경고: 동점 있음 — 정확 분포가 근사가 됨');
  const U = (a, b) => a.reduce((s, ai) => s + b.reduce((t, bj) => t + (ai < bj ? 1 : ai === bj ? 0.5 : 0), 0), 0);
  const uObs = U(x, y); // x<y 쌍의 수
  const n = all.length, k = x.length;
  const mu = (k * (n - k)) / 2;
  const dObs = Math.abs(uObs - mu);
  let extreme = 0, total = 0;
  const idx = [];
  (function rec(start) {
    if (idx.length === k) {
      const xs = idx.map((i) => all[i]);
      const ys = all.filter((_, i) => !idx.includes(i));
      total++;
      if (Math.abs(U(xs, ys) - mu) >= dObs - 1e-9) extreme++;
      return;
    }
    for (let i = start; i < n; i++) { idx.push(i); rec(i + 1); idx.pop(); }
  })(0);
  return { U_x_less_y: uObs, pairs: k * (n - k), p_two_sided: extreme / total, rank_biserial: (2 * uObs) / (k * (n - k)) - 1 };
}

// 부트스트랩(조건별 재표집) 중앙값 비 B/A, 백분위 95% CI. 시드 고정.
let seed = 20261122;
const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
function bootRatio(a, b, R = 10000) {
  const rs = [];
  for (let r = 0; r < R; r++) {
    const ra = a.map(() => a[Math.floor(rnd() * a.length)]);
    const rb = b.map(() => b[Math.floor(rnd() * b.length)]);
    rs.push(median(rb) / median(ra));
  }
  rs.sort((p, q) => p - q);
  return [rs[Math.floor(0.025 * R)], rs[Math.floor(0.975 * R)]];
}

const mw = mannWhitneyExact(tA, tB);
const ci = bootRatio(tA, tB);
const picksPerItem = mean(A.map((r) => r.picks.filter((k) => k < 3).length));
const noneCorrect = A.filter((r) => r.picks.includes(3)).length;
const supplemented = A.filter((r) => r.text.trim()).length;
const fid = (xs) => mean(xs.map((r) => r.fidelity));

const summary = {
  label: '저자 1인 파일럿(탐색적, 본인 평정) — 일반화 불가',
  n_items: { A: A.length, B: B.length, defined: items.length },
  time_sec: {
    A: { median: median(tA), mean: mean(tA) },
    B: { median: median(tB), mean: mean(tB) },
    ratio_of_medians_B_over_A: median(tB) / median(tA),
    ratio_ci95_bootstrap: ci,
    mann_whitney_exact: mw,
  },
  self_rated_fidelity_1to5: { A: fid(A), B: fid(B) },
  A_picks_per_item: picksPerItem,
  A_supplemented_items: supplemented,
  A_none_correct: noneCorrect,
};
fs.writeFileSync(path.join(HERE, 'summary.json'), JSON.stringify(summary, null, 1) + '\n');

const f = (x, d = 1) => x.toFixed(d);
console.log(`저자 1인 파일럿 (A ${A.length}건, B ${B.length}건)
| 지표 | (A) 확인·교정 | (B) 직접 서술 |
|---|---|---|
| 항목당 시간 중앙값(평균) | ${f(median(tA))}초(${f(mean(tA))}초) | ${f(median(tB))}초(${f(mean(tB))}초) |
| 본인 평정 정확도(1-5, 평균) | ${f(fid(A))} | ${f(fid(B))} |
| 고른 예상 답 / 보충 입력 | 항목당 ${f(picksPerItem)}개 / ${supplemented}건 | - |
| '모두 틀림' 선택 | ${noneCorrect}/${A.length} | - |

시간 비(중앙값 B/A) ${f(median(tB) / median(tA), 2)}배, 부트스트랩 95% CI [${f(ci[0])}, ${f(ci[1])}]배 (10,000회, 시드 고정)
정확 맨-휘트니 U(A<B 쌍) = ${mw.U_x_less_y}/${mw.pairs}, 양측 p = ${mw.p_two_sided.toFixed(4)}, 순위이연상관 r = ${f(mw.rank_biserial, 2)}`);
