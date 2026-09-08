// HTTP server — plain node:http, zero dependencies.
// Routes:
//   GET  /                          static frontend (public/)
//   GET  /api/health                config sanity check
//   POST /api/session               {freeText} -> generate spec + run search
//   PUT  /api/session/:id/spec      {spec}     -> recruiter edited filters/rubric, re-run
//   POST /api/session/:id/feedback  {message, verdicts} -> refine spec, re-run
//   POST /api/session/:id/freeze    freeze the search
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Load .env if present (never committed). Env vars already set take precedence.
try {
  const envPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '.env');
  await readFile(envPath, 'utf8').then((txt) => {
    for (const line of txt.split('\n')) {
      const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/i);
      if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  });
} catch { /* no .env — fine */ }

import { getLLMConfig, callStructured, LLMError } from './lib/llm.js';
import { buildSpecPrompt, buildRefinePrompt } from './lib/prompts.js';
import { normalizeSpec, normalizeRefinement } from './lib/schemas.js';
import { runSearch } from './lib/search.js';
import { filterGroupFailures } from './lib/filters.js';
import {
  createSession, getSession, serialize, pushRound, pushChat, currentRound, PAGE_SIZE,
} from './lib/store.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, 'public');
const PORT = Number(process.env.PORT || 3000);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

function readBody(req, limit = 200_000) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('Request body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new Error('Invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

async function serveStatic(req, res, urlPath) {
  const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
  const filePath = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!filePath.startsWith(PUBLIC_DIR)) return sendJson(res, 403, { error: 'Forbidden' });
  try {
    const data = await readFile(filePath);
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' });
    res.end(data);
  } catch {
    sendJson(res, 404, { error: 'Not found' });
  }
}

function llmErrorPayload(err) {
  const retryable = err instanceof LLMError ? err.retryable : false;
  return {
    error: err.message || 'LLM request failed',
    retryable,
    hint: retryable
      ? 'The model provider was slow, rate-limited, or returned malformed output. Nothing was lost — retry when ready.'
      : 'Check your LLM_API_KEY / LLM_BASE_URL / LLM_MODEL configuration.',
  };
}

// ---------- handlers ----------

async function handleCreateSession(req, res) {
  const body = await readBody(req);
  const freeText = typeof body.freeText === 'string' ? body.freeText.trim() : '';
  if (freeText.length < 8) return sendJson(res, 400, { error: 'Describe what you are looking for (at least a few words).' });
  if (freeText.length > 2000) return sendJson(res, 400, { error: 'Requirement is too long (max 2000 characters).' });

  const session = createSession(freeText);
  try {
    const spec = await callStructured(buildSpecPrompt(freeText), normalizeSpec);
    session.spec = spec;
    pushChat(session, {
      role: 'app',
      kind: 'spec_created',
      text: `Here is how I read your requirement. Filters are the hard constraints; the rubric is what I will judge fit against. Edit anything that looks wrong, then run the search.`,
    });
    const search = await runSearch(loadPool(), spec);
    const round = pushRound(session, { spec, ...search });
    pushChat(session, {
      role: 'app',
      kind: 'results',
      text: search.results.length
        ? `Round 1: ${search.filteredCount} of ${search.total} profiles passed the filters. Top ${Math.min(PAGE_SIZE, search.results.length)} below, ranked by rubric fit. React in chat or mark each profile — I will refine from there.`
        : `Round 1: no profiles passed those filters. Loosen something below (or tell me in chat) and I will re-run.`,
    });
    return sendJson(res, 201, { session: serialize(session), roundId: round.round });
  } catch (err) {
    return sendJson(res, 502, llmErrorPayload(err));
  }
}

