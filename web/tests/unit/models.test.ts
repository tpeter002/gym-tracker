import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { analyze, AnalyzerError, analyzerEndpoint, analyzerInfo, listModels, modelChoice } from '../../src/lib/analyzer';
import { exportBackup, parseBackup, restoreBackup } from '../../src/lib/backup';
import { defaultSettings, emptyState, normalizeSettings } from '../../src/lib/types';
import type { Settings } from '../../src/lib/types';
import { applyAnalysis, saveVideoLink } from '../../src/lib/videos';

// Choosing the model that names a video's exercises: the settings behind it,
// what goes to the analyzer, and what must never leave the browser.

const NO_KEYS = { anthropic: '', zai: '', openrouter: '', gemini: '' };

describe('model settings', () => {
  it('start with the choice left to the analyzer', () => {
    expect(defaultSettings()).toEqual({
      unit: 'kg', effort: 'rpe', analyzerURL: '', modelProvider: '', models: NO_KEYS, apiKeys: NO_KEYS,
      autoExport: { strava: false, garmin: false }, rankStandards: '', shareCode: '',
    });
    expect(modelChoice(defaultSettings())).toBeNull();
  });

  it('hand out separate objects, so one state never edits another', () => {
    const first = defaultSettings();
    first.models.zai = 'glm-5.3-flash';
    expect(defaultSettings().models.zai).toBe('');
    expect(emptyState().settings).not.toBe(emptyState().settings);
  });

  it('fill in what settings saved by an earlier version lack', () => {
    // Exactly what the app stored before models were selectable.
    const stored = { unit: 'lb', effort: 'rir', analyzerURL: 'my-mac.local:8787' };
    expect(normalizeSettings(stored)).toEqual({ ...defaultSettings(), ...stored });
  });

  it('keep a complete set of settings as it is', () => {
    const settings: Settings = {
      unit: 'lb', effort: 'rir', analyzerURL: 'http://mac.local:8787', modelProvider: 'openrouter',
      models: { anthropic: 'claude-haiku-5-5', zai: '', openrouter: 'qwen/qwen3.8-flash', gemini: 'gemini-3.5-flash-lite' },
      apiKeys: { anthropic: '', zai: 'zai-key', openrouter: 'sk-or-key', gemini: '' },
      autoExport: { strava: true, garmin: false }, rankStandards: 'women', shareCode: 'a1b2c3d4e5f6a7b8c9d0e1f2',
    };
    expect(normalizeSettings(settings)).toEqual(settings);
    expect(normalizeSettings(structuredClone(settings))).not.toBe(settings);
  });

  it('replace anything of the wrong kind with its default', () => {
    expect(normalizeSettings(undefined)).toEqual(defaultSettings());
    expect(normalizeSettings('nonsense')).toEqual(defaultSettings());
    expect(normalizeSettings({
      unit: 'stone', effort: 7, analyzerURL: null, modelProvider: 'openai',
      models: { zai: 42, openrouter: 'a/b', extra: 'ignored' }, apiKeys: 'sk-or-key',
    })).toEqual({ ...defaultSettings(), models: { ...NO_KEYS, openrouter: 'a/b' } });
  });

  it('turn into the choice sent to the analyzer', () => {
    const settings = defaultSettings();
    settings.modelProvider = 'zai';
    expect(modelChoice(settings)).toEqual({ provider: 'zai', model: '', apiKey: '' });

    settings.models.zai = ' glm-5.3-flash ';
    settings.apiKeys.zai = ' zai-key\n';
    settings.models.openrouter = 'not this one';
    settings.apiKeys.openrouter = 'nor this key';
    expect(modelChoice(settings)).toEqual({ provider: 'zai', model: 'glm-5.3-flash', apiKey: 'zai-key' });
  });
});

