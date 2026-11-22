// Nemotron-Personas-Korea(CC BY 4.0)에서 반복 판단 직무 퍼소나 N명 층화 추출 (시드 고정)
// 사용: node bench/persona/sample-personas.mjs [--n 30]
import fs from 'node:fs';
import path from 'node:path';
const HERE = path.dirname(new URL(import.meta.url).pathname);
const N = Number(process.argv.includes('--n') ? process.argv[process.argv.indexOf('--n') + 1] : 30);
const API = 'https://datasets-server.huggingface.co/rows?dataset=nvidia/Nemotron-Personas-Korea&config=default&split=train';
let seed = 20261123;
const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
const GROUPS = {
  사무: /사무|회계|경리|총무|인사|행정|비서|기획|재무|법무|경영지원/,
  연구: /연구|과학|분석가|엔지니어(?!.*소프트)|설계/,
  제조: /생산|제조|조립|기계|용접|가공|품질|검사원|공정|조작원/,
  의료: /의사|간호|약사|치료사|의료|병원|임상|보건|방사선/,
  교육: /교사|강사|교수|교육|보육|학원/,
  영업: /영업|판매|매장|상품|마케팅|보험|부동산|중개/,
  IT: /소프트웨어|프로그래머|개발자|정보|시스템|네트워크|데이터|웹|IT/,
};
const groupOf = (occ) => Object.entries(GROUPS).find(([, re]) => re.test(occ))?.[0] ?? null;
const rows = [];
for (let k = 0; k < 40; k++) {
  const off = Math.floor(rnd() * (1_000_000 - 100));
  const r = await fetch(`${API}&offset=${off}&length=100`);
  if (!r.ok) { console.warn('fetch fail', r.status); continue; }
  const j = await r.json();
  for (const x of j.rows) rows.push({ offset: off + x.row_idx - (j.rows[0].row_idx), ...x.row, row_idx: x.row_idx });
}
const cand = rows.filter((p) => p.age >= 25 && p.age <= 64 && groupOf(p.occupation));
// 층화: 직무군 라운드로빈, 같은 지역·성별 쏠림 회피
const byG = Object.fromEntries(Object.keys(GROUPS).map((g) => [g, cand.filter((p) => groupOf(p.occupation) === g)]));
const picked = [], usedProv = {};
let gi = 0;
while (picked.length < N && Object.values(byG).some((a) => a.length)) {
  const g = Object.keys(GROUPS)[gi++ % 7];
  const pool = byG[g];
  if (!pool.length) continue;
  const female = picked.filter((p) => p.sex === '여자').length, male = picked.length - female;
  pool.sort((a, b) => (usedProv[a.province] ?? 0) - (usedProv[b.province] ?? 0) || ((a.sex === '여자') === (female < male) ? -1 : 1));
  const p = pool.shift();
  usedProv[p.province] = (usedProv[p.province] ?? 0) + 1;
  picked.push(p);
}
const out = picked.map((p, i) => ({
  pid: `P${String(i + 1).padStart(2, '0')}`, group: groupOf(p.occupation), uuid: p.uuid, row_idx: p.row_idx,
  sex: p.sex, age: p.age, province: p.province, district: p.district, occupation: p.occupation, education_level: p.education_level,
  persona: p.persona, professional_persona: p.professional_persona, skills_and_expertise: p.skills_and_expertise, cultural_background: p.cultural_background,
}));
fs.mkdirSync(path.join(HERE, 'data'), { recursive: true });
fs.writeFileSync(path.join(HERE, 'data', 'personas.json'), JSON.stringify({ source: 'nvidia/Nemotron-Personas-Korea (CC BY 4.0)', seed: 20261123, fetched_rows: rows.length, candidates: cand.length, personas: out }, null, 1));
console.log(`rows ${rows.length}, candidates ${cand.length}, picked ${out.length}`);
for (const p of out) console.log(p.pid, p.group, p.sex, p.age, p.province, p.occupation);
