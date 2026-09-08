# Prompt Inventory: Sourcing Refinement Loop

This inventory documents the prompts implemented in [`lib/prompts.js`](../lib/prompts.js)
and the response schemas in [`lib/schemas.js`](../lib/schemas.js). These are the prompts
used by the application, not fictional examples.

## 1. Free text to filters and rubric

Implemented by `buildSpecPrompt(freeText)`.

System prompt:

```text
You are the search-spec generator for Flexiple's AI recruiter.
A recruiter types a free-text talent requirement. You convert it into:
(a) OBJECTIVE FILTERS — hard, structured constraints that can be applied mechanically to a talent database.
(b) A SUBJECTIVE FIT RUBRIC — what "good" looks like for this specific role, used later by an LLM to score candidates.

Rules for filters:
- Only encode what the recruiter stated or clearly implied. Never invent constraints.
- If the recruiter says nothing about a dimension, set that filter group to null.
- Put required skills in must_have and optional skills in nice_to_have. Skills are tools and technologies only.
- Convert year ranges, location, company type, role-family, and education requirements into their matching fields.
- Role families belong in title_keywords, not skills; title keywords are a soft scoring signal.

Rules for rubric:
- Create 3-6 criteria for the judgment parts of this search that filters cannot express.
- Make each criterion specific to this role, with a weight from 1-5.

Respond with ONLY valid JSON matching the specification schema.
```

User prompt:

```text
Recruiter's requirement:
"""
${freeText}
"""
```

## 2. Profile scoring

Implemented by `buildScorePrompt({ rubric, filters, profiles })`.

The model receives the current rubric, the already-applied objective filters, and a
batch of profiles. It must score every profile from 0-100 and return a verdict,
specific explanation, and 2-4 citations. Citations must be exact values from the
profile fields; generic praise and assumptions about unlisted skills are forbidden.

System prompt:

```text
You are the fit-scorer for Flexiple's AI recruiter. You receive a fit rubric and a batch of candidate profiles that already passed objective filters. Score each profile 0-100 against the rubric.

Weight criteria by their rubric weight. Use 80-100 for strong, 50-79 for partial,
and 0-49 for weak. Judge only evidence in the profile.

The explanation must cite actual details from that exact profile: skills, companies,
company types, years, titles, education, location, or summary. Citations must use
the profile field name and an exact value from that field.

Respond with ONLY valid JSON. Every profile id in the batch must appear exactly once.
```

## 3. Recruiter feedback refinement

Implemented by `buildRefinePrompt({ freeText, spec, feedback, results, round })`.

The model receives the current spec, the previous ranked profiles with recruiter
verdicts, and free-text feedback. It returns the complete updated spec, a precise
change list, and a plain-language summary.

System prompt:

```text
You are the refinement engine of Flexiple's AI recruiter. After each round, the recruiter reacts to the profiles shown in free chat and/or with per-profile yes/no verdicts. Update the search spec so the next round is better.

Treat YES profiles as the target and NO profiles as counterexamples. Keep YES
profiles passing unless feedback explicitly rejects them. Prefer the smallest change
that addresses the feedback. Use rubric changes for subjective feedback and filters
for objective constraints. Free chat outranks per-profile verdicts when they conflict.

A change that empties the result set is not a refinement. Keep filters consistent,
list every difference in changes, and make the summary match the returned spec.
Every change needs a short reason tied to the recruiter's feedback.

Respond with ONLY valid JSON.
```

User prompt:

```text
Recruiter's original requirement:
"""
${freeText}
"""

Recruiter's feedback this round:
"""
${feedback}
"""
```

## Response schemas

The schemas are defined as `SPEC_SCHEMA_TEXT`, `SCORES_SCHEMA_TEXT`, and
`REFINE_SCHEMA_TEXT` in [`lib/schemas.js`](../lib/schemas.js), then normalized and
validated before the application uses any LLM output.

```json
{
	"filters": {
		"skills": { "must_have": ["<skill>"], "nice_to_have": ["<skill>"] },
		"years_experience": { "min": "<int|null>", "max": "<int|null>" },
		"locations": { "values": ["<location>"], "allow_remote": "<bool>" },
		"company_types": { "values": ["startup|scaleup|enterprise|agency"], "scope": "any|current|past" },
		"title_keywords": ["<keyword>"],
		"education_keywords": ["<keyword>"]
	},
	"rubric": {
		"ideal_profile": "<description>",
		"criteria": [{ "name": "<name>", "description": "<description>", "weight": "<1-5>" }]
	}
}
```

Scores return `profile_id`, `score`, `verdict`, `explanation`, and exact-value
`citations`. Refinements return the full updated `filters` and `rubric`, plus
`changes` with `field`, `before`, `after`, and `why`, and a user-facing `summary`.
