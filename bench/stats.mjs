// 통계 유틸: Wilson 신뢰구간, 정확 맥니마 검정, 대응 부트스트랩
export function wilson(k, n, z = 1.96) {
  if (!n) return [null, null];
  const p = k / n, d = 1 + (z * z) / n;
  const c = (p + (z * z) / (2 * n)) / d;
  const h = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d;
  return [Math.max(0, c - h), Math.min(1, c + h)];
}

function logChoose(n, k) {
  let s = 0;
  for (let i = 1; i <= k; i++) s += Math.log(n - k + i) - Math.log(i);
  return s;
}

/** 정확 맥니마(이항) 양측 p. b = A만 1, c = B만 1 */
export function mcnemarExact(b, c) {
  const n = b + c;
  if (n === 0) return 1;
  const k = Math.min(b, c);
  let p = 0;
  for (let i = 0; i <= k; i++) p += Math.exp(logChoose(n, i) - n * Math.LN2);
  return Math.min(1, 2 * p);
}

/** 대응 이진 결과 x[i], y[i] (0/1)의 비율 차이(x - y) 부트스트랩 95% CI */
export function pairedBootstrapDiff(x, y, B = 4000, seed = 12345) {
  const n = x.length;
  if (!n) return [null, null];
  let s = seed;
  const r = () => ((s = (s * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  const diffs = [];
  for (let b = 0; b < B; b++) {
    let d = 0;
    for (let i = 0; i < n; i++) { const j = Math.floor(r() * n); d += x[j] - y[j]; }
    diffs.push(d / n);
  }
  diffs.sort((a, b) => a - b);
  return [diffs[Math.floor(0.025 * B)], diffs[Math.floor(0.975 * B)]];
}

export const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);
export const median = (a) => {
  if (!a.length) return null;
  const s = [...a].sort((x, y) => x - y), m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
