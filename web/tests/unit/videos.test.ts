import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { analyze, AnalyzerError, AnalyzerUnreachable } from '../../src/lib/analyzer';
import { seedLibrary } from '../../src/lib/exercises';
import { analysisErrors, analyzePending } from '../../src/lib/identify';
import { getState, replaceState } from '../../src/lib/store';
import { emptyState } from '../../src/lib/types';
import { saveVideoLink, videoSource, webLink } from '../../src/lib/videos';

// Saved videos: where a link is from, what may become a clickable link, and
// which videos get another go at being identified.

describe('where a video is from', () => {
  it.each([
    ['https://www.instagram.com/reel/Cxyz123/', 'Instagram'], ['https://instagram.com/p/abc', 'Instagram'],
    ['https://www.tiktok.com/@someone/video/1', 'TikTok'], ['https://vm.tiktok.com/abc/', 'TikTok'],
    ['https://www.youtube.com/shorts/abcdefghijk', 'YouTube'], ['https://m.youtube.com/watch?v=abcdefghijk', 'YouTube'],
    ['https://youtu.be/abcdefghijk', 'YouTube'],
    ['https://www.facebook.com/reel/1', 'Facebook'], ['https://fb.watch/abc/', 'Facebook'],
    // A site is told by its name, not by letters its name happens to contain.
    ['https://notyoutube.example.com/clip', 'notyoutube.example.com'], ['https://youtube.com.evil.example/x', 'youtube.com.evil.example'],
    ['https://awww.example.com/clip', 'awww.example.com'], ['https://www.example.com/clip', 'example.com'],
    ['not a link', ''],
  ])('%s → %s', (link, source) => {
    expect(videoSource(link)).toBe(source);
  });
});

describe('what may become a link to tap', () => {
  it('is a web address and nothing else', () => {
    expect(webLink('https://www.youtube.com/shorts/abcdefghijk')).toBe('https://www.youtube.com/shorts/abcdefghijk');
    expect(webLink('http://example.com/a')).toBe('http://example.com/a');
    for (const link of ['javascript:alert(1)', 'JavaScript:alert(1)', 'data:text/html,<script>1</script>', 'file:///etc/passwd',
      'vbscript:x', 'gymtracker://add?url=x', 'www.youtube.com/shorts/abc', 'leg day', '', null]) {
      expect(webLink(link), String(link)).toBeNull();
    }
  });
});

describe('asking the analyzer', () => {
  const fetched = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>();
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const ANSWER = { title: 'Leg day', caption: '', thumbnail: null, exercises: [], model: 'stub' };
  let analyses = 0;

  /** An analyzer whose /analyze does what `answer` says; /health is fine unless told otherwise. */
  function analyzer(answer: () => Response | Promise<Response>, health: () => Response = () => json({ ok: true })): void {
    fetched.mockImplementation(async (url) => {
      if (url.endsWith('/health')) return health();
      analyses += 1;
      return answer();
    });
  }

  /** A fresh saved video; every test uses its own link, because what was tried is remembered until the page reloads. */
  function saved(link: string): string {
    const state = emptyState();
    seedLibrary(state);
    const id = saveVideoLink(state, link)!.id;
    replaceState(state);
    return id;
  }

  const video = () => getState().videos[0];

  beforeEach(() => {
    fetched.mockReset();
    analyses = 0;
    vi.stubGlobal('fetch', fetched);
    vi.stubGlobal('document', { baseURI: 'http://localhost:8787/' });
  });
  afterEach(() => vi.unstubAllGlobals());

  it('tells "never got there" apart from an answer that is a no', async () => {
    analyzer(() => { throw new TypeError('Failed to fetch'); });
    await expect(analyze('', 'https://youtu.be/abcdefghijk', [])).rejects.toBeInstanceOf(AnalyzerUnreachable);

    analyzer(() => new Response('<!doctype html>', { headers: { 'content-type': 'text/html' } })); // a static host's own page
    await expect(analyze('', 'https://youtu.be/abcdefghijk', [])).rejects.toBeInstanceOf(AnalyzerUnreachable);

    analyzer(() => json({ detail: "Couldn't download the video." }, 502));
    const refused = await analyze('', 'https://youtu.be/abcdefghijk', []).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(AnalyzerError);
    expect(refused).not.toBeInstanceOf(AnalyzerUnreachable);
    expect((refused as Error).message).toBe("Couldn't download the video.");

    analyzer(() => { throw new DOMException('timed out', 'TimeoutError'); });
    const slow = await analyze('', 'https://youtu.be/abcdefghijk', []).catch((error: unknown) => error);
    expect(slow).not.toBeInstanceOf(AnalyzerUnreachable); // it may well have run: not something to repeat by itself
    expect((slow as Error).message).toBe('The analyzer took too long to answer. Try again.');
  });

  it('tries a video again when the analyzer dropped out before answering', async () => {
    const id = saved('https://youtu.be/dropped0001');
    analyzer(() => { throw new TypeError('Failed to fetch'); });
    await analyzePending();
    expect(analyses).toBe(1);
    expect(video().analyzedAt).toBeNull();
    expect(analysisErrors.get().get(id)).toMatch(/Couldn't reach the analyzer|no analyzer at this site/);

    // Back in reach: the same video gets its turn without the page being reloaded.
    analyzer(() => json(ANSWER));
    await analyzePending();
    expect(analyses).toBe(2);
    expect(video().analyzedAt).not.toBeNull();
    expect(video().title).toBe('Leg day');
    expect(analysisErrors.get().has(id)).toBe(false);
  });

  it('does not keep retrying a video the analyzer said no to', async () => {
    const id = saved('https://youtu.be/refused0001');
    analyzer(() => json({ detail: "Couldn't download the video." }, 502));
    await analyzePending();
    await analyzePending();
    await analyzePending();
    expect(analyses).toBe(1); // every free-tier request counts; a link that can't be downloaded is asked about once
    expect(analysisErrors.get().get(id)).toBe("Couldn't download the video.");
  });

  it('does not repeat an analysis that timed out by itself', async () => {
    saved('https://youtu.be/tooslow0001');
    analyzer(() => { throw new DOMException('timed out', 'TimeoutError'); });
    await analyzePending();
    await analyzePending();
    expect(analyses).toBe(1);
  });

  it('asks nothing while the analyzer is away, and so has nothing to give up on', async () => {
    saved('https://youtu.be/waiting0001');
    analyzer(() => json(ANSWER), () => { throw new TypeError('Failed to fetch'); });
    await analyzePending();
    expect(analyses).toBe(0);

    analyzer(() => json(ANSWER));
    await analyzePending();
    expect(analyses).toBe(1);
    expect(video().analyzedAt).not.toBeNull();
  });
});
