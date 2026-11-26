import { MODEL_PROVIDERS } from './types';
import type { ExerciseSuggestion, ModelProvider, Settings } from './types';
import type { AnalysisResult } from './videos';

// Client for the analyzer service in ../server (download → frames → a vision model).

/** Message is written for the person using the app. */
export class AnalyzerError extends Error {}

/**
 * Where a request goes. With no address set, the analyzer is taken to be the
 * server this page was loaded from — it can serve the app as well.
 */
export function analyzerEndpoint(address: string, path: 'health' | 'analyze' | 'models', pageURL: string): string {
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
const text = (value: unknown): string | null => (typeof value === 'string' && value.trim() ? value.trim() : null);

const isProvider = (value: unknown): value is ModelProvider => (MODEL_PROVIDERS as readonly unknown[]).includes(value);

/** Which model to ask, as chosen under Settings → Video model. */
export interface ModelChoice {
  provider: ModelProvider;
  /** Empty: the service's default model. */
  model: string;
  /** Empty: the key the analyzer has for that service. */
  apiKey: string;
}

/** null when the settings leave the choice to the analyzer. */
export function modelChoice(settings: Settings): ModelChoice | null {
  const provider = settings.modelProvider;
  if (!provider) return null;
  return { provider, model: settings.models[provider].trim(), apiKey: settings.apiKeys[provider].trim() };
}

/** What an analyzer says about the model services it can use. */
export interface AnalyzerInfo {
  /** The service it uses when the app doesn't choose; null if it didn't say. */
  defaultProvider: ModelProvider | null;
  /** Empty for an analyzer from before models were selectable — it ignores the choice. */
  providers: { id: ModelProvider; defaultModel: string; hasKey: boolean }[];
}

/** null when there is no analyzer at the address. */
export async function analyzerInfo(address: string): Promise<AnalyzerInfo | null> {
  try {
    const response = await fetch(analyzerEndpoint(address, 'health', document.baseURI), {
      cache: 'no-store',
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok || !isJSON(response)) return null;
    const body = (await response.json()) as Record<string, unknown>;
    const listed = Array.isArray(body.providers) ? (body.providers as Record<string, unknown>[]) : [];
    return {
      defaultProvider: isProvider(body.default_provider) ? body.default_provider : null,
      providers: listed.flatMap((item) => (item && isProvider(item.id)
        ? [{ id: item.id, defaultModel: text(item.default_model) ?? '', hasKey: item.has_key === true }]
        : [])),
    };
  } catch {
    return null;
  }
}

export interface ModelOption {
  id: string;
  /** Name and price, for the list of suggestions. */
  label: string;
}

/** Models the analyzer suggests for a service; empty when it can't say. Any model name can still be typed. */
export async function listModels(address: string, provider: ModelProvider): Promise<ModelOption[]> {
  try {
    const url = `${analyzerEndpoint(address, 'models', document.baseURI)}?provider=${encodeURIComponent(provider)}`;
    const response = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    if (!response.ok || !isJSON(response)) return [];
    const body = (await response.json()) as Record<string, unknown>;
    if (!Array.isArray(body.models)) return [];
    return (body.models as Record<string, unknown>[]).flatMap((item) => {
      const id = item ? text(item.id) : null;
      return id ? [{ id, label: text(item.label) ?? id }] : [];
    });
  } catch {
    return [];
  }
}

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

export async function analyze(
  address: string,
  videoURL: string,
  knownExercises: string[],
  choice: ModelChoice | null = null,
): Promise<AnalysisResult> {
  // Without a choice the request is what it has always been, so any analyzer understands it.
  const request: Record<string, unknown> = { url: videoURL, known_exercises: knownExercises };
  if (choice) {
    request.provider = choice.provider;
    if (choice.model) request.model = choice.model;
    if (choice.apiKey) request.api_key = choice.apiKey;
  }
  let response: Response;
  try {
    response = await fetch(analyzerEndpoint(address, 'analyze', document.baseURI), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
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
    model: text(body.model),
  };
}