describe('API keys and backups', () => {
  function withKeys() {
    const state = emptyState();
    state.settings.modelProvider = 'openrouter';
    state.settings.models.openrouter = 'qwen/qwen3.8-flash';
    state.settings.apiKeys = { anthropic: 'sk-ant-SECRET', zai: 'zai-SECRET', openrouter: 'sk-or-SECRET', gemini: 'AIza-SECRET' };
    return state;
  }

  it('a backup holds the model choice but no key', () => {
    const state = withKeys();
    const file = exportBackup(state, 1234);
    expect(file).not.toContain('SECRET');
    expect(state.settings.apiKeys.zai).toBe('zai-SECRET'); // exporting doesn't touch what is in the app

    const restored = parseBackup(file).state.settings;
    expect(restored).toEqual({ ...state.settings, apiKeys: NO_KEYS });
  });

  it('a key written into a backup file by hand is not taken', () => {
    const file = JSON.parse(exportBackup(withKeys(), 1234));
    file.data.settings.apiKeys = { zai: 'planted' };
    expect(parseBackup(JSON.stringify(file)).state.settings.apiKeys).toEqual(NO_KEYS);
  });

  it('restoring keeps the keys already in this browser', () => {
    const current = withKeys();
    const other = emptyState();
    other.settings.unit = 'lb';
    other.settings.modelProvider = 'zai';
    saveVideoLink(other, 'https://www.youtube.com/shorts/abcdefghijk');

    const restored = restoreBackup(current, parseBackup(exportBackup(other)));

    expect(restored.settings).toEqual({ ...other.settings, apiKeys: current.settings.apiKeys });
    expect(restored.videos).toEqual(other.videos);
    expect(current.settings.modelProvider).toBe('openrouter'); // the state being replaced is left alone
  });

  it('a backup from before models were selectable still restores', () => {
    const state = emptyState();
    saveVideoLink(state, 'https://www.youtube.com/shorts/abcdefghijk');
    const file = JSON.parse(exportBackup(state, 1234));
    file.data.settings = { unit: 'lb', effort: 'rir', analyzerURL: 'my-mac.local:8787' };
    delete file.data.videos[0].analyzedBy;

    const restored = parseBackup(JSON.stringify(file)).state;

    expect(restored.settings).toEqual({ ...defaultSettings(), unit: 'lb', effort: 'rir', analyzerURL: 'my-mac.local:8787' });
    expect(restored.videos[0]).toMatchObject({ url: 'https://www.youtube.com/shorts/abcdefghijk', analyzedBy: null });
  });
});

describe('which model identified a video', () => {
  const result = { title: 'Rows', caption: null, thumbnail: null, exercises: [] };

  it('is remembered with the video and survives a backup', () => {
    const state = emptyState();
    const { id } = saveVideoLink(state, 'https://www.youtube.com/shorts/abcdefghijk')!;
    expect(state.videos[0].analyzedBy).toBeNull();

    applyAnalysis(state, id, { ...result, model: 'glm-4.6v-flash' }, 1000);
    expect(state.videos[0]).toMatchObject({ analyzedAt: 1000, analyzedBy: 'glm-4.6v-flash' });
    expect(parseBackup(exportBackup(state)).state.videos[0].analyzedBy).toBe('glm-4.6v-flash');

    applyAnalysis(state, id, { ...result, model: 'claude-opus-5-5' }, 2000);
    expect(state.videos[0].analyzedBy).toBe('claude-opus-5-5');
  });

  it('is cleared when a later answer does not say', () => {
    const state = emptyState();
    const { id } = saveVideoLink(state, 'https://www.youtube.com/shorts/abcdefghijk')!;
    applyAnalysis(state, id, { ...result, model: 'glm-4.6v-flash' }, 1000);
    applyAnalysis(state, id, result, 2000); // an analyzer from before models were selectable
    expect(state.videos[0].analyzedBy).toBeNull();
  });
});

