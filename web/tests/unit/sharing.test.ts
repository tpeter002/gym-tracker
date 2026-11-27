import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { exportBackup, parseBackup, restoreBackup } from '../../src/lib/backup';
import { collectShared, ensureShareCode, shareAddress } from '../../src/lib/inbox';
import { getState, replaceState } from '../../src/lib/store';
import { defaultSettings, emptyState, normalizeSettings, SHARE_CODE } from '../../src/lib/types';

// Links shared from other apps: the inbox each browser has at the analyzer,
// and collecting what a Shortcut left there.

const CODE = 'a1b2c3d4e5f6a7b8c9d0e1f2';
const REEL = 'https://www.instagram.com/reel/DfBev3RTD5k/';

describe("this browser's inbox", () => {
  it('gets its code once, and keeps it', () => {
    const state = emptyState();
    expect(state.settings.shareCode).toBe('');
    ensureShareCode(state);
    const code = state.settings.shareCode;
    expect(code).toMatch(SHARE_CODE);
    ensureShareCode(state);
    expect(state.settings.shareCode).toBe(code);
  });

  it('differs from one browser to the next', () => {
    const codes = new Set(Array.from({ length: 50 }, () => {
      const state = emptyState();
      ensureShareCode(state);
      return state.settings.shareCode;
    }));
    expect(codes.size).toBe(50);
  });

  it('survives storage, and anything that is not a code reads as none', () => {
    expect(normalizeSettings({ shareCode: CODE }).shareCode).toBe(CODE);
    for (const stored of [undefined, 42, '', 'short', 'has spaces in it!', '../../etc/passwd', 'x'.repeat(65)]) {
      expect(normalizeSettings({ shareCode: stored }).shareCode).toBe('');
    }
  });

  it('has its address at the analyzer the page came from, or at the one set in Settings', () => {
    const settings = { ...defaultSettings(), shareCode: CODE };
    expect(shareAddress(settings, 'http://192.168.1.20:8787/#/settings')).toBe(`http://192.168.1.20:8787/inbox/${CODE}`);
    expect(shareAddress(settings, 'https://me.example/gym/')).toBe(`https://me.example/gym/inbox/${CODE}`);
    expect(shareAddress({ ...settings, analyzerURL: 'my-mac.local:8787/' }, 'https://me.example/gym/')).toBe(`http://my-mac.local:8787/inbox/${CODE}`);
    expect(shareAddress(defaultSettings(), 'http://192.168.1.20:8787/')).toBeNull();
  });
});

describe('a backup', () => {
  const withCode = (code: string) => {
    const state = emptyState();
    state.settings.shareCode = code;
    state.settings.unit = 'lb';
    return state;
  };

  it('never contains the code', () => {
    const state = withCode(CODE);
    const file = exportBackup(state);
    expect(file).not.toContain(CODE);
    expect(parseBackup(file).state.settings.shareCode).toBe('');
    expect(state.settings.shareCode).toBe(CODE); // exporting doesn't touch what is in the app
  });

  it('cannot plant one', () => {
    const file = JSON.parse(exportBackup(withCode(CODE))) as { data: { settings: Record<string, unknown> } };
    file.data.settings.shareCode = 'planted-by-a-file';
    expect(parseBackup(JSON.stringify(file)).state.settings.shareCode).toBe('');
  });

  it("restores everything else and leaves this browser's code in place", () => {
    const backup = parseBackup(exportBackup(withCode('code-of-the-other-device')));
    const restored = restoreBackup(withCode(CODE), backup);
    expect(restored.settings.shareCode).toBe(CODE);
    expect(restored.settings.unit).toBe('lb');
  });
});

