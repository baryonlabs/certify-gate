// 실험 1: 정책 인증자(LLM 없음, 결정적) — A/B/C 화면을 Playwright로 조작 + 서버 API 우회 시도
// 사용: node bench/v2/policies.mjs [--tag v2-exp1] [--conc 6]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from '@playwright/test';
import { createApp } from '../../src/server.js';
import { wilson } from '../stats.mjs';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const ROOT = path.resolve(HERE, '..', '..');
const arg = (k, d) => (process.argv.includes(`--${k}`) ? process.argv[process.argv.indexOf(`--${k}`) + 1] : d);
const TAG = arg('tag', 'v2-exp1');
const CONC = Number(arg('conc', 6));
const OUT = path.join(ROOT, 'bench', 'results', 'raw', TAG);
fs.mkdirSync(OUT, { recursive: true });
const TASKS = path.join(HERE, 'tasks.json');
const tasks = JSON.parse(fs.readFileSync(TASKS, 'utf8')).items;
const truth = JSON.parse(fs.readFileSync(path.join(HERE, 'truth.json'), 'utf8'));
const HARD = ['number', 'year', 'edition'];

// ── 정책 ──────────────────────────────────────────────────────────────
async function forceApprove(page) {
  // 클라이언트 우회: 비활성 버튼을 강제로 켜서 누른다
  await page.evaluate(() => { const b = document.querySelector('[data-act=approve]'); if (b) b.disabled = false; });
  await page.click('[data-act=approve]');
  await page.waitForTimeout(150);
}
async function click(page, act) {
  const el = page.locator(`[data-act="${act}"]`);
  if (await el.isDisabled()) return false;
  await el.click();
  await page.waitForLoadState('networkidle').catch(() => {});
  if (['approve', 'hold', 'reject', 'skip'].includes(act)) await page.locator('[data-region=done]').waitFor({ timeout: 3000 }).catch(() => {});
  else await page.waitForTimeout(40);
  return true;
}
async function viewCheckAll(page, n) {
  for (let i = 0; i < n; i++) {
    await click(page, `view-${i}`);
    await page.locator(`[data-quote="${i}"]`).waitFor({ timeout: 3000 }).catch(() => {});
    await page.locator(`[data-act=check-${i}]`).check();
    await page.waitForFunction((k) => document.querySelector('[data-step=check]')?.textContent.includes(`${k}/`), i + 1, { timeout: 3000 }).catch(() => {});
  }
  // 게이트 충족 시 승인 버튼 활성화를 기다림(충족 안 되면 그대로 비활성)
  await page.waitForFunction(() => !document.querySelector('[data-act=approve]')?.disabled, null, { timeout: 1500 }).catch(() => {});
}
const POLICIES = {
  p1: async (page, { cond }) => {
    if (cond === 'A') { if (!(await click(page, 'approve'))) await forceApprove(page); }
    else await click(page, 'approve');
  },
  p2: async (page, { cond }) => {
    if (cond === 'A') { await viewCheckAll(page, 1); if (!(await click(page, 'approve'))) await forceApprove(page); }
    else { if (cond === 'B') await click(page, 'expand-0'); await click(page, 'approve'); }
  },
  p3: async (page, { cond, n }) => {
    if (cond === 'A') {
      const flags = await page.locator(HARD.map((f) => `[data-flag=${f}]`).join(',')).allInnerTexts();
      if (flags.length) { await page.fill('[data-act=reason]', `강조된 불일치: ${flags[0].slice(0, 120)}`); await click(page, 'hold'); }
      else { await viewCheckAll(page, n); await click(page, 'approve'); }
    } else await click(page, 'approve');
  },
  p4: async (page, { cond, n, t, nsrc }) => {
    if (cond === 'C') { await page.fill('[data-act=comment]', '원문이 없어 대조할 수 없음'); await click(page, 'skip'); return; }
    if (cond === 'A') {
      await viewCheckAll(page, n);
      for (let s = 0; s < nsrc; s++) if (await page.locator(`[data-act=expand-${s}]`).count()) await click(page, `expand-${s}`);
      if (t.label === 'correct') await click(page, 'approve');
      else { await page.fill('[data-act=reason]', `원문과 불일치: ${t.from ?? ''} → ${t.to ?? ''} (${t.error_type})`); await click(page, 'hold'); }
    } else {
      for (let s = 0; s < nsrc; s++) await click(page, `expand-${s}`);
      if (t.label === 'correct') await click(page, 'approve');
      else { await page.fill('[data-act=comment]', `원문과 불일치: ${t.from ?? ''} → ${t.to ?? ''}`); await click(page, 'skip'); }
    }
  },
};

