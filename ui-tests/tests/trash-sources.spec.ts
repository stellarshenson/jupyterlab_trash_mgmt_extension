import { expect, test } from '@jupyterlab/galata';
import type { IJupyterLabPageFixture } from '@jupyterlab/galata';
import type { Route } from '@playwright/test';

/**
 * The extra trash sources, one collapsible section each, below the main list.
 *
 * ACC-SCOPE-67-SOURCES: the sections follow the server order, the xdg trash
 *   stays the main listing, and a source the server did not return has none.
 * ACC-SCOPE-68-COLLAPSE: a header click or Enter / Space toggles a section,
 *   and a collapsed section stays collapsed across a reload.
 * ACC-SCOPE-69-COUNTS: every header carries its own source's count and size.
 * ACC-SCOPE-73-ABSENT-SOURCE: a source missing from the answer has no section.
 * ACC-SCOPE-74-STREAM: each section lists as soon as its own answer arrives.
 * ACC-SCOPE-75-STATIC-HEADERS: the section header and caret carry no motion.
 * ACC-SCOPE-86-SHOW-VOLUMES: the sections show only while Show Volumes is
 *   checked in the header menu; every case above turns it on first.
 * ACC-SCOPE-90-MERGED-LIST: while it is off, every source's rows are one list.
 * ACC-SCOPE-91-MERGED-ACTIONS: a location row of that list deletes in its own
 *   source.
 * ACC-SCOPE-88-EMPTY-ALL: the header trash button's dialog lists every source.
 * ACC-SCOPE-87-SECTION-EMPTY: a band's trash button's dialog names its source.
 * ACC-SCOPE-89-BAND-DESIGN: the band stays 21px with and without its button.
 * ACC-SCOPE-104-VOLUME-BANDS: with Show Volumes on, the summary bar totals
 *   every trash; the home band ~ sits under it behind the layout-color3
 *   divider, folds the main list, and its button's dialog names the XDG trash.
 * ACC-SCOPE-100-MENU-EVERYWHERE: a right-click on the main list's empty space
 *   or on a section band offers Show Volumes.
 * ACC-SCOPE-97-BUTTON-BOX: the band and home band trash buttons draw an
 *   18px box with a gap to every edge of the band.
 * DEF-PANEL-40-EMPTY-DISABLED: a trash button whose trash holds 0 items shows
 *   disabled, never hidden.
 * DEF-PANEL-41-SECTION-EMPTY: an expanded band of an empty trash shows the
 *   Trash is empty line.
 * ACC-SCOPE-103-HIDE-VOLUMES: while the bands show, the menu entry reads Hide
 *   Volumes, with no check mark.
 * ACC-FILTER-105-QUERY: the header filter narrows the rows to the name or
 *   original path containing the text; clearing brings every row back.
 * ACC-BANDS-107-HARMONICA: the panel-wide wheel drives the open section; at
 *   the list's end it pulls the neighbour in and the event that reaches the
 *   give length folds the section and opens the neighbour.
 * ACC-BANDS-108-STACK: a short open section keeps its content height and the
 *   next band follows under its last row; the section takes the remaining
 *   height only when its rows exceed it.
 *
 * Every answer the section UI reads is stubbed with page.route, so the test
 * controls the data and reads nothing from the real trash. The main listing
 * (GET .../list without a source) is left to the real server; under the
 * bubblewrap runner that is the seeded trash, never the developer's own. The
 * two layout cases stub the main listing too, because its row count decides
 * the layout they measure.
 */

const TAB = 'li.lm-TabBar-tab[data-id="jp-trash-panel"]';
const PANEL = '#jp-trash-panel';
// ServerConnection appends a cache-buster query to every request, so the
// sources pattern ends in * to admit it; the list pattern's own * admits it.
const SOURCES_ROUTE = '**/jupyterlab-trash-mgmt-extension/sources*';
const SOURCE_LIST_ROUTE = '**/jupyterlab-trash-mgmt-extension/list?source=*';
const SHOW_VOLUMES_KEY =
  '@stellarshenson/jupyterlab-trash-mgmt-extension:panel:show-volumes';

interface IStubSource {
  id: string;
  label: string;
  item_count: number;
  total_size: string;
  total_bytes: number;
  error: string;
  mountpoint: string;
}

interface IStubItem {
  name: string;
  trash_path: string;
  original_path: string;
  deletion_date: string;
  size: number;
  size_formatted: string;
  is_dir: boolean;
  is_symlink: boolean;
}

interface IStubListing {
  items: IStubItem[];
  total_size: number;
  total_size_formatted: string;
  item_count: number;
}

const SOURCES: IStubSource[] = [
  {
    id: 'xdg',
    label: 'Trash',
    item_count: 0,
    total_size: '0 B',
    total_bytes: 0,
    error: '',
    mountpoint: '/'
  },
  {
    id: 'cache',
    label: '/home/cache',
    item_count: 2,
    total_size: '1.2 MB',
    total_bytes: 1258291,
    error: '',
    mountpoint: '/'
  },
  {
    id: 'home:alice',
    label: '/home/alice',
    item_count: 1,
    total_size: '7 KB',
    total_bytes: 7168,
    error: '',
    mountpoint: '/home'
  }
];

const CACHE_ITEMS = [
  stubItem('cache-a.bin', '700 KB'),
  stubItem('cache-b.bin', '500 KB')
];
const ALICE_ITEMS = [stubItem('alice.txt', '1 KB')];

/** A /list item in the shape the panel reads. */
function stubItem(name: string, sizeFormatted: string): IStubItem {
  return {
    name,
    trash_path: `/tmp/${name}`,
    original_path: `/home/lab/${name}`,
    deletion_date: '2026-01-01T00:00:00',
    size: 1024,
    size_formatted: sizeFormatted,
    is_dir: false,
    is_symlink: false
  };
}

function stubListing(items: IStubItem[]): IStubListing {
  return {
    items,
    total_size: items.length * 1024,
    total_size_formatted: '1 KB',
    item_count: items.length
  };
}

type ListingAnswer = IStubItem[] | ((route: Route) => Promise<void>);

/**
 * Stub the sources answer and every per-source listing. A source with no
 * entry answers an empty listing, so an auto-refresh tick cannot leave a
 * request pending.
 */
async function stubSources(
  page: IJupyterLabPageFixture,
  sources: IStubSource[],
  listings: Record<string, ListingAnswer>
): Promise<void> {
  await page.route(SOURCES_ROUTE, route =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(sources)
    })
  );
  await page.route(SOURCE_LIST_ROUTE, async route => {
    const id = new URL(route.request().url()).searchParams.get('source') ?? '';
    const answer = listings[id];
    if (typeof answer === 'function') {
      await answer(route);
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(stubListing(answer ?? []))
    });
  });
}

/** Stub the main listing: GET .../list without a source parameter. */
async function stubMainList(
  page: IJupyterLabPageFixture,
  items: IStubItem[]
): Promise<void> {
  await page.route(
    url =>
      url.pathname.endsWith('/jupyterlab-trash-mgmt-extension/list') &&
      !url.searchParams.has('source'),
    route =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(stubListing(items))
      })
  );
}

/** Save Show Volumes as on before the page loads, as the header menu does. */
async function showVolumesOn(page: IJupyterLabPageFixture): Promise<void> {
  await page.addInitScript(key => {
    window.localStorage.setItem(key, 'true');
  }, SHOW_VOLUMES_KEY);
}

/** Show the panel and wait for its first main listing. */
async function openPanel(page: IJupyterLabPageFixture): Promise<void> {
  const tab = page.locator(TAB);
  await tab.waitFor({ state: 'visible', timeout: 60_000 });
  await tab.click();
  await page
    .locator(`${PANEL} .jp-TrashPanel-loading`)
    .waitFor({ state: 'hidden', timeout: 60_000 });
}

const section = (page: IJupyterLabPageFixture, id: string) =>
  page.locator(`${PANEL} .jp-TrashPanel-section[data-source="${id}"]`);

const sectionHeader = (page: IJupyterLabPageFixture, id: string) =>
  section(page, id).locator('.jp-TrashPanel-sectionHeader');

const sectionLabel = (page: IJupyterLabPageFixture, id: string) =>
  section(page, id).locator('.jp-TrashPanel-sectionLabel');

const sectionList = (page: IJupyterLabPageFixture, id: string) =>
  section(page, id).locator('.jp-TrashPanel-sectionList');

const sectionRows = (page: IJupyterLabPageFixture, id: string) =>
  section(page, id).locator('.jp-TrashPanel-sectionRow');

const sectionEntries = (page: IJupyterLabPageFixture, id: string) =>
  section(page, id).locator('.jp-TrashPanel-sectionEntries');

/** Click a folded band's fold toggle and wait for it to open. */
async function openBand(
  page: IJupyterLabPageFixture,
  id: string
): Promise<void> {
  await sectionHeader(page, id).click();
  await expect(sectionHeader(page, id)).toHaveAttribute(
    'aria-expanded',
    'true'
  );
}

test.use({ autoGoto: false });

