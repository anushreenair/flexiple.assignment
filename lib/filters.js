// Objective filter engine. Pure, deterministic, runs locally against profiles.json.
// Design note: nice_to_have skills deliberately DO NOT filter — they are context
// for the LLM scorer. Filters are hard constraints only.

const norm = (s) => String(s ?? '').toLowerCase().trim();

function matchesSkills(profile, skills) {
  if (!skills) return true;
  const have = new Set(profile.skills.map(norm));
  return (skills.must_have || []).every((s) => have.has(norm(s)));
}

function matchesYears(profile, years) {
  if (!years) return true;
  if (years.min != null && profile.years_experience < years.min) return false;
  if (years.max != null && profile.years_experience > years.max) return false;
  return true;
}

function matchesLocation(profile, locations) {
  if (!locations) return true;
  const values = (locations.values || []).map(norm);
  if (values.includes(norm(profile.location))) return true;
  if (locations.allow_remote && norm(profile.location).startsWith('remote')) return true;
  return false;
}

function matchesCompanyTypes(profile, ct) {
  if (!ct) return true;
  const wanted = new Set((ct.values || []).map(norm));
  if (!wanted.size) return true;
  const scope = ct.scope || 'any';
  if (scope === 'current' || scope === 'any') {
    if (wanted.has(norm(profile.current_company_type))) return true;
  }
  if (scope === 'past' || scope === 'any') {
    if (profile.past_companies.some((pc) => wanted.has(norm(pc.company_type)))) return true;
  }
  return false;
}

function matchesTitle(profile, keywords) {
  // Role family is a SOFT signal: it guides rubric scoring, never hard-filters.
  // Dataset titles are coarse ("Database Reliability Engineer" for a backend role),
  // so hard-filtering on them empties the pool and starves the refinement loop.
  return true;
}

function matchesEducation(profile, keywords) {
  if (!keywords || !keywords.length) return true;
  const edu = norm(profile.education);
  return keywords.some((k) => edu.includes(norm(k)));
}

/**
 * Which filter groups does this profile fail? Used by the refine guard:
 * profiles the recruiter approved must survive the next round's filters.
 */
export function filterGroupFailures(profile, filters) {
  const f = filters || {};
  const fails = [];
  if (!matchesSkills(profile, f.skills)) fails.push('skills');
  if (!matchesYears(profile, f.years_experience)) fails.push('years_experience');
  if (!matchesLocation(profile, f.locations)) fails.push('locations');
  if (!matchesCompanyTypes(profile, f.company_types)) fails.push('company_types');
  if (!matchesEducation(profile, f.education_keywords)) fails.push('education_keywords');
  return fails;
}

/**
 * Apply objective filters to the pool.
 * @returns {{matched: object[], total: number, activeFilters: string[]}}
 *   activeFilters: human-readable list of constraints actually applied,
 *   used by the UI so the recruiter sees what did the cutting.
 */
export function applyFilters(pool, filters) {
  const f = filters || {};
  const matched = pool.filter(
    (p) =>
      matchesSkills(p, f.skills) &&
      matchesYears(p, f.years_experience) &&
      matchesLocation(p, f.locations) &&
      matchesCompanyTypes(p, f.company_types) &&
      matchesTitle(p, f.title_keywords) &&
      matchesEducation(p, f.education_keywords),
  );

  const activeFilters = [];
  if (f.skills?.must_have?.length) activeFilters.push(`Must have skills: ${f.skills.must_have.join(', ')}`);
  if (f.skills?.nice_to_have?.length) activeFilters.push(`Nice to have (scoring context only): ${f.skills.nice_to_have.join(', ')}`);
  if (f.years_experience && (f.years_experience.min != null || f.years_experience.max != null)) {
    const { min, max } = f.years_experience;
    activeFilters.push(
      min != null && max != null ? `${min}–${max} years experience`
        : min != null ? `At least ${min} years experience`
        : `At most ${max} years experience`,
    );
  }
  if (f.locations) {
    const parts = [];
    if (f.locations.values?.length) parts.push(f.locations.values.join(', '));
    if (f.locations.allow_remote) parts.push('remote OK');
    if (parts.length) activeFilters.push(`Location: ${parts.join(' / ')}`);
  }
  if (f.company_types?.values?.length) {
    const scopeLabel = { any: 'any time', current: 'currently', past: 'previously' }[f.company_types.scope || 'any'];
    activeFilters.push(`Company background (${scopeLabel}): ${f.company_types.values.join(', ')}`);
  }
  if (f.title_keywords?.length) activeFilters.push(`Role focus (scored, not filtered): ${f.title_keywords.join(' / ')}`);
  if (f.education_keywords?.length) activeFilters.push(`Education contains: ${f.education_keywords.join(' / ')}`);

  return { matched, total: pool.length, activeFilters };
}
