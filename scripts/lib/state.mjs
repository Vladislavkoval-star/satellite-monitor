import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

/**
 * State is a small JSON file committed back to the repo by the workflow.
 * It keeps consecutive-failure counts so a single blip does not alert, and
 * tracks when each host went down so recovery messages can report duration.
 */
export async function loadState(file) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return { hosts: {}, updatedAt: null };
  }
}

export async function saveState(file, state) {
  state.updatedAt = new Date().toISOString();
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(state, null, 1)}\n`, 'utf8');
}

export function emptyHostState() {
  return {
    fails: 0,
    down: false,
    downSince: null,
    lastAlertAt: null,
    lastSslAlertAt: null,
    // Why the last failing observation failed. The alert text used to be the
    // only place this existed, so reconstructing an incident meant reading
    // Telegram scrollback — and Actions logs age out. Keeping it in the state
    // file puts the cause in the same commit history as the transition.
    lastReason: null,
    lastFailureKind: null,
  };
}

export function humaniseDuration(fromIso) {
  if (!fromIso) return 'неизвестно сколько';
  const minutes = Math.max(1, Math.round((Date.now() - new Date(fromIso).getTime()) / 60000));
  if (minutes < 60) return `${minutes} мин`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} ч ${minutes % 60} мин`;
  return `${Math.floor(hours / 24)} д ${hours % 24} ч`;
}

export function hoursSince(iso) {
  if (!iso) return Infinity;
  return (Date.now() - new Date(iso).getTime()) / 3600000;
}
