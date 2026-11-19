// The roadmap page: the platinum path in stages, built from the official
// descriptions, with each stage's trophies and earned counts.
import { ROADMAP_STAGES, KIND_LABELS } from '../config.js';
import { gradeBadge } from './checklist.js';
import { isSpoilerHidden, SPOILER_PLACEHOLDER } from '../filters.js';

export function renderRoadmap(page, trophies, state) {
  page.replaceChildren();
  const head = document.createElement('div');
  head.className = 'page-head';
  const h = document.createElement('h2');
  h.textContent = 'Roadmap to the platinum';
  const intro = document.createElement('p');
  intro.textContent = 'The platinum path in seven stages, built from the official trophy descriptions. Story first, the missables before the finale, then side strands, activities, collectibles, money and combat — with 100% completion last, because nearly every other trophy feeds into it.';
  head.append(h, intro);
  page.append(head);

  for (const stage of ROADMAP_STAGES) {
    const members = trophies.filter((t) => t.stage === stage.stage);
    const earnedCount = members.filter((t) => state.earned.has(t.id)).length;
    const section = document.createElement('section');
    section.className = 'roadmap-stage';
    const sh = document.createElement('h3');
    sh.textContent = `${stage.title} — ${earnedCount} of ${members.length} earned`;
    const blurb = document.createElement('p');
    blurb.className = 'stage-blurb';
    blurb.textContent = stage.blurb;
    const list = document.createElement('ul');
    list.className = 'stage-list';
    for (const t of members) {
      const li = document.createElement('li');
      const mark = document.createElement('span');
      mark.className = 'stage-mark';
      mark.textContent = state.earned.has(t.id) ? '✓' : '○';
      const name = document.createElement('button');
      name.type = 'button';
      name.className = 'stage-name';
      name.textContent = isSpoilerHidden(t, state.settings, state.earned) ? SPOILER_PLACEHOLDER : t.name;
      name.addEventListener('click', () => state.onSelect(t.id));
      const kind = document.createElement('span');
      kind.className = 'stage-kind';
      kind.textContent = KIND_LABELS[t.kind] ?? t.kind;
      li.append(mark, name, gradeBadge(t.grade), kind);
      if (t.missable) {
        const flag = document.createElement('span');
        flag.className = 'missable-flag';
        flag.textContent = 'MISSABLE';
        li.append(flag);
      }
      list.append(li);
    }
    section.append(sh, blurb, list);
    page.append(section);
  }
}
