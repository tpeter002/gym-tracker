import { analyze, AnalyzerError, analyzerOnline, AnalyzerUnreachable, checkAnalyzer, modelChoice } from './analyzer';
import { signal } from './signal';
import { getState, update } from './store';
import { applyAnalysis, saveVideoLink } from './videos';

// Saving a link as a video and having the analyzer name its exercises — now,
// or whenever the analyzer is next within reach.

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
    // Out of reach is not a verdict on the video: the next sweep may try it.
    if (error instanceof AnalyzerUnreachable) attempted.delete(video.url);
    setError(videoId, error instanceof AnalyzerError ? error.message : 'Something went wrong while analyzing the video.');
  } finally {
    setAnalyzing(videoId, false);
  }
}

/** Saves the link found in `raw` and returns the video's id, or null if there is no link. */
export function addVideoLink(raw: string): string | null {
  const result = update((draft) => saveVideoLink(draft, raw));
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

/**
 * A link handed over in the page address: `?url=…` from a bookmark, or
 * `?text=…&url=…` from Android's share sheet (see the manifest).
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
