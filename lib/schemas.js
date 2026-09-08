// JSON schemas + normalizers/validators for every LLM-produced structure.
// We use `response_format: json_object` (widest provider support) and enforce
// shape here. Anything malformed triggers a repair retry in llm.js.

export const SPEC_SCHEMA_TEXT = `
{
  "filters": {
    "skills": { "must_have": ["<skill>"], "nice_to_have": ["<skill>"] },
    "years_experience": { "min": <int|null>, "max": <int|null> },
    "locations": { "values": ["<location>"], "allow_remote": <bool> },
    "company_types": { "values": ["startup"|"scaleup"|"enterprise"|"agency"], "scope": "any"|"current"|"past" },
    "title_keywords": ["<keyword>"],
    "education_keywords": ["<keyword>"]
  },
  "rubric": {
    "ideal_profile": "<1-2 sentence description of what great looks like for THIS role>",
    "criteria": [
      { "name": "<short name>", "description": "<what good looks like, specific to this role>", "weight": <int 1-5> }
    ]
  }
}
Any filter group the recruiter did not state or clearly imply must be null.
rubric.criteria must have 3-6 entries.`;

export const SCORES_SCHEMA_TEXT = `
{
  "scores": [
    {
      "profile_id": "<id>",
      "score": <int 0-100>,
      "verdict": "strong"|"partial"|"weak",
      "explanation": "<2-3 sentences, specific to this profile>",
      "citations": [ { "field": "<profile field name>", "value": "<exact value from that field>" } ]
    }
  ]
}`;

export const REFINE_SCHEMA_TEXT = `
{
  "filters": <full updated filters object, same schema as before>,
  "rubric": <full updated rubric object, same schema as before>,
  "changes": [
    { "field": "<e.g. filters.years_experience.min>", "before": <old value>, "after": <new value>, "why": "<one sentence tied to the recruiter's feedback>" }
  ],
  "summary": "<1-2 sentences telling the recruiter what changed and why, in plain language>"
}
If the feedback does not warrant any spec change, return the spec unchanged with an empty changes array and say so in summary.`;

// ---------- normalizers ----------

const asStr = (v) => (typeof v === 'string' ? v.trim() : null);
const strList = (v) =>
  Array.isArray(v)
    ? [...new Set(v.map(asStr).filter(Boolean))]
    : null;
const asInt = (v) => (Number.isFinite(v) ? Math.trunc(v) : null);
const asBool = (v) => (typeof v === 'boolean' ? v : null);

export function normalizeFilters(raw) {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new ValidationError('filters must be an object or null');
  const f = {};

  if (raw.skills != null) {
    if (typeof raw.skills !== 'object') throw new ValidationError('filters.skills must be an object or null');
    const must = strList(raw.skills.must_have) || [];
    const nice = strList(raw.skills.nice_to_have) || [];
    f.skills = must.length || nice.length ? { must_have: must, nice_to_have: nice } : null;
  } else f.skills = null;

  if (raw.years_experience != null) {
    const y = raw.years_experience;
    if (typeof y !== 'object') throw new ValidationError('filters.years_experience must be an object or null');
    let min = asInt(y.min), max = asInt(y.max);
    if (min != null && (min < 0 || min > 60)) throw new ValidationError('years_experience.min out of range');
    if (max != null && (max < 0 || max > 60)) throw new ValidationError('years_experience.max out of range');
    if (min != null && max != null && min > max) [min, max] = [max, min];
    f.years_experience = min != null || max != null ? { min, max } : null;
  } else f.years_experience = null;

  if (raw.locations != null) {
    const l = raw.locations;
    if (typeof l !== 'object') throw new ValidationError('filters.locations must be an object or null');
    const values = strList(l.values) || [];
    const allowRemote = asBool(l.allow_remote) ?? false;
    f.locations = values.length || allowRemote ? { values, allow_remote: allowRemote } : null;
  } else f.locations = null;

  if (raw.company_types != null) {
    const c = raw.company_types;
    if (typeof c !== 'object') throw new ValidationError('filters.company_types must be an object or null');
    const values = (strList(c.values) || []).map((v) => v.toLowerCase());
    const allowed = ['startup', 'scaleup', 'enterprise', 'agency'];
    const bad = values.filter((v) => !allowed.includes(v));
    if (bad.length) throw new ValidationError(`company_types.values contains unknown types: ${bad.join(', ')}`);
    const scope = ['any', 'current', 'past'].includes(c.scope) ? c.scope : 'any';
    f.company_types = values.length ? { values, scope } : null;
  } else f.company_types = null;

  f.title_keywords = strList(raw.title_keywords);
  f.education_keywords = strList(raw.education_keywords);

  // Deterministic guard: models sometimes leak role families ("backend", "frontend")
  // into skills.must_have, which hard-filters against the dataset's coarse skill
  // vocabulary and empties results. Role families are a soft scoring signal — move them.
  const ROLE_FAMILIES = ['backend', 'frontend', 'front end', 'back end', 'full stack', 'fullstack', 'platform', 'data', 'devops', 'mobile', 'qa', 'security', 'ml'];
  if (f.skills) {
    const relocate = (list) => {
      const keep = [];
      for (const s of list) {
        const low = s.toLowerCase();
        if (ROLE_FAMILIES.includes(low)) {
          if (!f.title_keywords) f.title_keywords = [];
          if (!f.title_keywords.includes(low)) f.title_keywords.push(low);
        } else keep.push(s);
      }
      return keep;
    };
    const must = relocate(f.skills.must_have);
    const nice = relocate(f.skills.nice_to_have);
    f.skills = must.length || nice.length ? { must_have: must, nice_to_have: nice } : null;
  }

  const empty =
    !f.skills && !f.years_experience && !f.locations && !f.company_types &&
    !(f.title_keywords && f.title_keywords.length) &&
    !(f.education_keywords && f.education_keywords.length);
  return empty ? null : f;
}