describe('talking to the analyzer', () => {
  const PAGE = 'http://localhost:8787/';
  const fetched = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>();
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const sentBody = () => JSON.parse(fetched.mock.calls.at(-1)![1]!.body as string) as Record<string, unknown>;
  const answer = { title: 'Rows', caption: 'Pull day', thumbnail: 'data:image/jpeg;base64,AAAA', exercises: [{ name: 'Pull Up' }] };

  beforeEach(() => {
    fetched.mockReset();
    vi.stubGlobal('fetch', fetched);
    vi.stubGlobal('document', { baseURI: PAGE });
  });
  afterEach(() => vi.unstubAllGlobals());

  it('sends exactly the old request when no model is chosen', async () => {
    fetched.mockResolvedValue(json(answer));

    const result = await analyze('', 'https://youtu.be/abc', ['Pull Up']);

    expect(fetched.mock.calls[0][0]).toBe('http://localhost:8787/analyze');
    expect(fetched.mock.calls[0][1]).toMatchObject({ method: 'POST', headers: { 'Content-Type': 'application/json' } });
    expect(sentBody()).toEqual({ url: 'https://youtu.be/abc', known_exercises: ['Pull Up'] });
    // An answer without a model name — from an older analyzer — reads as before.
    expect(result).toEqual({
      title: 'Rows', caption: 'Pull day', thumbnail: 'data:image/jpeg;base64,AAAA', model: null,
      exercises: [{ name: 'Pull Up', libraryMatch: null, muscleGroup: null, equipment: null, notes: null, setsReps: null }],
    });
  });

  it('sends the service, and the model and key only when they are set', async () => {
    fetched.mockImplementation(async () => json({ ...answer, provider: 'zai', model: 'glm-5.3-flash' }));

    await analyze('', 'https://youtu.be/abc', [], { provider: 'zai', model: '', apiKey: '' });
    expect(sentBody()).toEqual({ url: 'https://youtu.be/abc', known_exercises: [], provider: 'zai' });

    const result = await analyze('mac.local:8787', 'https://youtu.be/abc', [], { provider: 'zai', model: 'glm-5.3-flash', apiKey: 'zai-key' });
    expect(fetched.mock.calls.at(-1)![0]).toBe('http://mac.local:8787/analyze');
    expect(sentBody()).toEqual({
      url: 'https://youtu.be/abc', known_exercises: [], provider: 'zai', model: 'glm-5.3-flash', api_key: 'zai-key',
    });
    expect(result.model).toBe('glm-5.3-flash');
  });

  it("passes on the analyzer's explanation when the model call fails", async () => {
    fetched.mockResolvedValue(json({ detail: 'Z.ai rejected your API key — check it in the app under Settings → Video model.' }, 401));
    await expect(analyze('', 'https://youtu.be/abc', [], { provider: 'zai', model: '', apiKey: 'bad' }))
      .rejects.toThrow(new AnalyzerError('Z.ai rejected your API key — check it in the app under Settings → Video model.'));
  });

  it('builds the address of the model list like the others', () => {
    expect(analyzerEndpoint('', 'models', 'https://example.org/gym/#/settings')).toBe('https://example.org/gym/models');
    expect(analyzerEndpoint('my-mac.local:8787/', 'models', PAGE)).toBe('http://my-mac.local:8787/models');
  });

  it('reads which services an analyzer can use', async () => {
    fetched.mockResolvedValue(json({
      ok: true, default_provider: 'zai',
      providers: [
        { id: 'anthropic', label: 'Anthropic', default_model: 'claude-opus-5-5', has_key: false },
        { id: 'zai', label: 'Z.ai', default_model: 'glm-4.6v-flash', has_key: true },
        { id: 'mistral', label: 'Not known to this app', default_model: 'x', has_key: true },
        null,
      ],
    }));

    expect(await analyzerInfo('')).toEqual({
      defaultProvider: 'zai',
      providers: [
        { id: 'anthropic', defaultModel: 'claude-opus-5-5', hasKey: false },
        { id: 'zai', defaultModel: 'glm-4.6v-flash', hasKey: true },
      ],
    });
    expect(fetched.mock.calls[0][0]).toBe('http://localhost:8787/health');
  });

  it('recognises an analyzer from before models were selectable', async () => {
    fetched.mockResolvedValue(json({ ok: true }));
    expect(await analyzerInfo('')).toEqual({ defaultProvider: null, providers: [] });
  });

  it('reports no analyzer when the address answers with something else', async () => {
    fetched.mockResolvedValue(new Response('<!doctype html>', { headers: { 'content-type': 'text/html' } }));
    expect(await analyzerInfo('')).toBeNull();
    fetched.mockRejectedValue(new TypeError('Failed to fetch'));
    expect(await analyzerInfo('')).toBeNull();
  });

  it('lists the models an analyzer suggests for a service', async () => {
    fetched.mockResolvedValue(json({
      provider: 'openrouter', default_model: 'openrouter/free',
      models: [{ id: 'openrouter/free', label: 'Free Models Router — free' }, { id: 'a/b' }, { label: 'no id' }, null],
    }));

    expect(await listModels('', 'openrouter')).toEqual([
      { id: 'openrouter/free', label: 'Free Models Router — free' },
      { id: 'a/b', label: 'a/b' },
    ]);
    expect(fetched.mock.calls[0][0]).toBe('http://localhost:8787/models?provider=openrouter');
  });

  it('has no suggestions when the analyzer cannot give any', async () => {
    fetched.mockResolvedValue(json({ detail: 'Not Found' }, 404)); // an older analyzer
    expect(await listModels('', 'zai')).toEqual([]);
    fetched.mockResolvedValue(new Response('<!doctype html>', { headers: { 'content-type': 'text/html' } })); // a static host
    expect(await listModels('', 'zai')).toEqual([]);
    fetched.mockRejectedValue(new TypeError('Failed to fetch'));
    expect(await listModels('', 'zai')).toEqual([]);
  });
});
