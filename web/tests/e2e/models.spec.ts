import { readFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { CANNED_ANALYSIS, mockAnalyzer, mockModelAnalyzer, saveVideo } from './helpers';

// Settings → Video model: which service and model name a video's exercises,
// and whose API key is used.

const LINK = 'https://www.youtube.com/shorts/abcdefghijk';

const service = (page: Page) => page.getByLabel('Service');
const model = (page: Page) => page.getByRole('combobox', { name: 'Model' });
const apiKey = (page: Page) => page.getByLabel('API key');

test('until you pick a service, the request is the one every analyzer understands', async ({ page }) => {
  const requests = await mockModelAnalyzer(page);
  await page.goto('/#/settings');
  await expect(service(page)).toHaveValue('');
  await expect(service(page).locator('option')).toHaveText(['Analyzer’s choice', 'Claude (Anthropic)', 'Z.ai (GLM)', 'OpenRouter']);
  await expect(model(page)).toHaveCount(0);
  await expect(apiKey(page)).toHaveCount(0);

  await saveVideo(page, LINK);
  await expect(page.getByRole('main').getByRole('link', { name: /Face Pull \(Cable\)/ })).toBeVisible();

  expect(requests).toHaveLength(1);
  expect(Object.keys(requests[0]).sort()).toEqual(['known_exercises', 'url']);
  // The analyzer says which model it used, and the video remembers.
  await expect(page.getByText('Identified by claude-opus-5-5.')).toBeVisible();
});

test('pick a service, a model and a key of your own', async ({ page }) => {
  const requests = await mockModelAnalyzer(page);
  await page.goto('/#/settings');

  await service(page).selectOption({ label: 'Z.ai (GLM)' });
  // This analyzer has no Z.ai key, so the app says one is needed.
  await expect(page.getByText('The analyzer has no key for Z.ai (GLM), so it needs yours.')).toBeVisible();
  await expect(model(page)).toHaveAttribute('placeholder', 'Default: glm-4.6v-flash');
  await expect(apiKey(page)).toHaveAttribute('placeholder', 'Your own Z.ai (GLM) key');
  await expect(apiKey(page)).toHaveAttribute('type', 'password');
  // The analyzer's suggestions back the model field; any other name can be typed.
  const suggestions = page.locator('#model-suggestions option');
  await expect(suggestions).toHaveCount(2);
  expect(await suggestions.evaluateAll((options) => options.map((option) => (option as HTMLOptionElement).value)))
    .toEqual(['glm-4.6v-flash', 'glm-5.3-flash']);

  await model(page).fill('glm-5.3-flash');
  await apiKey(page).fill('zai-test-key');
  await expect(page.getByText(/so it needs yours/)).toHaveCount(0);

  // Each service keeps its own model and key.
  await service(page).selectOption({ label: 'OpenRouter' });
  await expect(model(page)).toHaveValue('');
  await expect(apiKey(page)).toHaveValue('');
  await expect(model(page)).toHaveAttribute('placeholder', 'Default: openrouter/free');
  await service(page).selectOption({ label: 'Z.ai (GLM)' });
  await expect(model(page)).toHaveValue('glm-5.3-flash');

  // All of it is still there after the app is opened again.
  await page.reload();
  await expect(service(page)).toHaveValue('zai');
  await expect(model(page)).toHaveValue('glm-5.3-flash');
  await expect(apiKey(page)).toHaveValue('zai-test-key');

  await saveVideo(page, LINK);
  await expect(page.getByRole('main').getByRole('link', { name: /Face Pull \(Cable\)/ })).toBeVisible();
  expect(requests).toHaveLength(1);
  expect(requests[0]).toMatchObject({ url: LINK, provider: 'zai', model: 'glm-5.3-flash', api_key: 'zai-test-key' });
  await expect(page.getByText('Identified by glm-5.3-flash.')).toBeVisible();

  // Without a model name the service's default is asked for; without a key, the analyzer's own is used.
  await page.goto('/#/settings');
  await service(page).selectOption({ label: 'Claude (Anthropic)' });
  await expect(apiKey(page)).toHaveAttribute('placeholder', 'Using the analyzer’s key');
  await page.goto('/#/videos');
  await page.getByRole('main').getByRole('link', { name: /3 cable moves/ }).click();
  await page.getByRole('button', { name: 'Identify Again' }).click();
  await expect(page.getByText('Identified by claude-opus-5-5.')).toBeVisible();
  expect(requests).toHaveLength(2);
  expect(Object.keys(requests[1]).sort()).toEqual(['known_exercises', 'provider', 'url']);
  expect(requests[1].provider).toBe('anthropic');

  // Handing the choice back to the analyzer drops it from the request again.
  await page.goto('/#/settings');
  await service(page).selectOption({ label: 'Analyzer’s choice' });
  await page.goto('/#/videos');
  await page.getByRole('main').getByRole('link', { name: /3 cable moves/ }).click();
  await page.getByRole('button', { name: 'Identify Again' }).click();
  await expect.poll(() => requests.length).toBe(3);
  expect(Object.keys(requests[2]).sort()).toEqual(['known_exercises', 'url']);
});

test('a backup carries the model choice but never the key', async ({ page, browser }) => {
  await mockModelAnalyzer(page);
  await page.goto('/#/settings');
  await service(page).selectOption({ label: 'OpenRouter' });
  await model(page).fill('qwen/qwen3.8-flash');
  await apiKey(page).fill('sk-or-SECRET-key');

  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download Backup' }).click();
  const saved = await download;
  const text = await readFile(await saved.path(), 'utf8');
  expect(text).not.toContain('SECRET');
  expect(JSON.parse(text).data.settings).toMatchObject({
    modelProvider: 'openrouter',
    models: { openrouter: 'qwen/qwen3.8-flash' },
    apiKeys: { anthropic: '', zai: '', openrouter: '' },
  });
  const file = { name: saved.suggestedFilename(), mimeType: 'application/json', buffer: Buffer.from(text) };

  // Another browser gets the choice and an empty key field.
  const context = await browser.newContext({ baseURL: 'http://localhost:4173' });
  const other = await context.newPage();
  await mockModelAnalyzer(other);
  await other.goto('/#/settings');
  await other.getByLabel('Backup file').setInputFiles(file);
  await other.getByRole('alertdialog').getByRole('button', { name: 'Replace' }).click();
  await expect(service(other)).toHaveValue('openrouter');
  await expect(model(other)).toHaveValue('qwen/qwen3.8-flash');
  await expect(apiKey(other)).toHaveValue('');
  await context.close();

  // Restoring here doesn't wipe the key this browser already has.
  await model(page).fill('changed-since-the-backup');
  await page.getByLabel('Backup file').setInputFiles(file);
  await page.getByRole('alertdialog').getByRole('button', { name: 'Replace' }).click();
  await expect(model(page)).toHaveValue('qwen/qwen3.8-flash');
  await expect(apiKey(page)).toHaveValue('sk-or-SECRET-key');
});

test('an analyzer from before models were selectable is called out', async ({ page }) => {
  const requests = await mockAnalyzer(page, 200, CANNED_ANALYSIS); // its /health only says ok…
  await page.route(/\/models\?provider=/, (route) => route.fulfill({ status: 404, json: { detail: 'Not Found' } })); // …and it has no /models
  await page.goto('/#/settings');
  await service(page).selectOption({ label: 'Z.ai (GLM)' });
  await expect(page.getByText('This analyzer is an older version and ignores the choice — update it and start it again.')).toBeVisible();
  await expect(model(page)).toHaveAttribute('placeholder', 'Default model');
  await expect(page.locator('#model-suggestions option')).toHaveCount(0);

  // Videos are still identified — by whatever that analyzer uses — and nothing is claimed about the model.
  await saveVideo(page, LINK);
  await expect(page.getByRole('main').getByRole('link', { name: /Face Pull \(Cable\)/ })).toBeVisible();
  expect(JSON.parse(requests[0])).toMatchObject({ url: LINK, provider: 'zai' });
  await expect(page.getByText(/Identified by/)).toHaveCount(0);
});

test('why the model could not be asked is shown on the video', async ({ page }) => {
  await mockAnalyzer(page, 401, { detail: 'OpenRouter rejected your API key — check it in the app under Settings → Video model.' });
  await page.route(/\/models\?provider=/, (route) => route.fulfill({ json: { provider: 'openrouter', default_model: 'openrouter/free', models: [] } }));
  await page.goto('/#/settings');
  await service(page).selectOption({ label: 'OpenRouter' });
  await apiKey(page).fill('sk-or-wrong');
  await saveVideo(page, LINK);
  await expect(page.getByText('OpenRouter rejected your API key — check it in the app under Settings → Video model.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Identify Exercises' })).toBeEnabled();
});
