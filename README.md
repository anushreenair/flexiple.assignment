# Sourcing Refinement Loop — Flexiple engineering challenge

One small, real slice of Flexiple's AI recruiter: a recruiter types a free-text talent
requirement, the app turns it into objective filters + a subjective fit rubric, filters and
LLM-scores a local talent pool, then refines the spec from recruiter feedback until the
recruiter freezes the search.

## Run it

```bash
# 1. set the LLM key (any OpenAI-compatible endpoint works)
export LLM_API_KEY=***
# optional — defaults shown:
# export LLM_BASE_URL=https://api.openai.com/v1
# export LLM_MODEL=gpt-4o-mini

# 2. run
npm start          # zero dependencies; needs Node >= 20
# open http://localhost:3000
```

That's it — no `npm install` (the backend is plain `node:http`, the frontend is vanilla ES
modules, no build step). You can also put the three variables in a `.env` file next to
`server.js` (see `.env.example`); `.env` is gitignored.

Run the end-to-end API test (makes real LLM calls, ~2 min):

```bash
python3 test_api.py
```

## What the loop does

1. **Free text → spec.** `POST /api/session` sends the requirement to the LLM, which returns
   structured objective filters (skills, years, location, company background) and a weighted
   fit rubric. Validated + normalized locally; malformed JSON triggers a repair round-trip.
2. **Filter.** Deterministic, local, pure — `lib/filters.js` applies the hard constraints to
   `data/profiles.json` (48 profiles).
3. **Score & rank.** Surviving profiles are batch-scored by the LLM against the rubric
   (0–100 + verdict + explanation + citations). Citations are re-verified server-side against
   the actual profile fields, so an explanation can never cite evidence that isn't there.
4. **Refine.** The recruiter reacts in chat ("1 is too junior, 2 and 4 are right") and/or with
   per-profile ✓/✗. The LLM returns an updated spec **plus a change list with reasons**, which
   the UI renders as a diff. Re-runs immediately. Repeats indefinitely.
5. **Freeze.** Snapshot of final filters, rubric, and ranked shortlist; the session locks.

The current spec is always visible in a live side panel and is directly editable — edits
re-run the search without an LLM round-trip.

## Architecture

```
server.js            HTTP server + API routes (node:http, zero deps)
lib/llm.js           OpenAI-compatible client: timeouts, retries, JSON repair
lib/prompts.js       ALL prompts, in-repo and readable (they are part of the submission)
lib/schemas.js       validators/normalizers for every LLM structure
lib/filters.js       deterministic filter engine (pure functions)
lib/search.js        filter -> score -> rank -> verify citations
lib/store.js         in-memory session store (single search session, per scope)
public/              frontend: index.html, styles.css, app.js (vanilla ES modules)
data/profiles.json   the supplied 48-profile talent pool
test_api.py          end-to-end API test with real LLM calls
```

LLM configuration (env vars, never committed):

| Variable         | Meaning                                               | Default                       |
| ---------------- | ----------------------------------------------------- | ----------------------------- |
| `LLM_API_KEY`  | **required** — bearer key for the LLM endpoint | —                            |
| `LLM_BASE_URL` | OpenAI-compatible base URL                            | `https://api.openai.com/v1` |
| `LLM_MODEL`    | model id                                              | `gpt-4o-mini`               |

Structured output: requests use `response_format: {type: "json_object"}` where the provider
supports it, and every response passes through `lib/schemas.js` (type/range/vocabulary
checks, weight clamping, min>max swap, role-family relocation). Failures get one repair
round-trip that shows the model its own output plus the validation errors, then retries with
backoff on 429/5xx/timeout. If it still fails, the UI shows a recoverable error state and the
previous results stay intact.

## Decisions

**Prioritised**

- *Loop quality over feature count.* The refinement round is the product, so it got the most
  engineering: change-list diffs with reasons, verdict-consistency guards (below), and
  prompts tuned so feedback like "1 is too junior" produces a visible, correct spec change.
- *Trust in explanations.* Explanations must cite real profile fields; citations are verified
  server-side after scoring and silently trimmed if the model hallucinates a value. A
  recruiter who catches one fake citation stops trusting the whole product.
- *Designed states, not just happy path.* First load, thinking (with step progression +
  elapsed timer), empty results (with concrete relaxation suggestions), LLM failure
  (recoverable toast + intact prior results), frozen summary, and session restore after an
  accidental refresh (`?session=` deep link / sessionStorage).
- *Deterministic where deterministic is right.* Filtering is pure local code; the LLM only
  does what needs judgment (spec generation, scoring, refinement). This keeps results
  reproducible and testable — `test_api.py` re-checks every returned profile against the pool
  with plain Python.

**Cut, and why**

- *Persistence, login, multi-session history* — explicitly out of scope per the brief.
- *Streaming responses* — rounds take 10–40s; a well-designed thinking state with progress
  beats a half-streamed JSON blob, and streaming adds failure modes for little user value here.
- *A framework* — zero dependencies means the reviewer runs `npm start` and nothing else.
  Vanilla ES modules kept the frontend honest about what each state needs.
- *nice-to-have skills and role family as hard filters* — see below.

**Two judgment calls worth calling out**

1. *Nice-to-have skills and role family are soft signals, not filters.* The dataset's skill
   vocabulary and job titles are coarse ("Database Reliability Engineer" for a backend role).
   Hard-filtering on them empties the pool and starves the refinement loop. They're passed to
   the scorer as context instead, and a normalizer relocates role-family words ("backend") if
   the model leaks them into `must_have`. 
2. *A refinement that excludes the recruiter's approved profiles is rolled back.* If the LLM
   tightens a filter group such that a profile the recruiter just marked ✓ would no longer
   pass, that group reverts to its previous value and the change list says so explicitly
   ("proposed tightening → rolled back, because it would have cut profiles you approved").
   Losing the one profile you said "yes" to is the fastest way to lose a recruiter's trust.

**Known limitations**

- Sessions live in memory; a server restart drops them (frontend detects this and offers a
  fresh search).
- Scoring batches all filtered profiles in one call; at 48 profiles this is fine, at 98M it
  would page.
- The refine step trusts the model's self-reported change list after validation; the rollback
  guard covers the highest-risk inconsistency (filters vs. verdicts) but not every possible one.
