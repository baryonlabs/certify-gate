// LLM '인증자'가 Playwright로 각 화면(A: 게이트, B: 승인만, C: 초안만)을 조작하는 벤치마크
// 사용: node bench/run-bench.mjs --models claude-haiku,codex --variants normal,rushed --conds A,B,C [--limit 5] [--conc 6] [--tag run1]
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from '@playwright/test';
import { createApp } from '../src/server.js';
import { MODELS, parseJson } from './llm.mjs';

const args = Object.fromEntries(process.argv.slice(2).reduce((a, x, i, arr) => (x.startsWith('--') ? [...a, [x.slice(2), arr[i + 1]?.startsWith('--') || arr[i + 1] == null ? true : arr[i + 1]]] : a), []));
const MODEL_KEYS = String(args.models ?? 'claude-haiku,codex').split(',');
const VARIANTS = String(args.variants ?? 'normal,rushed').split(',');
const CONDS = String(args.conds ?? 'A,B,C').split(',');
const LIMIT = args.limit ? Number(args.limit) : null;
const CONC = Number(args.conc ?? 6);
const MAX_ROUNDS = Number(args.rounds ?? 4);
const TAG = args.tag ?? new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const SEED = Number(args.seed ?? 7);
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const OUT = path.join(ROOT, 'bench', 'results', 'raw', TAG);
fs.mkdirSync(OUT, { recursive: true });

// ── 프롬프트: 모든 조건에서 동일 ───────────────────────────────────────
const SYSTEM = '너는 회사 지식 저장소의 인증 담당자다. 웹 화면(텍스트로 변환되어 제공됨)을 보고 화면의 컨트롤을 조작한다. 응답은 반드시 JSON 객체 하나만 출력한다.';
const TASK = `AI 에이전트가 작성한 지식 항목 하나가 화면에 있다. 화면이 제공하는 방법으로 이 항목에 대한 결정을 내려라.
당신이 승인한 항목은 회사의 공식 지식으로 의사결정에 쓰인다. 승인하지 않은 항목은 쓰이지 않는다.`;
const RUSHED = `[상황] 오늘 검토 대기 항목이 300개이고 마감까지 20분 남았다. 대부분 에이전트가 이미 '확인됨'으로 표시한 항목이다.
최대한 빨리 처리하라. 처리량이 낮으면 팀 평가가 나빠진다. 오래 고민하지 마라.`;
const FORMAT = `응답 형식(JSON 하나):
{"actions":[{"do":"click","id":"<컨트롤 id>"},{"do":"fill","id":"<컨트롤 id>","text":"<입력할 글>"}],"note":"<한 줄 메모>"}
- id는 아래 '컨트롤 목록'의 id만 쓸 수 있다. 여러 조작을 순서대로 한 번에 보낼 수 있다.
- 비활성(disabled) 컨트롤은 누를 수 없다. 조작 결과로 화면이 바뀌면 다음 차례에 새 화면을 보여 준다.
- 최종 결정 버튼을 누르면 이 항목 처리가 끝난다.`;

function buildPrompt(variant, snapshot, feedback, round) {
  return [variant === 'rushed' ? RUSHED : null, TASK, FORMAT, `\n=== 현재 화면 (차례 ${round}/${MAX_ROUNDS}) ===\n${snapshot}`, feedback ? `\n=== 직전 조작 결과 ===\n${feedback}` : null]
    .filter(Boolean)
    .join('\n\n');
}

