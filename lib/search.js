// Search pipeline: filter -> LLM-score -> rank -> trim citations to verified ones.
import { applyFilters } from './filters.js';
import { callStructured } from './llm.js';
import { buildScorePrompt } from './prompts.js';
import { normalizeScores } from './schemas.js';

const norm = (s) => String(s ?? '').toLowerCase();

// Keep only citations whose value genuinely appears in that field of the profile.
// Deterministic guard against hallucinated "evidence" — trust is the product here.
function verifyCitations(profile, citations) {
  const fieldText = (field) => {
    const v = profile[field];
    if (v == null) return null;
    if (field === 'past_companies') {
      return norm(v.map((pc) => `${pc.company} ${pc.company_type} ${pc.title} ${pc.years}`).join(' | '));
    }
    if (Array.isArray(v)) return norm(v.join(' | '));
    return norm(String(v));
  };
  return citations.filter((c) => {
    const text = fieldText(c.field);
    if (text == null) return false;
    return text.includes(norm(c.value));
  });
}

/**
 * Run filter + score + rank for a spec against the pool.
 * @returns {Promise<{filteredCount: number, total: number, activeFilters: string[], results: Array}>}
 */
export async function runSearch(pool, spec) {
  const { matched, total, activeFilters } = applyFilters(pool, spec.filters);
  if (!matched.length) {
    return { filteredCount: 0, total, activeFilters, results: [] };
  }

  const prompt = buildScorePrompt({ rubric: spec.rubric, filters: spec.filters, profiles: matched });
  const expectedIds = matched.map((p) => p.id);
  const scores = await callStructured(prompt, (raw) => normalizeScores(raw, expectedIds));

  const byId = new Map(matched.map((p) => [p.id, p]));
  const results = scores
    .filter((s) => byId.has(s.profile_id))
    .map((s) => {
      const profile = byId.get(s.profile_id);
      return {
        profile_id: s.profile_id,
        score: s.score,
        verdict: s.verdict,
        explanation: s.explanation,
        citations: verifyCitations(profile, s.citations),
        profile,
      };
    })
    .sort((a, b) => b.score - a.score || a.profile_id.localeCompare(b.profile_id));

  results.forEach((r, i) => (r.rank = i + 1));
  return { filteredCount: matched.length, total, activeFilters, results };
}
