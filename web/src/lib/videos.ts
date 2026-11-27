import { findByName, guessMuscle, newExercise, normalizeName } from './exercises';
import { uid } from './ids';
import { EQUIPMENT, MUSCLE_GROUPS } from './types';
import type { AnalysisResult, AppState, Equipment, Exercise, ExerciseSuggestion, MuscleGroup, SavedVideo } from './types';

/**
 * First http(s) link in a piece of shared or pasted text. Apps like TikTok
 * share "Check this out! https://…" rather than a bare link.
 */
export function firstURL(text: string): URL | null {
  for (const [candidate] of text.matchAll(/https?:\/\/[^\s<>"']+/gi)) {
    try {
      return new URL(candidate.replace(/[.,;:!?)\]}]+$/, ''));
    } catch {
      // not a link after all; try the next one
    }
  }
  return null;
}

/**
 * Share links carry per-share tracking parameters (`igsh`, `si`, `utm_*`…);
 * dropping them keeps the same clip from being saved twice.
 */
export function canonicalLink(url: URL): string {
  const result = new URL(url.href);
  const keep = new Set(['v', 'list', 't']);
  for (const name of [...result.searchParams.keys()]) {
    if (!keep.has(name)) result.searchParams.delete(name);
  }
  result.hash = '';
  return result.href;
}

/** The link if it is a web address, otherwise null — typed-in links end up as hrefs. */
export function webLink(link: string | null): string | null {
  if (!link) return null;
  try {
    return ['http:', 'https:'].includes(new URL(link).protocol) ? link : null;
  } catch {
    return null;
  }
}

function hostOf(link: string): string {
  try {
    return new URL(link).hostname.toLowerCase();
  } catch {
    return '';
  }
}

export function videoSource(link: string): string {
  const host = hostOf(link).replace(/^(www|m)\./, '');
  const isAt = (...sites: string[]) => sites.some((site) => host === site || host.endsWith(`.${site}`));
  if (isAt('instagram.com')) return 'Instagram';
  if (isAt('tiktok.com')) return 'TikTok';
  if (isAt('youtube.com', 'youtu.be')) return 'YouTube';
  if (isAt('facebook.com', 'fb.watch')) return 'Facebook';
  return host;
}

export const videoTitle = (video: SavedVideo) => video.title || `${videoSource(video.url)} video`;

/** YouTube serves a still for any video id; other sites only get one from the analyzer. */
export function youtubeThumbnail(link: string): string | null {
  let url: URL;
  try {
    url = new URL(link);
  } catch {
    return null;
  }
  const host = url.hostname.replace(/^(www|m)\./, '');
  let id: string | null = null;
  if (host === 'youtu.be') id = url.pathname.split('/')[1] ?? null;
  else if (host === 'youtube.com') {
    const [, kind, value] = url.pathname.split('/');
    id = kind === 'watch' ? url.searchParams.get('v') : ['shorts', 'embed', 'live'].includes(kind) ? value : null;
  }
  return id && /^[\w-]{6,}$/.test(id) ? `https://i.ytimg.com/vi/${id}/hqdefault.jpg` : null;
}

export const exercisesFrom = (state: AppState, videoId: string) =>
  state.exercises.filter((exercise) => exercise.videoId === videoId);

/** Saves the link in `raw`, or finds the video already saved for it. */
export function saveVideoLink(state: AppState, raw: string): { id: string; created: boolean } | null {
  const url = firstURL(raw);
  if (!url) return null;
  const link = canonicalLink(url);
  const existing = state.videos.find((video) => video.url === link);
  if (existing) return { id: existing.id, created: false };
  const video: SavedVideo = {
    id: uid(), url: link, title: '', caption: '', thumbnail: null,
    addedAt: Date.now(), analyzedAt: null, analyzedBy: null, suggestions: [],
  };
  state.videos.push(video);
  return { id: video.id, created: true };
}