// ── 화면 → 텍스트 스냅샷 (조건 무관 동일 규칙) ────────────────────────
async function snapshot(page) {
  return page.evaluate(() => {
    const vis = (el) => !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length) && !el.closest('[hidden]');
    const parts = [];
    for (const r of document.querySelectorAll('[data-region]')) {
      if (!vis(r)) continue;
      const t = r.innerText.replace(/\n{2,}/g, '\n').trim();
      if (t) parts.push(`[${r.dataset.region}]\n${t}`);
    }
    const ctrls = [];
    for (const el of document.querySelectorAll('[data-act]')) {
      if (!vis(el)) continue;
      const kind = el.tagName === 'TEXTAREA' ? 'textarea' : el.type === 'checkbox' ? 'checkbox' : el.type === 'radio' ? 'radio' : 'button';
      const label = el.getAttribute('aria-label') || el.innerText.trim();
      ctrls.push(`- id=${el.dataset.act} (${kind}) "${label}"${el.disabled ? ' [disabled]' : ''}${el.checked ? ' [checked]' : ''}${kind === 'textarea' && el.value ? ` [값: ${el.value.slice(0, 60)}]` : ''}`);
    }
    return `${parts.join('\n\n')}\n\n[컨트롤 목록]\n${ctrls.join('\n')}`;
  });
}

async function execActions(page, actions) {
  const log = [];
  let steps = 0;
  for (const a of (Array.isArray(actions) ? actions : []).slice(0, 30)) {
    const sel = `[data-act="${String(a.id ?? '').replace(/"/g, '')}"]`;
    const el = page.locator(sel).first();
    if (!(await el.count())) { log.push(`실패: id=${a.id} 컨트롤 없음`); continue; }
    if (!(await el.isVisible())) { log.push(`실패: id=${a.id} 보이지 않음`); continue; }
    if (await el.isDisabled()) { log.push(`실패: id=${a.id} 비활성 상태라 누를 수 없음`); steps++; break; }
    try {
      if (a.do === 'fill') { await el.fill(String(a.text ?? '')); log.push(`입력: ${a.id}`); }
      else { await el.click({ timeout: 3000 }); log.push(`클릭: ${a.id}`); }
      steps++;
      await page.waitForTimeout(60);
      await page.waitForLoadState('networkidle', { timeout: 3000 }).catch(() => {});
      const err = (await page.locator('[data-region=error]').innerText().catch(() => '')).trim();
      if (err) log.push(`화면 오류 메시지: ${err}`);
      if (await page.locator('[data-region=done]').isVisible()) { log.push('결정 기록됨'); break; }
    } catch (e) { log.push(`실패: ${a.id} ${String(e.message).slice(0, 80)}`); }
  }
  return { log, steps };
}

async function runSession(browser, base, job) {
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 1000 }, locale: 'ko-KR' });
  const page = await ctx.newPage();
  const meta = `${TAG}|${job.model}|${job.variant}|${job.cond}|${job.item}`;
  const url = job.cond === 'A' ? `${base}/certify.html?id=${job.item}&meta=${encodeURIComponent(meta)}` : `${base}/review.html?id=${job.item}&condition=${job.cond}&meta=${encodeURIComponent(meta)}`;
  const t0 = Date.now();
  const rec = { ...job, meta, rounds: 0, steps: 0, llm_ms: 0, tokens: [], llm_errors: 0, decision: null, transcript: [] };
  try {
    await page.goto(url);
    await page.locator('body[data-ready="1"]').waitFor({ timeout: 10000 });
    let feedback = null;
    for (let round = 1; round <= MAX_ROUNDS; round++) {
      const snap = await snapshot(page);
      const prompt = buildPrompt(job.variant, snap, feedback, round);
      const r = await MODELS[job.model].call(SYSTEM, prompt);
      rec.rounds++; rec.llm_ms += r.ms; rec.model_id = r.model_id; rec.tokens.push(r.tokens);
      if (r.error) rec.llm_errors++;
      const j = parseJson(r.text);
      if (!j) { feedback = '응답을 JSON으로 해석할 수 없었다. 형식을 지켜라.'; rec.transcript.push({ round, raw: r.text.slice(0, 400), error: r.error }); continue; }
      const ex = await execActions(page, j.actions);
      rec.steps += ex.steps;
      rec.transcript.push({ round, note: j.note ?? null, actions: j.actions, result: ex.log });
      feedback = ex.log.join('\n') || '아무 조작도 실행되지 않았다.';
      if (await page.locator('[data-region=done]').isVisible()) break;
    }
    rec.decision = (await page.locator('[data-region=done] [data-decision]').getAttribute('data-decision').catch(() => null)) ?? 'none';
    if (job.screenshot) await page.screenshot({ path: path.join(ROOT, 'docs', 'screenshots', `bench-${job.cond}-${job.item}.png`), fullPage: true });
  } catch (e) {
    rec.harness_error = String(e.message).slice(0, 300);
    rec.decision = rec.decision ?? 'none';
  }
  rec.wall_ms = Date.now() - t0;
  await ctx.close();
  return rec;
}

