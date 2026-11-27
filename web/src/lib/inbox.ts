import { analyzerEndpoint, askAnalyzer, postToAnalyzer } from './analyzer';
import { uid } from './ids';
import { getState, update } from './store';
import type { AppState, Settings } from './types';
import { saveVideoLink } from './videos';

// Links shared from other apps.
//
// A web page can't be listed in the iPhone share sheet, and a Shortcut can't
// hand a link to an app on the Home Screen. So a Shortcut posts the link to
// the analyzer, into an inbox only this browser reads (server/inbox.py), and
// the app collects what is waiting whenever it comes to the front.

/** Gives this browser its inbox, the first time the app runs in it. */
export function ensureShareCode(state: AppState): void {
  if (!state.settings.shareCode) state.settings.shareCode = uid();
}

/** Where a Shortcut posts shared links for this browser; null until the inbox exists. */
export function shareAddress(settings: Settings, pageURL: string): string | null {
  return settings.shareCode ? analyzerEndpoint(settings.analyzerURL, `inbox/${settings.shareCode}`, pageURL) : null;
}

let isCollecting = false;
/** The inbox is looked at every time the app comes to the front; an analyzer that is away shouldn't hold that up. */
const patience = () => ({ signal: AbortSignal.timeout(5000) });

/** Saves the links shared since last time as videos. Returns how many were new. */
export async function collectShared(): Promise<number> {
  const code = getState().settings.shareCode;
  if (!code || isCollecting) return 0;
  isCollecting = true;
  try {
    const answer = await askAnalyzer(`inbox/${code}`, patience());
    const listed = answer?.status === 200 && Array.isArray(answer.body?.links) ? answer.body.links : [];
    const waiting = listed.flatMap((item: unknown) => {
      const link = (typeof item === 'object' && item !== null ? item : {}) as Record<string, unknown>;
      return typeof link.id === 'string' && typeof link.url === 'string' ? [{ id: link.id, url: link.url }] : [];
    });
    if (waiting.length === 0) return 0;

    const created = update((draft) => waiting.filter((link) => saveVideoLink(draft, link.url)?.created).length);
    // Only now may the analyzer forget them. If it can't be told they come again
    // next time, and saving a link that is already there changes nothing.
    const told = await postToAnalyzer(`inbox/${code}/taken`, { ids: waiting.map((link) => link.id) });
    return told ? created : 0;
  } finally {
    isCollecting = false;
  }
}
