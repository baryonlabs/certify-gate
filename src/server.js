// certify-gate HTTP 서버 (의존성 없음: node:http)
// 상태 전이는 전부 서버에서 강제한다. 클라이언트는 화면일 뿐이다.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Store } from './store.js';
import { analyze } from './align.js';
import { decide, verify, gateStatus, isContested, decisionUsable, TransitionError, STATUS, ROLES } from './state.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json' };

export function createApp(opts = {}) {
  const bench = !!opts.bench;
  const store = new Store({
    dataDir: opts.dataDir ?? path.join(ROOT, 'work'),
    seedDir: opts.seedDir ?? path.join(ROOT, 'data', 'seed'),
    itemsFile: opts.itemsFile ?? null,
    persist: !bench,
    logFile: opts.logFile ?? null,
  });
  const users = JSON.parse(fs.readFileSync(opts.usersFile ?? path.join(ROOT, 'data', 'users.json'), 'utf8'));
  const byToken = new Map(users.map((u) => [u.token, { name: u.name, role: u.role }]));
  const sessions = new Map();
  const conditions = bench || opts.baselines ? ['A', 'B', 'C'] : ['A'];

  function actorOf(req) {
    const h = req.headers.authorization ?? '';
    const tok = h.startsWith('Bearer ') ? h.slice(7) : null;
    return tok ? byToken.get(tok) ?? null : null;
  }

  function view(item, condition) {
    const base = { id: item.id, label: item.label, status: item.status, round: item.round, sentences: item.sentences, contested: isContested(item) };
    if (condition === 'C') return { ...base, sources: item.sources.map((s) => ({ label: s.label, url: s.url })) };
    const v = { ...base, sources: item.sources, interpretations: item.interpretations ?? null };
    if (condition === 'A') v.analysis = analyze(item);
    return v;
  }

  function need(actor) {
    if (!actor) throw new TransitionError('unauthenticated', '토큰이 필요합니다', 401);
  }

  function getSession(sid) {
    const s = sessions.get(sid);
    if (!s) throw new TransitionError('no_session', '세션 없음', 404);
    if (s.done) throw new TransitionError('session_closed', '이미 결정이 기록된 세션', 409);
    return s;
  }

  const routes = [
    ['GET', /^\/api\/me$/, (req) => actorOf(req) ?? { name: null, role: null }],
    ['GET', /^\/api\/config$/, () => ({ bench, conditions })],
    ['GET', /^\/api\/items$/, () => store.list().map((it) => ({ id: it.id, label: it.label, status: it.status, contested: isContested(it), n_sentences: it.sentences.length, round: it.round }))],
    ['GET', /^\/api\/items\/([^/]+)$/, (req, m, q) => {
      const it = store.get(decodeURIComponent(m[1]));
      if (!it) throw new TransitionError('not_found', '항목 없음', 404);
      const c = q.get('condition') ?? 'A';
      if (!conditions.includes(c)) throw new TransitionError('bad_condition', '허용되지 않은 화면 조건', 400);
      return view(it, c);
    }],
    // 클라이언트가 상태를 직접 바꾸려는 시도는 항상 거부
    ['PATCH', /^\/api\/items\/([^/]+)$/, () => { throw new TransitionError('direct_write_forbidden', '상태는 결정 API를 통해서만 바뀝니다', 403); }],
    ['PUT', /^\/api\/items\/([^/]+)$/, () => { throw new TransitionError('direct_write_forbidden', '상태는 결정 API를 통해서만 바뀝니다', 403); }],
    ['POST', /^\/api\/items\/([^/]+)\/verify$/, (req, m) => {
      const actor = actorOf(req); need(actor);
      const it = store.get(decodeURIComponent(m[1]));
      if (!it) throw new TransitionError('not_found', '항목 없음', 404);
      const next = verify(it, actor);
      store.put(next);
      return { id: next.id, status: next.status };
    }],
    ['POST', /^\/api\/sessions$/, (req, m, q, body) => {
      const actor = actorOf(req); need(actor);
      const it = store.get(body.item_id);
      if (!it) throw new TransitionError('not_found', '항목 없음', 404);
      const condition = body.condition ?? 'A';
      if (!conditions.includes(condition)) throw new TransitionError('bad_condition', '기준 화면(B/C)은 벤치마크 모드에서만 열립니다', 400);
      const sid = crypto.randomUUID();
      sessions.set(sid, {
        id: sid, item_id: it.id, condition, actor, started_at: new Date().toISOString(), t0: Date.now(),
        viewed: new Map(), checked: new Map(), contest: null, events: [], meta: body.meta ?? null,
      });
      return { session_id: sid };
    }],
    ['POST', /^\/api\/sessions\/([^/]+)\/view$/, (req, m, q, body) => {
      const s = getSession(m[1]); sameActor(s, actorOf(req));
      const it = store.get(s.item_id); const i = Number(body.idx);
      if (!(i >= 0 && i < it.sentences.length)) throw new TransitionError('bad_idx', '문장 번호 오류', 400);
      if (!s.viewed.has(i)) s.viewed.set(i, new Date().toISOString());
      s.events.push({ t: Date.now() - s.t0, ev: 'view', idx: i });
      return { ok: true };
    }],
    ['POST', /^\/api\/sessions\/([^/]+)\/check$/, (req, m, q, body) => {
      const s = getSession(m[1]); sameActor(s, actorOf(req));
      const i = Number(body.idx);
      if (s.condition !== 'A') throw new TransitionError('bad_condition', '대조 체크는 인증 화면 전용', 400);
      if (!s.viewed.has(i)) throw new TransitionError('not_viewed', '원문 위치를 먼저 열어야 체크할 수 있습니다', 409);
      if (body.checked === false) s.checked.delete(i); else s.checked.set(i, new Date().toISOString());
      s.events.push({ t: Date.now() - s.t0, ev: body.checked === false ? 'uncheck' : 'check', idx: i });
      return { gate: gateStatus(store.get(s.item_id), sessionForGate(s)) };
    }],
    ['POST', /^\/api\/sessions\/([^/]+)\/contest$/, (req, m, q, body) => {
      const s = getSession(m[1]); sameActor(s, actorOf(req));
      const it = store.get(s.item_id);
      if (!isContested(it)) throw new TransitionError('not_contested', '쟁점 항목이 아님', 400);
      const choice = body.choice ?? null;
      if (choice != null && !(it.interpretations ?? []).some((x) => x.id === choice)) throw new TransitionError('bad_choice', '없는 해석', 400);
      s.contest = { choice, reason: (body.reason ?? '').trim() };
      s.events.push({ t: Date.now() - s.t0, ev: 'contest', choice });
      return { gate: gateStatus(it, sessionForGate(s)) };
    }],
    ['GET', /^\/api\/sessions\/([^/]+)$/, (req, m) => {
      const s = sessions.get(m[1]);
      if (!s) throw new TransitionError('no_session', '세션 없음', 404);
      return { id: s.id, condition: s.condition, done: !!s.done, gate: gateStatus(store.get(s.item_id), sessionForGate(s)), decision: s.decision ?? null };
    }],
    ['POST', /^\/api\/sessions\/([^/]+)\/decision$/, (req, m, q, body) => {
      const actor = actorOf(req); need(actor);
      const s = getSession(m[1]); sameActor(s, actor);
      const it = store.get(s.item_id);
      const decidedAt = new Date();
      let toStatus = it.status;
      if (s.condition === 'A') {
        const next = decide(it, actor, { decision: body.decision, reason: body.reason, session: sessionForGate(s) });
        toStatus = next.status;
        if (next.status === STATUS.CERTIFIED) next.certification = { by: actor.name, at: decidedAt.toISOString(), session_id: s.id };
        if (!bench) store.put(next);
      } else {
        // 기준 화면(B/C): 게이트 없음. 기록만 남기고 상태는 바꾸지 않는다(벤치마크 전용).
        if (actor.role !== ROLES.HUMAN) throw new TransitionError('forbidden_role', '사람 역할만', 403);
        if (!['approve', 'skip'].includes(body.decision)) throw new TransitionError('bad_decision', '기준 화면 결정은 approve/skip', 400);
      }
      const rec = {
        log_id: crypto.randomUUID(), item_id: it.id, item_label: it.label, condition: s.condition,
        actor, session_id: s.id, started_at: s.started_at, decided_at: decidedAt.toISOString(),
        duration_ms: Date.now() - s.t0, decision: body.decision, reason: (body.reason ?? body.comment ?? '').trim(),
        from_status: it.status, to_status: toStatus,
        checked_sentences: [...s.checked.entries()].sort((a, b) => a[0] - b[0]).map(([idx, at]) => ({ idx, text: it.sentences[idx], viewed_at: s.viewed.get(idx), checked_at: at })),
        viewed_sentences: [...s.viewed.keys()].sort((a, b) => a - b),
        contest: isContested(it) ? { interpretations: it.interpretations ?? null, choice: s.contest?.choice ?? null, reason: s.contest?.reason ?? '' } : null,
        events: s.events, meta: s.meta,
      };
      store.appendLog(rec);
      s.done = true; s.decision = body.decision;
      return { ok: true, log_id: rec.log_id, to_status: toStatus };
    }],
    ['GET', /^\/api\/log$/, () => store.readLog()],
    ['GET', /^\/api\/export$/, () => store.exportOntology()],
    ['GET', /^\/api\/decision-kb$/, () => decisionUsable(store.list()).map((it) => ({ id: it.id, label: it.label, definition: it.definition, certification: it.certification }))],
    ['POST', /^\/api\/import$/, (req, m, q, body) => {
      const actor = actorOf(req); need(actor);
      if (actor.role !== ROLES.HUMAN) throw new TransitionError('forbidden_role', '사람 역할만', 403);
      return { imported: store.importOntology(body.path) };
    }],
  ];

  function sessionForGate(s) {
    return { checked: [...s.checked.keys()], contest: s.contest };
  }
  function sameActor(s, actor) {
    need(actor);
    if (s.actor.name !== actor.name) throw new TransitionError('forbidden', '세션 소유자가 아님', 403);
  }

  async function handler(req, res) {
    const url = new URL(req.url, 'http://x');
    try {
      if (url.pathname.startsWith('/api/')) {
        for (const [meth, re, fn] of routes) {
          if (meth !== req.method) continue;
          const m = url.pathname.match(re);
          if (!m) continue;
          const body = ['POST', 'PATCH', 'PUT'].includes(req.method) ? await readJson(req) : {};
          const out = await fn(req, m, url.searchParams, body);
          return send(res, 200, out);
        }
        return send(res, 404, { error: 'not_found' });
      }
      return serveStatic(url.pathname, res);
    } catch (e) {
      if (e instanceof TransitionError) return send(res, e.httpStatus, { error: e.code, message: e.message });
      if (e instanceof SyntaxError) return send(res, 400, { error: 'bad_json', message: e.message });
      console.error(e);
      return send(res, 500, { error: 'internal', message: e.message });
    }
  }

  return { server: http.createServer(handler), store, sessions };
}

function serveStatic(p, res) {
  let file;
  if (p.startsWith('/icons/')) file = path.join(ROOT, 'node_modules', '@tabler', 'icons', 'icons', 'outline', path.basename(p));
  else file = path.join(ROOT, 'public', p === '/' ? 'index.html' : path.normalize(p).replace(/^(\.\.[/\\])+/, ''));
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404); return res.end('not found');
  }
  res.writeHead(200, { 'content-type': MIME[path.extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store' });
  fs.createReadStream(file).pipe(res);
}

function send(res, code, obj) {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let d = '';
    req.on('data', (c) => { d += c; if (d.length > 2e6) req.destroy(); });
    req.on('end', () => { try { resolve(d ? JSON.parse(d) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const env = process.env;
  const { server } = createApp({
    bench: env.BENCH === '1',
    baselines: env.BASELINES === '1',
    dataDir: env.DATA_DIR,
    itemsFile: env.ITEMS_FILE,
    logFile: env.LOG_FILE,
    usersFile: env.USERS_FILE,
  });
  const port = Number(env.PORT ?? 5173);
  server.listen(port, '127.0.0.1', () => console.log(`certify-gate http://127.0.0.1:${port}  (bench=${env.BENCH === '1'})`));
}