export function normalizeRubric(raw) {
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) throw new ValidationError('rubric must be an object');
  const ideal = asStr(raw.ideal_profile);
  if (!ideal) throw new ValidationError('rubric.ideal_profile is required');
  if (!Array.isArray(raw.criteria) || raw.criteria.length < 1) throw new ValidationError('rubric.criteria must be a non-empty array');
  const criteria = raw.criteria.slice(0, 6).map((c, i) => {
    if (typeof c !== 'object' || c === null) throw new ValidationError(`rubric.criteria[${i}] must be an object`);
    const name = asStr(c.name);
    const description = asStr(c.description);
    if (!name || !description) throw new ValidationError(`rubric.criteria[${i}] needs name and description`);
    let weight = asInt(c.weight) ?? 3;
    weight = Math.min(5, Math.max(1, weight));
    return { name, description, weight };
  });
  return { ideal_profile: ideal, criteria };
}

export function normalizeSpec(raw) {
  if (raw == null || typeof raw !== 'object') throw new ValidationError('spec must be an object with filters and rubric');
  if (!('filters' in raw) || !('rubric' in raw)) throw new ValidationError('spec must contain filters and rubric');
  return { filters: normalizeFilters(raw.filters), rubric: normalizeRubric(raw.rubric) };
}

export function normalizeScores(raw, expectedIds) {
  if (raw == null || typeof raw !== 'object' || !Array.isArray(raw.scores)) {
    throw new ValidationError('scores response must be an object with a scores array');
  }
  const seen = new Set();
  const out = [];
  for (const s of raw.scores) {
    if (typeof s !== 'object' || s === null) continue;
    const id = asStr(s.profile_id);
    if (!id || !expectedIds.includes(id) || seen.has(id)) continue;
    seen.add(id);
    let score = asInt(s.score);
    if (score == null) throw new ValidationError(`score for ${id} must be an integer`);
    score = Math.min(100, Math.max(0, score));
    const verdict = ['strong', 'partial', 'weak'].includes(s.verdict) ? s.verdict : score >= 70 ? 'strong' : score >= 40 ? 'partial' : 'weak';
    const explanation = asStr(s.explanation);
    if (!explanation) throw new ValidationError(`explanation for ${id} is required`);
    const citations = Array.isArray(s.citations)
      ? s.citations
          .map((c) => (c && typeof c === 'object' ? { field: asStr(c.field), value: asStr(c.value) } : null))
          .filter((c) => c && c.field && c.value)
          .slice(0, 6)
      : [];
    out.push({ profile_id: id, score, verdict, explanation, citations });
  }
  if (!out.length) throw new ValidationError('no valid score entries found');
  return out;
}

export function normalizeRefinement(raw) {
  const spec = normalizeSpec(raw);
  if (!Array.isArray(raw.changes)) throw new ValidationError('refinement must include a changes array');
  const clip = (s, n) => (s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s);
  const clampWeight = (v) => (Number.isFinite(v) ? Math.min(5, Math.max(1, Math.trunc(v))) : v);
  const changes = [];
  for (const c of raw.changes.slice(0, 10)) {
    if (typeof c !== 'object' || c === null) throw new ValidationError('each change must be an object');
    const field = asStr(c.field);
    const why = asStr(c.why);
    if (!field || !why) throw new ValidationError('each change needs field and why');
    let before = c.before ?? null;
    let after = c.after ?? null;
    if (/weight/.test(field)) { before = clampWeight(before); after = clampWeight(after); }
    if (JSON.stringify(before) === JSON.stringify(after)) continue; // no-op after clamping
    changes.push({ field, before, after, why: clip(why, 220) });
  }
  const summary = asStr(raw.summary) || (changes.length ? 'Updated the search spec based on your feedback.' : 'No spec changes were needed for this feedback.');
  return { spec, changes, summary: clip(summary, 400) };
}

export class ValidationError extends Error {
  constructor(msg) {
    super(msg);
    this.name = 'ValidationError';
  }
}