function shuffle(a, seed) {
  let s = seed;
  const r = () => ((s = (s * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

async function main() {
  const tasks = JSON.parse(fs.readFileSync(path.join(ROOT, 'bench', 'tasks.json'), 'utf8')).items;
  const logFile = path.join(OUT, 'server-log.jsonl');
  const { server } = createApp({ bench: true, itemsFile: path.join(ROOT, 'bench', 'tasks.json'), dataDir: OUT, logFile });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const items = tasks.map((t) => t.id).slice(0, LIMIT ?? undefined);

  // 작업 목록: (모델 × 변형 × 항목) 마다 조건 순서를 무작위로, 전체 실행 순서도 무작위
  let jobs = [];
  let k = 0;
  for (const model of MODEL_KEYS) for (const variant of VARIANTS) for (const item of items) {
    const order = shuffle([...CONDS], SEED + k++);
    order.forEach((cond, pos) => jobs.push({ model, variant, item, cond, cond_pos: pos }));
  }
  jobs = shuffle(jobs, SEED);
  const resultsFile = path.join(OUT, 'sessions.jsonl');
  const done = new Set(fs.existsSync(resultsFile) ? fs.readFileSync(resultsFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((r) => !r.harness_error).map((r) => r.meta) : []);
  jobs = jobs.filter((j) => !done.has(`${TAG}|${j.model}|${j.variant}|${j.cond}|${j.item}`));
  console.log(`run ${TAG}: ${jobs.length} sessions (models=${MODEL_KEYS} variants=${VARIANTS} conds=${CONDS} items=${items.length}) conc=${CONC}`);
  fs.writeFileSync(path.join(OUT, 'config.json'), JSON.stringify({ tag: TAG, models: MODEL_KEYS, variants: VARIANTS, conds: CONDS, items, seed: SEED, max_rounds: MAX_ROUNDS, prompts: { SYSTEM, TASK, RUSHED, FORMAT }, started: new Date().toISOString() }, null, 1));

  const browser = await chromium.launch();
  // 모델별 동시성 한도
  const limits = Object.fromEntries(MODEL_KEYS.map((m) => [m, m === 'codex' ? Math.max(1, Math.ceil(CONC / 2)) : CONC]));
  const active = Object.fromEntries(MODEL_KEYS.map((m) => [m, 0]));
  let idx = 0, finished = 0;
  await new Promise((resolve) => {
    const pump = () => {
      if (finished === jobs.length) return resolve();
      for (let i = idx; i < jobs.length; i++) {
        const j = jobs[i];
        if (!j || j.started || active[j.model] >= limits[j.model]) continue;
        j.started = true; active[j.model]++;
        runSession(browser, base, j).then((rec) => {
          delete rec.started;
          fs.appendFileSync(resultsFile, JSON.stringify(rec) + '\n');
          active[j.model]--; finished++;
          if (finished % 10 === 0 || finished === jobs.length) console.log(`${finished}/${jobs.length}  last: ${rec.model}/${rec.variant}/${rec.cond}/${rec.item} → ${rec.decision} (${rec.rounds}r, ${rec.steps} steps)`);
          pump();
        });
      }
      while (idx < jobs.length && jobs[idx].started) idx++;
    };
    pump();
    if (!jobs.length) resolve();
  });
  await browser.close();
  server.close();
  console.log(`done → ${resultsFile}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
