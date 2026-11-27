import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { CANNED_ANALYSIS, escapeRegExp, mockAnalyzer, mockInbox, seed } from './helpers';

// Videos shared from other apps: a Shortcut leaves the link in this browser's
// inbox at the analyzer, and the app collects it the next time it is open.

const REEL = 'https://www.instagram.com/reel/Cxyz123/';

const shareAddress = (page: Page) => page.getByLabel('Share address');
/** What happens when the app is brought back to the front. */
const comeBack = (page: Page) => page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));

test('a video shared from another app is saved and identified when the app opens', async ({ page }) => {
  const analyses = await mockAnalyzer(page, 200, CANNED_ANALYSIS);
  const inbox = await mockInbox(page, [`${REEL}?igsh=abc123`]);

  await page.goto('/#/');

  // Without a tap: the video is there, named, and its exercises wait on the to-try list.
  const toTry = page.getByRole('region', { name: 'To try' });
  await expect(toTry.getByRole('link', { name: /Saved Videos\s*1/ })).toBeVisible();
  await expect(toTry.getByRole('link', { name: /Face Pull \(Cable\)/ })).toBeVisible();
  await expect(toTry.getByRole('link', { name: /Half-Kneeling Cable Y Raise/ })).toBeVisible();
  await toTry.getByRole('link', { name: /Saved Videos/ }).click();
  await expect(page.getByRole('link', { name: /3 cable moves for rear delts/ })).toBeVisible();

  // The analyzer was told the link was taken, and was asked to identify it once, without the share parameter.
  expect(inbox.taken).toEqual([['link-1']]);
  expect(analyses).toHaveLength(1);
  expect(JSON.parse(analyses[0]).url).toBe(REEL);

  // Opening the app again finds nothing new and asks for nothing more.
  await page.reload();
  await expect(page.getByRole('link', { name: /3 cable moves for rear delts/ })).toBeVisible();
  await expect.poll(() => inbox.asked.length).toBeGreaterThan(1);
  await page.waitForLoadState('networkidle'); // whatever it was going to ask for, it has asked by now
  expect(inbox.taken).toHaveLength(1);
  expect(analyses).toHaveLength(1);
});

test('what is shared while the app is in the background is there when it comes back', async ({ page }) => {
  await mockAnalyzer(page, 200, CANNED_ANALYSIS);
  const inbox = await mockInbox(page);
  await page.goto('/#/videos');
  await expect(page.getByText('No Saved Videos')).toBeVisible();
  await expect.poll(() => inbox.asked.length).toBe(1);

  inbox.links.push({ id: 'from-instagram', url: REEL, added_at: Date.now() });
  // Coming back while the first look at the inbox is still being finished off does nothing, as it should; come back again.
  await expect(async () => {
    await comeBack(page);
    await expect(page.getByRole('link', { name: /3 cable moves for rear delts/ })).toBeVisible({ timeout: 1000 });
  }).toPass();
  expect(inbox.taken).toEqual([['from-instagram']]);
});

test('a shared video is kept when the analyzer cannot identify it', async ({ page }) => {
  const analyses = await mockAnalyzer(page, 502, { detail: "Couldn't download that video." });
  const inbox = await mockInbox(page, [REEL]);
  await page.goto('/#/videos');
  await page.getByRole('link', { name: /Instagram video/ }).click();
  // The analysis has been tried and has failed…
  await expect(page.getByText("Couldn't download that video.")).toBeVisible();
  // …and the video is still there, taken from the inbox, asked about once.
  await page.goto('/#/videos');
  await expect(page.getByRole('link', { name: /Instagram video/ })).toBeVisible();
  expect(analyses).toHaveLength(1);
  expect(inbox.taken).toEqual([['link-1']]);
});

test("Settings shows this browser's own address, and it stays the same", async ({ page, context, browserName, baseURL }) => {
  const inbox = await mockInbox(page);
  await page.goto('/#/settings');

  await expect(shareAddress(page)).toHaveValue(new RegExp(`^${escapeRegExp(baseURL!)}/inbox/[0-9a-f]{24}$`));
  const address = await shareAddress(page).inputValue();
  // It is the inbox the app itself asks for.
  await expect.poll(() => inbox.asked).toContain(new URL(address).pathname);
  await expect(page.getByText('Get Contents of URL')).toBeVisible();

  await page.reload();
  await expect(shareAddress(page)).toHaveValue(address);

  // Restoring a backup replaces the data but not this browser's inbox.
  await seed(page);
  await expect(shareAddress(page)).toHaveValue(address);

  // With an analyzer address entered, that is where the Shortcut must post.
  await page.getByLabel('Analyzer address').fill('my-mac.local:8787');
  await expect(shareAddress(page)).toHaveValue(`http://my-mac.local:8787${new URL(address).pathname}`);
  await page.getByLabel('Analyzer address').fill('');

  if (browserName === 'chromium') await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.getByRole('button', { name: 'Copy Address' }).click();
  await expect(page.getByText('Copied')).toBeVisible();
  // Only Chromium lets a test read the clipboard back.
  if (browserName === 'chromium') expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(address);
});

test('two browsers get two different inboxes', async ({ page, browser }) => {
  await page.goto('/#/settings');
  const other = await (await browser.newContext()).newPage(); // gets the configured address, like the first
  await other.goto('/#/settings');
  const [mine, theirs] = [await shareAddress(page).inputValue(), await shareAddress(other).inputValue()];
  expect(mine).toMatch(/\/inbox\/[0-9a-f]{24}$/);
  expect(theirs).toMatch(/\/inbox\/[0-9a-f]{24}$/);
  expect(mine).not.toBe(theirs);
  await other.context().close();
});

test('copying works where the browser offers no clipboard, as on the plain http address of a Mac', async ({ page, context, browserName }) => {
  test.skip(browserName !== 'chromium', 'only Chromium lets a test read the clipboard back');
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.addInitScript(() => {
    navigator.clipboard.writeText = () => Promise.reject(new DOMException('Not allowed', 'NotAllowedError'));
  });
  await page.goto('/#/settings');
  const address = await shareAddress(page).inputValue();

  await page.getByRole('button', { name: 'Copy Address' }).click();

  await expect(page.getByText('Copied')).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(address);
});