test('renders one section per source, in server order, with its own count and size', async ({
  page
}) => {
  await showVolumesOn(page);
  await stubSources(page, SOURCES, {
    cache: CACHE_ITEMS,
    'home:alice': ALICE_ITEMS
  });
  await page.goto();
  await openPanel(page);

  const sections = page.locator(`${PANEL} .jp-TrashPanel-section[data-source]`);
  await expect(sections).toHaveCount(3);
  const order = await sections.evaluateAll(elements =>
    elements.map(element => (element as HTMLElement).dataset.source)
  );
  expect(order).toEqual(['xdg', 'cache', 'home:alice']);

  // Each header carries its own source's count and size.
  await expect(sectionLabel(page, 'cache')).toHaveText(
    '/home/cache (2 items, 1.2 MB)'
  );
  await expect(sectionLabel(page, 'home:alice')).toHaveText(
    '/home/alice (1 item, 7 KB)'
  );

  // The column is the summary bar's next sibling, the home section is its
  // first child, and the main list lives in the home entries box.
  const placed = await page.evaluate(() => {
    const summary = document.querySelector(
      '#jp-trash-panel .jp-TrashPanel-summary'
    );
    const column = document.querySelector(
      '#jp-trash-panel .jp-TrashPanel-sections'
    );
    const home = document.querySelector(
      '#jp-trash-panel .jp-TrashPanel-section[data-source="xdg"]'
    );
    const entries = home?.querySelector('.jp-TrashPanel-sectionEntries');
    const main = document.querySelector('#jp-trash-panel .jp-TrashPanel-list');
    return {
      summaryNext: summary?.nextElementSibling === column,
      homeFirst: column?.firstElementChild === home,
      mainInside: entries != null && main != null && entries.contains(main)
    };
  });
  expect(placed).toEqual({
    summaryNext: true,
    homeFirst: true,
    mainInside: true
  });
  await expect(page.locator(`${PANEL} [data-source="xdg"]`)).toHaveCount(1);
  await expect(page.locator(`${PANEL} [data-source="home:bob"]`)).toHaveCount(
    0
  );

  // The stub values live in the two headers and nowhere else in the panel.
  const occurrences = await page.evaluate(() => {
    const text = document.querySelector('#jp-trash-panel')?.textContent ?? '';
    return ['/home/cache (2 items, 1.2 MB)', '/home/alice (1 item, 7 KB)'].map(
      value => text.split(value).length - 1
    );
  });
  expect(occurrences).toEqual([1, 1]);
});

// ACC-BANDS-111-TRASH-TIP: the band tooltip names the mountpoint of the
// volume that holds the band's trash folder, after the label.
test('the band tooltip names the mountpoint of the volume holding its trash', async ({
  page
}) => {
  const mountpoint = '/mnt/lab-home';
  await showVolumesOn(page);
  await stubMainList(page, []);
  await stubSources(
    page,
    [{ ...SOURCES[0], mountpoint }, SOURCES[1], SOURCES[2]],
    { cache: CACHE_ITEMS, 'home:alice': ALICE_ITEMS }
  );
  await page.goto();
  await openPanel(page);

  const title = await sectionLabel(page, 'xdg')
    .locator('.jp-TrashPanel-sectionText')
    .getAttribute('title');
  expect(title?.endsWith(` on ${mountpoint}`)).toBe(true);
});

test('a header click opens a folded section and folds the open one, and the state survives a reload', async ({
  page
}) => {
  await showVolumesOn(page);
  await stubSources(page, SOURCES, {
    cache: CACHE_ITEMS,
    'home:alice': ALICE_ITEMS
  });
  await page.goto();
  await openPanel(page);

  // A fresh key opens the home section alone
  await expect(sectionHeader(page, 'xdg')).toHaveAttribute(
    'aria-expanded',
    'true'
  );
  await expect(sectionHeader(page, 'cache')).toHaveAttribute(
    'aria-expanded',
    'false'
  );

  // A click on the folded cache band opens it and folds the home band
  await sectionHeader(page, 'cache').click();
  await expect(sectionHeader(page, 'cache')).toHaveAttribute(
    'aria-expanded',
    'true'
  );
  await expect(sectionRows(page, 'cache')).toHaveCount(2);
  await expect(sectionList(page, 'cache')).toBeVisible();
  await expect(sectionHeader(page, 'xdg')).toHaveAttribute(
    'aria-expanded',
    'false'
  );
  await expect(sectionLabel(page, 'cache')).toHaveText(
    '/home/cache (2 items, 1.2 MB)'
  );

  await page.reload();
  await openPanel(page);

  await expect(sectionHeader(page, 'cache')).toHaveAttribute(
    'aria-expanded',
    'true'
  );
  await expect(sectionHeader(page, 'xdg')).toHaveAttribute(
    'aria-expanded',
    'false'
  );
  await expect(sectionRows(page, 'cache')).toHaveCount(2);

  // A click on the open cache band folds it, and every band is a band
  await sectionHeader(page, 'cache').click();
  await expect(sectionHeader(page, 'cache')).toHaveAttribute(
    'aria-expanded',
    'false'
  );
  await expect(sectionList(page, 'cache')).toBeHidden();
  for (const id of ['xdg', 'cache', 'home:alice']) {
    await expect(sectionHeader(page, id)).toHaveAttribute(
      'aria-expanded',
      'false'
    );
  }
  await expect(sectionLabel(page, 'cache')).toHaveText(
    '/home/cache (2 items, 1.2 MB)'
  );
});

test('Enter and Space on a focused header open and fold its section', async ({
  page
}) => {
  await showVolumesOn(page);
  await stubSources(page, SOURCES, {
    cache: CACHE_ITEMS,
    'home:alice': ALICE_ITEMS
  });
  await stubMainList(page, [stubItem('main-a.txt', '1 KB')]);
  await page.goto();
  await openPanel(page);

  const header = sectionHeader(page, 'cache');
  await header.focus();
  await expect(header).toBeFocused();

  // Enter opens the folded band and folds the home band
  await page.keyboard.press('Enter');
  await expect(header).toHaveAttribute('aria-expanded', 'true');
  await expect(sectionList(page, 'cache')).toBeVisible();
  await expect(sectionHeader(page, 'xdg')).toHaveAttribute(
    'aria-expanded',
    'false'
  );
  await expect(header).toBeFocused();

  // Space folds the now-open band and keeps the focus on it
  await page.keyboard.press('Space');
  await expect(header).toHaveAttribute('aria-expanded', 'false');
  await expect(sectionList(page, 'cache')).toBeHidden();
  await expect(header).toBeFocused();

  // Reopen the home band so the main list shows, then Shift+Tab into it
  await openBand(page, 'xdg');
  await header.focus();
  // DEF-PANEL-34-FOCUS-RING: tabbing into the main list with no active row
  // makes its first row active, so the row ring shows where the focus is.
  const list = page.locator(`${PANEL} .jp-TrashPanel-list`);
  const firstRow = list.locator('.jp-TrashPanel-item').first();
  await page.keyboard.press('Shift+Tab');
  await expect(list).toBeFocused();
  await expect(firstRow).toHaveClass(/jp-mod-active/);
  await expect(list).toHaveAttribute(
    'aria-activedescendant',
    (await firstRow.getAttribute('id'))!
  );
});

test('a held source listing does not hold back another section', async ({
  page
}) => {
  let release = (): void => {};
  const held = new Promise<void>(resolve => {
    release = resolve;
  });
  let markRequested = (): void => {};
  const aliceRequested = new Promise<void>(resolve => {
    markRequested = resolve;
  });
  const heldAlice = async (route: Route): Promise<void> => {
    markRequested();
    await held;
    try {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(stubListing(ALICE_ITEMS))
      });
    } catch {
      // The page may be gone when a failed assertion ends the test.
    }
  };

  await showVolumesOn(page);
  await stubSources(page, SOURCES, {
    cache: CACHE_ITEMS,
    'home:alice': heldAlice
  });
  await page.goto();
  try {
    await openPanel(page);
    // The route matched: the held source is pending, not absent.
    await aliceRequested;

    // The cache section opens and shows its rows while home:alice is still
    // unanswered; every listing is prefetched, so opening does not wait
    await openBand(page, 'cache');
    await expect(sectionRows(page, 'cache')).toHaveCount(2);
    await expect(sectionRows(page, 'home:alice')).toHaveCount(0);
    await expect(sectionHeader(page, 'home:alice')).toHaveAttribute(
      'aria-expanded',
      'false'
    );

    release();
    await openBand(page, 'home:alice');
    await expect(sectionRows(page, 'home:alice')).toHaveCount(1);
  } finally {
    // Release any handler a tick started and drop the route, so the test
    // cannot be left waiting on the held answer.
    release();
    await page.unroute(SOURCE_LIST_ROUTE).catch(() => {});
  }
});

test('the section header and caret carry no motion', async ({ page }) => {
  await showVolumesOn(page);
  await stubSources(page, SOURCES, {
    cache: CACHE_ITEMS,
    'home:alice': ALICE_ITEMS
  });
  await page.goto();
  await openPanel(page);

  const styles = await page.evaluate(() => {
    const header = document.querySelector(
      '#jp-trash-panel .jp-TrashPanel-section[data-source="cache"] .jp-TrashPanel-sectionHeader'
    );
    const caret = header?.querySelector('.jp-TrashPanel-caret');
    if (header === null || caret == null) {
      return null;
    }
    const read = (element: Element) => {
      const style = getComputedStyle(element);
      return {
        animationName: style.animationName,
        transitionDuration: style.transitionDuration
      };
    };
    return { header: read(header), caret: read(caret) };
  });
  expect(styles).not.toBeNull();
  for (const value of [styles!.header, styles!.caret]) {
    expect(value.animationName).toBe('none');
    for (const duration of value.transitionDuration.split(',')) {
      expect(duration.trim()).toBe('0s');
    }
  }
});

const manyItems = (prefix: string) =>
  Array.from({ length: 60 }, (_, index) =>
    stubItem(`${prefix}-${String(index).padStart(2, '0')}.txt`, '1 KB')
  );

const LONG_SOURCES: IStubSource[] = [
  {
    id: 'xdg',
    label: 'Trash',
    item_count: 0,
    total_size: '0 B',
    total_bytes: 0,
    error: '',
    mountpoint: '/'
  },
  {
    id: 'cache',
    label: '/home/cache',
    item_count: 60,
    total_size: '60 MB',
    total_bytes: 62914560,
    error: '',
    mountpoint: '/'
  },
  {
    id: 'home:alice',
    label: '/home/alice',
    item_count: 60,
    total_size: '60 KB',
    total_bytes: 61440,
    error: '',
    mountpoint: '/home'
  }
];

