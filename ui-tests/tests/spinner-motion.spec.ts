import { expect, test } from '@jupyterlab/galata';
import type { IJupyterLabPageFixture } from '@jupyterlab/galata';

/**
 * ACC-MOTION-58-SPIN: both spinner animations keep rotating while the system
 * prefers reduced motion. The rotation is the whole busy signal, so the
 * reduced-motion rule dims the spinners but must not stop them until force
 * motion is turned off.
 */

const TAB = 'li.lm-TabBar-tab[data-id="jp-trash-panel"]';
const HEADER_SVG = '.jp-TrashPanel-header-button.jp-mod-spinning svg';
const LOADING = '.jp-TrashPanel-loadingSpinner';
const SPIN = 'jp-trash-panel-spin';

/** Open the panel and wait for its first load. */
async function openPanel(page: IJupyterLabPageFixture): Promise<void> {
  await page.locator(TAB).click();
  // The first load raises the veil; wait for it so the Refresh click below is
  // the spin being measured.
  await page
    .locator('#jp-trash-panel .jp-TrashPanel-loading')
    .waitFor({ state: 'hidden', timeout: 60_000 });
}

/** Click Refresh, then read both animation names while the header spins. */
async function spinAndRead(
  page: IJupyterLabPageFixture
): Promise<{ header: string; loading: string }> {
  await page
    .locator('#jp-trash-panel .jp-TrashPanel-header-button[title="Refresh"]')
    .click();

  // One round trip: read the names while the header button still spins. The
  // loading spinner has no animation without the class.
  const names = await page.waitForFunction(
    ([headerSel, loadingSel]: [string, string]) => {
      const svg = document.querySelector(headerSel);
      const spinner = document.querySelector(loadingSel);
      if (!svg || !spinner) {
        return null;
      }
      return {
        header: getComputedStyle(svg).animationName,
        loading: getComputedStyle(spinner).animationName
      };
    },
    [HEADER_SVG, LOADING] as [string, string],
    { timeout: 30_000 }
  );
  return names.jsonValue();
}

async function spinnerNames(
  page: IJupyterLabPageFixture,
  reduced: boolean
): Promise<{ header: string; loading: string }> {
  // The emulation is the premise of the test; a silent miss would make the
  // reduced-motion case a copy of the default one.
  const prefersReduce = await page.evaluate(
    () => matchMedia('(prefers-reduced-motion: reduce)').matches
  );
  expect(prefersReduce).toBe(reduced);

  await openPanel(page);
  return spinAndRead(page);
}

async function expectSpinning(
  page: IJupyterLabPageFixture,
  reduced: boolean
): Promise<void> {
  const { header, loading } = await spinnerNames(page, reduced);
  console.log(
    `REDUCED_MOTION=${reduced} HEADER_ANIMATION=${header} LOADING_ANIMATION=${loading}`
  );
  expect(header).toBe(SPIN);
  expect(loading).toBe(SPIN);
}

test.describe('prefers-reduced-motion: reduce', () => {
  test.use({ reducedMotion: 'reduce' });

  test('both spinners keep animation-name jp-trash-panel-spin', async ({
    page
  }) => {
    await expectSpinning(page, true);
  });

  test('force motion off stops both spinners and keeps the chip', async ({
    page
  }) => {
    await openPanel(page);
    const chip = page.locator('#jp-trash-panel .jp-TrashPanel-motionChip');
    const toggle = page.locator('#jp-trash-panel .jp-TrashPanel-forceMotion');
    await expect(chip).toHaveText('reduced motion');
    await expect(toggle).toHaveAttribute('aria-pressed', 'true');
    const pressedBorder = await toggle.evaluate(
      (el: HTMLElement) => getComputedStyle(el).borderTopColor
    );

    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-pressed', 'false');
    const unpressedBorder = await toggle.evaluate(
      (el: HTMLElement) => getComputedStyle(el).borderTopColor
    );
    expect(pressedBorder).not.toBe(unpressedBorder);

    const { header, loading } = await spinAndRead(page);
    console.log(
      `FORCE_MOTION=off HEADER_ANIMATION=${header} LOADING_ANIMATION=${loading}`
    );
    expect(header).toBe('none');
    expect(loading).toBe('none');
    await expect(chip).toBeVisible();
  });
});

test.describe('prefers-reduced-motion: no-preference', () => {
  test.use({ reducedMotion: 'no-preference' });

  test('both spinners keep animation-name jp-trash-panel-spin', async ({
    page
  }) => {
    await expectSpinning(page, false);
  });
});
