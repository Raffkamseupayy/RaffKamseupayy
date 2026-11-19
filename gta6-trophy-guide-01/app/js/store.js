// Saved progress and settings, kept only in this browser's localStorage.
// Export writes a JSON file; import reads one back. Nothing leaves the device.
import { EARNED_KEY, SETTINGS_KEY } from './config.js';

export function loadEarned() {
  try {
    const raw = localStorage.getItem(EARNED_KEY);
    if (!raw) return new Set();
    const ids = JSON.parse(raw);
    if (!Array.isArray(ids)) return new Set();
    return new Set(ids.filter((n) => Number.isInteger(n)));
  } catch {
    return new Set();
  }
}

export function saveEarned(earned) {
  localStorage.setItem(EARNED_KEY, JSON.stringify([...earned].sort((a, b) => a - b)));
}

export function loadSettings() {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return { spoilers: false };
    const parsed = JSON.parse(raw);
    return { spoilers: Boolean(parsed.spoilers) };
  } catch {
    return { spoilers: false };
  }
}

export function saveSettings(settings) {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify({ spoilers: Boolean(settings.spoilers) }));
}

// Download the earned trophy ids as a JSON file.
export function exportProgress(earned) {
  const blob = new Blob([JSON.stringify({ app: 'leonida-trophy-guide', earned: [...earned].sort((a, b) => a - b) }, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'leonida-trophy-progress.json';
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// Read an exported progress file back into an earned set. Accepts the
// exported object shape ({earned: [...]}) or a bare array of ids.
export async function importProgressFile(file, validIds) {
  const text = await file.text();
  const parsed = JSON.parse(text);
  const ids = Array.isArray(parsed) ? parsed : parsed.earned;
  if (!Array.isArray(ids)) throw new Error('That file holds no earned list.');
  const valid = new Set(validIds);
  return new Set(ids.filter((n) => Number.isInteger(n) && valid.has(n)));
}
