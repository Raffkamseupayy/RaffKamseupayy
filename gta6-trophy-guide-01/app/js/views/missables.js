// The missables page: every missable trophy, with the mission or chapter it
// can be missed in, and the story trophies that are safe because missions
// are replayable.
import { gradeBadge } from './checklist.js';

export function renderMissables(page, trophies, state) {
  page.replaceChildren();
  const head = document.createElement('div');
  head.className = 'page-head';
  const h = document.createElement('h2');
  h.textContent = 'Missable trophies — do these before the finale';
  const intro = document.createElement('p');
  intro.textContent = 'Four trophies can be missed, as read from their official descriptions. Two need a partner beside you in free roam, one belongs to a mission window at VCIA, and one counts choices that may not come back. The game released 2026-11-19, so these flags are our reading of the descriptions, not yet verified in-game — each one says where that reading comes from.';
  head.append(h, intro);
  page.append(head);

  const missable = trophies.filter((t) => t.missable);
  const list = document.createElement('ol');
  list.className = 'missable-list';
  for (const t of missable) {
    const earned = state.earned.has(t.id);
    const li = document.createElement('li');
    li.className = 'missable-row' + (earned ? ' is-earned' : '');
    const name = document.createElement('button');
    name.type = 'button';
    name.className = 'missable-name';
    name.textContent = t.name;
    name.addEventListener('click', () => state.onSelect(t.id));
    const badges = document.createElement('span');
    badges.className = 'row-meta';
    badges.append(gradeBadge(t.grade));
    const desc = document.createElement('p');
    desc.className = 'row-desc';
    desc.textContent = `“${t.description}”`;
    const note = document.createElement('p');
    note.className = 'missable-note';
    note.textContent = t.missableNote;
    const status = document.createElement('p');
    status.className = 'missable-status';
    status.textContent = earned ? '✓ Earned — safe now.' : 'Not earned yet — do it before the final mission.';
    li.append(name, badges, desc, note, status);
    list.append(li);
  }
  page.append(list);

  const safe = document.createElement('div');
  safe.className = 'safe-note';
  const sh = document.createElement('h3');
  sh.textContent = 'What is not missable';
  const sp = document.createElement('p');
  sp.textContent = 'The 12 story trophies (chapters, named missions and the finale) are not flagged missable: story missions are replayable from the pause menu in past games in the series, so a failed or skipped mission can be run again. Collectibles, activities, races, challenges and shops stay available in free roam after the story, so they can be finished at any time. If the game turns out to lock any of these after the finale, this page will say so once it is checked in-game.';
  safe.append(sh, sp);
  page.append(safe);
}