/** Stub the main listing and two 60-row sections, then open the panel. */
async function openLongSections(
  page: IJupyterLabPageFixture,
  mainItems: IStubItem[]
): Promise<void> {
  await showVolumesOn(page);
  await stubMainList(page, mainItems);
  await stubSources(page, LONG_SOURCES, {
    cache: manyItems('cache'),
    'home:alice': manyItems('alice')
  });
  await page.goto();
  await openPanel(page);
  // Opening the cache band shows its rows without a wait: every listing is
  // prefetched with Show Volumes on
  await openBand(page, 'cache');
  await expect(sectionRows(page, 'cache')).toHaveCount(60);
}

// ACC-BANDS-108-STACK: the open section's entries box takes the column's
// height less every band, and scrolls inside it; the folded bands stay on
// screen. ACC-BANDS-107-HARMONICA overrides ACC-SCOPE-82-SECTION-SHARE.
test('a long open section takes the remaining height and the folded bands stay on screen', async ({
  page
}) => {
  await openLongSections(page, [
    stubItem('main-a.txt', '1 KB'),
    stubItem('main-b.txt', '1 KB'),
    stubItem('main-c.txt', '1 KB')
  ]);
  await expect(page.locator(`${PANEL} .jp-TrashPanel-item`)).toHaveCount(3);

  const measured = await page.evaluate(() => {
    const panel = document.querySelector('#jp-trash-panel') as HTMLElement;
    panel.style.width = '480px';
    panel.style.height = '500px';
    const column = panel.querySelector(
      '.jp-TrashPanel-sections'
    ) as HTMLElement;
    const entries = panel.querySelector(
      '.jp-TrashPanel-section[data-source="cache"] .jp-TrashPanel-sectionEntries'
    ) as HTMLElement;
    const bandHeight = (id: string) =>
      (
        panel.querySelector(
          `.jp-TrashPanel-section[data-source="${id}"] .jp-TrashPanel-sectionBand`
        ) as HTMLElement
      ).getBoundingClientRect().height;
    // A static band is its section box less the entries box: the band plus
    // the section's 1px borders, which the band rectangle alone omits
    const staticBand = (id: string) => {
      const section = panel.querySelector(
        `.jp-TrashPanel-section[data-source="${id}"]`
      ) as HTMLElement;
      const entries = section.querySelector(
        '.jp-TrashPanel-sectionEntries'
      ) as HTMLElement;
      return (
        section.getBoundingClientRect().height -
        entries.getBoundingClientRect().height
      );
    };
    const aliceBand = panel.querySelector(
      '.jp-TrashPanel-section[data-source="home:alice"] .jp-TrashPanel-sectionBand'
    ) as HTMLElement;
    const homeEntries = panel.querySelector(
      '.jp-TrashPanel-section[data-source="xdg"] .jp-TrashPanel-sectionEntries'
    ) as HTMLElement;
    const columnBox = column.getBoundingClientRect();
    const entriesBox = entries.getBoundingClientRect();
    return {
      panelHeight: panel.getBoundingClientRect().height,
      columnHeight: columnBox.height,
      entriesHeight: entriesBox.height,
      bands: [bandHeight('xdg'), bandHeight('cache'), bandHeight('home:alice')],
      staticBands: ['xdg', 'cache', 'home:alice'].map(staticBand),
      scrollHeight: entries.scrollHeight,
      clientHeight: entries.clientHeight,
      aliceOnScreen:
        aliceBand.getBoundingClientRect().bottom <= columnBox.bottom,
      homeEntriesHidden: getComputedStyle(homeEntries).display === 'none'
    };
  });

  console.log(
    `PANEL_HEIGHT=${measured.panelHeight} COLUMN_HEIGHT=${measured.columnHeight} ` +
      `ENTRIES_HEIGHT=${measured.entriesHeight} BANDS=${measured.bands.join(',')}`
  );

  expect(measured.panelHeight).toBeCloseTo(500, 0);
  // Every band stays on screen at its 21px content height
  for (const height of measured.bands) {
    expect(height).toBeCloseTo(21, 0);
  }
  // The open entries box takes the column less the static bands and their
  // section borders; the band rectangles alone are 3px short for three
  // sections
  const staticBands = measured.staticBands.reduce(
    (sum, height) => sum + height,
    0
  );
  expect(
    Math.abs(measured.entriesHeight - (measured.columnHeight - staticBands))
  ).toBeLessThanOrEqual(1);
  // Its rows exceed it, so it scrolls and the last band stays on screen
  expect(measured.scrollHeight).toBeGreaterThan(measured.clientHeight);
  expect(measured.aliceOnScreen).toBe(true);
  // The folded home band hides the main list in its entries box
  expect(measured.homeEntriesHidden).toBe(true);
});

// ACC-BANDS-108-STACK: a short open section keeps its content height, so the
// next band follows its last row and the free space sits below the last band.
// ACC-NAV-85-EMPTY-LINE: the 'Trash is empty' text starts within 12 px of the
// panel's left edge, not centered.
test('with an empty open home section the next bands stack under its empty line', async ({
  page
}) => {
  await openLongSections(page, []);
  // Open the home section on the empty main list
  await openBand(page, 'xdg');
  const emptyLine = page.locator(`${PANEL} .jp-TrashPanel-empty`).first();
  await expect(emptyLine).toBeVisible();
  await expect(emptyLine).toHaveText('Trash is empty');

  const measured = await page.evaluate(() => {
    const panel = document.querySelector('#jp-trash-panel') as HTMLElement;
    panel.style.width = '480px';
    panel.style.height = '500px';
    const homeEntries = panel.querySelector(
      '.jp-TrashPanel-section[data-source="xdg"] .jp-TrashPanel-sectionEntries'
    ) as HTMLElement;
    const cacheSection = panel.querySelector(
      '.jp-TrashPanel-section[data-source="cache"]'
    ) as HTMLElement;
    const aliceSection = panel.querySelector(
      '.jp-TrashPanel-section[data-source="home:alice"]'
    ) as HTMLElement;
    const panelRect = panel.getBoundingClientRect();
    // The text range, not the element box, which spans the panel width
    const range = document.createRange();
    range.selectNodeContents(
      panel.querySelector('.jp-TrashPanel-empty') as HTMLElement
    );
    return {
      panelHeight: panelRect.height,
      panelBottom: panelRect.bottom,
      homeBottom: homeEntries.getBoundingClientRect().bottom,
      cacheTop: cacheSection.getBoundingClientRect().top,
      aliceTop: aliceSection.getBoundingClientRect().top,
      cacheBottom: cacheSection.getBoundingClientRect().bottom,
      aliceBottom: aliceSection.getBoundingClientRect().bottom,
      emptyTextInset: range.getBoundingClientRect().left - panelRect.left
    };
  });

  expect(measured.panelHeight).toBeCloseTo(500, 0);
  // The cache band follows the home entries box, and alice follows the cache
  // band; no section stretches to the panel bottom, so the free space is
  // below the last band
  expect(Math.abs(measured.cacheTop - measured.homeBottom)).toBeLessThanOrEqual(
    1
  );
  expect(measured.aliceTop).toBeGreaterThanOrEqual(measured.cacheBottom - 1);
  expect(measured.aliceBottom).toBeLessThan(measured.panelBottom - 20);
  expect(measured.emptyTextInset).toBeGreaterThanOrEqual(0);
  expect(measured.emptyTextInset).toBeLessThanOrEqual(12);
});

// ACC-BANDS-107-HARMONICA: the wheel over the panel drives the open section;
// at the list's end two 100px notches reach the give length and fold it into
// the neighbour, and a notch during the fold does nothing.
test('the wheel folds the open band at its end and short bands stack under it', async ({
  page
}) => {
  await showVolumesOn(page);
  await stubMainList(page, [
    stubItem('main-a.txt', '1 KB'),
    stubItem('main-b.txt', '1 KB')
  ]);
  await stubSources(
    page,
    [
      {
        ...SOURCES[0],
        item_count: 2,
        total_size: '2 KB',
        total_bytes: 2048
      },
      SOURCES[1],
      SOURCES[2]
    ],
    { cache: CACHE_ITEMS, 'home:alice': ALICE_ITEMS }
  );
  await page.goto();
  await openPanel(page);

  // The home section is open and the cache band sits under its entries box
  await expect(sectionHeader(page, 'xdg')).toHaveAttribute(
    'aria-expanded',
    'true'
  );
  const stacked = await page.evaluate(() => {
    const homeEntries = document.querySelector(
      '#jp-trash-panel .jp-TrashPanel-section[data-source="xdg"] .jp-TrashPanel-sectionEntries'
    ) as HTMLElement;
    const cacheBand = document.querySelector(
      '#jp-trash-panel .jp-TrashPanel-section[data-source="cache"] .jp-TrashPanel-sectionBand'
    ) as HTMLElement;
    return (
      cacheBand.getBoundingClientRect().top -
      homeEntries.getBoundingClientRect().bottom
    );
  });
  expect(Math.abs(stacked)).toBeLessThanOrEqual(1);

  // Two 100px notches add 25px each and give on the second; the third lands
  // during the fold, where wheel events are cancelled and do nothing
  const bar = page.locator(`${PANEL} .jp-TrashPanel-summary`);
  await bar.hover();
  await page.mouse.wheel(0, 100);
  await page.mouse.wheel(0, 100);
  await page.waitForTimeout(50);
  await page.mouse.wheel(0, 100);
  await page.waitForTimeout(500);

  await expect(sectionHeader(page, 'cache')).toHaveAttribute(
    'aria-expanded',
    'true'
  );
  await expect(sectionRows(page, 'cache')).toHaveCount(2);
  await expect(sectionList(page, 'cache')).toBeVisible();
  await expect(sectionHeader(page, 'xdg')).toHaveAttribute(
    'aria-expanded',
    'false'
  );
  await expect(sectionEntries(page, 'xdg')).toBeHidden();
  // The fold crossed one section only, so the open section is cache
  await expect(sectionHeader(page, 'home:alice')).toHaveAttribute(
    'aria-expanded',
    'false'
  );

  // The alice band follows the short cache entries box immediately
  const aliceTop = await page.evaluate(() => {
    const cacheEntries = document.querySelector(
      '#jp-trash-panel .jp-TrashPanel-section[data-source="cache"] .jp-TrashPanel-sectionEntries'
    ) as HTMLElement;
    const aliceBand = document.querySelector(
      '#jp-trash-panel .jp-TrashPanel-section[data-source="home:alice"] .jp-TrashPanel-sectionBand'
    ) as HTMLElement;
    return (
      aliceBand.getBoundingClientRect().top -
      cacheEntries.getBoundingClientRect().bottom
    );
  });
  expect(Math.abs(aliceTop)).toBeLessThanOrEqual(1);
});

