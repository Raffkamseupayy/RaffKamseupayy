// The guide pane: the selected trophy's full guide in our own words, with
// its sources cited beside it, plus its official description and grade.
import { GRADE_LABELS, KIND_LABELS } from '../config.js';
import { gradeBadge } from './checklist.js';
import { isSpoilerHidden, SPOILER_PLACEHOLDER } from '../filters.js';

export function renderDetail(pane, trophy, state) {
  pane.replaceChildren();
  if (!trophy) {
    const empty = document.createElement('div');
    empty.className = 'detail-empty';
    const h = document.createElement('h2');
    h.textContent = 'Pick a trophy to read its guide';
    const p = document.createElement('p');
    p.textContent = 'Click any trophy in the checklist. Every guide is written in our own words for this entry and cites its sources beside it; where a place or step is not pinned down, the guide says so plainly.';
    empty.append(h, p);
    pane.append(empty);
    return;
  }

  const earned = state.earned.has(trophy.id);
  const hidden = isSpoilerHidden(trophy, state.settings, state.earned);
  const card = document.createElement('article');
  card.className = 'detail-card';

  const eyebrow = document.createElement('p');
  eyebrow.className = 'detail-eyebrow';
  eyebrow.textContent = `Trophy ${trophy.id} of 55 · ${KIND_LABELS[trophy.kind] ?? trophy.kind}`;
  const h = document.createElement('h2');
  h.textContent = hidden ? SPOILER_PLACEHOLDER : trophy.name;
  const badges = document.createElement('p');
  badges.className = 'detail-badges';
  badges.append(gradeBadge(trophy.grade));
  if (trophy.missable) {
    const flag = document.createElement('span');
    flag.className = 'missable-flag';
    flag.textContent = 'MISSABLE';
    badges.append(flag);
  }
  const earnedTag = document.createElement('span');
  earnedTag.className = 'earned-tag';
  earnedTag.textContent = earned ? '✓ Earned' : 'Not earned yet';
  badges.append(earnedTag);

  const official = document.createElement('blockquote');
  official.className = 'official-desc';
  const offLabel = document.createElement('span');
  offLabel.className = 'off-label';
  offLabel.textContent = 'Official description (PlayStation):';
  const offText = document.createElement('span');
  offText.textContent = hidden ? 'Hidden until earned.' : `“${trophy.description}”`;
  official.append(offLabel, document.createElement('br'), offText);

  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'earn-toggle';
  toggle.textContent = earned ? 'Mark as not earned' : 'Mark as earned';
  toggle.addEventListener('click', () => state.onToggle(trophy.id, !earned));

  card.append(eyebrow, h, badges, official, toggle);

  if (hidden) {
    const note = document.createElement('p');
    note.className = 'spoiler-note';
    note.textContent = 'Spoiler-safe mode is on: this story trophy stays hidden until you earn it. Turn the setting off, or tick it earned, to read its guide.';
    card.append(note);
  } else {
    const guideTitle = document.createElement('h3');
    guideTitle.textContent = 'Guide';
    const guide = document.createElement('p');
    guide.className = 'guide-text';
    guide.textContent = trophy.guide;
    const sourcesTitle = document.createElement('h3');
    sourcesTitle.textContent = 'Sources';
    const sources = document.createElement('p');
    sources.className = 'sources-text';
    sources.textContent = trophy.sources;
    card.append(guideTitle, guide, sourcesTitle, sources);
    if (trophy.missable && trophy.missableNote) {
      const missTitle = document.createElement('h3');
      missTitle.textContent = 'When it can be missed';
      const miss = document.createElement('p');
      miss.className = 'missable-note';
      miss.textContent = trophy.missableNote;
      card.append(missTitle, miss);
    }
    if (trophy.target !== null) {
      const target = document.createElement('p');
      target.className = 'target-note';
      target.textContent = `PSN tracks this one to a count of ${trophy.target.toLocaleString('en-US')}.`;
      card.append(target);
    }
  }
  pane.append(card);
}
