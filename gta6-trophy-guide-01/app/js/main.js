// Boot and routing for the Leonida Trophy Guide: loads the trophy data,
// reads the view from the URL (?view=, ?trophy=, ?spoilers=, ?kind=,
// ?grade=, ?q=), wires the controls, and renders. Sets window.__shotReady
// once the first render is done, so screenshots wait for real content.
import { GRADE_ORDER, GRADE_LABELS, KIND_LABELS, TOTAL_TROPHIES } from './config.js';
import { loadTrophies, countEarned, countByGrade, countByKind } from './data.js';
import { loadEarned, saveEarned, loadSettings, saveSettings, exportProgress, importProgressFile } from './store.js';
import { applyFilters } from './filters.js';
import { renderChecklist } from './views/checklist.js';
import { renderDetail } from './views/detail.js';
import { renderRoadmap } from './views/roadmap.js';
import { renderMissables } from './views/missables.js';

const params = new URLSearchParams(location.search);
const trophies = await loadTrophies();
const byId = new Map(trophies.map((t) => [t.id, t]));

const state = {
  earned: loadEarned(),
  settings: loadSettings(),
  view: ['checklist', 'roadmap', 'missables'].includes(params.get('view')) ? params.get('view') : 'checklist',
  selectedId: null,
  filters: {
    kind: params.get('kind') ?? 'all',
    grade: params.get('grade') ?? 'all',
    query: params.get('q') ?? '',
    hideEarned: false,
    earned: loadEarned(),
  },
  onToggle: null,
  onSelect: null,
};
state.filters.earned = state.earned;

// URL deep links: ?trophy=<id> opens that trophy's guide, ?spoilers=on
// turns spoiler-safe mode on for the screenshot.
const trophyParam = Number(params.get('trophy'));
if (Number.isInteger(trophyParam) && byId.has(trophyParam)) state.selectedId = trophyParam;
if (params.get('spoilers') === 'on') state.settings.spoilers = true;

const $ = (id) => document.getElementById(id);
const listEl = $('trophyList');
const detailPane = $('detailPane');
const roadmapPage = $('roadmapPage');
const missablesPage = $('missablesPage');
const layoutEl = document.querySelector('.layout');
const controlsEl = $('controls');

function visibleTrophies() {
  return applyFilters(trophies, state.filters);
}

function renderProgress() {
  const counts = countEarned(trophies, state.earned);
  $('earnedCount').textContent = String(counts.total);
  $('progressFill').style.width = `${Math.round((counts.total / TOTAL_TROPHIES) * 100)}%`;
  const next = trophies.find((t) => !state.earned.has(t.id) && t.missable);
  $('progressNote').textContent = counts.total === TOTAL_TROPHIES
    ? 'Platinum earned: Vice Got a Price!'
    : next
      ? `Next missable to clear: ${next.name}`
      : `${TOTAL_TROPHIES - counts.total} trophies to go — platinum: Vice Got a Price!`;

  // Counters by grade and by kind.
  const totalsGrade = countByGrade(trophies);
  const totalsKind = countByKind(trophies);
  const stats = $('stats');
  stats.replaceChildren();
  for (const grade of GRADE_ORDER) {
    const chip = document.createElement('span');
    chip.className = 'stat-chip';
    chip.textContent = `${GRADE_LABELS[grade]} ${counts.byGrade[grade] ?? 0}/${totalsGrade[grade] ?? 0}`;
    stats.append(chip);
  }
  const missableTotal = trophies.filter((t) => t.missable).length;
  const missableEarned = trophies.filter((t) => t.missable && state.earned.has(t.id)).length;
  const missChip = document.createElement('span');
  missChip.className = 'stat-chip stat-missable';
  missChip.textContent = `Missable ${missableEarned}/${missableTotal}`;
  stats.append(missChip);
  for (const kind of ['story', 'collectibles', 'activities', 'side']) {
    const chip = document.createElement('span');
    chip.className = 'stat-chip';
    chip.textContent = `${KIND_LABELS[kind]} ${counts.byKind[kind] ?? 0}/${totalsKind[kind] ?? 0}`;
    stats.append(chip);
  }
}