async function handleEditSpec(req, res, session) {
  const body = await readBody(req);
  if (session.status === 'frozen') return sendJson(res, 409, { error: 'Search is frozen. Start a new search to make changes.' });
  let spec;
  try {
    spec = normalizeSpec(body.spec);
  } catch (err) {
    return sendJson(res, 400, { error: `Invalid spec: ${err.message}` });
  }
  try {
    const search = await runSearch(loadPool(), spec);
    pushRound(session, { spec, ...search });
    pushChat(session, {
      role: 'app',
      kind: 'manual_edit',
      text: search.results.length
        ? `Re-ran with your edited spec: ${search.filteredCount} of ${search.total} profiles passed the filters.`
        : `Re-ran with your edited spec, but nothing passed the filters. Try loosening a constraint.`,
    });
    return sendJson(res, 200, { session: serialize(session) });
  } catch (err) {
    return sendJson(res, 502, llmErrorPayload(err));
  }
}

async function handleFeedback(req, res, session) {
  if (session.status === 'frozen') return sendJson(res, 409, { error: 'Search is frozen. Start a new search to make changes.' });
  const body = await readBody(req);
  const message = typeof body.message === 'string' ? body.message.trim() : '';
  const verdicts = body.verdicts && typeof body.verdicts === 'object' ? body.verdicts : {};

  const round = currentRound(session);
  if (!round) return sendJson(res, 409, { error: 'No search has been run yet.' });

  // Record verdicts on the current round.
  let cleanVerdicts = {};
  for (const [pid, v] of Object.entries(verdicts)) {
    if (round.results.some((r) => r.profile_id === pid) && (v === 'yes' || v === 'no')) {
      cleanVerdicts[pid] = v;
      round.verdicts[pid] = v;
    }
  }
  if (!message && !Object.keys(cleanVerdicts).length) {
    return sendJson(res, 400, { error: 'Add a message or mark at least one profile yes/no.' });
  }

  // Compose the feedback string the refine prompt sees.
  const verdictLines = Object.entries(cleanVerdicts).map(([pid, v]) => {
    const r = round.results.find((x) => x.profile_id === pid);
    return `#${r.rank} ${r.profile.name}: ${v.toUpperCase()}`;
  });
  const feedbackText = [
    message ? `Chat: "${message}"` : null,
    verdictLines.length ? `Per-profile verdicts:\n${verdictLines.join('\n')}` : null,
  ].filter(Boolean).join('\n\n');

  pushChat(session, { role: 'recruiter', kind: 'feedback', text: feedbackText });

  try {
    const resultsForPrompt = round.results.slice(0, PAGE_SIZE).map((r) => ({
      rank: r.rank,
      profile: r.profile,
      score: r.score,
      feedback: cleanVerdicts[r.profile_id] || null,
    }));
    const refinement = await callStructured(
      buildRefinePrompt({
        freeText: session.freeText,
        spec: session.spec,
        feedback: feedbackText,
        results: resultsForPrompt,
        round: session.round,
      }),
      normalizeRefinement,
    );

    let spec = refinement.spec;
    let changes = refinement.changes;
    let summary = refinement.summary;

    // Deterministic guard: profiles the recruiter approved must survive the new
    // filters. If the refined spec would exclude any YES profile, roll back only
    // the offending filter groups to their previous values and say so.
    const yesIds = Object.entries(cleanVerdicts).filter(([, v]) => v === 'yes').map(([pid]) => pid);
    if (yesIds.length && spec.filters) {
      const byId = new Map(loadPool().map((p) => [p.id, p]));
      const failing = new Set();
      for (const pid of yesIds) {
        const prof = byId.get(pid);
        if (prof) for (const g of filterGroupFailures(prof, spec.filters)) failing.add(g);
      }
      if (failing.size) {
        const prevFilters = session.spec.filters || {};
        const rolled = { ...spec.filters };
        const groups = [...failing];
        for (const g of groups) rolled[g] = prevFilters[g] ?? null;
        spec = { ...spec, filters: rolled };
        changes = changes.filter((c) => !failing.has(String(c.field).split('.')[1]));
        changes.push({
          field: groups.map((g) => `filters.${g}`).join(', '),
          before: '(proposed tightening)',
          after: '(rolled back)',
          why: `The tightened ${groups.join(' and ')} would have excluded profiles you marked yes, so I kept the previous values.`,
        });
        summary = `${summary} Note: I kept ${groups.map((g) => `filters.${g}`).join(' and ')} as-is — the tighter version would have cut profiles you approved.`;
      }
    }

    const search = await runSearch(loadPool(), spec);
    pushRound(session, { spec, ...search });
    pushChat(session, {
      role: 'app',
      kind: 'refined',
      text: summary,
      changes,
    });
    return sendJson(res, 200, { session: serialize(session) });
  } catch (err) {
    pushChat(session, {
      role: 'app',
      kind: 'error',
      text: `Could not process that feedback: ${err.message}. Your previous results are still intact — try again.`,
    });
    return sendJson(res, 502, llmErrorPayload(err));
  }
}