describe('collecting shared links', () => {
  const fetched = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>();
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const INBOX = `http://localhost:8787/inbox/${CODE}`;
  const taken = () => fetched.mock.calls
    .filter(([url, init]) => url === `${INBOX}/taken` && init?.method === 'POST')
    .map(([, init]) => JSON.parse(String(init!.body)) as { ids: string[] });
  const urls = () => getState().videos.map((video) => video.url);

  /** An analyzer with these links waiting. */
  function waiting(links: unknown, takenAnswer: () => Response = () => json({ links: [] })): void {
    fetched.mockImplementation(async (url, init) => {
      if (url === INBOX && !init?.method) return json({ links });
      if (url === `${INBOX}/taken`) return takenAnswer();
      throw new TypeError('Failed to fetch');
    });
  }

  beforeEach(() => {
    fetched.mockReset();
    vi.stubGlobal('fetch', fetched);
    vi.stubGlobal('document', { baseURI: 'http://localhost:8787/' });
    const state = emptyState();
    state.settings.shareCode = CODE;
    replaceState(state);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('saves each waiting link as a video, then tells the analyzer they were taken', async () => {
    waiting([
      { id: 'one', url: `${REEL}?igsh=MTE2eXUz`, added_at: 1 },
      { id: 'two', url: 'https://youtube.com/shorts/abc123', added_at: 2 },
    ]);

    expect(await collectShared()).toBe(2);

    // Saved the way a pasted link is: without the per-share tracking parameter, not yet identified.
    expect(urls()).toEqual([REEL, 'https://youtube.com/shorts/abc123']);
    expect(getState().videos.every((video) => video.analyzedAt === null)).toBe(true);
    expect(taken()).toEqual([{ ids: ['one', 'two'] }]);
  });

  it('asks only for the inbox of this browser', async () => {
    waiting([]);
    await collectShared();
    expect(fetched.mock.calls.map(([url]) => url)).toEqual([INBOX]);
  });

  it('does not save a video a second time, but still clears it from the inbox', async () => {
    waiting([{ id: 'one', url: REEL }]);
    await collectShared();
    waiting([{ id: 'again', url: `${REEL}?igsh=other` }]);

    expect(await collectShared()).toBe(0);

    expect(urls()).toEqual([REEL]);
    expect(taken().at(-1)).toEqual({ ids: ['again'] });
  });

  it('keeps the videos when the analyzer cannot be told, and survives getting them again', async () => {
    waiting([{ id: 'one', url: REEL }], () => { throw new TypeError('Failed to fetch'); });
    expect(await collectShared()).toBe(0); // reported as nothing, but nothing is lost
    expect(urls()).toEqual([REEL]);

    waiting([{ id: 'one', url: REEL }]);
    expect(await collectShared()).toBe(0);
    expect(urls()).toEqual([REEL]);
    expect(taken().at(-1)).toEqual({ ids: ['one'] });
  });

  it('does nothing when nothing waits, and never tells the analyzer about nothing', async () => {
    waiting([]);
    expect(await collectShared()).toBe(0);
    expect(urls()).toEqual([]);
    expect(taken()).toEqual([]);
  });

  it('ignores entries it cannot read and takes the rest', async () => {
    waiting([null, 'text', { id: 7, url: REEL }, { id: 'no-url' }, { id: 'not-a-link', url: 'leg day' }, { id: 'good', url: REEL }]);
    expect(await collectShared()).toBe(1);
    expect(urls()).toEqual([REEL]);
    // The unreadable-but-complete entry is cleared too, or it would come back forever.
    expect(taken()).toEqual([{ ids: ['not-a-link', 'good'] }]);
  });

  it.each([
    ['no analyzer in reach', async () => { throw new TypeError('Failed to fetch'); }],
    ['a static host answering with its own page', async () => new Response('<!doctype html>', { status: 200, headers: { 'content-type': 'text/html' } })],
    ['an analyzer from before inboxes existed', async () => json({ detail: 'Not Found' }, 404)],
    ['an answer that is not what was expected', async () => json({ links: 'none' })],
    ['an answer that is not JSON after all', async () => new Response('{oops', { status: 200, headers: { 'content-type': 'application/json' } })],
  ])('is quiet with %s', async (_, answer) => {
    fetched.mockImplementation(answer);
    expect(await collectShared()).toBe(0);
    expect(urls()).toEqual([]);
    expect(fetched).toHaveBeenCalledTimes(1);
  });

  it('asks nothing before the browser has its inbox', async () => {
    replaceState(emptyState());
    expect(await collectShared()).toBe(0);
    expect(fetched).not.toHaveBeenCalled();
  });

  it('runs once at a time', async () => {
    let release!: (response: Response) => void;
    fetched.mockImplementationOnce(() => new Promise<Response>((resolve) => { release = resolve; }));
    const first = collectShared();
    expect(await collectShared()).toBe(0); // the second call steps aside
    release(json({ links: [] }));
    await first;
    expect(fetched).toHaveBeenCalledTimes(1);
  });
});