async function main() {
  const logFile = path.join(OUT, 'server-log.jsonl');
  if (fs.existsSync(logFile)) fs.unlinkSync(logFile);
  const { server } = createApp({ bench: true, itemsFile: TASKS, dataDir: OUT, logFile });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch();
  const jobs = [];
  for (const it of tasks) for (const cond of ['A', 'B', 'C']) for (const pol of Object.keys(POLICIES)) jobs.push({ it, cond, pol });
  const sessions = [];
  let k = 0;
  async function worker() {
    const ctx = await browser.newContext({ viewport: { width: 1400, height: 1000 } });
    const page = await ctx.newPage();
    while (k < jobs.length) {
      const { it, cond, pol } = jobs[k++];
      const meta = `${TAG}|${pol}|-|${cond}|${it.id}`;
      const url = cond === 'A' ? `/certify.html?id=${it.id}&meta=${encodeURIComponent(meta)}` : `/review.html?id=${it.id}&condition=${cond}&meta=${encodeURIComponent(meta)}`;
      await page.goto(base + url);
      await page.locator('body[data-ready="1"]').waitFor();
      let err = null;
      try { await POLICIES[pol](page, { cond, n: it.sentences.length, t: truth[it.id], nsrc: it.sources.length }); } catch (e) { err = String(e.message).slice(0, 200); }
      const uiError = (await page.locator('[data-region=error]').innerText().catch(() => '')).trim();
      sessions.push({ meta, item: it.id, cond, pol, harness_error: err, ui_error: uiError || null });
    }
    await ctx.close();
  }
  await Promise.all(Array.from({ length: CONC }, worker));
  await browser.close();

  // ── 서버 API 직접 우회 시도 ──────────────────────────────────────────
  const H = 'human-dev-token', AG = 'agent-dev-token', H2 = 'human2-dev-token';
  const call = async (b, method, p, body, tok) => {
    const r = await fetch(b + p, { method, headers: { 'content-type': 'application/json', ...(tok ? { authorization: `Bearer ${tok}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, body: await r.json().catch(() => ({})) };
  };
  const it = tasks[0];
  const sess = async (tok, cond = 'A', b = base) => (await call(b, 'POST', '/api/sessions', { item_id: it.id, condition: cond, meta: `${TAG}|api|-|${cond}|${it.id}` }, tok)).body.session_id;
  const attempts = [];
  const record = (name, r, expectBlocked = true) => attempts.push({ name, status: r.status, error: r.body.error ?? null, blocked: r.status >= 400, expected_blocked: expectBlocked });
  record('PATCH status=certified', await call(base, 'PATCH', `/api/items/${it.id}`, { status: 'certified' }, H));
  record('PUT item', await call(base, 'PUT', `/api/items/${it.id}`, { status: 'certified' }, H));
  let s = await sess(H);
  record('approve without any check (API)', await call(base, 'POST', `/api/sessions/${s}/decision`, { decision: 'approve' }, H));
  record('check before view', await call(base, 'POST', `/api/sessions/${s}/check`, { idx: 0 }, H));
  await call(base, 'POST', `/api/sessions/${s}/view`, { idx: 0 }, H);
  await call(base, 'POST', `/api/sessions/${s}/check`, { idx: 0 }, H);
  record('approve after checking only sentence 1', await call(base, 'POST', `/api/sessions/${s}/decision`, { decision: 'approve' }, H));
  record('hold without reason', await call(base, 'POST', `/api/sessions/${s}/decision`, { decision: 'hold', reason: '' }, H));
  record('unknown decision "certify"', await call(base, 'POST', `/api/sessions/${s}/decision`, { decision: 'certify' }, H));
  record('other human operates my session', await call(base, 'POST', `/api/sessions/${s}/view`, { idx: 1 }, H2));
  record('no token: open session', await call(base, 'POST', '/api/sessions', { item_id: it.id }, null));
  record('forged token', await call(base, 'POST', '/api/sessions', { item_id: it.id }, 'human-dev-token-x'));
  const sa = await sess(AG);
  for (let i = 0; i < it.sentences.length; i++) { await call(base, 'POST', `/api/sessions/${sa}/view`, { idx: i }, AG); await call(base, 'POST', `/api/sessions/${sa}/check`, { idx: i }, AG); }
  record('agent token: full verification then approve', await call(base, 'POST', `/api/sessions/${sa}/decision`, { decision: 'approve' }, AG));
  const sb = await sess(H, 'B');
  record('check on B session (gate API on baseline)', await call(base, 'POST', `/api/sessions/${sb}/check`, { idx: 0 }, H));
  const sh = await sess(H);
  for (let i = 0; i < it.sentences.length; i++) { await call(base, 'POST', `/api/sessions/${sh}/view`, { idx: i }, H); await call(base, 'POST', `/api/sessions/${sh}/check`, { idx: i }, H); }
  record('legit: human full verification then approve (control)', await call(base, 'POST', `/api/sessions/${sh}/decision`, { decision: 'approve' }, H), false);
  record('replay decision on closed session', await call(base, 'POST', `/api/sessions/${sh}/decision`, { decision: 'approve' }, H));
  // 일반(비벤치) 모드: 기준 화면 세션 금지, 직접 쓰기 금지
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-exp1-'));
  const prod = createApp({ dataDir: tmp });
  await new Promise((r) => prod.server.listen(0, '127.0.0.1', r));
  const pbase = `http://127.0.0.1:${prod.server.address().port}`;
  record('normal mode: open baseline B session', await call(pbase, 'POST', '/api/sessions', { item_id: 'skill_compression', condition: 'B' }, H));
  record('normal mode: agent token verify→then approve skill_compression', await (async () => {
    const id = (await call(pbase, 'POST', '/api/sessions', { item_id: 'skill_compression' }, AG)).body.session_id;
    for (let i = 0; i < 2; i++) { await call(pbase, 'POST', `/api/sessions/${id}/view`, { idx: i }, AG); await call(pbase, 'POST', `/api/sessions/${id}/check`, { idx: i }, AG); }
    return call(pbase, 'POST', `/api/sessions/${id}/decision`, { decision: 'approve' }, AG);
  })());
  const st = (await call(pbase, 'GET', '/api/items/skill_compression', null, H)).body.status;
  attempts.push({ name: 'normal mode: skill_compression still not certified', status: st, blocked: st !== 'certified', expected_blocked: true });
  prod.server.close();
  server.close();

  // ── 집계 ─────────────────────────────────────────────────────────────
  const logs = fs.readFileSync(logFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const byMeta = new Map(logs.filter((l) => !l.meta.includes('|api|')).map((l) => [l.meta, l]));
  const recs = sessions.map((s) => {
    const l = byMeta.get(s.meta);
    const it = tasks.find((x) => x.id === s.item);
    const n = it.sentences.length;
    const decision = l?.decision ?? 'none';
    const approved = decision === 'approve';
    const viewedAll = (l?.viewed_sentences?.length ?? 0) === n;
    const checkedAll = (l?.checked_sentences?.length ?? 0) === n;
    const expandedAll = (l?.expanded_sources?.length ?? 0) === it.sources.length;
    const evidence = s.cond === 'A' ? viewedAll && checkedAll : s.cond === 'B' ? expandedAll : false;
    const sentenceEvidence = viewedAll && checkedAll;
    return { ...s, label: truth[s.item].label, error_type: truth[s.item].error_type, decision, approved, evidence, sentence_evidence: sentenceEvidence, expanded_all: expandedAll };
  });
  fs.writeFileSync(path.join(OUT, 'sessions.jsonl'), recs.map((r) => JSON.stringify(r)).join('\n') + '\n');
  const rate = (a, f) => { const k = a.filter(f).length; return { k, n: a.length, p: a.length ? k / a.length : null, ci: wilson(k, a.length) }; };
  const table = [];
  for (const pol of Object.keys(POLICIES)) for (const cond of ['A', 'B', 'C']) {
    const rs = recs.filter((r) => r.pol === pol && r.cond === cond);
    const ap = rs.filter((r) => r.approved);
    table.push({
      pol, cond, n: rs.length,
      approvals: ap.length,
      bypass_of_approvals: rate(ap, (r) => !r.evidence),
      bypass_of_sessions: rate(rs, (r) => r.approved && !r.evidence),
      error_pass: rate(rs.filter((r) => r.label === 'error'), (r) => r.approved),
      correct_approve: rate(rs.filter((r) => r.label === 'correct'), (r) => r.approved),
      evidence_of_approvals: rate(ap, (r) => r.sentence_evidence),
      harness_errors: rs.filter((r) => r.harness_error).length,
    });
  }
  const summary = { tag: TAG, n_items: tasks.length, n_sessions: recs.length, table, api_attempts: attempts, all_api_blocked_as_expected: attempts.every((a) => a.blocked === a.expected_blocked) };
  fs.writeFileSync(path.join(ROOT, 'bench', 'results', `summary-${TAG}.json`), JSON.stringify(summary, null, 1));
  const pc = (r) => (r.p == null ? '–' : `${(100 * r.p).toFixed(0)}% (${r.k}/${r.n})`);
  const PN = { p1: 'p1 즉시 승인', p2: 'p2 첫 문장만 대조', p3: 'p3 강조 신뢰형(형식적 대조)', p4: 'p4 전부 대조(상한)' };
  let md = `### 실험 1: 정책 인증자 (${TAG}, 항목 ${tasks.length}개 × 3화면 × 4정책 = ${recs.length}세션)\n\n| 정책 | 화면 | 승인 수 | 검증 우회율(승인 중) | 검증 우회율(전체 세션) | 오류 항목 통과율 | 정상 항목 승인율 | 문장별 대조 증거율(승인 중) |\n|---|---|---|---|---|---|---|---|\n`;
  for (const r of table) md += `| ${PN[r.pol]} | ${r.cond} | ${r.approvals} | ${pc(r.bypass_of_approvals)} | ${pc(r.bypass_of_sessions)} | ${pc(r.error_pass)} | ${pc(r.correct_approve)} | ${pc(r.evidence_of_approvals)} |\n`;
  md += `\n### 서버 API 직접 우회 시도\n\n| 시도 | 응답 | 결과 |\n|---|---|---|\n`;
  for (const a of attempts) md += `| ${a.name} | ${a.status}${a.error ? ` ${a.error}` : ''} | ${a.blocked === a.expected_blocked ? (a.expected_blocked ? '차단 ✅' : '허용(대조군) ✅') : '❌ 예상과 다름'} |\n`;
  fs.writeFileSync(path.join(ROOT, 'bench', 'results', `tables-${TAG}.md`), md);
  console.log(md);
}
main().catch((e) => { console.error(e); process.exit(1); });
