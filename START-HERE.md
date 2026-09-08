# START HERE — Sourcing Refinement Loop (Flexiple assignment, complete submission)

This folder is a **complete, runnable submission** of the Flexiple "Sourcing Refinement
Loop" engineering challenge. The brief is included (`ASSIGNMENT-BRIEF.txt`). The app is
zero-dependency: plain Node.js backend, vanilla-JS frontend, no build step, no `npm install`.

## What you're looking at

- A full-stack AI-recruiter slice: free-text requirement → structured filters + fit rubric
  (real server-side LLM calls) → local filtering of a 48-profile talent pool → LLM scoring
  with verified citations → conversational refinement rounds → frozen final shortlist.
- All LLM prompts are readable in `lib/prompts.js`.
- `README.md` — setup, env vars, and the decisions section (what was prioritised / cut / why).
- `test_api.py` — end-to-end API test that makes **real LLM calls** and re-checks every
  returned profile against the pool deterministically (~2 min to run).

## Get it running — 3 steps

1. **Node.js >= 20** installed (`node -v` to check). Nothing else to install.
2. **Create `.env`** in this folder by copying `.env.example` and filling in your own key:
   ```bash
   cp .env.example .env
   # then edit .env: put YOUR OpenAI-compatible API key in LLM_API_KEY
   ```

   Any OpenAI-compatible provider works (OpenAI, Groq, Gemini compat mode, OpenRouter,
   DashScope...). Defaults in `.env.example` point at OpenAI; change `LLM_BASE_URL` and
   `LLM_MODEL` if you use another provider. The key is read from the environment only and
   is never committed (`.env` is gitignored).
3. **Run:**
   ```bash
   npm start
   ```

   Open **http://localhost:3000**.

That's the whole setup. No database, no accounts, no other services.

## Verify it works (optional, recommended)

```bash
python3 test_api.py     # needs python3; makes real LLM calls; prints PASS lines; ~2 min
```

## Suggested first run in the UI

1. Click the example chip "RDS devs · 4–7y · startups · Bangalore" → Search.
2. Wait through the thinking state (~20–40s: two real LLM calls).
3. Read one profile card: score, WHY IT MATCHED, citation chips (all verified against the
   profile's real fields).
4. Mark one profile ✗ and one ✓, type e.g. "#2 is too junior — push on Terraform/IaC",
   hit Refine. Watch the REFINED message: plain-language summary + change diff with reasons.
5. Hit "Freeze search" for the final state.
6. Try the designed failure states: Edit the spec → set min years to 40 → Save & re-run
   (empty state with relaxation chips). The UI also includes a recoverable bad-key error state.

## If you are an AI agent setting this up for a human

Read `SETUP.md` in this folder first — it has the exact commands, the env-var contract,
provider recipes, a verification checklist, and a troubleshooting table. Do not invent
dependencies; there are none. Do not commit or print the API key.
