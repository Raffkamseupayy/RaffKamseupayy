// Filtering and the spoiler rule: what the checklist shows, and what a
// story trophy looks like before it is earned when spoilers are on.
export function applyFilters(trophies, filters) {
  const query = (filters.query ?? '').trim().toLowerCase();
  return trophies.filter((t) => {
    if (filters.kind !== 'all') {
      if (filters.kind === 'missable') {
        if (!t.missable) return false;
      } else if (t.kind !== filters.kind) {
        return false;
      }
    }
    if (filters.grade !== 'all' && t.grade !== filters.grade) return false;
    if (filters.hideEarned && filters.earned.has(t.id)) return false;
    if (query) {
      const hay = `${t.name} ${t.description} ${t.guide}`.toLowerCase();
      if (!hay.includes(query)) return false;
    }
    return true;
  });
}

// A story trophy is hidden while spoilers are on and it is not yet earned.
// The platinum and 100% completion trophies are not story spoilers.
export function isSpoilerHidden(trophy, settings, earned) {
  return Boolean(settings.spoilers) && trophy.kind === 'story' && !earned.has(trophy.id);
}

export const SPOILER_PLACEHOLDER = 'Hidden story trophy — earn it to reveal';
