import { expect, test } from '@jupyterlab/galata';
import type { IJupyterLabPageFixture } from '@jupyterlab/galata';

/**
 * ACC-MOTION-66-STATIC-REFRESH: the loading ring keeps animation-name
 * jp-trash-panel-spin under every system preference, while the header refresh
 * button's icon computes animationName none.
 */

const TAB = 'li.lm-TabBar-tab[data-id="jp-trash-panel"]';
const REFRESH_BUTTON =
  '#jp-trash-panel .jp-TrashPanel-header-button[title="Refresh"]';
const LOADING = '.jp-TrashPanel-loadingSpinner';
const SPIN = 'jp-trash-panel-spin';

/** Open the panel and wait for its first load. */
async function openPanel(page: IJupyterLabPageFixture): Promise<void> {
  await page.locator(TAB).click();
  await page
    .locator('#jp-trash-panel .jp-TrashPanel-loading')
    .waitFor({ state: 'hidden', timeout: 60_000 });
}

/** Read both animation names once the panel has loaded. */
async function motionNames(
  page: IJupyterLabPageFixture,
  reduced: boolean
): Promise<{
  header: string;
  loading: string;
  busyRing: string;
  busyIcon: string;
}> {
  // The emulation is the premise of the test; a silent miss would make the
  // reduced-motion case a copy of the default one.
  const prefersReduce = await page.evaluate(
    () => matchMedia('(prefers-reduced-motion: reduce)').matches
  );
  expect(prefersReduce).toBe(reduced);

  await openPanel(page);
  return page.evaluate(
    ([buttonSel, loadingSel]: [string, string]) => {
      const button = document.querySelector(buttonSel);
      const svg = button?.querySelector('svg');
      const spinner = document.querySelector(loadingSel);
      // P4: a rotating ring on the busy refresh button would have passed the
      // header check, so read it with the class applied.
      let busyRing = 'missing';
      let busyIcon = 'missing';
      if (button !== null && svg !== null) {
        button.classList.add('jp-mod-busy');
        busyRing = getComputedStyle(button, '::after').animationName;
        busyIcon = getComputedStyle(svg).animationName;
        button.classList.remove('jp-mod-busy');
      }
      return {
        header: svg ? getComputedStyle(svg).animationName : 'missing',
        loading: spinner ? getComputedStyle(spinner).animationName : 'missing',
        busyRing,
        busyIcon
      };
    },
    [REFRESH_BUTTON, LOADING] as [string, string]
  );
}

async function expectStaticHeader(
  page: IJupyterLabPageFixture,
  reduced: boolean
): Promise<void> {
  const { header, loading, busyRing, busyIcon } = await motionNames(
    page,
    reduced
  );
  console.log(
    `REDUCED_MOTION=${reduced} HEADER_ANIMATION=${header} LOADING_ANIMATION=${loading} BUSY_RING_ANIMATION=${busyRing} BUSY_ICON_ANIMATION=${busyIcon}`
  );
  expect(header).toBe('none');
  expect(loading).toBe(SPIN);
  expect(busyRing).toBe('none');
  expect(busyIcon).toBe('none');
}

test.describe('prefers-reduced-motion: reduce', () => {
  test.use({ reducedMotion: 'reduce' });

  test('keeps the loading ring turning and the header static', async ({
    page
  }) => {
    await expectStaticHeader(page, true);
    await expect(
      page.locator('#jp-trash-panel .jp-TrashPanel-motionChip')
    ).toHaveCount(0);
    await expect(
      page.locator('#jp-trash-panel .jp-TrashPanel-forceMotion')
    ).toHaveCount(0);
    await expect(
      page.locator('#jp-trash-panel.jp-mod-force-motion')
    ).toHaveCount(0);
  });
});

test.describe('prefers-reduced-motion: no-preference', () => {
  test.use({ reducedMotion: 'no-preference' });

  test('keeps the loading ring turning and the header static', async ({
    page
  }) => {
    await expectStaticHeader(page, false);
  });
});
