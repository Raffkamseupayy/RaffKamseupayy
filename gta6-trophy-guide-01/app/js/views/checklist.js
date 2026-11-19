// The checklist view: one row per trophy with its checkbox, official name,
// description, grade badge, kind tag and missable flag.
import { GRADE_LABELS, KIND_LABELS } from '../config.js';
import { isSpoilerHidden, SPOILER_PLACEHOLDER } from '../filters.js';

export function gradeBadge(grade) {
  const span = document.createElement('span');
  span.className = `grade grade-${grade}`;
  span.textContent = GRADE_LABELS[grade] ?? grade;
  return span;
}

export function renderChecklist(listEl, trophies, state, callbacks) {
  listEl.replaceChildren();
  for (const t of trophies) {
    const earned = state.earned.has(t.id);
    const hidden = isSpoilerHidden(t, state.settings, state.earned);
    const li = document.createElement('li');
    li.className = 'trophy-row' + (earned ? ' is-earned' : '') + (t.missable ? ' is-missable' : '');
    if (state.selectedId === t.id) li.classList.add('is-selected');
    li.dataset.trophyId = String(t.id);

    const box = document.createElement('input');
    box.type = 'checkbox';
    box.checked = earned;
    box.setAttribute('aria-label', `Earned: ${hidden ? SPOILER_PLACEHOLDER : t.name}`);
    box.addEventListener('change', () => callbacks.onToggle(t.id, box.checked));

    const body = document.createElement('button');
    body.type = 'button';
    body.className = 'row-body';
    body.addEventListener('click', () => callbacks.onSelect(t.id));

    const name = document.createElement('span');
    name.className = 'row-name';
    name.textContent = hidden ? SPOILER_PLACEHOLDER : t.name;
    const desc = document.createElement('span');
    desc.className = 'row-desc';
    desc.textContent = hidden ? 'Spoiler-safe mode hides this story trophy until you earn it.' : t.description;
    const meta = document.createElement('span');
    meta.className = 'row-meta';
    meta.append(gradeBadge(t.grade));
    const kind = document.createElement('span');
    kind.className = 'kind-tag';
    kind.textContent = KIND_LABELS[t.kind] ?? t.kind;
    meta.append(kind);
    if (t.target !== null) {
      const target = document.createElement('span');
      target.className = 'target-tag';
      target.textContent = `PSN target: ${t.target.toLocaleString('en-US')}`;
      meta.append(target);
    }
    if (t.missable) {
      const flag = document.createElement('span');
      flag.className = 'missable-flag';
      flag.textContent = 'MISSABLE';
      meta.append(flag);
    }
    body.append(name, desc, meta);
    li.append(box, body);
    listEl.append(li);
  }
}
