// The analyzer (server/analyzer.py) answers with these same muscle and equipment values.
export const MUSCLE_GROUPS = [
  'chest', 'back', 'shoulders', 'biceps', 'triceps', 'forearms', 'core',
  'quads', 'hamstrings', 'glutes', 'calves', 'fullBody', 'cardio', 'other',
] as const;
export type MuscleGroup = (typeof MUSCLE_GROUPS)[number];

export const EQUIPMENT = [
  'barbell', 'dumbbell', 'machine', 'cable', 'bodyweight', 'kettlebell', 'band', 'other',
] as const;
export type Equipment = (typeof EQUIPMENT)[number];

const capitalize = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

export function muscleTitle(muscle: MuscleGroup): string {
  if (muscle === 'fullBody') return 'Full Body';
  if (muscle === 'glutes') return 'Glutes & Hips';
  return capitalize(muscle);
}

export function equipmentTitle(equipment: Equipment): string {
  return capitalize(equipment);
}

/** Leg day, push day, pull day: the part of the body a muscle belongs to, for the muscles that belong to one. */
export const BODY_REGIONS = ['push', 'pull', 'legs'] as const;
export type BodyRegion = (typeof BODY_REGIONS)[number];
export const BODY_REGION_TITLES: Record<BodyRegion, string> = { push: 'Push', pull: 'Pull', legs: 'Legs' };
export const REGION_OF: Partial<Record<MuscleGroup, BodyRegion>> = {
  quads: 'legs', hamstrings: 'legs', glutes: 'legs', calves: 'legs',
  chest: 'push', shoulders: 'push', triceps: 'push',
  back: 'pull', biceps: 'pull', forearms: 'pull',
};

export type WeightUnit = 'kg' | 'lb';
export type EffortScale = 'rpe' | 'rir';
/** Whose strength standards the ranks are measured against. */
export type RankStandards = 'men' | 'women';

/** Services whose models can name the exercises in a video; the analyzer knows the same ids. */
export const MODEL_PROVIDERS = ['anthropic', 'zai', 'openrouter', 'gemini'] as const;
export type ModelProvider = (typeof MODEL_PROVIDERS)[number];

export const MODEL_PROVIDER_TITLES: Record<ModelProvider, string> = {
  anthropic: 'Claude (Anthropic)',
  zai: 'Z.ai (GLM)',
  openrouter: 'OpenRouter',
  gemini: 'Gemini (Google)',
};

/** Services a finished workout can be sent to; the analyzer knows the same ids. */
export const EXPORT_TARGETS = ['strava', 'garmin'] as const;
export type ExportTarget = (typeof EXPORT_TARGETS)[number];

export const EXPORT_TARGET_TITLES: Record<ExportTarget, string> = { strava: 'Strava', garmin: 'Garmin Connect' };

/** Where a workout stands with one of those services. */
export interface ExportState {
  /** waiting: goes out when the analyzer can be reached. failed: needs a look before it is tried again. */
  status: 'waiting' | 'sent' | 'failed';
  /** When it was queued, sent or refused. */
  at: number;
  /** The activity's page on the service, once sent. */
  url?: string;
  /** Why it failed or is still waiting, in the analyzer's words. */
  error?: string;
}

// All times are milliseconds since the epoch.

export interface Exercise {
  id: string;
  name: string;
  muscle: MuscleGroup;
  equipment: Equipment;
  isCustom: boolean;
  notes: string;
  /** Link to the clip this exercise came from, if any. */
  videoURL: string | null;
  /** The saved video it was added from; null once that video is deleted. */
  videoId: string | null;
  /** On the to-try list — put there by a saved video or by hand — until it is done in a workout. */
  wantToTry: boolean;
  createdAt: number;
}

export interface SetEntry {
  id: string;
  /** Kilograms; null for bodyweight. */
  weight: number | null;
  reps: number | null;
  /** Effort is stored as RPE whichever scale is shown. */
  rpe: number | null;
  isWarmup: boolean;
  isDone: boolean;
}

/** One exercise performed inside one workout. */
export interface WorkoutEntry {
  id: string;
  /** null once the exercise has been deleted. */
  exerciseId: string | null;
  /** Kept so history stays readable if the exercise is later deleted. */
  exerciseName: string;
  notes: string;
  sets: SetEntry[];
  /**
   * Dumbbell exercises only: the weights were typed in for the two dumbbells
   * together. Absent means one dumbbell, which is how Strong logs them and how
   * the ranks' standards count.
   */
  bothDumbbells?: boolean;
}

export interface Workout {
  id: string;
  name: string;
  startedAt: number;
  /** null while the workout is in progress. */
  endedAt: number | null;
  notes: string;
  entries: WorkoutEntry[];
  /** Per service, once the workout has been queued for it or sent by hand. */
  exports?: Partial<Record<ExportTarget, ExportState>>;
}

