// In-memory session store. One search session, no persistence across restarts
// (assignment scope: no login, no multi-session storage).
import { randomUUID } from 'node:crypto';

const sessions = new Map();

export function createSession(freeText) {
  const id = randomUUID();
  const session = {
    id,
    freeText,
    spec: null,            // {filters, rubric}
    round: 0,              // increments on every search execution
    status: 'initializing',// initializing | ready | frozen
    rounds: [],            // [{round, spec, filteredCount, activeFilters, results}]
    shownIds: [],          // profile ids currently shown to the recruiter
    chat: [],              // [{id, role: 'app'|'recruiter', kind, text, changes?, at}]
    frozenSnapshot: null,
    createdAt: Date.now(),
  };
  sessions.set(id, session);
  return session;
}

export function getSession(id) {
  return sessions.get(id) || null;
}

let msgSeq = 0;
export function pushChat(session, msg) {
  session.chat.push({ id: `m${++msgSeq}`, at: Date.now(), ...msg });
  return msg;
}

export function pushRound(session, { spec, filteredCount, total, activeFilters, results }) {
  session.round += 1;
  session.spec = spec;
  const round = {
    round: session.round,
    spec: structuredClone(spec),
    filteredCount,
    total,
    activeFilters,
    results,
    verdicts: {}, // profile_id -> 'yes' | 'no'
  };
  session.rounds.push(round);
  session.shownIds = results.slice(0, PAGE_SIZE).map((r) => r.profile_id);
  session.status = 'ready';
  return round;
}

export const PAGE_SIZE = 5;

export function currentRound(session) {
  return session.rounds[session.rounds.length - 1] || null;
}

// Shape sent to the frontend.
export function serialize(session) {
  const round = currentRound(session);
  return {
    id: session.id,
    freeText: session.freeText,
    spec: session.spec,
    round: session.round,
    status: session.status,
    shownIds: session.shownIds,
    chat: session.chat,
    activeFilters: round ? round.activeFilters : [],
    filteredCount: round ? round.filteredCount : 0,
    total: round ? round.total : 0,
    results: round ? round.results : [],
    verdicts: round ? round.verdicts : {},
    frozen: session.frozenSnapshot,
  };
}
