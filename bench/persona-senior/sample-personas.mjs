// Nemotron-Personas-Korea(CC BY 4.0)에서 시니어 엔지니어·숙련 기술직 페르소나 추출 (시드 고정)
// 사용: node bench/persona-senior/sample-personas.mjs [--n 100] [--calib 10]
// 본 표본 N명 + 임계값 보정용 별도 표본 CALIB명(서로 겹치지 않음)
import fs from 'node:fs';
import path from 'node:path';
const HERE = path.dirname(new URL(import.meta.url).pathname);
const arg = (k, d) => (process.argv.includes(`--${k}`) ? process.argv[process.argv.indexOf(`--${k}`) + 1] : d);
const N = Number(arg('n', 100)), CALIB = Number(arg('calib', 10));
let seed = 20261123;
const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
// 직무군(먼저 맞는 군에 배정). 사무·영업·교육·관리직 등 비기술직 제외
const EXCLUDE = /판매|영업|사무원|사무 |교사|강사|교수|상담|매니저|중개|보험|회계|마케팅|구직|은퇴|무직|학생|주부|요리|조리|미용|운전|배달|경비|청소|간병|돌봄|농|어업|축산|의사|간호|약사|환경미화|재활용|촬영|단순 종사원|단순종사|음향|조명|사진|영상|악기/;
const GROUPS = [
  ['품질·검사', /품질|검사|시험원|계측|검측/],
  ['설비·정비', /정비|설비|유지보수|보수원|수리원|수리 /],
  ['전기·전자', /전기|전자|통신|반도체|배전|송전/],
  ['화학·에너지·환경', /화학|화공|석유|가스|발전|에너지|원자력|환경|플랜트|정유/],
  ['건설·토목', /건설|건축|토목|배관|철근|목공|미장|타일|비계|측량|도장공|용접공|조적|방수|크레인|굴착/],
  ['IT 인프라·SW', /네트워크|시스템 운영|서버|정보 시스템|데이터베이스|정보 보안|보안 전문|소프트웨어|프로그래머|웹 개발|시스템 설계|IT/],
  ['제조·생산', /생산|제조|조립|가공|용접|조작원|기계|선반|금형|사출|주조|도금|제관|단조|프레스|봉제|섬유|인쇄|식품 제조/],
  ['엔지니어·기술자', /엔지니어|기술자|기술원|설계|공학|기사/],
];
const groupOf = (occ) => (EXCLUDE.test(occ) ? null : GROUPS.find(([, re]) => re.test(occ))?.[0] ?? null);
const EXP = /베테랑|수십 년|[1-4]\d ?년|경력|숙련|반장|조장|팀장|책임|선임|수석|고참|잔뼈|노하우|전수/;
const senior = (p) => p.age >= 45 || (p.age >= 38 && EXP.test(p.professional_persona + p.skills_and_expertise));
// HF datasets-server API는 429로 막혀 parquet 샤드 2개(train-00000, train-00004, 222,223행)를 받아 JSONL로 바꿔 쓴다.
// (bench/persona-senior/parquet-to-jsonl.py). 행 ID는 '샤드:행번호'.
const SRC = arg('rows', path.join(process.env.HOME, '.cache/nemotron-ko/rows.jsonl'));
const rows = fs.readFileSync(SRC, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const seen = new Set();
const cand = rows.filter((p) => !seen.has(p.uuid) && seen.add(p.uuid) && p.age <= 75 && senior(p) && groupOf(p.occupation));
// 시드 셔플 후 직무군 라운드로빈, 같은 직업·지역·성별 쏠림 회피
for (let i = cand.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [cand[i], cand[j]] = [cand[j], cand[i]]; }
const names = GROUPS.map(([g]) => g);
const byG = Object.fromEntries(names.map((g) => [g, cand.filter((p) => groupOf(p.occupation) === g)]));
const picked = [], usedProv = {}, usedOcc = {};
let gi = 0;
while (picked.length < N + CALIB && Object.values(byG).some((a) => a.length)) {
  const g = names[gi++ % names.length];
  const pool = byG[g];
  if (!pool.length) continue;
  const female = picked.filter((p) => p.sex === '여자').length, male = picked.length - female;
  pool.sort((a, b) => (usedOcc[a.occupation] ?? 0) - (usedOcc[b.occupation] ?? 0) || (usedProv[a.province] ?? 0) - (usedProv[b.province] ?? 0) || ((a.sex === '여자') === (female < male) ? -1 : 1));
  const p = pool.shift();
  usedProv[p.province] = (usedProv[p.province] ?? 0) + 1;
  usedOcc[p.occupation] = (usedOcc[p.occupation] ?? 0) + 1;
  picked.push(p);
}
const fmt = (p, pid) => ({
  pid, group: groupOf(p.occupation), uuid: p.uuid, row_idx: p.row_idx,
  sex: p.sex, age: p.age, province: p.province, district: p.district, occupation: p.occupation, education_level: p.education_level,
  persona: p.persona, professional_persona: p.professional_persona, skills_and_expertise: p.skills_and_expertise,
});
// 보정 표본은 라운드로빈 순서상 마지막 CALIB명 (본 표본과 겹치지 않음)
const main = picked.slice(0, N).map((p, i) => fmt(p, `S${String(i + 1).padStart(3, '0')}`));
const calib = picked.slice(N).map((p, i) => fmt(p, `C${String(i + 1).padStart(2, '0')}`));
const dist = (a, k) => a.reduce((o, p) => ((o[p[k]] = (o[p[k]] ?? 0) + 1), o), {});
const meta = { source: 'nvidia/Nemotron-Personas-Korea (CC BY 4.0), HF parquet shards train-00000/00004-of-00009', seed: 20261123, fetched_rows: rows.length, candidates: cand.length,
  criteria: '기술직 직무군(정규식) + (45세 이상 또는 38세 이상이면서 경력 신호어)', group_dist: dist(main, 'group'), sex_dist: dist(main, 'sex'),
  age: { min: Math.min(...main.map((p) => p.age)), max: Math.max(...main.map((p) => p.age)), mean: +(main.reduce((s, p) => s + p.age, 0) / main.length).toFixed(1) },
  candidate_group_dist: Object.fromEntries(names.map((g) => [g, byG[g].length + picked.filter((p) => groupOf(p.occupation) === g).length])) };
fs.mkdirSync(path.join(HERE, 'data'), { recursive: true });
fs.writeFileSync(path.join(HERE, 'data', 'personas.json'), JSON.stringify({ ...meta, personas: main, calibration: calib }, null, 1));
console.log(JSON.stringify(meta, null, 1));
for (const p of [...main, ...calib]) console.log(p.pid, p.group, p.sex, p.age, p.province, p.occupation);
