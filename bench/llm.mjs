// LLM 호출 어댑터 (로컬 CLI 사용: claude, codex). 도구·사용자 설정 없이 순수 텍스트 응답만 받는다.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function run(cmd, args, input, timeoutMs, cwd) {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'], cwd });
    let out = '', err = '';
    const to = setTimeout(() => { p.kill('SIGKILL'); err += '\n[timeout]'; }, timeoutMs);
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('close', (code) => { clearTimeout(to); resolve({ code, out, err }); });
    p.stdin.end(input);
  });
}

const EMPTY = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-llm-'));

export const MODELS = {
  // Anthropic 계열
  'claude-haiku': { family: 'anthropic', call: (sys, user) => claude('haiku', sys, user) },
  'claude-sonnet': { family: 'anthropic', call: (sys, user) => claude('sonnet', sys, user) },
  // OpenAI 계열 (codex CLI 기본 모델)
  codex: { family: 'openai', call: (sys, user) => codex(null, sys, user) },
  // opencode CLI (비대화 실행, stdin 닫음)
  'gpt-luna': { family: 'openai', call: (sys, user) => opencode('opencode-go/gpt-6-luna', sys, user) },
  'gemini-argon': { family: 'google', call: (sys, user) => opencode('opencode-go/gemini-4-argon', sys, user) },
};

function runNoStdin(cmd, args, timeoutMs, cwd) {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], cwd });
    let out = '', err = '';
    const to = setTimeout(() => { p.kill('SIGKILL'); err += '\n[timeout]'; }, timeoutMs);
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('close', (code) => { clearTimeout(to); resolve({ code, out, err }); });
  });
}

async function opencode(model, sys, user) {
  const t0 = Date.now();
  const prompt = `${sys}\n\n도구나 셸 명령, 파일 읽기를 하지 말고, 아래 내용만 보고 JSON으로만 답하라.\n\n${user}`;
  const r = await runNoStdin('opencode', ['run', '-m', model, prompt], 300000, EMPTY);
  const text = r.out.replace(/\x1b\[[0-9;]*m/g, '');
  const limit = /rate limit|quota|usage limit|429/i.test(r.err) && !text.includes('{');
  return { text, model_id: model, ms: Date.now() - t0, tokens: null, cost_usd: null, error: r.code !== 0 || limit ? (r.err || 'error').slice(-300) : null };
}

async function claude(model, sys, user) {
  const t0 = Date.now();
  const r = await run('claude', ['-p', '--model', model, '--tools', '', '--setting-sources', '', '--system-prompt', sys, '--no-session-persistence', '--output-format', 'json'], user, 180000, EMPTY);
  let j = {};
  try { j = JSON.parse(r.out); } catch { /* noop */ }
  return {
    text: j.result ?? '',
    model_id: Object.keys(j.modelUsage ?? {})[0] ?? model,
    ms: Date.now() - t0,
    tokens: { in: (j.usage?.input_tokens ?? 0) + (j.usage?.cache_read_input_tokens ?? 0) + (j.usage?.cache_creation_input_tokens ?? 0), out: j.usage?.output_tokens ?? 0 },
    cost_usd: j.total_cost_usd ?? null,
    error: r.code !== 0 || j.is_error ? (r.err || j.result || 'error').slice(0, 300) : null,
  };
}

async function codex(model, sys, user) {
  const t0 = Date.now();
  const outFile = path.join(EMPTY, `codex-${process.pid}-${Math.random().toString(36).slice(2)}.txt`);
  const args = ['exec', '--skip-git-repo-check', '--ephemeral', '--ignore-user-config', '-s', 'read-only', '-C', EMPTY, '-o', outFile];
  if (model) args.push('-m', model);
  args.push('-');
  const prompt = `${sys}\n\n도구나 셸 명령을 실행하지 말고, 아래 내용만 보고 JSON으로만 답하라.\n\n${user}`;
  const r = await run('codex', args, prompt, 240000, EMPTY);
  let text = '';
  try { text = fs.readFileSync(outFile, 'utf8'); fs.unlinkSync(outFile); } catch { /* noop */ }
  const m = (r.err + r.out).match(/^model:\s*(.+)$/m);
  const tok = (r.err + r.out).match(/tokens used\s*\n?\s*([\d,]+)/);
  return {
    text,
    model_id: m ? m[1].trim() : 'codex-default',
    ms: Date.now() - t0,
    tokens: { total: tok ? Number(tok[1].replace(/,/g, '')) : null },
    cost_usd: null,
    error: r.code !== 0 ? (r.err || 'error').slice(-300) : null,
  };
}

/** 응답에서 첫 JSON 객체를 뽑는다 */
export function parseJson(text) {
  if (!text) return null;
  const s = text.replace(/```(?:json)?/g, '');
  const i = s.indexOf('{');
  if (i < 0) return null;
  let depth = 0, inStr = false, esc = false;
  for (let k = i; k < s.length; k++) {
    const ch = s[k];
    if (inStr) { if (esc) esc = false; else if (ch === '\\') esc = true; else if (ch === '"') inStr = false; continue; }
    if (ch === '"') inStr = true;
    else if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) {
      try { return JSON.parse(s.slice(i, k + 1)); } catch { return null; }
    }
  }
  return null;
}
