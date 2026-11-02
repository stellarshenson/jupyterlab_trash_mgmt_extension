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
 *
 * Every answer the section UI reads is stubbed with page.route, so the test
 * controls the data and reads nothing from the real trash. The main listing
 * (GET .../list without a source) is left to the real server; under the
 * bubblewrap runner that is the seeded trash, never the developer's own.
 */

const TAB = 'li.lm-TabBar-tab[data-id="jp-trash-panel"]';
const PANEL = '#jp-trash-panel';
// ServerConnection appends a cache-buster query to every request, so the
// sources pattern ends in * to admit it; the list pattern's own * admits it.
const SOURCES_ROUTE = '**/jupyterlab-trash-mgmt-extension/sources*';
const SOURCE_LIST_ROUTE = '**/jupyterlab-trash-mgmt-extension/list?source=*';

interface IStubSource {
  id: string;
  label: string;
  item_count: number;
  total_size: string;
  error: string;
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
  { id: 'xdg', label: 'Trash', item_count: 0, total_size: '0 B', error: '' },
  {
    id: 'cache',
    label: '/home/cache',
    item_count: 2,
    total_size: '1.2 MB',
    error: ''
  },
  {
    id: 'home:alice',
    label: '/home/alice',
    item_count: 1,
    total_size: '7 KB',
    error: ''
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

test.use({ autoGoto: false });

test('renders one section per source, in server order, with its own count and size', async ({
  page
}) => {
  await stubSources(page, SOURCES, {
    cache: CACHE_ITEMS,
    'home:alice': ALICE_ITEMS
  });
  await page.goto();
  await openPanel(page);

  const sections = page.locator(`${PANEL} .jp-TrashPanel-section[data-source]`);
  await expect(sections).toHaveCount(2);
  const order = await sections.evaluateAll(elements =>
    elements.map(element => (element as HTMLElement).dataset.source)
  );
  expect(order).toEqual(['cache', 'home:alice']);

  // Each header carries its own source's count and size.
  await expect(sectionLabel(page, 'cache')).toHaveText(
    '/home/cache (2 items, 1.2 MB)'
  );
  await expect(sectionLabel(page, 'home:alice')).toHaveText(
    '/home/alice (1 item, 7 KB)'
  );

  // The sections sit below the main listing, which stays the xdg trash.
  const belowMainList = await page.evaluate(() => {
    const main = document.querySelector('#jp-trash-panel .jp-TrashPanel-list');
    const first = document.querySelector(
      '#jp-trash-panel .jp-TrashPanel-section'
    );
    return (
      main !== null &&
      first !== null &&
      (main.compareDocumentPosition(first) &
        Node.DOCUMENT_POSITION_FOLLOWING) !==
        0
    );
  });
  expect(belowMainList).toBe(true);
  await expect(page.locator(`${PANEL} [data-source="xdg"]`)).toHaveCount(0);
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

test('a header click collapses a section and the state survives a reload', async ({
  page
}) => {
  await stubSources(page, SOURCES, {
    cache: CACHE_ITEMS,
    'home:alice': ALICE_ITEMS
  });
  await page.goto();
  await openPanel(page);

  await expect(sectionHeader(page, 'cache')).toHaveAttribute(
    'aria-expanded',
    'true'
  );
  await expect(sectionRows(page, 'cache')).toHaveCount(2);

  await sectionHeader(page, 'cache').click();
  await expect(sectionHeader(page, 'cache')).toHaveAttribute(
    'aria-expanded',
    'false'
  );
  await expect(sectionList(page, 'cache')).toBeHidden();
  await expect(sectionLabel(page, 'cache')).toHaveText(
    '/home/cache (2 items, 1.2 MB)'
  );
  // The other section is untouched by the toggle.
  await expect(sectionHeader(page, 'home:alice')).toHaveAttribute(
    'aria-expanded',
    'true'
  );

  await page.reload();
  await openPanel(page);

  await expect(sectionHeader(page, 'cache')).toHaveAttribute(
    'aria-expanded',
    'false'
  );
  await expect(sectionList(page, 'cache')).toBeHidden();
  await expect(sectionLabel(page, 'cache')).toHaveText(
    '/home/cache (2 items, 1.2 MB)'
  );
  await expect(sectionRows(page, 'home:alice')).toHaveCount(1);

  await sectionHeader(page, 'cache').click();
  await expect(sectionHeader(page, 'cache')).toHaveAttribute(
    'aria-expanded',
    'true'
  );
  await expect(sectionList(page, 'cache')).toBeVisible();
  await expect(sectionRows(page, 'cache')).toHaveCount(2);
});

test('Enter and Space on a focused header toggle its section', async ({
  page
}) => {
  await stubSources(page, SOURCES, {
    cache: CACHE_ITEMS,
    'home:alice': ALICE_ITEMS
  });
  await page.goto();
  await openPanel(page);

  const header = sectionHeader(page, 'cache');
  await header.focus();
  await expect(header).toBeFocused();

  await page.keyboard.press('Enter');
  await expect(header).toHaveAttribute('aria-expanded', 'false');
  await expect(sectionList(page, 'cache')).toBeHidden();

  await page.keyboard.press('Space');
  await expect(header).toHaveAttribute('aria-expanded', 'true');
  await expect(sectionList(page, 'cache')).toBeVisible();
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

  await stubSources(page, SOURCES, {
    cache: CACHE_ITEMS,
    'home:alice': heldAlice
  });
  await page.goto();
  try {
    await openPanel(page);
    // The route matched: the held source is pending, not absent.
    await aliceRequested;

    // The cache section renders while home:alice is still unanswered.
    await expect(sectionRows(page, 'cache')).toHaveCount(2);
    await expect(sectionRows(page, 'home:alice')).toHaveCount(0);
    await expect(sectionHeader(page, 'home:alice')).toHaveAttribute(
      'aria-expanded',
      'true'
    );

    release();
    await expect(sectionRows(page, 'home:alice')).toHaveCount(1);
  } finally {
    // Release any handler a tick started and drop the route, so the test
    // cannot be left waiting on the held answer.
    release();
    await page.unroute(SOURCE_LIST_ROUTE).catch(() => {});
  }
});

test('the section header and caret carry no motion', async ({ page }) => {
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

test('expanded sections keep a 40 percent cap and leave the main list its share', async ({
  page
}) => {
  const many = (prefix: string) =>
    Array.from({ length: 60 }, (_, index) =>
      stubItem(`${prefix}-${String(index).padStart(2, '0')}.txt`, '1 KB')
    );
  const sources: IStubSource[] = [
    { id: 'xdg', label: 'Trash', item_count: 0, total_size: '0 B', error: '' },
    {
      id: 'cache',
      label: '/home/cache',
      item_count: 60,
      total_size: '60 MB',
      error: ''
    },
    {
      id: 'home:alice',
      label: '/home/alice',
      item_count: 60,
      total_size: '60 KB',
      error: ''
    }
  ];
  await stubSources(page, sources, {
    cache: many('cache'),
    'home:alice': many('alice')
  });
  await page.goto();
  await openPanel(page);
  await expect(sectionRows(page, 'cache')).toHaveCount(60);
  await expect(sectionRows(page, 'home:alice')).toHaveCount(60);

  const measured = await page.evaluate(() => {
    const panel = document.querySelector('#jp-trash-panel') as HTMLElement;
    panel.style.width = '480px';
    panel.style.height = '500px';
    // The seeded trash can be empty, which hides the list behind the empty
    // placeholder. Show the list slot and hide the placeholder, so the flex
    // rule that decides the list's height is the one measured.
    const list = panel.querySelector('.jp-TrashPanel-list') as HTMLElement;
    const empty = panel.querySelector('.jp-TrashPanel-empty') as HTMLElement;
    list.style.display = 'block';
    empty.style.display = 'none';
    const sections = panel.querySelector(
      '.jp-TrashPanel-sections'
    ) as HTMLElement;
    const panelHeight = panel.getBoundingClientRect().height;
    return {
      panelHeight,
      listHeight: list.getBoundingClientRect().height,
      sectionsHeight: sections.getBoundingClientRect().height,
      sectionsMaxHeight: getComputedStyle(sections).maxHeight
    };
  });

  // Chrome reports the specified 40% as-is; a browser that resolves it to
  // pixels is accepted too.
  const sectionsMaxPercent = measured.sectionsMaxHeight.endsWith('%')
    ? Number.parseFloat(measured.sectionsMaxHeight)
    : (Number.parseFloat(measured.sectionsMaxHeight) / measured.panelHeight) *
      100;

  console.log(
    `PANEL_HEIGHT=${measured.panelHeight} LIST_HEIGHT=${measured.listHeight} ` +
      `SECTIONS_HEIGHT=${measured.sectionsHeight} ` +
      `SECTIONS_MAX_HEIGHT=${measured.sectionsMaxHeight}`
  );

  expect(measured.panelHeight).toBeCloseTo(500, 0);
  // The sections must not squeeze the main list out of the panel.
  expect(measured.listHeight).toBeGreaterThanOrEqual(
    0.3 * measured.panelHeight
  );
  expect(sectionsMaxPercent).toBeCloseTo(40, 0);
  expect(measured.sectionsHeight).toBeLessThanOrEqual(
    (sectionsMaxPercent / 100) * measured.panelHeight + 1
  );
});
