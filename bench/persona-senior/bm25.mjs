// 글자 2-gram BM25 (한국어 형태소 분석기 없이 쓰는 단어 일치 검색). 논문 ② 검색과 방법 (c) 기준선에 쓴다.
const norm = (s) => String(s).toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ');
export function grams(s) {
  const out = [];
  for (const w of norm(s).split(/\s+/).filter(Boolean)) {
    if (w.length === 1) out.push(w);
    for (let i = 0; i + 1 < w.length; i++) out.push(w.slice(i, i + 2));
  }
  return out;
}
/** query 문자열과 docs 배열의 BM25 점수 배열(IDF는 docs 안에서 계산) */
export function bm25Scores(query, docs, k1 = 1.2, b = 0.75) {
  const D = docs.map(grams), N = D.length, avg = D.reduce((s, d) => s + d.length, 0) / N;
  const df = {};
  for (const d of D) for (const t of new Set(d)) df[t] = (df[t] ?? 0) + 1;
  const q = [...new Set(grams(query))];
  return D.map((d) => {
    const tf = {}; for (const t of d) tf[t] = (tf[t] ?? 0) + 1;
    return q.reduce((s, t) => {
      if (!tf[t]) return s;
      const idf = Math.log(1 + (N - df[t] + 0.5) / (df[t] + 0.5));
      return s + idf * (tf[t] * (k1 + 1)) / (tf[t] + k1 * (1 - b + (b * d.length) / avg));
    }, 0);
  });
}