// DEF-PANEL-48-FOLD-SCROLLBAR: the pull and the fold hold the entries box
// shorter than its rows, so the browser would draw a scrollbar over rows that
// are pinned; both trading boxes hide the bar while the animating class is on.
test('the fold draws no scrollbar on the leaving empty section', async ({
  page
}) => {
  await showVolumesOn(page);
  await stubMainList(page, []);
  await stubSources(
    page,
    [
      { ...SOURCES[0], item_count: 0, total_size: '0 B', total_bytes: 0 },
      { ...SOURCES[1], item_count: 0, total_size: '0 B', total_bytes: 0 },
      SOURCES[2]
    ],
    { cache: [], 'home:alice': ALICE_ITEMS }
  );
  await page.goto();
  await openPanel(page);

  // At rest the open home box carries the theme's scrollbar pair
  const atRest = await sectionEntries(page, 'xdg').evaluate(
    (entries: HTMLElement) => getComputedStyle(entries).scrollbarColor
  );
  expect(atRest).not.toBe('rgba(0, 0, 0, 0) rgba(0, 0, 0, 0)');

  // The empty open box is 24px and its give length is half of it, so the first
  // 100px notch already folds it into the cache band
  const bar = page.locator(`${PANEL} .jp-TrashPanel-summary`);
  await bar.hover();
  await page.mouse.wheel(0, 100);
  await page.mouse.wheel(0, 100);
  await page.waitForTimeout(60);

  // The fold trades the leaving home box and the entering cache box; both are
  // shorter than their rows, so both carry the class and neither draws its bar
  const during = await page.evaluate(() => {
    const boxes = Array.from(
      document.querySelectorAll('#jp-trash-panel .jp-TrashPanel-sectionEntries')
    ) as HTMLElement[];
    return boxes.map(entries => ({
      id: entries
        .closest('.jp-TrashPanel-section')
        ?.getAttribute('data-source'),
      classes: Array.from(entries.classList),
      color: getComputedStyle(entries).scrollbarColor,
      thumb: getComputedStyle(entries, '::-webkit-scrollbar-thumb')
        .backgroundColor
    }));
  });
  const animating = during.filter(box =>
    box.classes.includes('jp-mod-animating')
  );
  expect(animating.map(box => box.id)).toEqual(['xdg', 'cache']);
  for (const box of animating) {
    expect(box.color).toBe('rgba(0, 0, 0, 0) rgba(0, 0, 0, 0)');
    expect(box.thumb).toBe('rgba(0, 0, 0, 0)');
  }

  await page.waitForTimeout(500);
  await expect(sectionHeader(page, 'cache')).toHaveAttribute(
    'aria-expanded',
    'true'
  );
});

// ACC-BANDS-108-STACK: a panel shorter than its static bands scrolls the
// column, so every band stays reachable; the wheel keeps the native scroll
// instead of folding.
test('a dozen bands in a short panel scroll the column instead of clipping', async ({
  page
}) => {
  const shortSources: IStubSource[] = [
    {
      ...SOURCES[0],
      item_count: 1,
      total_size: '1 KB',
      total_bytes: 1024
    },
    ...Array.from({ length: 11 }, (_, index) => ({
      id: `home:s${index}`,
      label: `/home/s${index}`,
      item_count: 0,
      total_size: '0 B',
      total_bytes: 0,
      error: '',
      mountpoint: '/home'
    }))
  ];
  await showVolumesOn(page);
  await stubMainList(page, [stubItem('main-a.txt', '1 KB')]);
  await stubSources(page, shortSources, {});
  await page.goto();
  await openPanel(page);

  // The 12 bands need 252px; a 200px panel leaves the column less than that
  await page.evaluate(() => {
    (document.querySelector('#jp-trash-panel') as HTMLElement).style.height =
      '200px';
  });
  // A repaint measures the column and marks it short
  await page.locator(`${PANEL} button[title="Refresh"]`).click();
  await expect
    .poll(() =>
      page.evaluate(() =>
        document
          .querySelector('#jp-trash-panel .jp-TrashPanel-sections')!
          .classList.contains('jp-mod-short')
      )
    )
    .toBe(true);

  const measured = await page.evaluate(() => {
    const column = document.querySelector(
      '#jp-trash-panel .jp-TrashPanel-sections'
    ) as HTMLElement;
    const open = column.querySelector(
      '.jp-TrashPanel-section:not(.jp-mod-collapsed)'
    ) as HTMLElement;
    const entries = open.querySelector(
      '.jp-TrashPanel-sectionEntries'
    ) as HTMLElement;
    const lastBand = column.querySelector(
      '.jp-TrashPanel-section:last-child .jp-TrashPanel-sectionBand'
    ) as HTMLElement;
    column.scrollTop = column.scrollHeight;
    return {
      overflowY: getComputedStyle(column).overflowY,
      scrolls: column.scrollHeight > column.clientHeight,
      openShrink: getComputedStyle(open).flexShrink,
      entriesHeight: entries.getBoundingClientRect().height,
      lastBandBottom: lastBand.getBoundingClientRect().bottom,
      columnBottom: column.getBoundingClientRect().bottom
    };
  });
  expect(measured.overflowY).toBe('auto');
  expect(measured.scrolls).toBe(true);
  // The open section keeps its natural height; the column is the scroller
  expect(measured.openShrink).toBe('0');
  expect(measured.entriesHeight).toBeGreaterThan(0);
  // Scrolling the column reaches the last band
  expect(measured.lastBandBottom).toBeLessThanOrEqual(
    measured.columnBottom + 1
  );

  // A wheel over a band scrolls the column natively and folds nothing
  await page.evaluate(() => {
    (
      document.querySelector(
        '#jp-trash-panel .jp-TrashPanel-sections'
      ) as HTMLElement
    ).scrollTop = 0;
  });
  await sectionHeader(page, 'xdg').hover();
  await page.mouse.wheel(0, 120);
  await page.waitForTimeout(100);
  const scrolled = await page.evaluate(
    () =>
      (
        document.querySelector(
          '#jp-trash-panel .jp-TrashPanel-sections'
        ) as HTMLElement
      ).scrollTop
  );
  expect(scrolled).toBeGreaterThan(0);
  await expect(sectionHeader(page, 'xdg')).toHaveAttribute(
    'aria-expanded',
    'true'
  );
});

/**
 * ACC-SCOPE-76-LOCATION-TRASH: a location trash is a section after the cache
 *   and home sections, labelled with its folder.
 * ACC-SCOPE-78-LOCATION-RESTORE: its row opens a Restore menu by right-click
 *   or Shift+F10, and Restore posts the path with the source id.
 * ACC-SCOPE-92-RESTORE-ALL: a cache row restores the same way.
 */
const LOCATION_ID = 'location:/mnt/data/.Trash-1000';
const LOCATION_SOURCES: IStubSource[] = [
  ...SOURCES,
  {
    id: LOCATION_ID,
    label: '/mnt/data',
    item_count: 1,
    total_size: '3 KB',
    total_bytes: 3072,
    error: '',
    mountpoint: '/mnt/data'
  }
];
const LOCATION_ITEM: IStubItem = {
  ...stubItem('data.csv', '3 KB'),
  trash_path: '/mnt/data/.Trash-1000/files/data.csv',
  original_path: '/mnt/data/data.csv'
};
// The cache-buster query follows the path, as on the sources route.
const RESTORE_ROUTE = '**/jupyterlab-trash-mgmt-extension/restore*';

const restoreMenuItem = (page: IJupyterLabPageFixture) =>
  page.locator('.lm-Menu .lm-Menu-itemLabel', { hasText: /^Restore$/ });

async function stubLocation(page: IJupyterLabPageFixture): Promise<void> {
  await showVolumesOn(page);
  await stubSources(page, LOCATION_SOURCES, {
    cache: CACHE_ITEMS,
    'home:alice': ALICE_ITEMS,
    [LOCATION_ID]: [LOCATION_ITEM]
  });
  await page.goto();
  await openPanel(page);
}

test('a location trash is a section after the cache and home sections', async ({
  page
}) => {
  await stubLocation(page);

  const order = await page
    .locator(`${PANEL} .jp-TrashPanel-section[data-source]`)
    .evaluateAll(elements =>
      elements.map(element => (element as HTMLElement).dataset.source)
    );
  expect(order).toEqual(['xdg', 'cache', 'home:alice', LOCATION_ID]);
  await openBand(page, LOCATION_ID);
  await expect(sectionLabel(page, LOCATION_ID)).toHaveText(
    '/mnt/data (1 item, 3 KB)'
  );
  await expect(sectionRows(page, LOCATION_ID)).toContainText('data.csv');
});

