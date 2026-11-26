import type { ExerciseSuggestion } from './types';
import type { AnalysisResult } from './videos';

// Client for the analyzer service in ../server (download → frames → Claude).

/** Message is written for the person using the app. */
export class AnalyzerError extends Error {}

/**
 * Where a request goes. With no address set, the analyzer is taken to be the
 * server this page was loaded from — it can serve the app as well.
 */
export function analyzerEndpoint(address: string, path: 'health' | 'analyze', pageURL: string): string {
  let base = address.trim();
  if (!base) return new URL(path, pageURL).href;
  if (!base.includes('://')) base = `http://${base}`;
  return `${base.replace(/\/+$/, '')}/${path}`;
}

/** Browsers refuse to let an https page call a plain-http address (other than this computer). */
export function isBlockedAsMixedContent(address: string, pageURL: string): boolean {
  try {
    const target = new URL(analyzerEndpoint(address, 'health', pageURL));
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(target.hostname);
    return new URL(pageURL).protocol === 'https:' && target.protocol === 'http:' && !local;
  } catch {
    return false;
  }
}

function unreachableMessage(address: string): string {
  if (isBlockedAsMixedContent(address, document.baseURI)) {
    return "This page is loaded over https, so the browser won't let it call an http analyzer. " +
      "Open the app from the analyzer's own address instead.";
  }
  return address.trim()
    ? "Couldn't reach the analyzer. Check that it's running and that the address in Settings is right."
    : "There's no analyzer at this site. Start it on your Mac and open the app from its address, or set the address in Settings.";
}

const isJSON = (response: Response) => (response.headers.get('content-type') ?? '').includes('json');

export async function isReachable(address: string): Promise<boolean> {
  try {
    const response = await fetch(analyzerEndpoint(address, 'health', document.baseURI), {
      cache: 'no-store',
      signal: AbortSignal.timeout(5000),
    });
    // A static host may answer any path with its index page; only JSON is the analyzer.
    return response.ok && isJSON(response);
  } catch {
    return false;
  }
}

const text = (value: unknown): string | null => (typeof value === 'string' && value.trim() ? value.trim() : null);

function readSuggestion(raw: unknown): ExerciseSuggestion | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const item = raw as Record<string, unknown>;
  const name = text(item.name);
  if (!name) return null;
  return {
    name,
    libraryMatch: text(item.library_match),
    muscleGroup: text(item.muscle_group),
    equipment: text(item.equipment),
    notes: text(item.notes),
    setsReps: text(item.sets_reps),
  };
}

export async function analyze(address: string, videoURL: string, knownExercises: string[]): Promise<AnalysisResult> {
  let response: Response;
  try {
    response = await fetch(analyzerEndpoint(address, 'analyze', document.baseURI), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: videoURL, known_exercises: knownExercises }),
      signal: AbortSignal.timeout(240_000), // download + frames + model call
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'TimeoutError') {
      throw new AnalyzerError('The analyzer took too long to answer. Try again.');
    }
    throw new AnalyzerError(unreachableMessage(address));
  }
  if (!isJSON(response)) throw new AnalyzerError(unreachableMessage(address));

  const body = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  if (!response.ok) {
    throw new AnalyzerError(text(body?.detail) ?? `The analyzer returned an error (${response.status}).`);
  }
  if (!body || !Array.isArray(body.exercises)) throw new AnalyzerError("The analyzer's answer couldn't be read.");
  const thumbnail = text(body.thumbnail);
  return {
    title: text(body.title),
    caption: text(body.caption),
    // Only an embedded image: a remote address could stop working, or track the viewer.
    thumbnail: thumbnail?.startsWith('data:image/') ? thumbnail : null,
    exercises: body.exercises.map(readSuggestion).filter((item) => item !== null),
  };
}