function renderAll() {
  renderProgress();
  const isChecklist = state.view === 'checklist';
  layoutEl.hidden = !isChecklist;
  controlsEl.style.display = isChecklist ? '' : 'none';
  $('listHint').style.display = isChecklist ? '' : 'none';
  roadmapPage.hidden = state.view !== 'roadmap';
  missablesPage.hidden = state.view !== 'missables';
  for (const btn of document.querySelectorAll('#tabs button')) {
    btn.classList.toggle('is-active', btn.dataset.view === state.view);
  }
  if (isChecklist) {
    const shown = visibleTrophies();
    renderChecklist(listEl, shown, state, { onToggle: toggleEarned, onSelect: selectTrophy });
    $('emptyNote').hidden = shown.length !== 0;
    $('listHint').textContent = `Showing ${shown.length} of ${TOTAL_TROPHIES} trophies. Click a row to read its guide; tick the box when you earn it.`;
    const selected = state.selectedId !== null ? byId.get(state.selectedId) : null;
    renderDetail(detailPane, selected, state);
  } else if (state.view === 'roadmap') {
    renderRoadmap(roadmapPage, trophies, state);
  } else {
    renderMissables(missablesPage, trophies, state);
  }
}

function toggleEarned(id, earned) {
  if (earned) state.earned.add(id);
  else state.earned.delete(id);
  saveEarned(state.earned);
  renderAll();
}

function selectTrophy(id) {
  state.selectedId = id;
  if (state.view !== 'checklist') {
    state.view = 'checklist';
    const url = new URL(location.href);
    url.searchParams.set('view', 'checklist');
    history.replaceState(null, '', url);
  }
  renderAll();
  const row = listEl.querySelector(`[data-trophy-id="${id}"]`);
  if (row) row.scrollIntoView({ block: 'nearest' });
}

state.onToggle = toggleEarned;
state.onSelect = selectTrophy;

// Controls: search, kind and grade filters, hide-earned, spoiler toggle,
// export, import and reset.
const searchBox = $('searchBox');
searchBox.value = state.filters.query;
searchBox.addEventListener('input', () => {
  state.filters.query = searchBox.value;
  renderAll();
});
const kindFilter = $('kindFilter');
kindFilter.value = ['all', 'story', 'missable', 'collectibles', 'activities', 'side', 'completion'].includes(state.filters.kind) ? state.filters.kind : 'all';
state.filters.kind = kindFilter.value;
kindFilter.addEventListener('change', () => {
  state.filters.kind = kindFilter.value;
  renderAll();
});
const gradeFilter = $('gradeFilter');
gradeFilter.value = ['all', 'platinum', 'gold', 'silver', 'bronze'].includes(state.filters.grade) ? state.filters.grade : 'all';
state.filters.grade = gradeFilter.value;
gradeFilter.addEventListener('change', () => {
  state.filters.grade = gradeFilter.value;
  renderAll();
});
$('hideEarned').addEventListener('change', (e) => {
  state.filters.hideEarned = e.target.checked;
  renderAll();
});
const spoilerToggle = $('spoilerToggle');
spoilerToggle.checked = state.settings.spoilers;
spoilerToggle.addEventListener('change', () => {
  state.settings.spoilers = spoilerToggle.checked;
  saveSettings(state.settings);
  renderAll();
});
$('exportBtn').addEventListener('click', () => exportProgress(state.earned));
$('importFile').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    state.earned = await importProgressFile(file, trophies.map((t) => t.id));
    state.filters.earned = state.earned;
    saveEarned(state.earned);
    renderAll();
  } catch (err) {
    alert('Could not import that file: ' + err.message);
  }
  e.target.value = '';
});
$('resetBtn').addEventListener('click', () => {
  if (!confirm('Clear all earned trophies? This cannot be undone.')) return;
  state.earned = new Set();
  state.filters.earned = state.earned;
  saveEarned(state.earned);
  renderAll();
});
for (const btn of document.querySelectorAll('#tabs button')) {
  btn.addEventListener('click', () => {
    state.view = btn.dataset.view;
    renderAll();
  });
}

renderAll();
window.__shotReady = true;