test('right-click on a location row restores it with its source', async ({
  page
}) => {
  const bodies: unknown[] = [];
  await page.route(RESTORE_ROUTE, async route => {
    bodies.push(route.request().postDataJSON());
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        success: true,
        restored_to: LOCATION_ITEM.original_path
      })
    });
  });
  await stubLocation(page);

  // ACC-SCOPE-84-ROW-HOVER: a location row takes the main-list hover
  // background, and so does a cache row (ACC-SCOPE-92-RESTORE-ALL).
  const background = (locator: ReturnType<typeof sectionRows>) =>
    locator.evaluate(element => getComputedStyle(element).backgroundColor);
  const hoverColor = await page.locator(PANEL).evaluate(panel => {
    // Resolve the variable to the same rgb() form backgroundColor reports.
    const probe = document.createElement('div');
    probe.style.background = 'var(--jp-layout-color2)';
    panel.appendChild(probe);
    const color = getComputedStyle(probe).backgroundColor;
    probe.remove();
    return color;
  });
  // One section is open at rest, so each row is hovered while its band is
  await openBand(page, 'cache');
  const cacheRow = sectionRows(page, 'cache').first();
  await cacheRow.hover();
  await expect.poll(() => background(cacheRow)).toBe(hoverColor);
  await openBand(page, LOCATION_ID);
  const locationRow = sectionRows(page, LOCATION_ID);
  await locationRow.hover();
  await expect.poll(() => background(locationRow)).toBe(hoverColor);

  await sectionRows(page, LOCATION_ID).click({ button: 'right' });
  await expect(restoreMenuItem(page)).toBeVisible();
  await restoreMenuItem(page).click();

  await expect.poll(() => bodies.length).toBe(1);
  expect(bodies[0]).toEqual({
    trash_path: LOCATION_ITEM.trash_path,
    source: LOCATION_ID
  });
});

test('Shift+F10 on a focused location row opens the Restore menu', async ({
  page
}) => {
  await stubLocation(page);
  await openBand(page, LOCATION_ID);

  const row = sectionRows(page, LOCATION_ID);
  await row.focus();
  await expect(row).toBeFocused();
  await expect(restoreMenuItem(page)).toHaveCount(0);

  await page.keyboard.press('Shift+F10');
  await expect(restoreMenuItem(page)).toBeVisible();
});

test('right-click on a cache row restores it with its source', async ({
  page
}) => {
  const bodies: unknown[] = [];
  await page.route(RESTORE_ROUTE, async route => {
    bodies.push(route.request().postDataJSON());
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        success: true,
        restored_to: CACHE_ITEMS[0].original_path
      })
    });
  });
  await stubLocation(page);
  await openBand(page, 'cache');

  await sectionRows(page, 'cache').first().click({ button: 'right' });
  await expect(restoreMenuItem(page)).toBeVisible();
  await restoreMenuItem(page).click();

  await expect.poll(() => bodies.length).toBe(1);
  expect(bodies[0]).toEqual({
    trash_path: CACHE_ITEMS[0].trash_path,
    source: 'cache'
  });
});

const showVolumesItem = (page: IJupyterLabPageFixture) =>
  page.locator('.lm-Menu .lm-Menu-itemLabel', { hasText: /^Show Volumes$/ });

const hideVolumesItem = (page: IJupyterLabPageFixture) =>
  page.locator('.lm-Menu .lm-Menu-itemLabel', { hasText: /^Hide Volumes$/ });

test('a right-click on the header turns Show Volumes on and the sections show', async ({
  page
}) => {
  await stubSources(page, SOURCES, {
    cache: CACHE_ITEMS,
    'home:alice': ALICE_ITEMS
  });
  await page.goto();
  await openPanel(page);
  await expect(page.locator(`${PANEL} .jp-TrashPanel-section`)).toHaveCount(0);

  await page
    .locator(`${PANEL} .jp-TrashPanel-header`)
    .click({ button: 'right' });
  await expect(showVolumesItem(page)).toBeVisible();
  await showVolumesItem(page).click();

  await expect(page.locator(`${PANEL} .jp-TrashPanel-section`)).toHaveCount(3);
  // One section opens at rest: each other band opens to show its rows
  await openBand(page, 'cache');
  await expect(sectionRows(page, 'cache')).toHaveCount(2);
  await openBand(page, 'home:alice');
  await expect(sectionRows(page, 'home:alice')).toHaveCount(1);
});

test('with Show Volumes off the xdg and location rows are one list', async ({
  page
}) => {
  await stubMainList(page, [stubItem('main-a.txt', '1 KB')]);
  await stubSources(page, [SOURCES[0], LOCATION_SOURCES[3]], {
    [LOCATION_ID]: [LOCATION_ITEM]
  });
  await page.goto();
  await openPanel(page);

  const items = page.locator(
    `${PANEL} .jp-TrashPanel-list .jp-TrashPanel-item`
  );
  await expect(items).toHaveCount(2);
  await expect(items.filter({ hasText: 'main-a.txt' })).toHaveCount(1);
  await expect(
    items.and(page.locator(`[data-source="${LOCATION_ID}"]`))
  ).toContainText('data.csv');
  await expect(page.locator(`${PANEL} .jp-TrashPanel-section`)).toHaveCount(0);
  await expect(page.locator(`${PANEL} .jp-TrashPanel-summaryText`)).toHaveText(
    '2 items \u00B7 2.0 KB'
  );

  // Show Volumes on splits the merged rows: the main list keeps the XDG row
  // and the location row moves to its section; off merges them again.
  const toggleShowVolumes = async (
    item: typeof showVolumesItem
  ): Promise<void> => {
    await page
      .locator(`${PANEL} .jp-TrashPanel-header`)
      .click({ button: 'right' });
    await item(page).click();
  };
  await toggleShowVolumes(showVolumesItem);
  await openBand(page, LOCATION_ID);
  await expect(sectionRows(page, LOCATION_ID)).toHaveCount(1);
  await expect(sectionRows(page, LOCATION_ID)).toContainText('data.csv');
  await expect(items).toHaveCount(1);
  await expect(items).toContainText('main-a.txt');
  await expect(
    items.and(page.locator(`[data-source="${LOCATION_ID}"]`))
  ).toHaveCount(0);

  await toggleShowVolumes(hideVolumesItem);
  await expect(page.locator(`${PANEL} .jp-TrashPanel-section`)).toHaveCount(0);
  await expect(items).toHaveCount(2);
  await expect(
    items.and(page.locator(`[data-source="${LOCATION_ID}"]`))
  ).toContainText('data.csv');
});

test('a right-click on the main list empty space or a section band toggles Show Volumes', async ({
  page
}) => {
  await stubMainList(page, [stubItem('main-a.txt', '1 KB')]);
  await stubSources(page, SOURCES, {
    cache: CACHE_ITEMS,
    'home:alice': ALICE_ITEMS
  });
  await page.goto();
  await openPanel(page);
  await expect(page.locator(`${PANEL} .jp-TrashPanel-section`)).toHaveCount(0);

  // Below the one row is the list's empty space
  const list = page.locator(`${PANEL} .jp-TrashPanel-list`);
  const box = (await list.boundingBox())!;
  await list.click({
    button: 'right',
    position: { x: 20, y: box.height - 8 }
  });
  await expect(showVolumesItem(page)).toBeVisible();
  await showVolumesItem(page).click();
  await openBand(page, 'cache');
  await expect(sectionRows(page, 'cache')).toHaveCount(2);

  await section(page, 'cache')
    .locator('.jp-TrashPanel-sectionBand')
    .click({ button: 'right' });
  await expect(hideVolumesItem(page)).toBeVisible();
  await hideVolumesItem(page).click();
  await expect(page.locator(`${PANEL} .jp-TrashPanel-section`)).toHaveCount(0);
});

const dialog = (page: IJupyterLabPageFixture) => page.locator('.jp-Dialog');

/** Close the open dialog with Cancel, so nothing is sent to the server. */
async function cancelDialog(page: IJupyterLabPageFixture): Promise<void> {
  await dialog(page).getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog(page)).toHaveCount(0);
}

// The cache-buster query follows the path, as on the sources route.
const DELETE_ROUTE = '**/jupyterlab-trash-mgmt-extension/delete*';

test('delete a location row from the merged list', async ({ page }) => {
  const bodies: unknown[] = [];
  await page.route(DELETE_ROUTE, async route => {
    bodies.push(route.request().postDataJSON());
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ success: true })
    });
  });
  await stubMainList(page, [stubItem('main-a.txt', '1 KB')]);
  // The location answers without its row once the delete has reached it
  await stubSources(page, [SOURCES[0], LOCATION_SOURCES[3]], {
    [LOCATION_ID]: route =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(
          stubListing(bodies.length > 0 ? [] : [LOCATION_ITEM])
        )
      })
  });
  await page.goto();
  await openPanel(page);

  const items = page.locator(
    `${PANEL} .jp-TrashPanel-list .jp-TrashPanel-item`
  );
  const row = items.and(page.locator(`[data-source="${LOCATION_ID}"]`));
  await expect(row).toContainText('data.csv');
  await row.click();
  await row.click({ button: 'right' });
  await page
    .locator('.lm-Menu .lm-Menu-itemLabel', {
      hasText: /^Delete Permanently$/
    })
    .click();
  await dialog(page)
    .getByRole('button', { name: 'Delete', exact: true })
    .click();

  await expect.poll(() => bodies.length).toBe(1);
  expect(bodies[0]).toEqual({
    trash_path: LOCATION_ITEM.trash_path,
    source: LOCATION_ID
  });
  await expect(row).toHaveCount(0);
  await expect(items).toHaveCount(1);
});