async function handleFreeze(req, res, session) {
  if (session.status === 'frozen') return sendJson(res, 200, { session: serialize(session) });
  const round = currentRound(session);
  if (!round) return sendJson(res, 409, { error: 'Nothing to freeze yet — run a search first.' });
  session.status = 'frozen';
  session.frozenSnapshot = {
    frozenAt: Date.now(),
    freeText: session.freeText,
    rounds: session.rounds.length,
    spec: structuredClone(session.spec),
    activeFilters: round.activeFilters,
    filteredCount: round.filteredCount,
    total: round.total,
    results: structuredClone(round.results),
  };
  pushChat(session, {
    role: 'app',
    kind: 'frozen',
    text: `Search frozen after ${session.rounds.length} round${session.rounds.length === 1 ? '' : 's'}. Final filters, rubric, and the ranked shortlist are below.`,
  });
  return sendJson(res, 200, { session: serialize(session) });
}

// ---------- pool ----------

let poolCache = null;
function loadPool() {
  if (!poolCache) {
    // Loaded synchronously once at startup via top-level await below.
    throw new Error('Pool not loaded');
  }
  return poolCache;
}

const poolPath = path.join(__dirname, 'data', 'profiles.json');
poolCache = JSON.parse(await readFile(poolPath, 'utf8'));
console.log(`Loaded ${poolCache.length} profiles from data/profiles.json`);

// ---------- router ----------

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const p = url.pathname;
  try {
    if (p.startsWith('/api/')) {
      if (req.method === 'GET' && p === '/api/health') {
        try {
          const cfg = getLLMConfig();
          return sendJson(res, 200, { ok: true, model: cfg.model, baseUrl: cfg.baseUrl, poolSize: poolCache.length });
        } catch (err) {
          return sendJson(res, 200, { ok: false, error: err.message });
        }
      }
      if (req.method === 'POST' && p === '/api/session') return await handleCreateSession(req, res);

      const m = p.match(/^\/api\/session\/([\w-]+)\/(spec|feedback|freeze)$/);
      if (m) {
        const session = getSession(m[1]);
        if (!session) return sendJson(res, 404, { error: 'Session not found' });
        if (m[2] === 'spec' && req.method === 'PUT') return await handleEditSpec(req, res, session);
        if (m[2] === 'feedback' && req.method === 'POST') return await handleFeedback(req, res, session);
        if (m[2] === 'freeze' && req.method === 'POST') return await handleFreeze(req, res, session);
        return sendJson(res, 405, { error: 'Method not allowed' });
      }
      const g = p.match(/^\/api\/session\/([\w-]+)$/);
      if (g && req.method === 'GET') {
        const session = getSession(g[1]);
        if (!session) return sendJson(res, 404, { error: 'Session not found' });
        return sendJson(res, 200, { session: serialize(session) });
      }
      return sendJson(res, 404, { error: 'Not found' });
    }
    if (req.method === 'GET' || req.method === 'HEAD') return await serveStatic(req, res, p);
    return sendJson(res, 405, { error: 'Method not allowed' });
  } catch (err) {
    console.error(err);
    return sendJson(res, 500, { error: err.message || 'Internal server error' });
  }
});

server.listen(PORT, () => {
  try {
    const cfg = getLLMConfig();
    console.log(`LLM: ${cfg.model} @ ${cfg.baseUrl}`);
  } catch (err) {
    console.warn(`WARN: ${err.message}`);
  }
  console.log(`Sourcing Refinement Loop running at http://localhost:${PORT}`);
});
