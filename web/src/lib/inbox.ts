import { analyze, analyzerEndpoint, AnalyzerError, isReachable, modelChoice } from './analyzer';
import { uid } from './ids';
import { getState, signal, update } from './store';
import type { AppState, Settings } from './types';
import { applyAnalysis, saveVideoLink } from './videos';

// Turns pasted / shared links into saved videos and sends them to the analyzer.

/**
 * Links already sent to the analyzer since the page loaded. One that can't be
 * downloaded shouldn't be retried every time the app comes to the front.
 */
const attempted = new Set<string>();
let isSweeping = false;

/** Ids of the videos being analyzed right now. */
export const analyzing = signal<ReadonlySet<string>>(new Set());
/** Why the last analysis of a video failed, by video id. */
export const analysisErrors = signal<ReadonlyMap<string, string>>(new Map());
/** Whether the analyzer answered when last asked; null until the first check. */
export const analyzerOnline = signal<boolean | null>(null);

export async function checkAnalyzer(): Promise<boolean> {
  const online = await isReachable(getState().settings.analyzerURL);
  analyzerOnline.set(online);
  return online;
}

function setAnalyzing(videoId: string, on: boolean): void {
  const next = new Set(analyzing.get());
  if (on) next.add(videoId);
  else next.delete(videoId);
  analyzing.set(next);
}

function setError(videoId: string, message: string | null): void {
  const next = new Map(analysisErrors.get());
  if (message) next.set(videoId, message);
  else next.delete(videoId);
  analysisErrors.set(next);
}

/** Asks the analyzer which exercises are in the video and stores the answer. */
export async function analyzeVideo(videoId: string): Promise<void> {
  const state = getState();
  const video = state.videos.find((candidate) => candidate.id === videoId);
  if (!video || analyzing.get().has(videoId)) return;
  attempted.add(video.url);
  setAnalyzing(videoId, true);
  setError(videoId, null);
  try {
    const names = state.exercises.map((exercise) => exercise.name);
    const result = await analyze(state.settings.analyzerURL, video.url, names, modelChoice(state.settings));
    update((draft) => applyAnalysis(draft, videoId, result)); // does nothing if it was deleted meanwhile
    analyzerOnline.set(true);
  } catch (error) {
    setError(videoId, error instanceof AnalyzerError ? error.message : 'Something went wrong while analyzing the video.');
  } finally {
    setAnalyzing(videoId, false);
  }
}

/** Saves the link found in `raw` and returns the video's id, or null if there is no link. */
export function addVideoLink(raw: string): string | null {
  let saved: { id: string; created: boolean } | null = null;
  update((draft) => {
    saved = saveVideoLink(draft, raw);
  });
  const result = saved as { id: string; created: boolean } | null;
  if (!result) return null;
  if (result.created) {
    // Without an analyzer the link is simply kept; it is picked up by the next sweep.
    void checkAnalyzer().then((online) => (online ? analyzeVideo(result.id) : undefined));
  }
  return result.id;
}

/**
 * Analyzes saved videos that haven't been yet — typically ones added while
 * the Mac running the analyzer was out of reach.
 */
export async function analyzePending(): Promise<void> {
  if (isSweeping) return;
  const waiting = getState().videos
    .filter((video) => video.analyzedAt === null && !attempted.has(video.url))
    .sort((a, b) => a.addedAt - b.addedAt);
  if (waiting.length === 0) return;
  isSweeping = true;
  try {
    if (!(await checkAnalyzer())) return;
    for (const video of waiting) {
      const current = getState().videos.find((candidate) => candidate.id === video.id);
      if (current && current.analyzedAt === null) await analyzeVideo(video.id);
    }
  } finally {
    isSweeping = false;
  }
}

// --- links shared from other apps -----------------------------------------------
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

/** Saves the links shared since last time as videos. Returns how many were new. */
export async function collectShared(): Promise<number> {
  const address = shareAddress(getState().settings, document.baseURI);
  if (!address || isCollecting) return 0;
  isCollecting = true;
  try {
    const response = await fetch(address, { cache: 'no-store', signal: AbortSignal.timeout(5000) });
    // A static host may answer any path with its own page; only JSON is the analyzer.
    if (!response.ok || !(response.headers.get('content-type') ?? '').includes('json')) return 0;
    const body = (await response.json()) as { links?: unknown };
    const waiting = (Array.isArray(body.links) ? body.links : []).flatMap((item: unknown) => {
      const link = (typeof item === 'object' && item !== null ? item : {}) as Record<string, unknown>;
      return typeof link.id === 'string' && typeof link.url === 'string' ? [{ id: link.id, url: link.url }] : [];
    });
    if (waiting.length === 0) return 0;

    let created = 0;
    update((draft) => {
      for (const link of waiting) created += saveVideoLink(draft, link.url)?.created ? 1 : 0;
    });
    // Only now may the analyzer forget them. If this fails they come again next
    // time, and saving a link that is already there changes nothing.
    await fetch(`${address}/taken`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: waiting.map((link) => link.id) }),
      signal: AbortSignal.timeout(5000),
    });
    return created;
  } catch {
    return 0; // no analyzer within reach; the links keep waiting
  } finally {
    isCollecting = false;
  }
}

/**
 * A link handed over in the page address: `?url=…` from a bookmark or an iOS
 * Shortcut, or `?text=…&url=…` from Android's share sheet (see the manifest).
 * Returns the saved video's id.
 */
export function takeSharedLink(): string | null {
  const params = new URLSearchParams(window.location.search);
  const shared = [params.get('url'), params.get('text'), params.get('title')].filter(Boolean).join(' ');
  if (!shared) return null;
  // Drop the query so a reload doesn't add it again.
  history.replaceState(history.state, '', window.location.pathname + window.location.hash);
  return addVideoLink(shared);
}