/** Exercises added from it stay on the list; they only lose their way back to it. */
export function deleteVideo(state: AppState, videoId: string): void {
  state.videos = state.videos.filter((video) => video.id !== videoId);
  for (const exercise of state.exercises) {
    if (exercise.videoId === videoId) exercise.videoId = null;
  }
}

export const resolvedName = (suggestion: ExerciseSuggestion) => suggestion.libraryMatch ?? suggestion.name;

export function linkExercise(exercise: Exercise, video: SavedVideo): void {
  exercise.videoId = video.id;
  exercise.videoURL = video.url;
  exercise.wantToTry = true;
}

export function linkExerciseById(state: AppState, exerciseId: string, videoId: string): void {
  const exercise = state.exercises.find((candidate) => candidate.id === exerciseId);
  const video = state.videos.find((candidate) => candidate.id === videoId);
  if (exercise && video) linkExercise(exercise, video);
}

export function unlinkExercise(state: AppState, exerciseId: string, videoId: string): void {
  const exercise = state.exercises.find((candidate) => candidate.id === exerciseId);
  const video = state.videos.find((candidate) => candidate.id === videoId);
  if (!exercise) return;
  exercise.videoId = null;
  exercise.wantToTry = false;
  if (video && exercise.videoURL === video.url) exercise.videoURL = null;
}

const oneOf = <T extends string>(values: readonly T[], value: string | null): T | null =>
  (values as readonly string[]).includes(value ?? '') ? (value as T) : null;

/**
 * Puts a suggestion on the to-try list, reusing a library exercise when the
 * name matches and creating a custom one otherwise.
 */
export function adoptSuggestion(state: AppState, suggestion: ExerciseSuggestion, videoId: string): void {
  const video = state.videos.find((candidate) => candidate.id === videoId);
  if (!video) return;
  let exercise = findByName(state, resolvedName(suggestion));
  if (!exercise) {
    exercise = newExercise(
      suggestion.name,
      oneOf<MuscleGroup>(MUSCLE_GROUPS, suggestion.muscleGroup) ?? guessMuscle(suggestion.name),
      oneOf<Equipment>(EQUIPMENT, suggestion.equipment) ?? 'other',
      true,
    );
    state.exercises.push(exercise);
  }
  linkExercise(exercise, video);
  if (!exercise.notes) {
    const lines: string[] = [];
    if (suggestion.notes) lines.push(suggestion.notes);
    if (suggestion.setsReps) lines.push(`From the video: ${suggestion.setsReps}`);
    exercise.notes = lines.join('\n');
  }
}

/**
 * Stores what the analyzer found. The first result goes straight onto the
 * to-try list — the point is not having to come back to the video. Later
 * runs only refresh the suggestions, so exercises you removed stay removed.
 */
export function applyAnalysis(state: AppState, videoId: string, result: AnalysisResult, now = Date.now()): void {
  const video = state.videos.find((candidate) => candidate.id === videoId);
  if (!video) return;
  const isFirstResult = video.analyzedAt === null;
  video.suggestions = result.exercises;
  video.analyzedAt = now;
  video.analyzedBy = result.model ?? null;
  if (isFirstResult) {
    for (const suggestion of result.exercises) adoptSuggestion(state, suggestion, videoId);
  }
  if (result.caption) video.caption = result.caption;
  if (result.title && !video.title) video.title = result.title;
  if (result.thumbnail && !video.thumbnail) video.thumbnail = result.thumbnail;
}

/** Suggestions that aren't on the list yet. */
export function pendingSuggestions(state: AppState, video: SavedVideo): ExerciseSuggestion[] {
  const added = new Set(exercisesFrom(state, video.id).map((exercise) => normalizeName(exercise.name)));
  return video.suggestions.filter((suggestion) =>
    !added.has(normalizeName(resolvedName(suggestion))) && !added.has(normalizeName(suggestion.name)));
}
