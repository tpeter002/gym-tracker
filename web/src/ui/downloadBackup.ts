import { backupFilename, exportBackup } from '../lib/backup';
import type { AppState } from '../lib/types';

/** Hands the browser a backup file of everything in `state` to save. */
export function downloadBackup(state: AppState): void {
  const url = URL.createObjectURL(new Blob([exportBackup(state)], { type: 'application/json' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = backupFilename();
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