export interface BodyWeight {
  id: string;
  date: number;
  kg: number;
}

/** One exercise the analyzer found in a video. */
export interface ExerciseSuggestion {
  name: string;
  /** Exact name of a library exercise when the analyzer recognised one. */
  libraryMatch: string | null;
  muscleGroup: string | null;
  equipment: string | null;
  /** Short how-to, in the analyzer's words. */
  notes: string | null;
  /** Sets × reps when the video prescribes them. */
  setsReps: string | null;
}

/** What the analyzer says about a video. */
export interface AnalysisResult {
  title: string | null;
  caption: string | null;
  thumbnail: string | null;
  exercises: ExerciseSuggestion[];
  /** The model that answered, when the analyzer says (older analyzers don't). */
  model?: string | null;
}

/** A workout clip saved from Instagram, TikTok, YouTube… */
export interface SavedVideo {
  id: string;
  url: string;
  title: string;
  caption: string;
  /** A small image as a data: URL, from the analyzer. */
  thumbnail: string | null;
  addedAt: number;
  analyzedAt: number | null;
  /** The model that named the exercises. Absent on videos analyzed before this was recorded. */
  analyzedBy?: string | null;
  /** Kept so reopening the video doesn't cost another AI call. */
  suggestions: ExerciseSuggestion[];
}

export interface Settings {
  unit: WeightUnit;
  effort: EffortScale;
  /** Empty means the analyzer is the server this page came from. */
  analyzerURL: string;
  /** Which service names the exercises in a video. Empty leaves the choice to the analyzer. */
  modelProvider: ModelProvider | '';
  /** The model to ask at each service. Empty means that service's default. */
  models: Record<ModelProvider, string>;
  /** Your own API key for each service. Kept in this browser only — a backup never contains them. */
  apiKeys: Record<ModelProvider, string>;
  /** Whether a workout is sent to each connected service as soon as it is finished. */
  autoExport: Record<ExportTarget, boolean>;
  /** Which strength standards lifts are ranked against. Empty until chosen; nothing is ranked before that. */
  rankStandards: RankStandards | '';
  /**
   * Names this browser's inbox at the analyzer, where links shared from other
   * apps wait (see inbox.ts). Made on first use; a backup never contains it,
   * or two devices would empty each other's inbox.
   */
  shareCode: string;
}

export interface AppState {
  exercises: Exercise[];
  workouts: Workout[];
  bodyWeights: BodyWeight[];
  videos: SavedVideo[];
  settings: Settings;
  /** Version of the built-in exercise list that has been added so far. */
  libraryVersion: number;
}

const perProvider = (read: (provider: ModelProvider) => string) =>
  Object.fromEntries(MODEL_PROVIDERS.map((provider) => [provider, read(provider)])) as Record<ModelProvider, string>;

export const defaultSettings = (): Settings => ({
  unit: 'kg',
  effort: 'rpe',
  analyzerURL: '',
  modelProvider: '',
  models: perProvider(() => ''),
  apiKeys: perProvider(() => ''),
  autoExport: { strava: false, garmin: false },
  rankStandards: '',
  shareCode: '',
});

/** What the analyzer accepts as an inbox code. */
export const SHARE_CODE = /^[A-Za-z0-9_-]{8,64}$/;

/**
 * Settings as they come out of storage or a backup file, made whole: anything
 * missing or of the wrong kind gets its default. Settings saved before a field
 * existed simply lack it.
 */
export function normalizeSettings(raw: unknown): Settings {
  const stored = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  const text = (value: unknown) => (typeof value === 'string' ? value : '');
  const flags = (value: unknown) => (typeof value === 'object' && value !== null ? value : {}) as Record<string, unknown>;
  const table = (value: unknown) => {
    const entries = (typeof value === 'object' && value !== null ? value : {}) as Record<string, unknown>;
    return perProvider((provider) => text(entries[provider]));
  };
  return {
    unit: stored.unit === 'lb' ? 'lb' : 'kg',
    effort: stored.effort === 'rir' ? 'rir' : 'rpe',
    analyzerURL: text(stored.analyzerURL),
    modelProvider: (MODEL_PROVIDERS as readonly unknown[]).includes(stored.modelProvider) ? (stored.modelProvider as ModelProvider) : '',
    models: table(stored.models),
    apiKeys: table(stored.apiKeys),
    autoExport: { strava: flags(stored.autoExport).strava === true, garmin: flags(stored.autoExport).garmin === true },
    rankStandards: stored.rankStandards === 'men' || stored.rankStandards === 'women' ? stored.rankStandards : '',
    shareCode: SHARE_CODE.test(text(stored.shareCode)) ? text(stored.shareCode) : '',
  };
}

export function emptyState(): AppState {
  return {
    exercises: [],
    workouts: [],
    bodyWeights: [],
    videos: [],
    settings: defaultSettings(),
    libraryVersion: 0,
  };
}