test('the header trash button lists every source in its dialog', async ({
  page
}) => {
  await stubLocation(page);

  await page.locator(`${PANEL} .jp-TrashPanel-header-button-danger`).click();
  await expect(dialog(page)).toContainText('Empty All Bins');
  for (const text of [
    'Trash (0 items, 0 B)',
    '/home/cache (2 items, 1.2 MB)',
    '/home/alice (1 item, 7 KB)',
    '/mnt/data (1 item, 3 KB)'
  ]) {
    await expect(dialog(page)).toContainText(text);
  }
  await cancelDialog(page);
});

// ACC-SCOPE-106-CLEAN-REPORT: an accepted Empty All Bins reports the totals in
// a success notification, and no result dialog stays open.
test('an accepted Empty All Bins reports in a success notification', async ({
  page
}) => {
  await page.route('**/jupyterlab-trash-mgmt-extension/empty*', route =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        success: true,
        deleted_count: 3,
        sources: [
          { id: 'xdg', label: 'Trash', deleted_count: 2, errors: [] },
          { id: 'cache', label: '/home/cache', deleted_count: 1, errors: [] },
          {
            id: 'home:alice',
            label: '/home/alice',
            deleted_count: 0,
            errors: []
          },
          {
            id: LOCATION_ID,
            label: '/mnt/data',
            deleted_count: 0,
            errors: []
          }
        ]
      })
    })
  );
  await stubLocation(page);

  await page.locator(`${PANEL} .jp-TrashPanel-header-button-danger`).click();
  await expect(dialog(page)).toContainText('Empty All Bins');
  await dialog(page).getByRole('button', { name: 'Empty All Bins' }).click();

  const toast = page.locator('.jp-Notification-Toast-success');
  await expect(toast).toHaveCount(1);
  await expect(toast).toContainText('3 items deleted');
  await expect(dialog(page)).toHaveCount(0);
});

test("a band's trash button names its own source in the dialog", async ({
  page
}) => {
  await stubLocation(page);
  // The harmonica opens one section at rest; open the band whose button empties it
  await openBand(page, LOCATION_ID);

  await section(page, LOCATION_ID)
    .locator('.jp-TrashPanel-sectionEmpty')
    .click();
  await expect(dialog(page)).toContainText('Empty Trash in /mnt/data');
  await expect(dialog(page)).toContainText('/mnt/data (1 item, 3 KB)');
  await expect(dialog(page)).not.toContainText('/home/cache');
  await expect(sectionHeader(page, LOCATION_ID)).toHaveAttribute(
    'aria-expanded',
    'true'
  );
  await cancelDialog(page);
});

// ACC-SCOPE-94-EMPTY-FOCUS: a keyboard empty that disables the band button
// hands the focus to that section's fold toggle, inside the panel.
test('a keyboard empty from a band button leaves the focus on its fold toggle', async ({
  page
}) => {
  const bodies: unknown[] = [];
  await page.route('**/jupyterlab-trash-mgmt-extension/empty*', async route => {
    bodies.push(route.request().postDataJSON());
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ success: true, deleted_count: 1, errors: [] })
    });
  });
  await showVolumesOn(page);
  // Once the empty POST has arrived, the location reports and lists nothing
  const emptied = () => bodies.length > 0;
  await stubSources(page, [SOURCES[0], LOCATION_SOURCES[3]], {
    [LOCATION_ID]: route =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(stubListing(emptied() ? [] : [LOCATION_ITEM]))
      })
  });
  await page.route(SOURCES_ROUTE, route =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([
        SOURCES[0],
        emptied()
          ? {
              ...LOCATION_SOURCES[3],
              item_count: 0,
              total_size: '0 B',
              total_bytes: 0
            }
          : LOCATION_SOURCES[3]
      ])
    })
  );
  await page.goto();
  await openPanel(page);
  await openBand(page, LOCATION_ID);
  await expect(sectionRows(page, LOCATION_ID)).toHaveCount(1);

  const toggle = sectionHeader(page, LOCATION_ID);
  const button = section(page, LOCATION_ID).locator(
    '.jp-TrashPanel-sectionEmpty'
  );
  await toggle.focus();
  await page.keyboard.press('Tab');
  await expect(button).toBeFocused();

  await page.keyboard.press('Enter');
  await expect(dialog(page)).toContainText('Empty Trash in /mnt/data');
  await page.keyboard.press('Enter');
  await expect(dialog(page)).toHaveCount(0);

  await expect.poll(() => bodies.length).toBe(1);
  expect(bodies[0]).toEqual({ scope: 'source', source: LOCATION_ID });
  await expect(button).toBeVisible();
  await expect(button).toBeDisabled();
  await expect(toggle).toBeFocused();
  const focus = await page.evaluate(() => {
    const active = document.activeElement;
    return {
      inPanel:
        document.querySelector('#jp-trash-panel')?.contains(active) ?? false,
      onBody: active === document.body
    };
  });
  expect(focus).toEqual({ inPanel: true, onBody: false });
});

// ACC-SCOPE-104-VOLUME-BANDS: with Show Volumes on, the home band button
// empties the XDG trash alone; the band keeps its height with the button, and
// the summary bar carries no trash button.
test('the home band trash button names the home trash in its dialog', async ({
  page
}) => {
  await showVolumesOn(page);
  await stubMainList(page, [stubItem('main-a.txt', '1 KB')]);
  await stubSources(
    page,
    [
      { ...SOURCES[0], item_count: 1, total_size: '1 KB', total_bytes: 1024 },
      ...SOURCES.slice(1)
    ],
    { cache: CACHE_ITEMS, 'home:alice': ALICE_ITEMS }
  );
  await page.goto();
  await openPanel(page);

  const bar = section(page, 'xdg').locator('.jp-TrashPanel-sectionBand');
  const button = bar.locator('.jp-TrashPanel-sectionEmpty');
  await expect(button).toBeVisible();
  await expect(button).toBeEnabled();
  await expect(
    page.locator(`${PANEL} .jp-TrashPanel-summary button`)
  ).toHaveCount(0);
  const withButton = (await bar.boundingBox())!;
  const box = (await button.boundingBox())!;
  await button.evaluate(
    element => ((element as HTMLElement).style.display = 'none')
  );
  const withoutButton = (await bar.boundingBox())!;
  await button.evaluate(
    element => ((element as HTMLElement).style.display = '')
  );
  expect(withButton.height).toBeCloseTo(21, 0);
  expect(withButton.height).toBeCloseTo(withoutButton.height, 0);
  expect(box.height).toBeLessThanOrEqual(withButton.height);
  expect(box.x + box.width).toBeLessThan(withButton.x + withButton.width);

  await button.click();
  await expect(dialog(page)).toContainText('Empty Trash in Trash');
  await expect(dialog(page)).toContainText('Trash (1 item, 1 KB)');
  await expect(dialog(page)).not.toContainText('/home/cache');
  await cancelDialog(page);
});

test('a band is 21px with an enabled and a disabled trash button, and the button is no taller', async ({
  page
}) => {
  await showVolumesOn(page);
  await stubSources(
    page,
    [
      ...SOURCES,
      {
        id: 'home:bob',
        label: '/home/bob',
        item_count: 0,
        total_size: '0 B',
        total_bytes: 0,
        error: '',
        mountpoint: '/home'
      }
    ],
    { cache: CACHE_ITEMS, 'home:alice': ALICE_ITEMS }
  );
  await page.goto();
  await openPanel(page);

  const band = (id: string) =>
    section(page, id).locator('.jp-TrashPanel-sectionBand');
  const button = (id: string) =>
    section(page, id).locator('.jp-TrashPanel-sectionEmpty');
  await expect(button('cache')).toBeVisible();
  await expect(button('cache')).toBeEnabled();
  await expect(button('home:bob')).toBeVisible();
  await expect(button('home:bob')).toBeDisabled();

  const withButton = (await band('cache').boundingBox())!;
  const withDisabled = (await band('home:bob').boundingBox())!;
  const box = (await button('cache').boundingBox())!;
  expect(withButton.height).toBeCloseTo(21, 0);
  expect(withDisabled.height).toBeCloseTo(21, 0);
  expect(box.height).toBeLessThanOrEqual(withButton.height);
});

// ACC-SCOPE-97-BUTTON-BOX, ACC-SCOPE-104-VOLUME-BANDS
test('the band and home band trash buttons draw an 18px box inside their band, and the home band names the XDG trash', async ({
  page
}) => {
  const xdgLabel = '~';
  await showVolumesOn(page);
  await stubMainList(page, [stubItem('main-a.txt', '1 KB')]);
  await stubSources(
    page,
    [
      {
        ...SOURCES[0],
        label: xdgLabel,
        item_count: 1,
        total_size: '1 KB',
        total_bytes: 1024
      },
      ...SOURCES.slice(1)
    ],
    { cache: CACHE_ITEMS, 'home:alice': ALICE_ITEMS }
  );
  await page.goto();
  await openPanel(page);

  // The summary bar keeps the total of every trash, with no label
  await expect(page.locator(`${PANEL} .jp-TrashPanel-summaryText`)).toHaveText(
    '4 items \u00B7 1.2 MB'
  );
  await expect(
    sectionLabel(page, 'xdg').locator('.jp-TrashPanel-sectionText')
  ).toHaveAttribute('title', `${xdgLabel} on /`);

  type Box = { x: number; y: number; width: number; height: number };
  const expectInside = (box: Box, outer: Box): void => {
    expect(box.width).toBeCloseTo(18, 0);
    expect(box.height).toBeCloseTo(18, 0);
    expect(box.x).toBeGreaterThan(outer.x);
    expect(box.y).toBeGreaterThan(outer.y);
    expect(box.x + box.width).toBeLessThan(outer.x + outer.width);
    expect(box.y + box.height).toBeLessThan(outer.y + outer.height);
  };

  // The hover paints the button's own box, so that box is the red one
  const band = section(page, 'cache').locator('.jp-TrashPanel-sectionBand');
  const bandButton = section(page, 'cache').locator(
    '.jp-TrashPanel-sectionEmpty'
  );
  await bandButton.hover();
  await expect(bandButton).not.toHaveCSS(
    'background-color',
    'rgba(0, 0, 0, 0)'
  );
  const bandBox = (await band.boundingBox())!;
  expect(bandBox.height).toBeCloseTo(21, 0);
  expectInside((await bandButton.boundingBox())!, bandBox);

  const home = section(page, 'xdg').locator('.jp-TrashPanel-sectionBand');
  const homeButton = home.locator('.jp-TrashPanel-sectionEmpty');
  await homeButton.hover();
  await expect(homeButton).not.toHaveCSS(
    'background-color',
    'rgba(0, 0, 0, 0)'
  );
  expectInside((await homeButton.boundingBox())!, (await home.boundingBox())!);
});

