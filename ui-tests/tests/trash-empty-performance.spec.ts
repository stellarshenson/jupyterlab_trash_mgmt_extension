import { expect, test } from '@jupyterlab/galata';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Empty Trash with a large trash must not freeze the server.
 *
 * The trash is seeded on disk before the page loads: 2,000 folders of four
 * small files plus 2,000 single files, so 4,000 top-level entries and 10,000
 * files. While the Empty Trash POST runs, the page polls /api/status every
 * 50 ms; a blocked event loop shows up as a ping latency near the POST
 * duration.
 */

const TRASH_HOME = path.resolve(__dirname, '..', '.trash-home');
const TRASH_DIR = path.join(TRASH_HOME, 'Trash');
const FOLDER_COUNT = 2000;
const FILES_PER_FOLDER = 4;
const SINGLE_COUNT = 2000;

test.use({ autoGoto: false });
test.setTimeout(300_000);

test.beforeAll(() => {
  fs.rmSync(TRASH_DIR, { recursive: true, force: true });
  const filesDir = path.join(TRASH_DIR, 'files');
  const infoDir = path.join(TRASH_DIR, 'info');
  fs.mkdirSync(filesDir, { recursive: true });
  fs.mkdirSync(infoDir, { recursive: true });

  const body = Buffer.from('seed\n');
  const trashinfo = (original: string) =>
    Buffer.from(
      `[Trash Info]\nPath=${original}\nDeletionDate=2026-01-01T00:00:00\n`
    );

  for (let i = 0; i < FOLDER_COUNT; i++) {
    const name = `folder-${String(i).padStart(4, '0')}`;
    const folder = path.join(filesDir, name);
    fs.mkdirSync(folder);
    for (let j = 0; j < FILES_PER_FOLDER; j++) {
      fs.writeFileSync(path.join(folder, `file-${j}.txt`), body);
    }
    fs.writeFileSync(
      path.join(infoDir, `${name}.trashinfo`),
      trashinfo(`/tmp/seed/${name}`)
    );
  }

  for (let i = 0; i < SINGLE_COUNT; i++) {
    const name = `single-${String(i).padStart(4, '0')}.txt`;
    fs.writeFileSync(path.join(filesDir, name), body);
    fs.writeFileSync(
      path.join(infoDir, `${name}.trashinfo`),
      trashinfo(`/tmp/seed/${name}`)
    );
  }
});

test('Empty Trash does not freeze the server', async ({ page }) => {
  await page.goto();

  const tab = page.locator('li.lm-TabBar-tab[data-id="jp-trash-panel"]');
  await tab.waitFor({ state: 'visible', timeout: 60_000 });
  await tab.click();

  const summary = page.locator('#jp-trash-panel .jp-TrashPanel-summary');
  await expect(summary).toContainText('4000 items', { timeout: 60_000 });

  // 50 ms ping loop; it records the latency of every /api/status round trip.
  await page.evaluate(() => {
    const state = window as any;
    state.__pings = [];
    state.__pingStop = false;
    state.__pingDone = false;
    state.__pingLoop = (async () => {
      while (!state.__pingStop) {
        const started = performance.now();
        try {
          await fetch('/api/status', { cache: 'no-store' });
        } catch (error) {
          // A failed round trip still is a latency sample.
        }
        state.__pings.push(performance.now() - started);
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      state.__pingDone = true;
    })();
  });

  const emptyResponse = page.waitForResponse(
    response =>
      response.url().includes('/jupyterlab-trash-mgmt-extension/empty') &&
      response.request().method() === 'POST',
    { timeout: 120_000 }
  );

  await page
    .locator('#jp-trash-panel .jp-TrashPanel-header-button-danger')
    .click();

  const startedAt = Date.now();
  await page
    .locator('.jp-Dialog')
    .getByRole('button', { name: 'Empty Trash' })
    .click();

  const response = await emptyResponse;
  await response.finished();
  const postMs = Date.now() - startedAt;

  await page.evaluate(() => {
    (window as any).__pingStop = true;
  });
  await page.waitForFunction(() => (window as any).__pingDone === true, null, {
    timeout: 10_000
  });
  const pings: number[] = await page.evaluate(
    () => (window as any).__pings as number[]
  );
  const pingMaxMs = Math.max(...pings);

  console.log(`EMPTY_POST_MS=${postMs}`);
  console.log(`PING_MAX_MS=${pingMaxMs.toFixed(1)}`);
  console.log(`PING_SAMPLES=${pings.length}`);
  console.log(`PING_ALL=${pings.map(ping => ping.toFixed(1)).join(',')}`);

  // The removal is long enough to observe, and the server kept answering.
  expect(postMs).toBeGreaterThanOrEqual(1000);
  expect(pingMaxMs).toBeLessThan(1000);
});
