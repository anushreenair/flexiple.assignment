# SETUP.md — exact setup, verification, and troubleshooting

Target: any machine with **Node.js >= 20** and (optionally, for the test) **Python 3**.
No package installs are required anywhere — the app has zero runtime dependencies.

## 1. Environment contract

The server reads these variables (from the process env, or from a `.env` file placed next
to `server.js`; process env wins):

| Variable       | Required | Purpose                          | Default if unset                  |
| -------------- | -------- | -------------------------------- | --------------------------------- |
| `LLM_API_KEY`  | **yes**  | Bearer key for the LLM endpoint  | — (app starts but searches fail)  |
| `LLM_BASE_URL` | no       | OpenAI-compatible base URL       | `https://api.openai.com/v1`       |
| `LLM_MODEL`    | no       | Model id                         | `gpt-4o-mini`                     |
| `PORT`         | no       | HTTP port                        | `3000`                            |

The client speaks the OpenAI chat-completions protocol (`POST {base}/chat/completions` with
`Authorization: Bearer $LLM_API_KEY`), so any OpenAI-compatible provider works.

### Provider recipes (pick ONE, put it in `.env`)

```bash
# OpenAI
LLM_API_KEY=***
LLM_BASE_URL=https://api.openai.com/v1
LLM_MODEL=gpt-4o-mini

# Groq (fast free tier)
LLM_API_KEY=***
LLM_BASE_URL=https://api.groq.com/openai/v1
LLM_MODEL=llama-3.3-70b-versatile

# OpenRouter
LLM_API_KEY=***
LLM_BASE_URL=https://openrouter.ai/api/v1
LLM_MODEL=meta-llama/llama-3.3-70b-instruct:free

# Google Gemini (OpenAI-compatible mode)
LLM_API_KEY=***
LLM_BASE_URL=https://generativelanguage.googleapis.com/v1beta/openai
LLM_MODEL=gemini-2.0-flash

# Alibaba DashScope (what this submission was tested against)
LLM_API_KEY=***
LLM_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1
LLM_MODEL=qwen-plus
```

Notes: the code requests `response_format: {"type":"json_object"}`; providers that ignore
it still work because every response is validated/normalized locally. Rate limits, 5xx and
timeouts retry with exponential backoff; malformed JSON gets one repair round-trip.

## 2. Exact commands

```bash
cd <this folder>
node -v                      # must be >= 20
cp .env.example .env         # then edit .env and set LLM_API_KEY (and base/model if needed)
npm start                    # prints "Sourcing Refinement Loop running at http://localhost:3000"
```

Open http://localhost:3000 in a browser. First search takes ~20–40s (two real LLM calls);
each refinement round ~15–40s. This latency is expected, not a hang.

Optional end-to-end test (real LLM calls, ~2 min, prints PASS/FAIL lines, exits 0 on success):

```bash
python3 test_api.py
```

## 3. Verification checklist (what "working" looks like)

- [ ] `curl -s localhost:3000/api/health` → `{"ok":true,"model":"...","baseUrl":"...","poolSize":48}`
- [ ] UI search screen loads; three example chips visible.
- [ ] Submitting a search shows the thinking state, then a workspace with ranked profile
      cards (score badge, WHY IT MATCHED, citation chips) and the live spec panel on the right.
- [ ] A refinement round (chat text and/or ✓/✗ marks → Refine) returns a REFINED message
      with a change diff and an updated result list.
- [ ] "Freeze search" shows the frozen filters, rubric, and ranked shortlist.
- [ ] `python3 test_api.py` ends with `ALL API TESTS PASSED` (optional but recommended).

## 4. Troubleshooting

| Symptom | Cause / fix |
| --- | --- |
| `Search failed: ... 401/403` | Bad or missing `LLM_API_KEY`. Check `.env` spelling; no quotes needed. |
| `Search failed: ... 404` on chat/completions | Wrong `LLM_BASE_URL` for your provider — use one of the recipes above exactly. |
| Search fails with rate-limit message after ~30s | Provider throttled; the app already retried with backoff. Wait a minute, retry. |
| Port 3000 in use | `PORT=3100 npm start`, then open `http://localhost:3100`. |
| `node: bad option`/syntax errors | Node < 20. Upgrade Node; there are no other dependencies to fix. |
| Results list empty right after a search | Possible but unusual — the UI shows relaxation chips; also try the first example chip, which is known to match 6 of 48 profiles. |
| Refresh loses the session | Sessions are in-memory by design (assignment scope). The UI restores via `?session=<id>` if the server is still up; after a server restart, start a new search. |

## 5. Repo map (for the reader/reviewer)

```
server.js        HTTP server + API routes (node:http, zero deps)
lib/llm.js       OpenAI-compatible client: timeouts, retries, JSON repair
lib/prompts.js   ALL prompts (part of the submission — read them)
lib/schemas.js   validation/normalization of every LLM structure
lib/filters.js   deterministic local filter engine
lib/search.js    filter -> score -> rank -> citation verification
lib/store.js     in-memory session store
public/          frontend (vanilla ES modules, no build step)
data/            the supplied 48-profile talent pool
test_api.py      end-to-end API test with real LLM calls
README.md        setup + decisions (prioritised / cut / why)
```

## 6. Hygiene

- Never commit or share `.env`. It is gitignored; share `.env.example` instead.
- No customer/PII data: `data/profiles.json` is the fictional dataset supplied with the brief.