// ACC-SCOPE-95-BAND-LINE: at 280px a long label takes the ellipsis and keeps
// its full text in the title; the band stays one 21px line and the count shows.
test('a band with a long label stays one 21px line at 280px and keeps its count', async ({
  page
}) => {
  const label = '/mnt/a-very-long-network-volume-name/with/many/nested/folders';
  const id = `location:${label}/.Trash-1000`;
  await showVolumesOn(page);
  await stubSources(
    page,
    [
      ...SOURCES,
      {
        id,
        label,
        item_count: 1,
        total_size: '3 KB',
        total_bytes: 3072,
        error: '',
        mountpoint: '/mnt/a-very-long-network-volume-name'
      }
    ],
    { cache: CACHE_ITEMS, 'home:alice': ALICE_ITEMS, [id]: [LOCATION_ITEM] }
  );
  await page.goto();
  await openPanel(page);
  await openBand(page, id);
  await expect(sectionRows(page, id)).toHaveCount(1);

  await page.evaluate(() => {
    const panel = document.querySelector('#jp-trash-panel') as HTMLElement;
    panel.style.width = '280px';
  });
  const text = sectionLabel(page, id).locator('.jp-TrashPanel-sectionText');
  const count = sectionLabel(page, id).locator('.jp-TrashPanel-sectionCount');
  await expect(text).toHaveAttribute(
    'title',
    `${label} on /mnt/a-very-long-network-volume-name`
  );
  await expect(count).toBeVisible();

  const band = (await section(page, id)
    .locator('.jp-TrashPanel-sectionBand')
    .boundingBox())!;
  const header = (await sectionHeader(page, id).boundingBox())!;
  const countBox = (await count.boundingBox())!;
  const truncated = await text.evaluate(
    element => element.scrollWidth > element.clientWidth
  );
  expect(band.width).toBeLessThanOrEqual(280);
  expect(band.height).toBeCloseTo(21, 0);
  expect(countBox.x + countBox.width).toBeLessThanOrEqual(
    header.x + header.width + 0.5
  );
  expect(truncated).toBe(true);
});

// ACC-SCOPE-100-MENU-EVERYWHERE: a mouse-opened row menu returns the focus to
// the main list, which draws no focus outline (DEF-PANEL-34-FOCUS-RING)
test('Escape from a mouse-opened row menu focuses the main list with no outline', async ({
  page
}) => {
  await stubMainList(page, [
    stubItem('main-a.txt', '1 KB'),
    stubItem('main-b.txt', '2 KB')
  ]);
  await stubSources(page, [SOURCES[0]], {});
  await page.goto();
  await openPanel(page);

  const row = page.locator(`${PANEL} .jp-TrashPanel-list .jp-TrashPanel-item`, {
    hasText: 'main-b.txt'
  });
  await row.click({ button: 'right' });
  const menu = page.locator('.lm-Menu');
  await expect(menu).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);

  const focus = await page.evaluate(() => {
    const list = document.querySelector('#jp-trash-panel .jp-TrashPanel-list');
    return {
      onList: document.activeElement === list,
      outline: list === null ? '' : getComputedStyle(list).outlineStyle
    };
  });
  expect(focus).toEqual({ onList: true, outline: 'none' });
});

// ACC-KEYS-102-NEIGHBOUR-ROW (DEF-PANEL-39-LIST-JUMP): a Delete confirmed with
// Enter keeps the list's scroll position and makes the next row active
test('Delete from a mouse-opened menu in a scrolled list keeps the scroll and activates the next row', async ({
  page
}) => {
  const all = Array.from({ length: 60 }, (_, i) =>
    stubItem(`row-${String(i).padStart(2, '0')}.txt`, '1 KB')
  );
  const deleted: string[] = [];
  await page.route(DELETE_ROUTE, async route => {
    deleted.push(route.request().postDataJSON().trash_path);
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ success: true })
    });
  });
  await page.route(
    url =>
      url.pathname.endsWith('/jupyterlab-trash-mgmt-extension/list') &&
      !url.searchParams.has('source'),
    route =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(
          stubListing(all.filter(item => !deleted.includes(item.trash_path)))
        )
      })
  );
  await stubSources(page, [SOURCES[0]], {});
  await page.goto();
  await openPanel(page);

  const items = page.locator(
    `${PANEL} .jp-TrashPanel-list .jp-TrashPanel-item`
  );
  await expect(items).toHaveCount(60);
  // Scroll the list, then take a row in view whose next row is in view too
  const picked = await page.evaluate(() => {
    const list = document.querySelector<HTMLElement>(
      '#jp-trash-panel .jp-TrashPanel-list'
    )!;
    list.scrollTop = 400;
    const box = list.getBoundingClientRect();
    const rows = Array.from(
      list.querySelectorAll<HTMLElement>('.jp-TrashPanel-item')
    );
    const inView = (row: HTMLElement) => {
      const rect = row.getBoundingClientRect();
      return rect.top >= box.top && rect.bottom <= box.bottom;
    };
    const at = rows.findIndex(
      (row, i) =>
        inView(row) && rows[i + 1] !== undefined && inView(rows[i + 1])
    );
    const name = (row: HTMLElement) =>
      row.querySelector('.jp-TrashPanel-item-name')!.textContent!;
    return {
      scrollTop: list.scrollTop,
      row: name(rows[at]),
      next: name(rows[at + 1])
    };
  });
  expect(picked.scrollTop).toBeGreaterThan(0);

  await items.filter({ hasText: picked.row }).click({ button: 'right' });
  await page
    .locator('.lm-Menu .lm-Menu-itemLabel', {
      hasText: /^Delete Permanently$/
    })
    .click();
  await expect(dialog(page)).toBeVisible();
  await page.keyboard.press('Enter');

  await expect.poll(() => deleted.length).toBe(1);
  await expect(items).toHaveCount(59);
  await expect(
    page.locator(
      `${PANEL} .jp-TrashPanel-list .jp-TrashPanel-item.jp-mod-active`
    )
  ).toContainText(picked.next);
  const scrollTop = await page.evaluate(
    () =>
      document.querySelector<HTMLElement>(
        '#jp-trash-panel .jp-TrashPanel-list'
      )!.scrollTop
  );
  expect(Math.abs(scrollTop - picked.scrollTop)).toBeLessThanOrEqual(1);
});

// DEF-PANEL-40-EMPTY-DISABLED: the header trash button stays, disabled, in the
// design system's disabled state, with no danger hover
test('with every trash empty the header trash button is visible and disabled', async ({
  page
}) => {
  await stubMainList(page, []);
  await stubSources(page, [SOURCES[0]], {});
  await page.goto();
  await openPanel(page);

  const button = page.locator(`${PANEL} .jp-TrashPanel-header-button-danger`);
  await expect(button).toBeVisible();
  await expect(button).toBeDisabled();
  await expect(button).toHaveAttribute('title', 'Empty Trash');
  await expect(button).toHaveCSS('opacity', '0.4');
  await button.hover();
  await expect(button).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
});

// DEF-PANEL-40-EMPTY-DISABLED, DEF-PANEL-41-SECTION-EMPTY
test('with Show Volumes on, an empty location band shows Trash is empty and its trash button is disabled', async ({
  page
}) => {
  await showVolumesOn(page);
  await stubSources(
    page,
    [
      SOURCES[0],
      {
        ...LOCATION_SOURCES[3],
        item_count: 0,
        total_size: '0 B',
        total_bytes: 0
      }
    ],
    { [LOCATION_ID]: [] }
  );
  await page.goto();
  await openPanel(page);

  const line = section(page, LOCATION_ID).locator('.jp-TrashPanel-empty');
  // The folded band shows no line; opening it shows the empty line
  await expect(line).toBeHidden();
  await openBand(page, LOCATION_ID);
  await expect(line).toBeVisible();
  await expect(line).toHaveText('Trash is empty');
  await expect(line).toHaveCSS('font-style', 'italic');
  const button = section(page, LOCATION_ID).locator(
    '.jp-TrashPanel-sectionEmpty'
  );
  await expect(button).toBeVisible();
  await expect(button).toBeDisabled();

  // A folded band shows no line
  await sectionHeader(page, LOCATION_ID).click();
  await expect(line).toBeHidden();
});

