// Loading the trophy data: one local JSON file, fetched from app/ itself.
// The file holds the official names, descriptions and grades plus our own
// guides, kinds, missable flags, roadmap stages and PSN targets.
import { DATA_URL } from './config.js';

export async function loadTrophies() {
  const response = await fetch(DATA_URL);
  if (!response.ok) throw new Error('Could not load ' + DATA_URL);
  const doc = await response.json();
  const trophies = Array.isArray(doc) ? doc : doc.trophies;
  return trophies.map((t) => ({
    id: t.id,
    name: t.name,
    description: t.description,
    grade: t.grade,
    guide: t.guide,
    sources: t.sources ?? '',
    kind: t.kind ?? 'activities',
    missable: Boolean(t.missable),
    missableNote: t.missableNote ?? '',
    stage: t.stage ?? 6,
    target: t.target ?? null,
  }));
}

// Count earned trophies, overall and grouped, for the progress counters.
export function countEarned(trophies, earned) {
  const byGrade = {};
  const byKind = {};
  let total = 0;
  for (const t of trophies) {
    if (!earned.has(t.id)) continue;
    total += 1;
    byGrade[t.grade] = (byGrade[t.grade] ?? 0) + 1;
    byKind[t.kind] = (byKind[t.kind] ?? 0) + 1;
  }
  return { total, byGrade, byKind };
}

export function countByGrade(trophies) {
  const out = {};
  for (const t of trophies) out[t.grade] = (out[t.grade] ?? 0) + 1;
  return out;
}

export function countByKind(trophies) {
  const out = {};
  for (const t of trophies) out[t.kind] = (out[t.kind] ?? 0) + 1;
  return out;
}