// ACC-SCOPE-103-HIDE-VOLUMES
test('the panel right-click menu reads Hide Volumes, choosing it hides the bands and the next right-click reads Show Volumes', async ({
  page
}) => {
  await showVolumesOn(page);
  await stubSources(page, SOURCES, {
    cache: CACHE_ITEMS,
    'home:alice': ALICE_ITEMS
  });
  await page.goto();
  await openPanel(page);
  await expect(page.locator(`${PANEL} .jp-TrashPanel-section`)).toHaveCount(3);

  const header = page.locator(`${PANEL} .jp-TrashPanel-header`);
  await header.click({ button: 'right' });
  await expect(hideVolumesItem(page)).toBeVisible();
  await expect(showVolumesItem(page)).toHaveCount(0);
  await expect(
    page.locator('.lm-Menu .lm-Menu-item.lm-mod-toggled')
  ).toHaveCount(0);
  await hideVolumesItem(page).click();
  await expect(page.locator(`${PANEL} .jp-TrashPanel-section`)).toHaveCount(0);

  await header.click({ button: 'right' });
  await expect(showVolumesItem(page)).toBeVisible();
  await expect(hideVolumesItem(page)).toHaveCount(0);
  await page.keyboard.press('Escape');
});

// ACC-SCOPE-104-VOLUME-BANDS: under the total line the home band ~ sits behind
// the layout-color3 divider, one 21px line, and folds the main list
test('the home band sits under the summary bar behind a layout-color3 line, folds the main list, and the bar totals the band counts', async ({
  page
}) => {
  await showVolumesOn(page);
  await stubMainList(page, [
    stubItem('main-a.txt', '1 KB'),
    stubItem('main-b.txt', '1 KB')
  ]);
  await stubSources(
    page,
    [
      {
        ...SOURCES[0],
        label: '~',
        item_count: 2,
        total_size: '2.0 KB',
        total_bytes: 2048
      },
      ...SOURCES.slice(1)
    ],
    { cache: CACHE_ITEMS, 'home:alice': ALICE_ITEMS }
  );
  await page.goto();
  await openPanel(page);
  await expect(sectionLabel(page, 'xdg')).toHaveText('~ (2 items, 2.0 KB)');

  // Show the cache rows, then reopen the home section for the fold case
  await openBand(page, 'cache');
  await expect(sectionRows(page, 'cache')).toHaveCount(2);
  await openBand(page, 'xdg');
  await expect(sectionHeader(page, 'xdg')).toHaveAttribute(
    'aria-expanded',
    'true'
  );
  await expect(page.locator(`${PANEL} .jp-TrashPanel-item`)).toHaveCount(2);

  // The total line is the sum of every band's count
  const counts = await page
    .locator(`${PANEL} .jp-TrashPanel-sectionCount`)
    .allTextContents();
  const sum = counts.reduce(
    (total, text) => total + Number(/\((\d+) items?,/.exec(text)![1]),
    0
  );
  expect(counts).toHaveLength(3);
  expect(sum).toBe(5);
  await expect(page.locator(`${PANEL} .jp-TrashPanel-summaryText`)).toHaveText(
    `${sum} items \u00B7 1.2 MB`
  );

  const geometry = await page.evaluate(() => {
    const panel = document.querySelector('#jp-trash-panel') as HTMLElement;
    const bar = panel.querySelector('.jp-TrashPanel-summary') as HTMLElement;
    const column = panel.querySelector(
      '.jp-TrashPanel-sections'
    ) as HTMLElement;
    const home = column.querySelector(
      '.jp-TrashPanel-section[data-source="xdg"]'
    ) as HTMLElement;
    const band = home.querySelector(
      '.jp-TrashPanel-sectionBand'
    ) as HTMLElement;
    // The token's computed colour, read from a probe in the panel's theme
    const probe = document.createElement('div');
    probe.style.color = 'var(--jp-layout-color3)';
    panel.appendChild(probe);
    const expected = getComputedStyle(probe).color;
    probe.remove();
    const line = getComputedStyle(home);
    return {
      next: bar.nextElementSibling === column,
      homeFirst: column.firstElementChild === home,
      barLine: getComputedStyle(bar).borderBottomWidth,
      barBottom: bar.getBoundingClientRect().bottom,
      bandTop: band.getBoundingClientRect().top,
      bandHeight: band.getBoundingClientRect().height,
      lineWidth: line.borderTopWidth,
      lineStyle: line.borderTopStyle,
      lineColour: line.borderTopColor,
      expected
    };
  });
  expect(geometry.next).toBe(true);
  expect(geometry.homeFirst).toBe(true);
  expect(geometry.barLine).toBe('0px');
  expect(geometry.lineWidth).toBe('1px');
  expect(geometry.lineStyle).toBe('solid');
  expect(geometry.lineColour).toBe(geometry.expected);
  expect(geometry.bandTop - geometry.barBottom).toBeCloseTo(1, 0);
  expect(geometry.bandHeight).toBeCloseTo(21, 0);

  // Folding hides the main list; the next band moves up under the home band
  const next = section(page, 'cache');
  const before = (await next.boundingBox())!;
  await sectionHeader(page, 'xdg').click();
  await expect(sectionHeader(page, 'xdg')).toHaveAttribute(
    'aria-expanded',
    'false'
  );
  await expect(page.locator(`${PANEL} .jp-TrashPanel-list`)).toBeHidden();
  await expect(
    page.locator(`${PANEL} .jp-TrashPanel-columnHeader`)
  ).toBeHidden();
  const home = (await section(page, 'xdg').boundingBox())!;
  const after = (await next.boundingBox())!;
  expect(after.y).toBeLessThan(before.y);
  expect(Math.abs(after.y - (home.y + home.height))).toBeLessThanOrEqual(1);
  // The folded band draws the line under it
  await expect(section(page, 'xdg')).toHaveCSS('border-bottom-width', '1px');
});

/** The computed colour of a theme token, read from a probe in the panel. */
async function tokenColour(
  page: IJupyterLabPageFixture,
  token: string
): Promise<string> {
  return page.evaluate(name => {
    const probe = document.createElement('div');
    probe.style.color = `var(${name})`;
    document.querySelector('#jp-trash-panel')!.appendChild(probe);
    const colour = getComputedStyle(probe).color;
    probe.remove();
    return colour;
  }, token);
}

// With Show Volumes off the summary bar keeps its line, as before the bands
test('with Show Volumes off the summary bar draws a 1px border-color2 line under it', async ({
  page
}) => {
  await stubSources(page, SOURCES, {});
  await page.goto();
  await openPanel(page);
  await expect(page.locator(`${PANEL} .jp-TrashPanel-section`)).toHaveCount(0);

  const bar = page.locator(`${PANEL} .jp-TrashPanel-summary`);
  await expect(bar).toHaveCSS('border-bottom-width', '1px');
  await expect(bar).toHaveCSS('border-bottom-style', 'solid');
  await expect(bar).toHaveCSS(
    'border-bottom-color',
    await tokenColour(page, '--jp-border-color2')
  );
});

// Dividers of a docked panel: an expanded band that shows no rows and no
// empty line draws the layout-color3 line above the next band
test('a band whose listing fails draws a 1px layout-color3 line above the next band', async ({
  page
}) => {
  await showVolumesOn(page);
  await stubSources(page, SOURCES, {
    cache: route =>
      route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'listing failed' })
      }),
    'home:alice': ALICE_ITEMS
  });
  await page.goto();
  await openPanel(page);
  // The cache band is folded at load; open it to show the failed listing
  await expect(sectionHeader(page, 'cache')).toHaveAttribute(
    'aria-expanded',
    'false'
  );
  await openBand(page, 'cache');
  await expect(sectionLabel(page, 'cache')).toHaveText(/^\/home\/cache: /);
  await expect(sectionHeader(page, 'cache')).toHaveAttribute(
    'aria-expanded',
    'true'
  );
  await expect(sectionRows(page, 'cache')).toHaveCount(0);
  await expect(
    section(page, 'cache').locator('.jp-TrashPanel-empty')
  ).toBeHidden();

  const failed = section(page, 'cache');
  await expect(failed).toHaveCSS('border-bottom-width', '1px');
  await expect(failed).toHaveCSS('border-bottom-style', 'solid');
  await expect(failed).toHaveCSS(
    'border-bottom-color',
    await tokenColour(page, '--jp-layout-color3')
  );
  const band = (await failed
    .locator('.jp-TrashPanel-sectionBand')
    .boundingBox())!;
  const next = (await section(page, 'home:alice')
    .locator('.jp-TrashPanel-sectionBand')
    .boundingBox())!;
  expect(next.y - (band.y + band.height)).toBeCloseTo(1, 0);
});

// ACC-FILTER-105-QUERY: typing in the header filter narrows the visible rows
// to the name or original path containing the text, ignoring case; clearing
// restores every row.
test('the header filter narrows the main list and clearing restores it', async ({
  page
}) => {
  await stubSources(page, SOURCES, {});
  await stubMainList(page, [
    stubItem('alpha.txt', '1 KB'),
    stubItem('beta.txt', '1 KB'),
    stubItem('folder-a', '1 KB')
  ]);
  await page.goto();
  await openPanel(page);

  const listRows = page.locator(
    `${PANEL} .jp-TrashPanel-list .jp-TrashPanel-item`
  );
  await expect(listRows).toHaveCount(3);

  await page.locator(`${PANEL} button[title="Filter trash"]`).click();
  const field = page.getByRole('searchbox', { name: 'Filter trash' });
  await expect(field).toBeVisible();
  await field.fill('ALP');
  await expect(listRows).toHaveCount(1);
  await expect(listRows.first().locator('.jp-TrashPanel-item-name')).toHaveText(
    'alpha.txt'
  );
  // The summary keeps the unfiltered count
  await expect(page.locator(`${PANEL} .jp-TrashPanel-summary`)).toContainText(
    '3 items'
  );

  await page.locator(`${PANEL} .jp-TrashPanel-filterClear`).click();
  await expect(listRows).toHaveCount(3);
});
