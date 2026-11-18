/**
 * Unit tests for the trash panel widget, with the server replaced by a mock.
 */

import { ServerConnection } from '@jupyterlab/services';
import { PageConfig } from '@jupyterlab/coreutils';
import { MessageLoop } from '@lumino/messaging';
import { showDialog, showErrorMessage } from '@jupyterlab/apputils';
import { requestAPI } from '../request';
import { TrashWidget } from '../widget';

jest.mock('../request', () => ({ requestAPI: jest.fn() }));

jest.mock('@jupyterlab/apputils', () => ({
  showDialog: jest.fn(),
  showErrorMessage: jest.fn(),
  Dialog: { cancelButton: jest.fn(), warnButton: jest.fn() }
}));

jest.mock('../icon', () => {
  const icon = (name: string) => ({
    element: ({ container }: { container: HTMLElement }) => {
      const svg = document.createElement('svg');
      svg.dataset.icon = name;
      container.appendChild(svg);
      return container;
    }
  });
  return {
    trashIcon: icon('trash'),
    folderIcon: icon('folder'),
    fileIcon: icon('file'),
    refreshIcon: icon('refresh')
  };
});

// The filter glyphs come from ui-components; its root index pulls in the
// React form components, whose ESM dependencies jest does not transform.
jest.mock('@jupyterlab/ui-components', () => {
  const icon = (name: string) => ({
    element: ({ container }: { container: HTMLElement }) => {
      const svg = document.createElement('svg');
      svg.dataset.icon = name;
      container.appendChild(svg);
      return container;
    }
  });
  return { closeIcon: icon('close'), filterIcon: icon('filter') };
});

const request = requestAPI as jest.Mock;
const settings = {} as ServerConnection.ISettings;

interface IRow {
  name: string;
  trash_path: string;
  is_dir?: boolean;
  is_symlink?: boolean;
  size?: number;
  deletion_date?: string;
}

/** Build a `list` response the way the server shapes it. */
function listOf(rows: IRow[], totalSize = '0 B') {
  return {
    items: rows.map(row => ({
      original_path: `/home/user/${row.trash_path}`,
      deletion_date: '2024-01-14T09:00:00',
      size: 0,
      size_formatted: '0 B',
      is_dir: false,
      is_symlink: false,
      ...row
    })),
    total_size: 0,
    total_size_formatted: totalSize,
    item_count: rows.length
  };
}

const file = (name: string, folder = ''): IRow => ({
  name,
  trash_path: folder ? `${folder}/${name}` : name
});

const folder = (name: string, parent = ''): IRow => ({
  ...file(name, parent),
  is_dir: true
});

/** A promise that the test settles by hand. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** The error `requestAPI` throws for a response with this HTTP status. */
function httpError(status: number) {
  return Object.assign(new Error(`HTTP ${status}`), { response: { status } });
}

type Route = unknown | (() => Promise<unknown>);

/**
 * Answer each end point from a table; an end point outside it fails the test.
 * The source list defaults to empty, so a test that does not care about the
 * extra sections still loads.
 */
function serve(routes: Record<string, Route>): Record<string, Route> {
  request.mockImplementation((endPoint: string) => {
    if (endPoint === 'sources' && !(endPoint in routes)) {
      return Promise.resolve([]);
    }
    if (!(endPoint in routes)) {
      return Promise.reject(new Error(`unexpected request: ${endPoint}`));
    }
    const route = routes[endPoint];
    return typeof route === 'function' ? route() : Promise.resolve(route);
  });
  return routes;
}

/** End points requested so far, oldest first, without the source list. */
function requested(): string[] {
  return request.mock.calls
    .map(call => call[0])
    .filter(endPoint => endPoint !== 'sources');
}

/** Let pending requests run out. */
async function settle(): Promise<void> {
  await jest.advanceTimersByTimeAsync(600);
}

/** Build a widget and run its first load. */
async function open(routes: Record<string, Route>): Promise<TrashWidget> {
  serve(routes);
  const widget = new TrashWidget(settings);
  void widget.refresh();
  await settle();
  return widget;
}

/** Run the first load, then attach the widget, so `focus()` works. */
async function openAttached(
  routes: Record<string, Route>
): Promise<TrashWidget> {
  const widget = await open(routes);
  document.body.appendChild(widget.node);
  return widget;
}

const find = <T extends HTMLElement = HTMLElement>(
  widget: TrashWidget,
  selector: string
): T => widget.node.querySelector<T>(selector)!;

const rows = (widget: TrashWidget): HTMLElement[] =>
  Array.from(widget.node.querySelectorAll<HTMLElement>('.jp-TrashPanel-item'));

const rowNames = (widget: TrashWidget): string[] =>
  rows(widget).map(
    row => row.querySelector('.jp-TrashPanel-item-name')!.textContent!
  );

const refreshButton = (widget: TrashWidget) =>
  find<HTMLButtonElement>(widget, 'button[title="Refresh"]');

const emptyButton = (widget: TrashWidget) =>
  find<HTMLButtonElement>(widget, 'button[title="Empty Trash"]');

const veil = (widget: TrashWidget) => find(widget, '.jp-TrashPanel-loading');

const summary = (widget: TrashWidget) => find(widget, '.jp-TrashPanel-summary');

const breadcrumb = (widget: TrashWidget) =>
  find(widget, '.jp-TrashPanel-breadcrumb');

const crumbs = (widget: TrashWidget): HTMLElement[] =>
  Array.from(
    breadcrumb(widget).querySelectorAll<HTMLElement>('.jp-TrashPanel-crumb')
  );

const selectedNames = (widget: TrashWidget): string[] =>
  Array.from(widget.node.querySelectorAll('.jp-mod-selected')).map(
    row => row.querySelector('.jp-TrashPanel-item-name')!.textContent!
  );

function doubleClick(element: HTMLElement): void {
  element.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
}

function click(element: HTMLElement, modifiers: MouseEventInit = {}): void {
  element.dispatchEvent(
    new MouseEvent('click', { bubbles: true, ...modifiers })
  );
}

function press(
  element: HTMLElement,
  key: string,
  modifiers: KeyboardEventInit = {}
): void {
  element.dispatchEvent(
    new KeyboardEvent('keydown', { key, bubbles: true, ...modifiers })
  );
}

/** Install a static `prefers-reduced-motion` query on the window. */
function mockReducedMotion(matches: boolean): void {
  window.matchMedia = jest.fn(() => ({
    matches
  })) as unknown as typeof window.matchMedia;
}

const listBox = (widget: TrashWidget) =>
  find<HTMLElement>(widget, '.jp-TrashPanel-list');

const activeRow = (widget: TrashWidget): HTMLElement | null =>
  widget.node.querySelector<HTMLElement>('.jp-TrashPanel-item.jp-mod-active');

const activeName = (widget: TrashWidget): string | undefined =>
  activeRow(widget)?.querySelector('.jp-TrashPanel-item-name')?.textContent ??
  undefined;

/** A trash that holds folder `a` with a file and the folder `b` inside. */
const nestedRoutes = (): Record<string, Route> => ({
  list: listOf([folder('a'), file('top.txt')]),
  'list?path=a': listOf([folder('b', 'a'), file('one.txt', 'a')], '18 B'),
  'list?path=a%2Fb': listOf([file('deep.txt', 'a/b')])
});

/** Open the nested trash and enter folder `a`. */
async function openInsideA(): Promise<TrashWidget> {
  const widget = await open(nestedRoutes());
  doubleClick(rows(widget)[rowNames(widget).indexOf('a')]);
  await settle();
  return widget;
}

const COLLAPSED_KEY =
  '@stellarshenson/jupyterlab-trash-mgmt-extension:panel:collapsed';

const SHOW_VOLUMES_KEY =
  '@stellarshenson/jupyterlab-trash-mgmt-extension:panel:show-volumes';

/** Turn Show Volumes on before the widget is built, as a saved choice does. */
function showVolumesOn(): void {
  window.localStorage.setItem(SHOW_VOLUMES_KEY, 'true');
}

interface ISource {
  id: string;
  label: string;
  item_count: number;
  total_size: string;
  total_bytes: number;
  error: string;
}

/** Build a `sources` response entry the way the server shapes it. */
function sourceOf(
  id: string,
  itemCount = 0,
  totalSize = '0 B',
  error = ''
): ISource {
  const label =
    id === 'xdg'
      ? 'Trash'
      : id === 'cache'
        ? '/home/cache'
        : id.startsWith('location:')
          ? id.slice('location:'.length).replace(/\/\.Trash-\d+$/, '')
          : `/home/${id.slice('home:'.length)}`;
  return {
    id,
    label,
    item_count: itemCount,
    total_size: totalSize,
    total_bytes: 0,
    error
  };
}

/** The xdg trash plus two extra sources, each with its own listing. */
function sourcedRoutes(): Record<string, Route> {
  return {
    sources: [
      sourceOf('xdg', 1, '5 B'),
      sourceOf('cache', 12, '40 MB'),
      sourceOf('home:alice', 1, '2 KB')
    ],
    list: listOf([file('one.txt')], '5 B'),
    'list?source=cache': listOf([file('cache.bin')], '40 MB'),
    'list?source=home%3Aalice': listOf([file('alice.txt')], '2 KB')
  };
}

const sections = (widget: TrashWidget): HTMLElement[] =>
  Array.from(
    widget.node.querySelectorAll<HTMLElement>('.jp-TrashPanel-section')
  );

const sectionOf = (widget: TrashWidget, id: string): HTMLElement =>
  find(widget, `.jp-TrashPanel-section[data-source="${id}"]`);

const sectionHeader = (widget: TrashWidget, id: string) =>
  sectionOf(widget, id).querySelector<HTMLButtonElement>(
    '.jp-TrashPanel-sectionHeader'
  )!;

const sectionLabel = (widget: TrashWidget, id: string) =>
  sectionOf(widget, id).querySelector<HTMLElement>(
    '.jp-TrashPanel-sectionLabel'
  )!;

const sectionList = (widget: TrashWidget, id: string) =>
  sectionOf(widget, id).querySelector<HTMLElement>(
    '.jp-TrashPanel-sectionList'
  )!;

const sectionRows = (widget: TrashWidget, id: string): HTMLElement[] =>
  Array.from(
    sectionOf(widget, id).querySelectorAll<HTMLElement>(
      '.jp-TrashPanel-sectionRow'
    )
  );

beforeEach(() => {
  jest.useFakeTimers();
  request.mockReset();
  (showErrorMessage as jest.Mock).mockReset();
  (showDialog as jest.Mock).mockReset();
  window.localStorage.clear();
});

afterEach(() => {
  jest.useRealTimers();
  document.body.innerHTML = '';
  delete (window as any).matchMedia;
});

describe('header', () => {
  it('shows the title; the stylesheet upper-cases it', async () => {
    const widget = await open({ list: listOf([]) });
    expect(find(widget, '.jp-TrashPanel-title').textContent).toBe(
      'Trash Management'
    );
  });

  it('has refresh as its last icon', async () => {
    const widget = await open({ list: listOf([file('one.txt')]) });
    const header = find(widget, '.jp-TrashPanel-header');
    expect(header.lastElementChild).toBe(refreshButton(widget));
  });

  it('puts Empty Trash directly left of refresh', async () => {
    const widget = await open({ list: listOf([file('one.txt')]) });
    expect(refreshButton(widget).previousElementSibling).toBe(
      emptyButton(widget)
    );
    expect(emptyButton(widget).hidden).toBe(false);
    expect(emptyButton(widget).disabled).toBe(false);
  });

  it('disables Empty Trash while the trash holds no item, keeping it and its tooltip', async () => {
    const widget = await open({ list: listOf([]) });
    expect(emptyButton(widget).hidden).toBe(false);
    expect(emptyButton(widget).disabled).toBe(true);
    expect(emptyButton(widget).title).toBe('Empty Trash');
  });

  it('keeps Empty Trash inside an empty folder', async () => {
    const widget = await open({
      list: listOf([folder('a')]),
      'list?path=a': listOf([])
    });
    doubleClick(rows(widget)[0]);
    await settle();
    expect(emptyButton(widget).disabled).toBe(false);
  });

  it('keeps the same buttons across loads', async () => {
    const widget = await open({ list: listOf([file('one.txt')]) });
    const before = refreshButton(widget);
    void widget.refresh();
    await settle();
    expect(refreshButton(widget)).toBe(before);
  });
});

describe('filter', () => {
  const filterButton = (widget: TrashWidget) =>
    find<HTMLButtonElement>(widget, 'button[title="Filter trash"]');

  const filterWrap = (widget: TrashWidget) =>
    find<HTMLDivElement>(widget, '.jp-TrashPanel-filterWrap');

  const filterInput = (widget: TrashWidget) =>
    find<HTMLInputElement>(widget, '.jp-TrashPanel-filterInput');

  const filterClear = (widget: TrashWidget) =>
    find<HTMLButtonElement>(widget, '.jp-TrashPanel-filterClear');

  /** Set the field's text and fire the event a keystroke fires. */
  function type(widget: TrashWidget, text: string): void {
    const input = filterInput(widget);
    input.value = text;
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }

  it('narrows the rows to the name match, ignoring case, and clearing restores every row', async () => {
    const widget = await open({
      list: listOf([file('alpha.txt'), file('beta.txt'), folder('folder-a')])
    });
    expect(filterWrap(widget).hidden).toBe(true);
    click(filterButton(widget));
    expect(filterWrap(widget).hidden).toBe(false);
    expect(filterButton(widget).getAttribute('aria-pressed')).toBe('true');
    expect(filterClear(widget).hidden).toBe(true);

    type(widget, 'ALP');
    expect(rowNames(widget)).toEqual(['alpha.txt']);
    expect(filterClear(widget).hidden).toBe(false);

    click(filterClear(widget));
    expect(rowNames(widget)).toEqual(['alpha.txt', 'beta.txt', 'folder-a']);
    expect(filterClear(widget).hidden).toBe(true);
    expect(filterInput(widget).value).toBe('');
  });

  it('drops a selected row the query hides, so Restore leaves it alone', async () => {
    const widget = await open({
      list: listOf([file('alpha.txt'), file('beta.txt')]),
      restore: { success: true }
    });
    click(rows(widget)[0]);
    click(rows(widget)[1], { ctrlKey: true });
    click(filterButton(widget));
    type(widget, 'alp');

    expect((widget as any)._commands.label('trash:restore')).toBe('Restore');

    void (widget as any)._commands.execute('trash:restore');
    await settle();

    const bodies = request.mock.calls
      .filter(call => call[0] === 'restore')
      .map(call => JSON.parse(call[2].body).trash_path);
    expect(bodies).toEqual(['alpha.txt']);
  });

  it('matches the original path as well as the name', async () => {
    const widget = await open({
      list: listOf([file('alpha.txt'), file('notes.txt', 'docs')])
    });
    click(filterButton(widget));
    type(widget, 'docs');
    expect(rowNames(widget)).toEqual(['notes.txt']);
  });

  it('leaves no rows when nothing matches, and does not claim the trash is empty', async () => {
    const widget = await open({
      list: listOf([file('alpha.txt'), file('beta.txt')])
    });
    click(filterButton(widget));
    type(widget, 'zzz');
    expect(rowNames(widget)).toEqual([]);
    // The line follows the unfiltered count, so it stays hidden here
    expect(find(widget, '.jp-TrashPanel-empty').style.display).toBe('none');
    expect(summary(widget).textContent).toBe('2 items · 0 B');
  });

  it('hiding the box clears the query and restores every row', async () => {
    const widget = await open({
      list: listOf([file('alpha.txt'), file('beta.txt'), folder('folder-a')])
    });
    click(filterButton(widget));
    type(widget, 'alp');
    expect(rowNames(widget)).toEqual(['alpha.txt']);

    click(filterButton(widget));
    expect(filterWrap(widget).hidden).toBe(true);
    expect(filterButton(widget).getAttribute('aria-pressed')).toBe('false');
    expect(filterInput(widget).value).toBe('');
    expect(rowNames(widget)).toEqual(['alpha.txt', 'beta.txt', 'folder-a']);
  });

  it('hands the focus to the filter button when the box is hidden', async () => {
    const widget = await openAttached({
      list: listOf([file('alpha.txt')])
    });
    click(filterButton(widget));
    expect(document.activeElement).toBe(filterInput(widget));

    click(filterButton(widget));
    expect(filterWrap(widget).hidden).toBe(true);
    expect(document.activeElement).toBe(filterButton(widget));
  });

  it('keeps the caret in the field while every keystroke re-renders the list', async () => {
    const widget = await openAttached({
      list: listOf([file('alpha.txt'), file('beta.txt')])
    });
    click(filterButton(widget));
    expect(document.activeElement).toBe(filterInput(widget));
    type(widget, 'alp');
    expect(document.activeElement).toBe(filterInput(widget));
    expect(rowNames(widget)).toEqual(['alpha.txt']);
  });

  it('narrows every section band too', async () => {
    showVolumesOn();
    const widget = await open(sourcedRoutes());
    click(filterButton(widget));
    type(widget, 'alice');
    // Only alice.txt carries the text; one.txt and cache.bin do not
    expect(rowNames(widget)).toEqual([]);
    expect(sectionRows(widget, 'cache')).toHaveLength(0);
    expect(sectionRows(widget, 'home:alice')).toHaveLength(1);

    type(widget, '');
    expect(rowNames(widget)).toEqual(['one.txt']);
    expect(sectionRows(widget, 'cache')).toHaveLength(1);
    expect(sectionRows(widget, 'home:alice')).toHaveLength(1);
  });
});

describe('summary bar', () => {
  it('shows count and size of the listed location', async () => {
    const twelve = Array.from({ length: 12 }, (_, i) => file(`f${i}.txt`));
    const widget = await open({ list: listOf(twelve, '4.5 MB') });
    expect(summary(widget).textContent).toBe('12 items · 4.5 MB');
  });

  it('uses the singular for one item', async () => {
    const widget = await open({ list: listOf([file('one.txt')], '5 B') });
    expect(summary(widget).textContent).toBe('1 item · 5 B');
  });

  it('reads zero for an empty trash', async () => {
    const widget = await open({ list: listOf([]) });
    expect(summary(widget).textContent).toBe('0 items · 0 B');
  });

  it('has no caret and does nothing on click', async () => {
    const widget = await open({ list: listOf([file('one.txt')]) });
    const calls = request.mock.calls.length;
    expect(
      summary(widget).querySelector('.jp-TrashPanel-sortArrow')
    ).toBeNull();
    click(summary(widget));
    await settle();
    expect(rowNames(widget)).toEqual(['one.txt']);
    expect(request.mock.calls).toHaveLength(calls);
  });

  it('describes the folder in view', async () => {
    const widget = await openInsideA();
    expect(summary(widget).textContent).toBe('2 items · 18 B');
  });
});

describe('sort headers', () => {
  const header = (widget: TrashWidget, column: string) =>
    find<HTMLElement>(
      widget,
      `.jp-TrashPanel-columnHeader .jp-TrashPanel-col-${column}`
    );

  it('makes each header a button', async () => {
    const widget = await open({ list: listOf([file('one.txt')]) });
    expect(
      [
        header(widget, 'name'),
        header(widget, 'modified'),
        header(widget, 'size')
      ].map(element => element.tagName)
    ).toEqual(['BUTTON', 'BUTTON', 'BUTTON']);
  });

  it('names the column and its sort state', async () => {
    const widget = await open({ list: listOf([file('one.txt')]) });
    expect(header(widget, 'name').getAttribute('aria-label')).toBe(
      'Name, not sorted'
    );
    expect(header(widget, 'modified').getAttribute('aria-label')).toBe(
      'Deleted, sorted descending'
    );
    expect(header(widget, 'size').getAttribute('aria-label')).toBe(
      'Size, not sorted'
    );

    click(header(widget, 'name'));
    expect(header(widget, 'name').getAttribute('aria-label')).toBe(
      'Name, sorted ascending'
    );
    click(header(widget, 'name'));
    expect(header(widget, 'name').getAttribute('aria-label')).toBe(
      'Name, sorted descending'
    );
  });

  it('still sorts on a click', async () => {
    const widget = await open({
      list: listOf([file('b.txt'), file('a.txt')])
    });
    click(header(widget, 'name'));
    expect(rowNames(widget)).toEqual(['a.txt', 'b.txt']);
    click(header(widget, 'name'));
    expect(rowNames(widget)).toEqual(['b.txt', 'a.txt']);
  });
});

describe('reduced motion', () => {
  /** The panel holds no chip, no toggle and no override class. */
  function expectNoMotionControl(widget: TrashWidget): void {
    expect(widget.node.querySelector('.jp-TrashPanel-motionChip')).toBeNull();
    expect(widget.node.querySelector('.jp-TrashPanel-forceMotion')).toBeNull();
    expect(widget.node.classList).not.toContain('jp-mod-force-motion');
  }

  it('renders no motion control under a reduce preference', async () => {
    mockReducedMotion(true);
    const widget = await open({ list: listOf([]) });
    expectNoMotionControl(widget);
  });

  it('renders no motion control without a reduce preference', async () => {
    mockReducedMotion(false);
    const widget = await open({ list: listOf([]) });
    expectNoMotionControl(widget);
  });
});

describe('refresh icon', () => {
  it('stays static after the initial load and over 500 ms', async () => {
    const widget = await open({ list: listOf([file('one.txt')]) });
    expect(rowNames(widget)).toEqual(['one.txt']);
    expect(refreshButton(widget).classList).not.toContain('jp-mod-spinning');

    await jest.advanceTimersByTimeAsync(2000);
    expect(refreshButton(widget).classList).not.toContain('jp-mod-spinning');
  });

  it('stays static through a clicked refresh', async () => {
    const widget = await open({ list: listOf([]) });
    const slow = deferred<unknown>();
    serve({ list: () => slow.promise });

    refreshButton(widget).click();
    await jest.advanceTimersByTimeAsync(2000);
    expect(refreshButton(widget).classList).not.toContain('jp-mod-spinning');
    expect(refreshButton(widget).getAttribute('aria-busy')).toBe('true');
    expect(refreshButton(widget).classList).toContain('jp-mod-busy');

    slow.resolve(listOf([file('one.txt')]));
    await settle();
    expect(refreshButton(widget).classList).not.toContain('jp-mod-spinning');
    expect(refreshButton(widget).getAttribute('aria-busy')).toBe('false');
    expect(refreshButton(widget).classList).not.toContain('jp-mod-busy');
    expect(rowNames(widget)).toEqual(['one.txt']);
  });

  it('clears the busy mark when a warm refresh never returns', async () => {
    const widget = await open({ list: listOf([file('one.txt')]) });
    let answered = false;
    const hung = deferred<unknown>();
    hung.promise.then(() => (answered = true));
    serve({ list: () => hung.promise });

    refreshButton(widget).click();
    await jest.advanceTimersByTimeAsync(100);
    expect(refreshButton(widget).getAttribute('aria-busy')).toBe('true');

    await jest.advanceTimersByTimeAsync(121000);
    expect(refreshButton(widget).getAttribute('aria-busy')).toBe('false');
    expect(refreshButton(widget).classList).not.toContain('jp-mod-busy');
    // The mark timed out visually; the request itself is still pending
    expect(answered).toBe(false);
    expect(requested()).toHaveLength(2);
  });

  it('clears the busy mark after a stale refresh and a second one', async () => {
    const widget = await open({ list: listOf([file('one.txt')]) });
    const hung = deferred<unknown>();
    serve({ list: () => hung.promise });

    refreshButton(widget).click();
    await jest.advanceTimersByTimeAsync(100);
    expect(refreshButton(widget).getAttribute('aria-busy')).toBe('true');

    // The stale timer clears the mark while the request is still pending
    await jest.advanceTimersByTimeAsync(121000);
    expect(refreshButton(widget).getAttribute('aria-busy')).toBe('false');

    // The late answer must not drive the counter below zero
    hung.resolve(listOf([file('one.txt')]));
    await settle();

    serve({ list: listOf([file('one.txt')]) });
    refreshButton(widget).click();
    await settle();

    expect(refreshButton(widget).getAttribute('aria-busy')).toBe('false');
    expect(refreshButton(widget).classList).not.toContain('jp-mod-busy');
  });
});

describe('loading veil', () => {
  it('announces the load to assistive technology', async () => {
    const widget = await open({ list: listOf([]) });
    expect(veil(widget).getAttribute('role')).toBe('status');
    expect(veil(widget).getAttribute('aria-label')).toBeTruthy();
  });

  it('marks the list busy while a load is pending', async () => {
    const slow = deferred<unknown>();
    serve({ list: () => slow.promise });
    const widget = new TrashWidget(settings);
    void widget.refresh();
    await jest.advanceTimersByTimeAsync(100);
    expect(listBox(widget).getAttribute('aria-busy')).toBe('true');

    slow.resolve(listOf([]));
    await settle();
    expect(listBox(widget).getAttribute('aria-busy')).toBe('false');
  });

  it('covers the panel on the first open until the first load ends', async () => {
    const first = deferred<unknown>();
    serve({ list: () => first.promise });
    const widget = new TrashWidget(settings);
    expect(veil(widget).hidden).toBe(false);

    void widget.refresh();
    await jest.advanceTimersByTimeAsync(2000);
    expect(veil(widget).hidden).toBe(false);

    first.resolve(listOf([]));
    await settle();
    expect(veil(widget).hidden).toBe(true);
  });

  it('comes down when a hung first load is bypassed by the background refresh', async () => {
    const hung = deferred<unknown>();
    serve({ list: () => hung.promise });
    const widget = new TrashWidget(settings);
    void widget.refresh();
    await jest.advanceTimersByTimeAsync(100);
    expect(veil(widget).hidden).toBe(false);

    // The first load hangs past the stale threshold, so the background
    // refresh chases it and renders rows under the raised veil
    await jest.advanceTimersByTimeAsync(121000);
    serve({ list: listOf([file('fresh.txt')]) });
    await (widget as any)._refreshInBackground();
    await settle();

    expect(requested()).toEqual(['list', 'list']);
    expect(rowNames(widget)).toEqual(['fresh.txt']);
    expect(veil(widget).hidden).toBe(true);
  });

  it('stays down on a refresh click after the first load', async () => {
    const widget = await open({ list: listOf([file('one.txt')]) });
    const slow = deferred<unknown>();
    serve({ list: () => slow.promise });

    refreshButton(widget).click();
    await jest.advanceTimersByTimeAsync(100);
    expect(veil(widget).hidden).toBe(true);
    expect(refreshButton(widget).classList).not.toContain('jp-mod-spinning');
    expect(rowNames(widget)).toEqual(['one.txt']);

    slow.resolve(listOf([file('one.txt')]));
    await settle();
  });

  it('covers the panel while a restore runs', async () => {
    const routes = serve({ list: listOf([file('one.txt')]) });
    const widget = new TrashWidget(settings);
    void widget.refresh();
    await settle();
    const restore = deferred<unknown>();
    routes.restore = () => restore.promise;

    click(rows(widget)[0]);
    void (widget as any)._commands.execute('trash:restore');
    await jest.advanceTimersByTimeAsync(100);
    expect(veil(widget).hidden).toBe(false);

    restore.resolve({ success: true });
    await settle();
    expect(veil(widget).hidden).toBe(true);
  });

  it('stays down during the background refresh', async () => {
    const widget = await open({ list: listOf([file('one.txt')]) });
    const slow = deferred<unknown>();
    serve({ list: () => slow.promise });

    void (widget as any)._refreshInBackground();
    await jest.advanceTimersByTimeAsync(100);
    expect(veil(widget).hidden).toBe(true);
    expect(refreshButton(widget).classList).not.toContain('jp-mod-spinning');

    slow.resolve(listOf([file('two.txt')]));
    await settle();
    expect(rowNames(widget)).toEqual(['two.txt']);
  });

  it('comes down and reports the error when the first load fails', async () => {
    serve({ list: () => Promise.reject(httpError(500)) });
    const widget = new TrashWidget(settings);
    void widget.refresh();
    await settle();

    expect(veil(widget).hidden).toBe(true);
    expect(refreshButton(widget).classList).not.toContain('jp-mod-spinning');
    expect(showErrorMessage).toHaveBeenCalledWith(
      'Trash Error',
      'Failed to load trash contents'
    );
  });
});

describe('folder navigation', () => {
  it('lists the children of a folder on double-click', async () => {
    const widget = await openInsideA();
    expect(requested()).toEqual(['list', 'list?path=a']);
    expect(rowNames(widget).sort()).toEqual(['b', 'one.txt']);
  });

  it('enters a folder inside a folder', async () => {
    const widget = await openInsideA();
    doubleClick(rows(widget)[rowNames(widget).indexOf('b')]);
    await settle();
    expect(requested()).toEqual(['list', 'list?path=a', 'list?path=a%2Fb']);
    expect(rowNames(widget)).toEqual(['deep.txt']);
  });

  it('encodes a folder name for the query string', async () => {
    const odd = '100% a&b #1';
    const widget = await open({
      list: listOf([folder(odd)]),
      [`list?path=${encodeURIComponent(odd)}`]: listOf([])
    });
    doubleClick(rows(widget)[0]);
    await settle();
    expect(requested()[1]).toBe('list?path=100%25%20a%26b%20%231');
    expect(crumbs(widget).map(crumb => crumb.textContent)).toEqual([
      'Trash',
      odd
    ]);
  });

  it('does nothing on a double-click of a file', async () => {
    const widget = await open(nestedRoutes());
    doubleClick(rows(widget)[rowNames(widget).indexOf('top.txt')]);
    await settle();
    expect(requested()).toEqual(['list']);
  });

  it('does not enter a symlink to a folder', async () => {
    const widget = await open({
      list: listOf([{ ...folder('link'), is_symlink: true }])
    });
    doubleClick(rows(widget)[0]);
    await settle();
    expect(requested()).toEqual(['list']);
  });

  it('draws a symlink to a folder as a file', async () => {
    const widget = await open({
      list: listOf([{ ...folder('link'), is_symlink: true }, folder('real')])
    });
    const iconOf = (name: string) =>
      rows(widget)[rowNames(widget).indexOf(name)].querySelector('svg')!.dataset
        .icon;
    expect(iconOf('link')).toBe('file');
    expect(iconOf('real')).toBe('folder');
    expect(rows(widget)[rowNames(widget).indexOf('link')].title).toContain(
      'Type: Symbolic link'
    );
  });

  it('keeps the refresh icon static while a folder loads', async () => {
    const slow = deferred<unknown>();
    const widget = await open({
      list: listOf([folder('a')]),
      'list?path=a': () => slow.promise
    });
    doubleClick(rows(widget)[0]);
    await jest.advanceTimersByTimeAsync(2000);
    expect(requested()).toEqual(['list', 'list?path=a']);
    expect(refreshButton(widget).classList).not.toContain('jp-mod-spinning');
    expect(veil(widget).hidden).toBe(true);

    slow.resolve(listOf([]));
    await settle();
    expect(refreshButton(widget).classList).not.toContain('jp-mod-spinning');
  });

  it('shows Folder is empty inside an empty folder', async () => {
    const widget = await open({
      list: listOf([folder('a')]),
      'list?path=a': listOf([])
    });
    doubleClick(rows(widget)[0]);
    await settle();
    const message = find(widget, '.jp-TrashPanel-empty');
    expect(message.textContent).toBe('Folder is empty');
    // Shown, with the display of the stylesheet (ACC-NAV-85-EMPTY-LINE)
    expect(message.style.display).toBe('');
  });

  it('shows Trash is empty at the top level', async () => {
    const widget = await open({ list: listOf([]) });
    expect(find(widget, '.jp-TrashPanel-empty').textContent).toBe(
      'Trash is empty'
    );
  });

  it('keeps the location on the background refresh', async () => {
    const widget = await openInsideA();
    await (widget as any)._refreshInBackground();
    expect(requested()).toEqual(['list', 'list?path=a', 'list?path=a']);
  });

  it('keeps the location on the reload after a delete', async () => {
    const widget = await openInsideA();
    (showDialog as jest.Mock).mockResolvedValue({ button: { accept: true } });
    const routes = nestedRoutes();
    routes.delete = { success: true };
    serve(routes);

    click(rows(widget)[rowNames(widget).indexOf('one.txt')]);
    void (widget as any)._commands.execute('trash:delete');
    await settle();
    expect(requested().slice(-2)).toEqual(['delete', 'list?path=a']);
  });

  it('keeps sort column and direction', async () => {
    const widget = await open(nestedRoutes());
    const sizeHeader = () =>
      find(widget, '.jp-TrashPanel-columnHeader .jp-TrashPanel-col-size');
    click(sizeHeader());
    click(sizeHeader());
    expect(sizeHeader().textContent).toBe('Size ▲');

    doubleClick(rows(widget)[rowNames(widget).indexOf('a')]);
    await settle();
    expect(sizeHeader().textContent).toBe('Size ▲');
  });

  it('lists the nearest parent when the folder in view is gone', async () => {
    const widget = await openInsideA();
    doubleClick(rows(widget)[rowNames(widget).indexOf('b')]);
    await settle();

    const routes = nestedRoutes();
    routes['list?path=a%2Fb'] = () => Promise.reject(httpError(404));
    serve(routes);
    await (widget as any)._refreshInBackground();

    expect(crumbs(widget).map(crumb => crumb.textContent)).toEqual([
      'Trash',
      'a'
    ]);
    expect(rowNames(widget).sort()).toEqual(['b', 'one.txt']);
  });

  it('stays where it is when a folder cannot be listed', async () => {
    const widget = await open({
      list: listOf([folder('a')]),
      'list?path=a': () => Promise.reject(httpError(500))
    });
    doubleClick(rows(widget)[0]);
    await settle();

    expect(showErrorMessage).toHaveBeenCalledTimes(1);
    expect(breadcrumb(widget).hidden).toBe(true);
    expect(rowNames(widget)).toEqual(['a']);
    await (widget as any)._refreshInBackground();
    expect(requested().slice(-1)).toEqual(['list']);
  });
});

describe('breadcrumb', () => {
  it('is hidden at the top level', async () => {
    const widget = await open(nestedRoutes());
    expect(breadcrumb(widget).hidden).toBe(true);
  });

  it('shows the path inside a folder', async () => {
    const widget = await openInsideA();
    doubleClick(rows(widget)[rowNames(widget).indexOf('b')]);
    await settle();
    expect(breadcrumb(widget).hidden).toBe(false);
    expect(breadcrumb(widget).textContent).toBe('Trash/a/b');
    expect(crumbs(widget).map(crumb => crumb.tagName)).toEqual([
      'BUTTON',
      'BUTTON',
      'SPAN'
    ]);
  });

  it('lists the level of a clicked segment', async () => {
    const widget = await openInsideA();
    doubleClick(rows(widget)[rowNames(widget).indexOf('b')]);
    await settle();

    click(crumbs(widget)[1]);
    await settle();
    expect(requested().slice(-1)).toEqual(['list?path=a']);
    expect(breadcrumb(widget).textContent).toBe('Trash/a');

    click(crumbs(widget)[0]);
    await settle();
    expect(requested().slice(-1)).toEqual(['list']);
    expect(breadcrumb(widget).hidden).toBe(true);
  });
});

describe('selection', () => {
  const two = () =>
    listOf([file('one.txt'), file('two.txt'), file('three.txt')]);

  it('survives the background refresh', async () => {
    const widget = await open({ list: two() });
    click(rows(widget)[rowNames(widget).indexOf('two.txt')]);
    expect(selectedNames(widget)).toEqual(['two.txt']);

    await (widget as any)._refreshInBackground();
    expect(selectedNames(widget)).toEqual(['two.txt']);
  });

  it('drops a row that is gone after the reload', async () => {
    const widget = await open({ list: two() });
    click(rows(widget)[rowNames(widget).indexOf('two.txt')]);
    serve({ list: listOf([file('one.txt')]) });

    await (widget as any)._refreshInBackground();
    expect(selectedNames(widget)).toEqual([]);
  });

  it('keeps the shift-click anchor across the background refresh', async () => {
    const widget = await open({ list: two() });
    const names = rowNames(widget);
    click(rows(widget)[0]);
    await (widget as any)._refreshInBackground();

    click(rows(widget)[2], { shiftKey: true });
    expect(selectedNames(widget)).toEqual(names);
  });

  it('is cleared when a folder is entered', async () => {
    const widget = await open(nestedRoutes());
    click(rows(widget)[rowNames(widget).indexOf('top.txt')]);
    expect(selectedNames(widget)).toEqual(['top.txt']);

    doubleClick(rows(widget)[rowNames(widget).indexOf('a')]);
    await settle();
    expect(selectedNames(widget)).toEqual([]);
  });

  it('is cleared when a folder is left', async () => {
    const widget = await openInsideA();
    click(rows(widget)[rowNames(widget).indexOf('one.txt')]);
    click(crumbs(widget)[0]);
    await settle();
    expect(selectedNames(widget)).toEqual([]);
  });

  it('restores every selected row inside a folder', async () => {
    const widget = await openInsideA();
    const routes = nestedRoutes();
    routes.restore = { success: true };
    serve(routes);

    click(rows(widget)[0]);
    click(rows(widget)[1], { ctrlKey: true });
    void (widget as any)._commands.execute('trash:restore');
    await settle();

    const bodies = request.mock.calls
      .filter(call => call[0] === 'restore')
      .map(call => JSON.parse(call[2].body).trash_path);
    expect(bodies.sort()).toEqual(['a/b', 'a/one.txt']);
  });

  it('starts the range at the clicked row after a sort change', async () => {
    const widget = await open({
      list: listOf([file('a.txt'), file('b.txt'), file('c.txt')])
    });
    const nameHeader = () =>
      find(widget, '.jp-TrashPanel-columnHeader .jp-TrashPanel-col-name');

    click(nameHeader());
    expect(rowNames(widget)).toEqual(['a.txt', 'b.txt', 'c.txt']);

    click(rows(widget)[0]);
    click(nameHeader());
    expect(rowNames(widget)).toEqual(['c.txt', 'b.txt', 'a.txt']);

    click(rows(widget)[rowNames(widget).indexOf('b.txt')], {
      shiftKey: true
    });
    expect(selectedNames(widget).sort()).toEqual(['a.txt', 'b.txt']);
  });
});

describe('keyboard model', () => {
  const three = () => listOf([file('a.txt'), file('b.txt'), file('c.txt')]);

  it('is one listbox tab stop and moves the active row with the arrows', async () => {
    const widget = await open({ list: three() });
    const list = listBox(widget);
    expect(list.tabIndex).toBe(0);
    expect(list.getAttribute('role')).toBe('listbox');
    expect(list.getAttribute('aria-multiselectable')).toBe('true');
    expect(list.getAttribute('aria-label')).toBe('Trash items');
    expect(rows(widget)[0].getAttribute('role')).toBe('option');
    expect(rows(widget)[0].getAttribute('aria-selected')).toBe('false');

    press(list, 'ArrowDown');
    expect(activeName(widget)).toBe('a.txt');
    expect(list.getAttribute('aria-activedescendant')).toBe(
      activeRow(widget)!.id
    );

    press(list, 'ArrowDown');
    expect(activeName(widget)).toBe('b.txt');

    press(list, 'ArrowUp');
    expect(activeName(widget)).toBe('a.txt');

    press(list, 'End');
    expect(activeName(widget)).toBe('c.txt');

    press(list, 'Home');
    expect(activeName(widget)).toBe('a.txt');
  });

  it('toggles the active row selection with Space', async () => {
    const widget = await open({ list: three() });
    const list = listBox(widget);

    press(list, 'ArrowDown');
    press(list, ' ');
    expect(selectedNames(widget)).toEqual(['a.txt']);
    expect(rows(widget)[0].getAttribute('aria-selected')).toBe('true');

    press(list, 'ArrowDown');
    press(list, ' ');
    expect(selectedNames(widget).sort()).toEqual(['a.txt', 'b.txt']);

    press(list, ' ');
    expect(selectedNames(widget)).toEqual(['a.txt']);
  });

  it('opens the active folder with Enter', async () => {
    const widget = await open(nestedRoutes());
    const list = listBox(widget);

    press(list, 'ArrowDown');
    expect(activeName(widget)).toBe('a');
    press(list, 'Enter');
    await settle();

    expect(requested()).toEqual(['list', 'list?path=a']);
  });

  it('opens the row menu with Shift+F10 and the menu key', async () => {
    const widget = await open({ list: three() });
    const list = listBox(widget);
    const opened = jest
      .spyOn((widget as any)._contextMenu, 'open')
      .mockImplementation(() => undefined);

    press(list, 'ArrowDown');
    press(list, 'F10', { shiftKey: true });
    expect(opened).toHaveBeenCalledTimes(1);
    expect(selectedNames(widget)).toEqual(['a.txt']);

    press(list, 'ContextMenu');
    expect(opened).toHaveBeenCalledTimes(2);
  });

  it('keeps the active row across a background reload', async () => {
    const widget = await open({ list: three() });
    const list = listBox(widget);

    press(list, 'ArrowDown');
    press(list, 'ArrowDown');
    const id = activeRow(widget)!.id;

    serve({ list: three() });
    await (widget as any)._refreshInBackground();

    expect(activeName(widget)).toBe('b.txt');
    expect(activeRow(widget)!.id).toBe(id);
    expect(list.getAttribute('aria-activedescendant')).toBe(id);
  });

  it('rings only the active row of the focused list, never the list (DEF-PANEL-34-FOCUS-RING)', async () => {
    const style = document.createElement('style');
    style.textContent = jest
      .requireActual('fs')
      .readFileSync('style/base.css', 'utf8');
    document.head.appendChild(style);
    const widget = await openAttached({ list: three() });
    const list = listBox(widget);

    click(rows(widget)[1]);
    list.focus();
    // jsdom keeps the outline shorthand unexpanded
    const listOutline = getComputedStyle(list).outline;
    const rowOutline = getComputedStyle(activeRow(widget)!).outline;
    style.remove();

    expect(document.activeElement).toBe(list);
    expect(listOutline).toBe('none');
    expect(rowOutline).toContain('solid');
  });
});

describe('row ids', () => {
  it('renders a path with a lone surrogate and keeps its active id across a reload', async () => {
    const lone = 'broken-\uDCFF.txt';
    const routes = { list: listOf([{ name: 'lone', trash_path: lone }]) };
    const widget = await open(routes);
    expect(rowNames(widget)).toEqual(['lone']);

    const list = listBox(widget);
    press(list, 'ArrowDown');
    const id = activeRow(widget)!.id;
    expect(id).toMatch(/^jp-trash-row-/);

    serve(routes);
    await (widget as any)._refreshInBackground();

    expect(activeName(widget)).toBe('lone');
    expect(activeRow(widget)!.id).toBe(id);
    expect(list.getAttribute('aria-activedescendant')).toBe(id);
  });
});

describe('focus edges', () => {
  const three = () => listOf([file('a.txt'), file('b.txt'), file('c.txt')]);

  it('moves focus to the list when a focused breadcrumb is activated', async () => {
    const widget = await openAttached(nestedRoutes());
    const list = listBox(widget);
    // jsdom takes every focus() as keyboard focus, which activates the first row
    list.focus();
    press(list, 'Enter');
    await settle();
    expect(breadcrumb(widget).textContent).toBe('Trash/a');

    const trashCrumb = crumbs(widget)[0];
    trashCrumb.focus();
    click(trashCrumb);
    await settle();

    expect(breadcrumb(widget).hidden).toBe(true);
    expect(document.activeElement).toBe(list);
  });

  it('makes the first row of an entered folder active while the list keeps the keyboard focus (DEF-PANEL-34-FOCUS-RING)', async () => {
    const widget = await openAttached(nestedRoutes());
    const list = listBox(widget);
    list.focus();
    expect(activeName(widget)).toBe('a');

    press(list, 'Enter');
    await settle();

    expect(breadcrumb(widget).textContent).toBe('Trash/a');
    expect(document.activeElement).toBe(list);
    expect(activeRow(widget)).toBe(rows(widget)[0]);
    expect(list.getAttribute('aria-activedescendant')).toBe(rows(widget)[0].id);
  });

  it('keeps the list focused across a background reload', async () => {
    const widget = await openAttached({ list: three() });
    const list = listBox(widget);
    list.focus();
    expect(document.activeElement).toBe(list);

    serve({ list: three() });
    await (widget as any)._refreshInBackground();

    expect(rows(widget).length).toBe(3);
    expect(document.activeElement).toBe(list);
  });

  it('returns focus to the same breadcrumb depth after a background reload', async () => {
    const widget = await openAttached(nestedRoutes());
    doubleClick(rows(widget)[rowNames(widget).indexOf('a')]);
    await settle();
    doubleClick(rows(widget)[rowNames(widget).indexOf('b')]);
    await settle();
    expect(breadcrumb(widget).textContent).toBe('Trash/a/b');

    const aCrumb = crumbs(widget)[1];
    aCrumb.focus();
    expect(document.activeElement).toBe(aCrumb);

    serve(nestedRoutes());
    await (widget as any)._refreshInBackground();

    expect(document.activeElement).toBe(crumbs(widget)[1]);
    expect((document.activeElement as HTMLElement).textContent).toBe('a');
    expect(document.activeElement).not.toBe(aCrumb);
  });

  it('keeps focus on the same sort header across a reload', async () => {
    const widget = await openAttached({ list: three() });
    const nameHeader = find<HTMLButtonElement>(
      widget,
      '.jp-TrashPanel-columnHeader .jp-TrashPanel-col-name'
    );
    nameHeader.focus();
    expect(document.activeElement).toBe(nameHeader);

    serve({ list: three() });
    await (widget as any)._refreshInBackground();

    const rebuilt = find<HTMLButtonElement>(
      widget,
      '.jp-TrashPanel-columnHeader .jp-TrashPanel-col-name'
    );
    expect(document.activeElement).toBe(rebuilt);
  });

  it('moves focus to refresh when an empty reload hides a focused sort header', async () => {
    const widget = await openAttached({ list: three() });
    const nameHeader = find<HTMLButtonElement>(
      widget,
      '.jp-TrashPanel-columnHeader .jp-TrashPanel-col-name'
    );
    nameHeader.focus();

    serve({ list: listOf([]) });
    await (widget as any)._refreshInBackground();

    expect(find(widget, '.jp-TrashPanel-columnHeader').style.display).toBe(
      'none'
    );
    expect(document.activeElement).toBe(refreshButton(widget));
  });

  it('returns focus to the list and its active row when the keyboard menu closes', async () => {
    const widget = await openAttached({ list: three() });
    const list = listBox(widget);
    list.focus();
    press(list, 'ArrowDown');
    expect(activeName(widget)).toBe('b.txt');

    press(list, 'ContextMenu');
    await jest.advanceTimersByTimeAsync(50);
    expect(document.activeElement).not.toBe(list);

    (widget as any)._contextMenu.close();
    await jest.advanceTimersByTimeAsync(50);

    expect(document.activeElement).toBe(list);
    expect(activeName(widget)).toBe('b.txt');
    expect(list.getAttribute('aria-activedescendant')).toBe(
      activeRow(widget)!.id
    );
  });

  it('makes a clicked row active, so Space toggles it', async () => {
    const widget = await openAttached({ list: three() });
    const list = listBox(widget);
    click(rows(widget)[rowNames(widget).indexOf('b.txt')]);

    expect(activeName(widget)).toBe('b.txt');
    expect(list.getAttribute('aria-activedescendant')).toBe(
      activeRow(widget)!.id
    );

    press(list, ' ');
    expect(selectedNames(widget)).toEqual([]);
  });

  it('moves focus to refresh when emptying the trash hides the list', async () => {
    const widget = await openAttached({ list: three() });
    const list = listBox(widget);
    list.focus();
    (showDialog as jest.Mock).mockResolvedValue({ button: { accept: true } });
    serve({ empty: { success: true, deleted_count: 3 }, list: listOf([]) });

    emptyButton(widget).click();
    await settle();

    expect(list.style.display).toBe('none');
    expect(document.activeElement).toBe(refreshButton(widget));
  });
});

describe('sort tie-break', () => {
  const unsorted = () => listOf([file('c.txt'), file('a.txt'), file('b.txt')]);

  it('sorts rows with an equal deletion date by name', async () => {
    const widget = await open({ list: unsorted() });
    expect(rowNames(widget)).toEqual(['a.txt', 'b.txt', 'c.txt']);
  });

  it('keeps the tie order in both directions', async () => {
    const widget = await open({ list: unsorted() });
    const deletedHeader = () =>
      find(widget, '.jp-TrashPanel-columnHeader .jp-TrashPanel-col-modified');

    expect(deletedHeader().textContent).toBe('Deleted ▼');
    expect(rowNames(widget)).toEqual(['a.txt', 'b.txt', 'c.txt']);

    click(deletedHeader());
    expect(deletedHeader().textContent).toBe('Deleted ▲');
    expect(rowNames(widget)).toEqual(['a.txt', 'b.txt', 'c.txt']);
  });
});

describe('load order', () => {
  it('skips the background refresh while a load is in flight', async () => {
    const slow = deferred<unknown>();
    const widget = await open({
      list: listOf([folder('a')]),
      'list?path=a': () => slow.promise
    });
    doubleClick(rows(widget)[0]);
    await jest.advanceTimersByTimeAsync(100);

    await (widget as any)._refreshInBackground();
    expect(requested()).toEqual(['list', 'list?path=a']);

    slow.resolve(listOf([file('one.txt', 'a')]));
    await settle();
    expect(rowNames(widget)).toEqual(['one.txt']);
  });

  it('lets the background refresh through a pending load only when it is stale', async () => {
    const slow = deferred<unknown>();
    const chase = deferred<unknown>();
    let opened = 0;
    const widget = await open({
      list: listOf([folder('a')]),
      'list?path=a': () => (opened++ === 0 ? slow.promise : chase.promise)
    });
    doubleClick(rows(widget)[0]);
    await jest.advanceTimersByTimeAsync(100);

    // Younger than the stale threshold, the pending load still blocks it
    await (widget as any)._refreshInBackground();
    expect(requested()).toEqual(['list', 'list?path=a']);

    // Past the threshold the chase re-requests the pending folder, not the root
    await jest.advanceTimersByTimeAsync(120000);
    const chasing = (widget as any)._refreshInBackground();
    expect(requested()).toEqual(['list', 'list?path=a', 'list?path=a']);

    // A second tick does not start a chase while the first one is in flight
    await (widget as any)._refreshInBackground();
    expect(requested()).toEqual(['list', 'list?path=a', 'list?path=a']);

    chase.resolve(listOf([file('fresh.txt', 'a')]));
    await chasing;
    await settle();
    expect(breadcrumb(widget).textContent).toBe('Trash/a');
    expect(rowNames(widget)).toEqual(['fresh.txt']);
  });

  it('measures the stale threshold from the oldest pending load', async () => {
    const hung = deferred<unknown>();
    const widget = await open({
      list: listOf([folder('a'), folder('b')]),
      'list?path=a': () => hung.promise,
      'list?path=b': listOf([file('in-b.txt', 'b')])
    });

    // Folder a hangs, then the newer load for folder b finishes
    doubleClick(rows(widget)[rowNames(widget).indexOf('a')]);
    await jest.advanceTimersByTimeAsync(100000);
    doubleClick(rows(widget)[rowNames(widget).indexOf('b')]);
    await settle();
    expect(rowNames(widget)).toEqual(['in-b.txt']);

    // The settled load no longer counts; only the hung one is past the threshold
    await jest.advanceTimersByTimeAsync(30000);
    serve({ 'list?path=b': listOf([file('fresh.txt', 'b')]) });
    const before = requested().length;
    await (widget as any)._refreshInBackground();

    expect(requested()).toHaveLength(before + 1);
    expect(requested()[before]).toBe('list?path=b');
    expect(breadcrumb(widget).textContent).toBe('Trash/b');
    expect(rowNames(widget)).toEqual(['fresh.txt']);
  });

  it('does not chase over a younger pending navigation', async () => {
    const hung = deferred<unknown>();
    const slow = deferred<unknown>();
    const widget = await open({
      list: listOf([folder('a'), folder('b')]),
      'list?path=a': () => hung.promise,
      'list?path=b': () => slow.promise
    });

    // Folder a hangs past the threshold, then a navigation to b starts
    doubleClick(rows(widget)[rowNames(widget).indexOf('a')]);
    await jest.advanceTimersByTimeAsync(121000);
    doubleClick(rows(widget)[rowNames(widget).indexOf('b')]);
    await jest.advanceTimersByTimeAsync(20000);

    // The newest pending load is 20 s old, so no background request is made
    const before = requested().length;
    await (widget as any)._refreshInBackground();
    expect(requested()).toHaveLength(before);

    // The navigation's own answer still renders
    slow.resolve(listOf([file('in-b.txt', 'b')]));
    await settle();
    expect(breadcrumb(widget).textContent).toBe('Trash/b');
    expect(rowNames(widget)).toEqual(['in-b.txt']);
  });

  it('does not chase on the age of a settled load', async () => {
    const hung = deferred<unknown>();
    const slow = deferred<unknown>();
    const widget = await open({
      list: listOf([folder('a'), folder('b')]),
      'list?path=a': () => hung.promise,
      'list?path=b': () => slow.promise
    });

    // Folder a hangs past the threshold, then a navigation to b starts
    doubleClick(rows(widget)[rowNames(widget).indexOf('a')]);
    await jest.advanceTimersByTimeAsync(121000);
    doubleClick(rows(widget)[rowNames(widget).indexOf('b')]);

    // Folder a's answer arrives after b started; a's target differs from the
    // newest request, so the superseded answer is dropped
    hung.resolve(listOf([file('in-a.txt', 'a')]));
    await settle();
    expect(breadcrumb(widget).textContent).toBe('Trash');

    // b is 29.4 s old; a's settled start must not fire a chase
    await jest.advanceTimersByTimeAsync(28800);
    const before = requested().length;
    await (widget as any)._refreshInBackground();
    expect(requested()).toHaveLength(before);

    slow.resolve(listOf([file('in-b.txt', 'b')]));
    await settle();
    expect(breadcrumb(widget).textContent).toBe('Trash/b');
    expect(rowNames(widget)).toEqual(['in-b.txt']);
  });

  it('renders a listing that answers after a chase has started', async () => {
    const slow = deferred<unknown>();
    const chase = deferred<unknown>();
    let opened = 0;
    const widget = await open({
      list: listOf([folder('a')]),
      'list?path=a': () => (opened++ === 0 ? slow.promise : chase.promise)
    });
    doubleClick(rows(widget)[0]);
    await jest.advanceTimersByTimeAsync(120000);

    // At the threshold the background refresh chases the same folder
    const chasing = (widget as any)._refreshInBackground();
    expect(requested()).toEqual(['list', 'list?path=a', 'list?path=a']);

    // The first listing answers at 130 s, after the chase started
    await jest.advanceTimersByTimeAsync(10000);
    slow.resolve(listOf([file('one.txt', 'a')]));
    await settle();

    expect(breadcrumb(widget).textContent).toBe('Trash/a');
    expect(rowNames(widget)).toEqual(['one.txt']);

    chase.resolve(listOf([file('one.txt', 'a')]));
    await chasing;
  });

  it('renders a chased answer for the pending folder over a newer chase', async () => {
    const hung = deferred<unknown>();
    const older = deferred<unknown>();
    const newer = deferred<unknown>();
    const answers = [hung.promise, older.promise, newer.promise];
    let opened = 0;
    const widget = await open({
      list: listOf([folder('a')]),
      'list?path=a': () => answers[opened++]
    });
    doubleClick(rows(widget)[0]);
    await jest.advanceTimersByTimeAsync(121000);

    // The first chase re-requests the pending folder and stays in flight
    const firstChase = (widget as any)._refreshInBackground();
    expect(requested()).toEqual(['list', 'list?path=a', 'list?path=a']);

    // A second chase for the same folder starts at the next stale boundary
    await jest.advanceTimersByTimeAsync(120000);
    const secondChase = (widget as any)._refreshInBackground();
    expect(requested()).toEqual([
      'list',
      'list?path=a',
      'list?path=a',
      'list?path=a'
    ]);

    // The first chase answers the newest requested location while the newer
    // request for that same location is still pending, so it renders
    older.resolve(listOf([file('first.txt', 'a')]));
    await firstChase;
    expect(breadcrumb(widget).textContent).toBe('Trash/a');
    expect(rowNames(widget)).toEqual(['first.txt']);

    newer.resolve(listOf([file('second.txt', 'a')]));
    await secondChase;
    await settle();
    expect(rowNames(widget)).toEqual(['second.txt']);
  });

  it('chases once per stale window while a load hangs', async () => {
    const hung = deferred<unknown>();
    const chased = deferred<unknown>();
    let opened = 0;
    const widget = await open({
      list: listOf([folder('a')]),
      'list?path=a': () => (opened++ === 0 ? hung.promise : chased.promise)
    });
    doubleClick(rows(widget)[0]);
    await jest.advanceTimersByTimeAsync(121000);

    // The first tick past the threshold starts a chase
    const first = (widget as any)._refreshInBackground();
    expect(requested()).toEqual(['list', 'list?path=a', 'list?path=a']);

    // 100 s into the chase's window, another tick starts no chase
    await jest.advanceTimersByTimeAsync(100000);
    await (widget as any)._refreshInBackground();
    expect(requested()).toEqual(['list', 'list?path=a', 'list?path=a']);

    // At the 120 s boundary the newest pending start is stale, so a second
    // chase starts even while the first one is still in flight
    await jest.advanceTimersByTimeAsync(20000);
    const second = (widget as any)._refreshInBackground();
    expect(requested()).toEqual([
      'list',
      'list?path=a',
      'list?path=a',
      'list?path=a'
    ]);

    // Both chases answer with the same listing and both render it
    chased.resolve(listOf([file('fresh.txt', 'a')]));
    await first;
    await second;
    await settle();
    expect(rowNames(widget)).toEqual(['fresh.txt']);

    // The original load is still pending past its window, so a later tick
    // chases again
    await jest.advanceTimersByTimeAsync(10000);
    serve({
      list: listOf([folder('a')]),
      'list?path=a': listOf([file('again.txt', 'a')])
    });
    await (widget as any)._refreshInBackground();
    expect(requested()).toEqual([
      'list',
      'list?path=a',
      'list?path=a',
      'list?path=a',
      'list?path=a'
    ]);
    expect(rowNames(widget)).toEqual(['again.txt']);
  });

  it('ignores a background response that a navigation overtook', async () => {
    const widget = await open(nestedRoutes());
    const stale = deferred<unknown>();
    const routes = nestedRoutes();
    routes.list = () => stale.promise;
    serve(routes);

    const background = (widget as any)._refreshInBackground();
    doubleClick(rows(widget)[rowNames(widget).indexOf('a')]);
    await settle();
    expect(breadcrumb(widget).textContent).toBe('Trash/a');

    stale.resolve(listOf([file('stale.txt')]));
    await background;
    expect(breadcrumb(widget).textContent).toBe('Trash/a');
    expect(rowNames(widget).sort()).toEqual(['b', 'one.txt']);
  });
});

describe('time column', () => {
  const timeOf = (widget: TrashWidget, name: string) =>
    rows(widget)[rowNames(widget).indexOf(name)].querySelector(
      '.jp-TrashPanel-col-modified'
    )!.textContent;

  it('is labelled Deleted', async () => {
    const widget = await open({ list: listOf([file('one.txt')]) });
    expect(
      find(widget, '.jp-TrashPanel-columnHeader .jp-TrashPanel-col-modified')
        .textContent
    ).toBe('Deleted \u25BC');
  });

  it('shows the age in a short form', async () => {
    jest.setSystemTime(new Date('2024-01-20T12:00:00'));
    const widget = await open({
      list: listOf([
        { ...file('ahead.txt'), deletion_date: '2024-01-20T13:00:00' },
        { ...file('minutes.txt'), deletion_date: '2024-01-20T11:01:00' },
        { ...file('hours.txt'), deletion_date: '2024-01-19T13:00:00' },
        { ...file('day.txt'), deletion_date: '2024-01-19T11:00:00' },
        { ...file('days.txt'), deletion_date: '2024-01-14T11:00:00' },
        { ...file('weeks.txt'), deletion_date: '2023-12-22T11:00:00' },
        { ...file('months.txt'), deletion_date: '2023-01-25T11:00:00' },
        { ...file('years.txt'), deletion_date: '2014-01-20T11:00:00' }
      ])
    });
    const shown = rowNames(widget).map(name => [name, timeOf(widget, name)]);
    expect(shown).toEqual([
      ['ahead.txt', 'just now'],
      ['minutes.txt', '59m ago'],
      ['hours.txt', '23h ago'],
      ['day.txt', 'yesterday'],
      ['days.txt', '6d ago'],
      ['weeks.txt', '4w ago'],
      ['months.txt', '12mo ago'],
      ['years.txt', '10y ago']
    ]);
  });
});

describe('failed reload after an action', () => {
  /** The action fails for the row, and the list request after it fails too. */
  const failing = (action: string): Record<string, Route> => ({
    list: () => Promise.reject(httpError(500)),
    [action]: () => Promise.reject(new Error('denied'))
  });

  /** The background reload logs its failure; the action does not wait for it. */
  function logReload() {
    return jest.spyOn(console, 'error').mockImplementation(() => undefined);
  }

  it('still reports the rows that could not be restored', async () => {
    const widget = await open({ list: listOf([file('one.txt')]) });
    serve(failing('restore'));
    const logged = logReload();

    await (widget as any)._restoreItems((widget as any)._items);
    await settle();
    expect(showErrorMessage).toHaveBeenCalledWith(
      'Restore Failed',
      'one.txt: denied'
    );
    expect(rowNames(widget)).toEqual(['one.txt']);
    expect(logged).toHaveBeenCalledWith(
      'Failed to load trash:',
      expect.objectContaining({ message: 'HTTP 500' })
    );
    logged.mockRestore();
  });

  it('still reports the rows that could not be deleted', async () => {
    const widget = await open({ list: listOf([file('one.txt')]) });
    (showDialog as jest.Mock).mockResolvedValue({ button: { accept: true } });
    serve(failing('delete'));
    const logged = logReload();

    await (widget as any)._deleteItems((widget as any)._items);
    await settle();
    expect(showErrorMessage).toHaveBeenCalledWith(
      'Delete Failed',
      'one.txt: denied'
    );
    expect(rowNames(widget)).toEqual(['one.txt']);
    expect(logged).toHaveBeenCalledWith(
      'Failed to load trash:',
      expect.objectContaining({ message: 'HTTP 500' })
    );
    logged.mockRestore();
  });
});

// ACC-KEYS-102-NEIGHBOUR-ROW, DEF-PANEL-39-LIST-JUMP
describe('neighbour row after a removal', () => {
  const names = ['r1', 'r2', 'r3', 'r4', 'r5', 'r6'];
  const listWithout = (gone: string[]) =>
    listOf(names.filter(name => !gone.includes(name)).map(name => file(name)));

  /** Open six rows, right-click `name` and run menu item `index`. */
  async function removeFromMenu(
    name: string,
    index: number,
    action: Route,
    gone: string[]
  ): Promise<TrashWidget> {
    const routes = { list: listWithout([]) };
    const widget = await openAttached(routes);
    (showDialog as jest.Mock).mockResolvedValue({ button: { accept: true } });
    rows(widget)[rowNames(widget).indexOf(name)].dispatchEvent(
      new MouseEvent('contextmenu', { bubbles: true, cancelable: true })
    );
    MessageLoop.flush();
    const menu = (widget as any)._contextMenu;
    expect(activeName(widget)).toBe(name);
    serve({
      list: listWithout(gone),
      [index === 0 ? 'restore' : 'delete']: action
    });
    menu.activeIndex = index;
    menu.triggerActiveItem();
    await settle();
    return widget;
  }

  it.each([
    ['Delete', 1],
    ['Restore', 0]
  ])(
    '%s of the active row 3 from a mouse-opened menu makes row 4 active',
    async (_, index) => {
      const widget = await removeFromMenu('r3', index as number, {}, ['r3']);
      expect(rowNames(widget)).toEqual(['r1', 'r2', 'r4', 'r5', 'r6']);
      expect(activeName(widget)).toBe('r4');
    }
  );

  it.each([
    ['Delete', 1],
    ['Restore', 0]
  ])('%s of the last row makes the new last row active', async (_, index) => {
    const widget = await removeFromMenu('r6', index as number, {}, ['r6']);
    expect(activeName(widget)).toBe('r5');
  });

  it('a multi-select delete of rows 2 to 4 makes row 5 active', async () => {
    const widget = await openAttached({ list: listWithout([]) });
    (showDialog as jest.Mock).mockResolvedValue({ button: { accept: true } });
    click(rows(widget)[1]);
    click(rows(widget)[3], { shiftKey: true });
    rows(widget)[2].dispatchEvent(
      new MouseEvent('contextmenu', { bubbles: true, cancelable: true })
    );
    MessageLoop.flush();
    expect(selectedNames(widget)).toEqual(['r2', 'r3', 'r4']);
    serve({ list: listWithout(['r2', 'r3', 'r4']), delete: {} });
    const menu = (widget as any)._contextMenu;
    menu.activeIndex = 1;
    menu.triggerActiveItem();
    await settle();
    expect(rowNames(widget)).toEqual(['r1', 'r5', 'r6']);
    expect(activeName(widget)).toBe('r5');
  });

  it('a failed delete keeps its row and the active row', async () => {
    const widget = await removeFromMenu(
      'r3',
      1,
      () => Promise.reject(new Error('denied')),
      []
    );
    expect(showErrorMessage).toHaveBeenCalledWith(
      'Delete Failed',
      'r3: denied'
    );
    expect(rowNames(widget)).toEqual(names);
    expect(activeName(widget)).toBe('r3');
  });
});

describe('Empty Trash', () => {
  it('reports the items that could not be removed', async () => {
    const widget = await open({ list: listOf([file('one.txt')]) });
    (showDialog as jest.Mock).mockResolvedValue({ button: { accept: true } });
    serve({
      list: listOf([file('one.txt')]),
      empty: {
        success: false,
        deleted_count: 0,
        sources: [
          {
            id: 'xdg',
            label: 'Trash',
            deleted_count: 0,
            errors: ['one.txt: denied']
          }
        ]
      }
    });

    emptyButton(widget).click();
    await settle();
    expect(showErrorMessage).toHaveBeenCalledWith(
      'Empty All Bins Failed',
      'Trash: 0 items deleted\nTrash: one.txt: denied'
    );
  });

  it('returns to the top level from inside a folder', async () => {
    const widget = await openInsideA();
    (showDialog as jest.Mock).mockResolvedValue({ button: { accept: true } });
    serve({
      list: listOf([]),
      'list?path=a': () => Promise.reject(httpError(404)),
      empty: { success: true, deleted_count: 2 }
    });

    emptyButton(widget).click();
    await settle();
    expect(breadcrumb(widget).hidden).toBe(true);
    expect(summary(widget).textContent).toBe('0 items · 0 B');
    expect(showErrorMessage).not.toHaveBeenCalled();
  });
});

describe('trash sources', () => {
  beforeEach(showVolumesOn);

  it('renders the returned sources in order, the home band above the main list and the others below it, absent ones omitted', async () => {
    const widget = await open(sourcedRoutes());

    // The xdg trash stays the main listing; its band holds no rows of its own
    expect(rowNames(widget)).toEqual(['one.txt']);
    expect(
      sectionOf(widget, 'xdg').querySelector('.jp-TrashPanel-sectionRow')
    ).toBeNull();

    // A section per source, in the order the server returned them
    expect(sections(widget).map(element => element.dataset.source)).toEqual([
      'xdg',
      'cache',
      'home:alice'
    ]);
    expect(listBox(widget).compareDocumentPosition(sections(widget)[0])).toBe(
      Node.DOCUMENT_POSITION_PRECEDING
    );
    expect(listBox(widget).compareDocumentPosition(sections(widget)[1])).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING
    );

    // A source the server did not return has no section
    expect(widget.node.querySelector('[data-source="home:bob"]')).toBeNull();
  });

  it('reports each source count and size in its header', async () => {
    const widget = await open(sourcedRoutes());
    expect(sectionLabel(widget, 'cache').textContent).toBe(
      '/home/cache (12 items, 40 MB)'
    );
    expect(sectionLabel(widget, 'home:alice').textContent).toBe(
      '/home/alice (1 item, 2 KB)'
    );
  });

  it('keeps the count and size in their own non-shrinking span', async () => {
    const style = document.createElement('style');
    // jest runs from the repository root
    style.textContent = jest
      .requireActual('fs')
      .readFileSync('style/base.css', 'utf8');
    document.head.appendChild(style);
    const widget = await openAttached(sourcedRoutes());
    const label = sectionLabel(widget, 'cache');
    const count = label.querySelector<HTMLElement>(
      ':scope > .jp-TrashPanel-sectionCount'
    )!;
    const shrink = getComputedStyle(count).flexShrink;
    style.remove();

    expect(
      label.querySelector(':scope > .jp-TrashPanel-sectionText')!.textContent
    ).toBe('/home/cache');
    expect(count.textContent).toBe(' (12 items, 40 MB)');
    expect(shrink).toBe('0');
  });

  it('keeps the band one line, the label text titled with its full label', async () => {
    const style = document.createElement('style');
    style.textContent = jest
      .requireActual('fs')
      .readFileSync('style/base.css', 'utf8');
    document.head.appendChild(style);
    const widget = await openAttached(sourcedRoutes());
    const label = sectionLabel(widget, 'cache');
    const text = label.querySelector<HTMLElement>(
      ':scope > .jp-TrashPanel-sectionText'
    )!;
    const wrap = getComputedStyle(label).flexWrap;
    const textStyle = getComputedStyle(text);
    const ellipsis = [textStyle.textOverflow, textStyle.whiteSpace];
    style.remove();

    expect(text.title).toBe('/home/cache');
    expect(wrap).not.toBe('wrap');
    expect(ellipsis).toEqual(['ellipsis', 'nowrap']);
  });

  it('lifts the 40% cap of the sections only while the main list is empty', async () => {
    const style = document.createElement('style');
    style.textContent = jest
      .requireActual('fs')
      .readFileSync('style/base.css', 'utf8');
    document.head.appendChild(style);
    const routes = { ...sourcedRoutes(), list: listOf([]) };
    const widget = await openAttached(routes);
    const box = find(widget, '.jp-TrashPanel-sections');
    const emptyCap = getComputedStyle(box).maxHeight;
    // ACC-NAV-85-EMPTY-LINE: the empty line is italic and never centered
    const emptyLine = getComputedStyle(find(widget, '.jp-TrashPanel-empty'));
    const emptyJustify = emptyLine.justifyContent;
    const emptyFontStyle = emptyLine.fontStyle;

    routes.list = listOf([file('one.txt')], '5 B');
    await widget.refresh();
    await settle();
    const fullCap = getComputedStyle(box).maxHeight;
    style.remove();

    expect(emptyCap).toBe('none');
    expect(fullCap).toBe('40%');
    expect(emptyJustify).not.toBe('center');
    expect(emptyFontStyle).toBe('italic');
  });

  it('sends no second sources request while one is running', async () => {
    const held = deferred<unknown>();
    const routes = sourcedRoutes();
    const answer = routes.sources;
    routes.sources = () => held.promise;
    serve(routes);
    const sourceCalls = () =>
      request.mock.calls.filter(call => call[0] === 'sources').length;
    const widget = new TrashWidget(settings);

    void widget.refresh();
    void widget.refresh();
    await settle();
    expect(sourceCalls()).toBe(1);

    held.resolve(answer);
    await settle();
    expect(sectionHeader(widget, 'cache')).not.toBeNull();
    void widget.refresh();
    await settle();
    expect(sourceCalls()).toBe(2);
  });

  it('collapses on a header click, writes the key, and reloads collapsed', async () => {
    const widget = await open(sourcedRoutes());
    const header = sectionHeader(widget, 'cache');
    expect(header.tagName).toBe('BUTTON');
    expect(header.getAttribute('type')).toBe('button');
    expect(header.getAttribute('aria-expanded')).toBe('true');
    expect(sectionRows(widget, 'cache')).toHaveLength(1);

    click(header);
    expect(header.getAttribute('aria-expanded')).toBe('false');
    expect(sectionList(widget, 'cache').hidden).toBe(true);
    expect(sectionLabel(widget, 'cache').textContent).toBe(
      '/home/cache (12 items, 40 MB)'
    );
    expect(JSON.parse(window.localStorage.getItem(COLLAPSED_KEY)!)).toEqual([
      'cache'
    ]);

    // A fresh widget reads the same key and draws the section collapsed
    const again = await open(sourcedRoutes());
    expect(sectionHeader(again, 'cache').getAttribute('aria-expanded')).toBe(
      'false'
    );
    expect(sectionList(again, 'cache').hidden).toBe(true);
    expect(sectionLabel(again, 'cache').textContent).toBe(
      '/home/cache (12 items, 40 MB)'
    );
    expect(
      sectionHeader(again, 'home:alice').getAttribute('aria-expanded')
    ).toBe('true');
  });

  it('toggles from the keyboard with Enter and Space', async () => {
    const widget = await openAttached(sourcedRoutes());
    const header = sectionHeader(widget, 'home:alice');
    header.focus();

    press(header, 'Enter');
    expect(header.getAttribute('aria-expanded')).toBe('false');
    expect(JSON.parse(window.localStorage.getItem(COLLAPSED_KEY)!)).toEqual([
      'home:alice'
    ]);

    press(header, ' ');
    expect(header.getAttribute('aria-expanded')).toBe('true');
    expect(document.activeElement).toBe(header);
  });

  it('renders the main list and the cache section while a home listing is held', async () => {
    const held = deferred<unknown>();
    const routes = sourcedRoutes();
    routes['list?source=home%3Aalice'] = () => held.promise;
    const widget = await open(routes);

    // The xdg list and the cache section answer without the held source
    expect(rowNames(widget)).toEqual(['one.txt']);
    expect(sectionRows(widget, 'cache')).toHaveLength(1);
    expect(sectionRows(widget, 'home:alice')).toHaveLength(0);

    held.resolve(listOf([file('alice.txt')], '2 KB'));
    await settle();
    expect(sectionRows(widget, 'home:alice')).toHaveLength(1);
  });

  it('posts scope all from the clean-all dialog after naming every source', async () => {
    const widget = await open(sourcedRoutes());
    (showDialog as jest.Mock).mockResolvedValue({ button: { accept: true } });
    const routes = sourcedRoutes();
    routes.empty = {
      success: true,
      deleted_count: 3,
      sources: [
        { id: 'xdg', label: 'Trash', deleted_count: 1, errors: [] },
        { id: 'cache', label: '/home/cache', deleted_count: 2, errors: [] }
      ]
    };
    serve(routes);

    await (widget as any)._commands.execute('trash:clean-all');
    await settle();

    const dialog = (showDialog as jest.Mock).mock.calls[0][0];
    expect(dialog.title).toBe('Empty All Bins');
    expect(dialog.body).toContain('Trash (1 item, 5 B)');
    expect(dialog.body).toContain('/home/cache (12 items, 40 MB)');
    expect(dialog.body).toContain('/home/alice (1 item, 2 KB)');

    const empty = request.mock.calls.find(call => call[0] === 'empty')!;
    expect(JSON.parse(empty[2].body)).toEqual({ scope: 'all' });

    // The run reports its per-source counts afterwards
    const report = (showDialog as jest.Mock).mock.calls[1][0];
    expect(report.body).toContain('Trash: 1 item deleted');
    expect(report.body).toContain('/home/cache: 2 items deleted');
  });

  it('names the workspace root and posts scope workspace', async () => {
    PageConfig.setOption('serverRoot', '/home/lab/workspace');
    const widget = await open(sourcedRoutes());
    (showDialog as jest.Mock).mockResolvedValue({ button: { accept: true } });
    const routes = sourcedRoutes();
    routes.empty = {
      success: true,
      deleted_count: 2,
      left_count: 3,
      sources: [
        { id: 'xdg', label: 'Trash', deleted_count: 1, errors: [] },
        { id: 'cache', label: '/home/cache', deleted_count: 1, errors: [] }
      ]
    };
    serve(routes);

    await (widget as any)._commands.execute('trash:clean-workspace');
    await settle();

    const dialog = (showDialog as jest.Mock).mock.calls[0][0];
    expect(dialog.title).toBe('Clean Workspace');
    expect(dialog.body).toContain('/home/lab/workspace');
    expect(dialog.body).toContain('Only entries under');
    expect(dialog.body).toContain('/home/cache (12 items, 40 MB)');
    expect(dialog.body).toContain('/home/alice (1 item, 2 KB)');

    const empty = request.mock.calls.find(call => call[0] === 'empty')!;
    expect(JSON.parse(empty[2].body)).toEqual({ scope: 'workspace' });

    // The run reports the per-source counts and the left count
    const report = (showDialog as jest.Mock).mock.calls[1][0];
    expect(report.body).toContain('Trash: 1 item deleted');
    expect(report.body).toContain('3 items left');
  });

  it('renders no section for an absent source and an error header for an unreadable one', async () => {
    const routes = sourcedRoutes();
    routes.sources = [
      sourceOf('xdg', 1, '5 B'),
      sourceOf('cache', 0, '0 B', 'Permission denied')
    ];
    const widget = await open(routes);

    expect(widget.node.querySelector('[data-source="home:alice"]')).toBeNull();
    expect(sectionLabel(widget, 'cache').textContent).toContain(
      'Permission denied'
    );
    expect(sectionRows(widget, 'cache')).toHaveLength(0);
    expect(requested()).not.toContain('list?source=cache');
  });

  it('renders the error in the header when a section listing fails', async () => {
    const routes = sourcedRoutes();
    routes['list?source=cache'] = () => Promise.reject(httpError(500));
    const widget = await open(routes);

    expect(sectionHeader(widget, 'cache').getAttribute('aria-expanded')).toBe(
      'true'
    );
    expect(sectionLabel(widget, 'cache').textContent).toContain('HTTP 500');
    expect(sectionRows(widget, 'cache')).toHaveLength(0);
  });

  it('carries no animation on the section header or caret', async () => {
    const widget = await open(sourcedRoutes());
    const header = sectionHeader(widget, 'cache');
    const caret = header.querySelector<HTMLElement>('.jp-TrashPanel-caret')!;

    expect(header.className).toBe('jp-TrashPanel-sectionHeader');
    expect(caret.className).toBe('jp-TrashPanel-caret');
    expect(header.getAttribute('aria-hidden')).toBeNull();
    expect(caret.getAttribute('aria-hidden')).toBe('true');
    for (const element of [header, caret]) {
      expect(element.style.getPropertyValue('animation')).toBe('');
      expect(element.style.getPropertyValue('transition')).toBe('');
    }
  });
});

describe('location trash sections', () => {
  beforeEach(showVolumesOn);

  const LOCATION = 'location:/mnt/data/.Trash-1000';
  const LISTING = 'list?source=location%3A%2Fmnt%2Fdata%2F.Trash-1000';

  /** The sourced routes plus a location trash holding two entries. */
  function locationRoutes(): Record<string, Route> {
    const routes = sourcedRoutes();
    routes.sources = [
      ...(routes.sources as ISource[]),
      sourceOf(LOCATION, 2, '3 KB')
    ];
    routes[LISTING] = listOf([file('a.txt'), file('b.txt')], '3 KB');
    return routes;
  }

  const locationRows = (widget: TrashWidget) => sectionRows(widget, LOCATION);

  const sectionMenuOpen = (widget: TrashWidget) =>
    jest
      .spyOn((widget as any)._sectionMenu, 'open')
      .mockImplementation(() => undefined);

  function rightClick(element: HTMLElement): void {
    element.dispatchEvent(
      new MouseEvent('contextmenu', { bubbles: true, cancelable: true })
    );
  }

  it('renders as a section labelled with its location after the cache and home sections', async () => {
    const widget = await open(locationRoutes());

    expect(sections(widget).map(element => element.dataset.source)).toEqual([
      'xdg',
      'cache',
      'home:alice',
      LOCATION
    ]);
    expect(sectionLabel(widget, LOCATION).textContent).toBe(
      '/mnt/data (2 items, 3 KB)'
    );
    expect(sectionList(widget, LOCATION).getAttribute('role')).toBe('listbox');
    expect(locationRows(widget).map(row => row.tabIndex)).toEqual([0, -1]);
  });

  it('opens the Restore menu on right-click and posts the source with the path', async () => {
    const widget = await open(locationRoutes());
    const opened = sectionMenuOpen(widget);

    rightClick(locationRows(widget)[0]);
    expect(opened).toHaveBeenCalledTimes(1);
    const menu = (widget as any)._sectionMenu;
    expect(menu.items.map((item: any) => item.label)).toEqual([
      'Restore',
      '',
      'Hide Volumes'
    ]);

    const routes = locationRoutes();
    routes.sources = [
      sourceOf('xdg', 1, '5 B'),
      sourceOf('cache', 12, '40 MB'),
      sourceOf('home:alice', 1, '2 KB'),
      sourceOf(LOCATION, 1, '1 KB')
    ];
    routes[LISTING] = listOf([file('b.txt')], '1 KB');
    routes.restore = { success: true, restored_to: '/mnt/data/a.txt' };
    serve(routes);

    await menu.commands.execute(menu.items[0].command);
    await settle();

    const restore = request.mock.calls.find(call => call[0] === 'restore')!;
    expect(restore[2].method).toBe('POST');
    expect(JSON.parse(restore[2].body)).toEqual({
      trash_path: 'a.txt',
      source: LOCATION
    });
    // The section and its count reload; the main list is not asked again
    expect(sectionLabel(widget, LOCATION).textContent).toBe(
      '/mnt/data (1 item, 1 KB)'
    );
    expect(locationRows(widget)).toHaveLength(1);
    expect(requested().filter(endPoint => endPoint === 'list')).toHaveLength(1);
    expect(showErrorMessage).not.toHaveBeenCalled();
  });

  it('turns off the panel hover while the Restore menu is open (ACC-SCOPE-84-ROW-HOVER)', async () => {
    const widget = await openAttached(locationRoutes());

    rightClick(locationRows(widget)[0]);
    expect(widget.node.classList).toContain('jp-mod-contextMenuOpen');

    (widget as any)._sectionMenu.close();
    expect(widget.node.classList).not.toContain('jp-mod-contextMenuOpen');
  });

  it('opens the menu with Shift+F10 and the menu key on the focused row', async () => {
    const widget = await openAttached(locationRoutes());
    const opened = sectionMenuOpen(widget);
    const row = locationRows(widget)[1];
    row.focus();
    expect(row.tabIndex).toBe(0);

    press(row, 'F10', { shiftKey: true });
    expect(opened).toHaveBeenCalledTimes(1);
    expect((widget as any)._sectionTarget.item.trash_path).toBe('b.txt');

    press(row, 'ContextMenu');
    expect(opened).toHaveBeenCalledTimes(2);

    press(row, 'F10');
    expect(opened).toHaveBeenCalledTimes(2);
  });

  it('moves the active row with the arrows, Home and End as one tab stop', async () => {
    const widget = await openAttached(locationRoutes());
    const [first, second] = locationRows(widget);
    first.focus();

    press(first, 'ArrowDown');
    expect(document.activeElement).toBe(second);
    expect(locationRows(widget).map(row => row.tabIndex)).toEqual([-1, 0]);

    // The last row stays active past the end
    press(second, 'ArrowDown');
    expect(document.activeElement).toBe(second);

    press(second, 'Home');
    expect(document.activeElement).toBe(first);
    press(first, 'End');
    expect(document.activeElement).toBe(second);
    press(second, 'ArrowUp');
    expect(document.activeElement).toBe(first);
    expect(locationRows(widget).map(row => row.tabIndex)).toEqual([0, -1]);
  });

  it('keeps the focused row node when a refresh brings the same listing', async () => {
    const widget = await openAttached(locationRoutes());
    const row = locationRows(widget)[1];
    row.focus();
    const asked = requested().filter(endPoint => endPoint === LISTING).length;

    await (widget as any)._refreshInBackground();
    await settle();

    expect(requested().filter(endPoint => endPoint === LISTING)).toHaveLength(
      asked + 1
    );
    expect(locationRows(widget)[1]).toBe(row);
    expect(document.activeElement).toBe(row);
  });

  // The first row hands the focus on to the next, the last one to the row before
  it.each([
    [0, ['b.txt', 'c.txt'], [0, -1]],
    [2, ['a.txt', 'b.txt'], [-1, 0]]
  ])(
    'focuses the former second row after a keyboard restore of row %d of three',
    async (restored, left, tabIndexes) => {
      const routes = locationRoutes();
      routes[LISTING] = listOf([file('a.txt'), file('b.txt'), file('c.txt')]);
      const widget = await openAttached(routes);
      sectionMenuOpen(widget);
      const row = locationRows(widget)[restored];
      row.focus();
      press(row, 'F10', { shiftKey: true });

      const after = locationRoutes();
      after[LISTING] = listOf(left.map(name => file(name)));
      after.restore = { success: true, restored_to: '/mnt/data/x' };
      serve(after);
      await (widget as any)._commands.execute('trash:restore-from-source');
      await settle();

      expect((document.activeElement as HTMLElement).dataset.path).toBe(
        'b.txt'
      );
      expect(locationRows(widget).map(item => item.tabIndex)).toEqual(
        tabIndexes
      );
    }
  );

  it('shows the error of a 409 answer and keeps the row', async () => {
    const widget = await open(locationRoutes());
    sectionMenuOpen(widget);
    rightClick(locationRows(widget)[0]);

    const routes = locationRoutes();
    routes.restore = () =>
      Promise.reject(
        Object.assign(new Error('Destination exists: /mnt/data/a.txt'), {
          response: { status: 409 }
        })
      );
    serve(routes);

    await (widget as any)._commands.execute('trash:restore-from-source');
    await settle();

    expect(showErrorMessage).toHaveBeenCalledWith(
      'Restore Failed',
      'a.txt: Destination exists: /mnt/data/a.txt'
    );
    expect(
      locationRows(widget).map(
        row => row.querySelector('.jp-TrashPanel-sectionName')!.textContent
      )
    ).toEqual(['a.txt', 'b.txt']);
    expect(veil(widget).hidden).toBe(true);
  });

  // ACC-SCOPE-92-RESTORE-ALL: if there is a trash, there is Restore
  it.each([
    ['cache', 'cache.bin'],
    ['home:alice', 'alice.txt']
  ])(
    'opens the Restore menu on a %s row by right-click and Shift+F10 and posts its source id',
    async (id, name) => {
      const widget = await openAttached(locationRoutes());
      const opened = sectionMenuOpen(widget);
      const row = sectionRows(widget, id)[0];
      expect(sectionList(widget, id).getAttribute('role')).toBe('listbox');
      expect(row.getAttribute('role')).toBe('option');
      expect(row.tabIndex).toBe(0);
      expect(row.title).toContain(`Original: /home/user/${name}`);

      rightClick(row);
      expect(opened).toHaveBeenCalledTimes(1);
      row.focus();
      press(row, 'F10', { shiftKey: true });
      expect(opened).toHaveBeenCalledTimes(2);

      const routes = locationRoutes();
      routes[`list?source=${encodeURIComponent(id)}`] = listOf([]);
      routes.restore = { success: true, restored_to: `/home/user/${name}` };
      serve(routes);
      await (widget as any)._commands.execute('trash:restore-from-source');
      await settle();

      const restore = request.mock.calls.find(call => call[0] === 'restore')!;
      expect(JSON.parse(restore[2].body)).toEqual({
        trash_path: name,
        source: id
      });
      expect(sectionRows(widget, id)).toHaveLength(0);
      expect(showErrorMessage).not.toHaveBeenCalled();
    }
  );

  it('names the location source with its count and size in both clean dialogs', async () => {
    const widget = await open(locationRoutes());
    (showDialog as jest.Mock).mockResolvedValue({ button: { accept: false } });

    await (widget as any)._commands.execute('trash:clean-all');
    await settle();
    await (widget as any)._commands.execute('trash:clean-workspace');
    await settle();

    const dialogs = (showDialog as jest.Mock).mock.calls.map(call => call[0]);
    expect(dialogs.map(dialog => dialog.title)).toEqual([
      'Empty All Bins',
      'Clean Workspace'
    ]);
    for (const dialog of dialogs) {
      expect(dialog.body).toContain('/mnt/data (2 items, 3 KB)');
    }
  });
});

describe('Show Volumes and the merged list', () => {
  const LOCATION = 'location:/mnt/data/.Trash-1000';
  const LISTING = 'list?source=location%3A%2Fmnt%2Fdata%2F.Trash-1000';

  const headerMenu = (widget: TrashWidget) => (widget as any)._headerMenu;

  function rightClick(element: HTMLElement): void {
    element.dispatchEvent(
      new MouseEvent('contextmenu', { bubbles: true, cancelable: true })
    );
  }

  /** A row deleted at this hour, so the default newest-first sort orders it. */
  const at = (row: IRow, hour: number): IRow => ({
    ...row,
    deletion_date: `2024-01-14T${String(hour).padStart(2, '0')}:00:00`
  });

  /** The xdg trash and a location trash, each with its own byte total. */
  function mergedRoutes(): Record<string, Route> {
    return {
      sources: [sourceOf('xdg', 2, '1000 B'), sourceOf(LOCATION, 1, '2.0 KB')],
      list: {
        ...listOf([at(file('one.txt'), 9), at(file('three.txt'), 11)]),
        total_size: 1000
      },
      [LISTING]: { ...listOf([at(folder('d'), 10)]), total_size: 2048 }
    };
  }

  const rowOf = (widget: TrashWidget, source: string, name: string) =>
    rows(widget).find(
      row =>
        row.dataset.source === source &&
        row.querySelector('.jp-TrashPanel-item-name')!.textContent === name
    )!;

  it.each([
    ['unset', null],
    ['unreadable', '{not json']
  ])(
    'is off while the saved choice is %s: no section, and the header menu holds Show Volumes unchecked',
    async (_, saved) => {
      if (saved !== null) {
        window.localStorage.setItem(SHOW_VOLUMES_KEY, saved);
      }
      const widget = await open(sourcedRoutes());
      expect(sections(widget)).toHaveLength(0);

      const opened = jest
        .spyOn(headerMenu(widget), 'open')
        .mockImplementation(() => undefined);
      rightClick(find(widget, '.jp-TrashPanel-header'));
      expect(opened).toHaveBeenCalledTimes(1);
      const items = headerMenu(widget).items;
      expect(items.map((item: any) => item.label)).toEqual(['Show Volumes']);
      expect(items[0].isToggled).toBe(false);
    }
  );

  it('draws the sections when run, saves the choice, and a new widget starts with it on', async () => {
    const widget = await open(sourcedRoutes());

    await (widget as any)._commands.execute('trash:show-volumes');
    await settle();
    expect(sections(widget).map(element => element.dataset.source)).toEqual([
      'xdg',
      'cache',
      'home:alice'
    ]);
    // While on, the main list is the XDG trash only
    expect(rowNames(widget)).toEqual(['one.txt']);
    expect(window.localStorage.getItem(SHOW_VOLUMES_KEY)).toBe('true');

    const again = await open(sourcedRoutes());
    expect(sections(again)).toHaveLength(3);
    expect(headerMenu(again).items[0].label).toBe('Hide Volumes');
    expect(headerMenu(again).items[0].isToggled).toBe(false);

    // Running it again removes the sections
    await (again as any)._commands.execute('trash:show-volumes');
    await settle();
    expect(sections(again)).toHaveLength(0);
    expect(window.localStorage.getItem(SHOW_VOLUMES_KEY)).toBe('false');
  });

  // ACC-SCOPE-103-HIDE-VOLUMES: the entry names what it does, with no check mark
  it('labels the entry Hide Volumes while the volumes show and Show Volumes while hidden, with no check mark, and notifies each flip', async () => {
    const widget = await open(sourcedRoutes());
    const commands = (widget as any)._commands;
    const changed = jest.fn();
    commands.commandChanged.connect((_: unknown, args: any) =>
      changed(args.id)
    );
    expect(commands.label('trash:show-volumes')).toBe('Show Volumes');
    expect(commands.isToggled('trash:show-volumes')).toBe(false);

    await commands.execute('trash:show-volumes');
    await settle();
    expect(commands.label('trash:show-volumes')).toBe('Hide Volumes');
    expect(commands.isToggled('trash:show-volumes')).toBe(false);
    expect(changed).toHaveBeenCalledWith('trash:show-volumes');

    changed.mockClear();
    await commands.execute('trash:show-volumes');
    await settle();
    expect(commands.label('trash:show-volumes')).toBe('Show Volumes');
    expect(changed).toHaveBeenCalledWith('trash:show-volumes');
  });

  it('merges a location answering later into the sorted main list and sums the summary', async () => {
    const held = deferred<unknown>();
    const routes = mergedRoutes();
    const listing = routes[LISTING];
    routes[LISTING] = () => held.promise;
    const widget = await open(routes);

    // The xdg rows show while the location is still unanswered
    expect(rowNames(widget)).toEqual(['three.txt', 'one.txt']);
    expect(summary(widget).textContent).toBe('2 items · 0 B');

    // A refresh sends no second request for the pending location
    void widget.refresh();
    await settle();
    expect(requested().filter(endPoint => endPoint === LISTING)).toHaveLength(
      1
    );

    held.resolve(listing);
    await settle();
    expect(rowNames(widget)).toEqual(['three.txt', 'd', 'one.txt']);
    expect(rowOf(widget, LOCATION, 'd')).toBeDefined();
    expect(summary(widget).textContent).toBe('3 items · 3.0 KB');
    expect(sections(widget)).toHaveLength(0);

    // Show Volumes on: the XDG rows only, and the location as a section
    await (widget as any)._commands.execute('trash:show-volumes');
    await settle();
    expect(rowNames(widget)).toEqual(['three.txt', 'one.txt']);
    expect(sections(widget).map(element => element.dataset.source)).toEqual([
      'xdg',
      LOCATION
    ]);
  });

  it('turning Show Volumes on drops the merged location row at once, before the next list answers', async () => {
    const routes = mergedRoutes();
    routes.list = listOf([file('one.txt')]);
    const widget = await open(routes);
    expect(rowNames(widget).sort()).toEqual(['d', 'one.txt']);

    const held = deferred<unknown>();
    serve({ ...routes, list: () => held.promise });
    await (widget as any)._commands.execute('trash:show-volumes');
    await settle();
    expect(rowNames(widget)).toEqual(['one.txt']);
    held.resolve(routes.list);
    await settle();
  });

  it('gives one name in two sources two rows, each its own identity', async () => {
    const routes = mergedRoutes();
    routes[LISTING] = listOf([file('one.txt')]);
    const widget = await openAttached(routes);

    expect(rowNames(widget).filter(name => name === 'one.txt')).toHaveLength(2);
    const ids = rows(widget).map(row => row.id);
    expect(new Set(ids).size).toBe(ids.length);

    const located = rowOf(widget, LOCATION, 'one.txt');
    click(located);
    expect(selectedNames(widget)).toEqual(['one.txt']);
    expect(located.classList).toContain('jp-mod-selected');
    expect(listBox(widget).getAttribute('aria-activedescendant')).toBe(
      located.id
    );
  });

  it('sends the location source id on restore, delete and folder entry of a location row', async () => {
    const routes = mergedRoutes();
    routes[LISTING] = {
      ...listOf([at(file('a.txt'), 12), at(folder('d'), 10)]),
      total_size: 2048
    };
    routes.restore = { success: true, restored_to: '/mnt/data/a.txt' };
    routes.delete = { success: true };
    routes[`${LISTING}&path=d`] = listOf([file('inner.txt', 'd')]);
    const widget = await open(routes);
    jest
      .spyOn((widget as any)._contextMenu, 'open')
      .mockImplementation(() => undefined);
    const bodyOf = (endPoint: string) =>
      JSON.parse(
        request.mock.calls.find(call => call[0] === endPoint)![2].body
      );

    rightClick(rowOf(widget, LOCATION, 'a.txt'));
    await (widget as any)._commands.execute('trash:restore');
    await settle();
    expect(bodyOf('restore')).toEqual({
      trash_path: 'a.txt',
      source: LOCATION
    });

    (showDialog as jest.Mock).mockResolvedValue({ button: { accept: true } });
    rightClick(rowOf(widget, LOCATION, 'a.txt'));
    await (widget as any)._commands.execute('trash:delete');
    await settle();
    expect(bodyOf('delete')).toEqual({ trash_path: 'a.txt', source: LOCATION });

    doubleClick(rowOf(widget, LOCATION, 'd'));
    await settle();
    expect(requested()).toContain(`${LISTING}&path=d`);
    expect(rowNames(widget)).toEqual(['inner.txt']);
    expect(rows(widget)[0].dataset.source).toBe(LOCATION);

    // The breadcrumb returns to the merged top level
    click(crumbs(widget)[0]);
    await settle();
    expect(rowNames(widget)).toEqual(['a.txt', 'three.txt', 'd', 'one.txt']);
    expect(showErrorMessage).not.toHaveBeenCalled();
  });

  it('draws a location answering before the XDG trash on the first load, then merges the XDG rows', async () => {
    const held = deferred<unknown>();
    const routes = mergedRoutes();
    const listing = routes.list;
    routes.list = () => held.promise;
    serve(routes);
    const widget = new TrashWidget(settings);
    void widget.refresh();
    await settle();
    expect(rowNames(widget)).toEqual(['d']);
    expect(veil(widget).hidden).toBe(true);

    held.resolve(listing);
    await settle();
    expect(rowNames(widget)).toEqual(['three.txt', 'd', 'one.txt']);
    expect(summary(widget).textContent).toBe('3 items · 3.0 KB');
  });

  it("shows 'Trash is empty' only once every source has answered with 0 items", async () => {
    const xdg = deferred<unknown>();
    const located = deferred<unknown>();
    serve({
      sources: [sourceOf('xdg'), sourceOf(LOCATION)],
      list: () => xdg.promise,
      [LISTING]: () => located.promise
    });
    const widget = new TrashWidget(settings);
    const emptyLine = () => find(widget, '.jp-TrashPanel-empty');
    void widget.refresh();
    await settle();
    expect(emptyLine().style.display).toBe('none');

    xdg.resolve(listOf([]));
    await settle();
    expect(emptyLine().style.display).toBe('none');

    located.resolve(listOf([]));
    await settle();
    expect(emptyLine().style.display).toBe('');
    expect(emptyLine().textContent).toBe('Trash is empty');
  });

  /** Hold the next two requests of an end point until the test answers them. */
  function holdRoute(routes: Record<string, Route>, endPoint: string) {
    const early = deferred<unknown>();
    const fresh = deferred<unknown>();
    let calls = 0;
    routes[endPoint] = () => (calls++ === 0 ? early.promise : fresh.promise);
    return { early, fresh };
  }

  /**
   * Start a location listing with a refresh, held until the test answers it,
   * and hold the next one too.
   */
  async function holdListings(
    widget: TrashWidget,
    routes: Record<string, Route>
  ) {
    const held = holdRoute(routes, LISTING);
    void widget.refresh();
    await settle();
    return held;
  }

  /** Follow an action's promise. */
  function track(action: Promise<void>): { done: boolean } {
    const state = { done: false };
    void action.then(() => (state.done = true));
    return state;
  }

  /** A row of this size in bytes. */
  const sized = (row: IRow, size: number): IRow => ({ ...row, size });

  /** A per-source entry of a clean response, with no error. */
  const cleaned = (id: string) => ({
    id,
    label: sourceOf(id).label,
    deleted_count: 1,
    errors: []
  });

  it('removes a deleted location row and lowers the veil before the location lists again, and drops a listing that started before it', async () => {
    const routes = mergedRoutes();
    const before = {
      ...listOf([
        at(sized(file('a.txt'), 1024), 12),
        at(sized(folder('d'), 2048), 10)
      ]),
      total_size: 3072
    };
    routes[LISTING] = before;
    routes.delete = { success: true };
    const widget = await open(routes);
    expect(summary(widget).textContent).toBe('4 items · 4.0 KB');
    const { early, fresh } = await holdListings(widget, routes);

    (showDialog as jest.Mock).mockResolvedValue({ button: { accept: true } });
    const item = (widget as any)._items.find(
      (row: any) => row.source === LOCATION && row.name === 'a.txt'
    );
    const action = track((widget as any)._deleteItems([item]));
    await settle();
    // The delete answered: the veil is down and its row is gone at once
    expect(action.done).toBe(true);
    expect(veil(widget).hidden).toBe(true);
    expect(rowNames(widget)).toEqual(['three.txt', 'd', 'one.txt']);
    expect(summary(widget).textContent).toBe('3 items · 3.0 KB');

    // The listing asked for before the delete answers late with the old rows
    early.resolve(before);
    await settle();
    expect(rowNames(widget)).toEqual(['three.txt', 'd', 'one.txt']);
    expect(summary(widget).textContent).toBe('3 items · 3.0 KB');

    // The fresh listing redraws the location's rows when it answers
    fresh.resolve({
      ...listOf([at(sized(folder('d'), 2048), 10), at(file('e.txt'), 8)]),
      total_size: 2048
    });
    await settle();
    expect(rowNames(widget)).toEqual(['three.txt', 'd', 'one.txt', 'e.txt']);
  });

  it('removes a deleted XDG row while the location listing is held, keeps the row whose delete failed, and ignores the pre-action listings', async () => {
    const routes = mergedRoutes();
    const xdgBefore = {
      ...listOf([
        at(sized(file('one.txt'), 100), 9),
        at(sized(file('three.txt'), 200), 11)
      ]),
      total_size: 300
    };
    routes.list = xdgBefore;
    let deletes = 0;
    routes.delete = () =>
      deletes++ === 0
        ? Promise.resolve({ success: true })
        : Promise.reject(new Error('denied'));
    const widget = await open(routes);
    expect(summary(widget).textContent).toBe('3 items · 2.3 KB');
    const locationBefore = routes[LISTING];
    const main = holdRoute(routes, 'list');
    const located = holdRoute(routes, LISTING);
    void widget.refresh();
    await settle();

    (showDialog as jest.Mock).mockResolvedValue({ button: { accept: true } });
    const items = ['one.txt', 'three.txt'].map(name =>
      (widget as any)._items.find((row: any) => row.name === name)
    );
    const action = track((widget as any)._deleteItems(items));
    await settle();
    expect(action.done).toBe(true);
    expect(veil(widget).hidden).toBe(true);
    // one.txt's delete succeeded, three.txt's failed and its row stays
    expect(rowNames(widget)).toEqual(['three.txt', 'd']);
    expect(summary(widget).textContent).toBe('2 items · 2.2 KB');
    expect(showErrorMessage).toHaveBeenCalledWith(
      'Delete Failed',
      'three.txt: denied'
    );

    // The listings asked for before the delete answer late with the old rows
    main.early.resolve(xdgBefore);
    located.early.resolve(locationBefore);
    await settle();
    expect(rowNames(widget)).toEqual(['three.txt', 'd']);
    expect(summary(widget).textContent).toBe('2 items · 2.2 KB');

    main.fresh.resolve({
      ...listOf([at(sized(file('three.txt'), 200), 11)]),
      total_size: 200
    });
    located.fresh.resolve(locationBefore);
    await settle();
    expect(rowNames(widget)).toEqual(['three.txt', 'd']);
  });

  it('removes every source row once Empty All Bins answers with no errors, before the sources list again', async () => {
    const routes = mergedRoutes();
    routes.empty = {
      success: true,
      deleted_count: 3,
      sources: [cleaned('xdg'), cleaned(LOCATION)]
    };
    const widget = await open(routes);
    expect(emptyButton(widget).disabled).toBe(false);
    const before = routes[LISTING];
    const { early, fresh } = await holdListings(widget, routes);
    routes.list = listOf([]);
    routes.sources = [sourceOf('xdg', 0, '0 B'), sourceOf(LOCATION, 0, '0 B')];

    (showDialog as jest.Mock).mockResolvedValue({ button: { accept: true } });
    const action = track((widget as any)._cleanSources('all'));
    await settle();
    expect(action.done).toBe(true);
    expect(veil(widget).hidden).toBe(true);
    expect(rowNames(widget)).toEqual([]);
    expect(summary(widget).textContent).toBe('0 items · 0 B');
    expect(emptyButton(widget).disabled).toBe(true);

    early.resolve(before);
    await settle();
    expect(rowNames(widget)).toEqual([]);
    expect(summary(widget).textContent).toBe('0 items · 0 B');

    fresh.resolve(listOf([]));
    await settle();
    expect(rowNames(widget)).toEqual([]);
  });

  it('removes only the rows under the notebook root of each source Clean Workspace reports without errors', async () => {
    PageConfig.setOption('serverRoot', '/home/user/');
    const routes = mergedRoutes();
    const outside = listOf([at(folder('d'), 10)]);
    outside.items[0].original_path = '/srv/d';
    routes[LISTING] = outside;
    routes.empty = {
      success: true,
      deleted_count: 2,
      sources: [cleaned('xdg'), cleaned(LOCATION)],
      left_count: 1
    };
    const widget = await open(routes);
    expect(rowNames(widget)).toEqual(['three.txt', 'd', 'one.txt']);
    // Both sources list again after the clean, held unanswered
    holdRoute(routes, 'list');
    holdRoute(routes, LISTING);

    (showDialog as jest.Mock).mockResolvedValue({ button: { accept: true } });
    await (widget as any)._cleanSources('workspace');
    await settle();
    expect(rowNames(widget)).toEqual(['d']);
  });

  it('removes the rows of a section its band empty emptied before the section lists again, with Show Volumes on', async () => {
    showVolumesOn();
    const routes = mergedRoutes();
    routes.empty = { success: true, deleted_count: 1 };
    const widget = await open(routes);
    expect(sectionRows(widget, LOCATION)).toHaveLength(1);
    const before = routes[LISTING];
    const { early, fresh } = await holdListings(widget, routes);
    routes.sources = [
      sourceOf('xdg', 2, '1000 B'),
      sourceOf(LOCATION, 0, '0 B')
    ];

    (showDialog as jest.Mock).mockResolvedValue({ button: { accept: true } });
    const action = track((widget as any)._emptySource(LOCATION));
    await settle();
    expect(action.done).toBe(true);
    expect(veil(widget).hidden).toBe(true);
    expect(sectionRows(widget, LOCATION)).toHaveLength(0);

    early.resolve(before);
    await settle();
    expect(sectionRows(widget, LOCATION)).toHaveLength(0);

    fresh.resolve(listOf([]));
    await settle();
    expect(sectionRows(widget, LOCATION)).toHaveLength(0);
  });

  // ACC-SCOPE-92-RESTORE-ALL: if there is a trash, there is Restore
  it.each([
    ['cache', 'cache.bin'],
    ['home:alice', 'alice.txt']
  ])(
    'offers Restore first on a %s row of the merged list and posts its source id',
    async (id, name) => {
      const widget = await open(sourcedRoutes());
      const commands = (widget as any)._commands;
      jest
        .spyOn((widget as any)._contextMenu, 'open')
        .mockImplementation(() => undefined);

      rightClick(rowOf(widget, id, name));
      expect(commands.isVisible('trash:restore')).toBe(true);
      expect(
        (widget as any)._contextMenu.items.map((item: any) => item.command)
      ).toEqual(['trash:restore', 'trash:delete', '', 'trash:show-volumes']);

      const routes = sourcedRoutes();
      routes[`list?source=${encodeURIComponent(id)}`] = listOf([]);
      routes.restore = { success: true, restored_to: `/home/user/${name}` };
      serve(routes);
      await commands.execute('trash:restore');
      await settle();

      const restore = request.mock.calls.find(call => call[0] === 'restore')!;
      expect(JSON.parse(restore[2].body)).toEqual({
        trash_path: name,
        source: id
      });
      expect(rows(widget).some(row => row.dataset.source === id)).toBe(false);
      expect(showErrorMessage).not.toHaveBeenCalled();
    }
  );
});

// ACC-SCOPE-100-MENU-EVERYWHERE: every right-click in the panel offers Show Volumes
describe('Show Volumes in every right-click', () => {
  /** Right-click an element and return the event, to read defaultPrevented. */
  function rightClick(element: HTMLElement): MouseEvent {
    const event = new MouseEvent('contextmenu', {
      bubbles: true,
      cancelable: true
    });
    element.dispatchEvent(event);
    return event;
  }

  const menuOpen = (widget: TrashWidget, menu: string) =>
    jest
      .spyOn((widget as any)[menu], 'open')
      .mockImplementation(() => undefined);

  it.each([
    ['the summary bar', '.jp-TrashPanel-summary'],
    ['the main list empty space', '.jp-TrashPanel-list'],
    ['the empty line', '.jp-TrashPanel-empty'],
    ['the breadcrumb', '.jp-TrashPanel-breadcrumb'],
    ['a section band', '.jp-TrashPanel-sectionBand'],
    ['a section fold toggle', '.jp-TrashPanel-sectionHeader'],
    [
      'a section trash button',
      '.jp-TrashPanel-section .jp-TrashPanel-sectionEmpty'
    ]
  ])(
    'opens the Show Volumes menu on %s and stops the browser menu',
    async (_, selector) => {
      showVolumesOn();
      const widget = await open(sourcedRoutes());
      const opened = menuOpen(widget, '_headerMenu');

      const event = rightClick(find(widget, selector));
      expect(opened).toHaveBeenCalledTimes(1);
      expect(event.defaultPrevented).toBe(true);
      const items = (widget as any)._headerMenu.items;
      expect(items.map((item: any) => item.label)).toEqual(['Hide Volumes']);
      expect(items[0].isToggled).toBe(false);
    }
  );

  it('ends the section row menu with a separator and Show Volumes after Restore', async () => {
    showVolumesOn();
    const widget = await open(sourcedRoutes());
    const opened = menuOpen(widget, '_sectionMenu');
    const header = menuOpen(widget, '_headerMenu');

    const event = rightClick(sectionRows(widget, 'cache')[0]);
    expect(opened).toHaveBeenCalledTimes(1);
    expect(header).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(true);
    const items = (widget as any)._sectionMenu.items;
    expect(items.map((item: any) => item.type)).toEqual([
      'command',
      'separator',
      'command'
    ]);
    expect(items.map((item: any) => item.command)).toEqual([
      'trash:restore-from-source',
      '',
      'trash:show-volumes'
    ]);
  });

  it('ends the main row menu with a separator and Show Volumes after Restore and Delete', async () => {
    const widget = await open(sourcedRoutes());
    const opened = menuOpen(widget, '_contextMenu');
    const header = menuOpen(widget, '_headerMenu');

    const event = rightClick(rows(widget)[0]);
    expect(opened).toHaveBeenCalledTimes(1);
    expect(header).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(true);
    const items = (widget as any)._contextMenu.items;
    expect(items.map((item: any) => item.type)).toEqual([
      'command',
      'command',
      'separator',
      'command'
    ]);
    expect(items.map((item: any) => item.command)).toEqual([
      'trash:restore',
      'trash:delete',
      '',
      'trash:show-volumes'
    ]);
  });

  it('turns the sections off when run from the menu of a section band', async () => {
    showVolumesOn();
    const widget = await open(sourcedRoutes());
    expect(sections(widget)).toHaveLength(3);
    const opened = menuOpen(widget, '_headerMenu');

    rightClick(find(widget, '.jp-TrashPanel-sectionBand'));
    expect(opened).toHaveBeenCalledTimes(1);
    const entry = (widget as any)._headerMenu.items[0];
    await (widget as any)._commands.execute(entry.command, entry.args);
    await settle();
    expect(sections(widget)).toHaveLength(0);
    expect(widget.showVolumes).toBe(false);
  });

  // ACC-SCOPE-100-MENU-EVERYWHERE: the focus the menu takes comes back to the panel
  describe('focus after the menu', () => {
    /** Right-click an element and let the opened menu take the focus. */
    function openMenuOn(element: HTMLElement): void {
      rightClick(element);
      MessageLoop.flush();
    }

    /** Run the menu item at an index, as Enter on it does. */
    function choose(menu: any, index: number): void {
      menu.activeIndex = index;
      menu.triggerActiveItem();
    }

    it('Show Volumes off from the menu of a focused fold toggle focuses the main list', async () => {
      showVolumesOn();
      const widget = await openAttached(sourcedRoutes());
      const band = sectionHeader(widget, 'cache');
      band.focus();
      openMenuOn(band);
      expect(document.activeElement).not.toBe(band);

      choose((widget as any)._headerMenu, 0);
      expect(sections(widget)).toHaveLength(0);
      expect(document.activeElement).toBe(listBox(widget));
    });

    it('Escape from the menu of a focused fold toggle focuses the fold toggle', async () => {
      showVolumesOn();
      const widget = await openAttached(sourcedRoutes());
      const band = sectionHeader(widget, 'cache');
      band.focus();
      openMenuOn(band);
      const menu = (widget as any)._headerMenu;
      expect(document.activeElement).not.toBe(band);

      press(menu.node, 'Escape', { keyCode: 27 });
      expect(menu.isAttached).toBe(false);
      expect(document.activeElement).toBe(band);
    });

    // DEF-PANEL-44-MENU-FOCUS: a disabled button cannot take the focus back
    it('Escape from the menu of a disabled band trash button focuses that band fold toggle', async () => {
      showVolumesOn();
      const routes = sourcedRoutes();
      routes.sources = [
        sourceOf('xdg', 1, '5 B'),
        sourceOf('cache', 0, '0 B'),
        sourceOf('home:alice', 1, '2 KB')
      ];
      routes['list?source=cache'] = listOf([]);
      const widget = await openAttached(routes);
      const button = sectionOf(widget, 'cache').querySelector<HTMLElement>(
        '.jp-TrashPanel-sectionEmpty:disabled'
      )!;
      openMenuOn(button);
      const menu = (widget as any)._headerMenu;
      expect(menu.isAttached).toBe(true);

      press(menu.node, 'Escape', { keyCode: 27 });
      expect(menu.isAttached).toBe(false);
      expect(document.activeElement).toBe(sectionHeader(widget, 'cache'));
    });

    it('Escape from the menu of the disabled header trash button focuses the refresh button', async () => {
      const widget = await openAttached({ list: listOf([]) });
      expect(emptyButton(widget).disabled).toBe(true);
      openMenuOn(emptyButton(widget));
      const menu = (widget as any)._headerMenu;
      expect(menu.isAttached).toBe(true);

      press(menu.node, 'Escape', { keyCode: 27 });
      expect(menu.isAttached).toBe(false);
      expect(document.activeElement).toBe(refreshButton(widget));
    });

    it('Show Volumes from the Shift+F10 menu of a section row focuses the main list', async () => {
      showVolumesOn();
      const widget = await openAttached(sourcedRoutes());
      const row = sectionRows(widget, 'cache')[0];
      row.focus();
      press(row, 'F10', { shiftKey: true });
      MessageLoop.flush();
      const menu = (widget as any)._sectionMenu;
      expect(menu.isAttached).toBe(true);
      expect(document.activeElement).not.toBe(row);

      choose(menu, 2);
      expect(sections(widget)).toHaveLength(0);
      expect(document.activeElement).toBe(listBox(widget));
    });

    it('Escape from a mouse-opened main row menu focuses the main list and keeps its selection and active row', async () => {
      const widget = await openAttached({
        list: listOf([file('a.txt'), file('b.txt'), file('c.txt')])
      });
      openMenuOn(rows(widget)[rowNames(widget).indexOf('b.txt')]);
      const menu = (widget as any)._contextMenu;
      expect(menu.isAttached).toBe(true);
      const list = listBox(widget);
      expect(document.activeElement).not.toBe(list);
      const selected = selectedNames(widget);
      const active = activeName(widget);

      press(menu.node, 'Escape', { keyCode: 27 });
      expect(menu.isAttached).toBe(false);
      expect(document.activeElement).toBe(list);
      expect(selectedNames(widget)).toEqual(selected);
      expect(activeName(widget)).toBe(active);
      expect(active).toBe('b.txt');
    });

    it('Escape from a mouse-opened section row menu focuses that row', async () => {
      showVolumesOn();
      const widget = await openAttached(sourcedRoutes());
      const row = sectionRows(widget, 'cache')[0];
      openMenuOn(row);
      const menu = (widget as any)._sectionMenu;
      expect(menu.isAttached).toBe(true);
      expect(document.activeElement).not.toBe(row);

      press(menu.node, 'Escape', { keyCode: 27 });
      expect(menu.isAttached).toBe(false);
      expect(document.activeElement).toBe(row);
    });

    it('Show Volumes off from a mouse-opened section row menu focuses the main list', async () => {
      showVolumesOn();
      const widget = await openAttached(sourcedRoutes());
      openMenuOn(sectionRows(widget, 'cache')[0]);
      const menu = (widget as any)._sectionMenu;
      expect(menu.isAttached).toBe(true);

      choose(menu, 2);
      expect(sections(widget)).toHaveLength(0);
      expect(document.activeElement).toBe(listBox(widget));
    });

    it('Delete from a mouse-opened main row menu leaves the focus in the panel', async () => {
      const routes: Record<string, Route> = {
        list: listOf([file('a.txt'), file('b.txt')]),
        delete: { success: true }
      };
      const widget = await openAttached(routes);
      (showDialog as jest.Mock).mockResolvedValue({ button: { accept: true } });
      openMenuOn(rows(widget)[rowNames(widget).indexOf('a.txt')]);
      const menu = (widget as any)._contextMenu;
      expect(menu.isAttached).toBe(true);

      serve({ ...routes, list: listOf([file('b.txt')]) });
      choose(menu, 1);
      await settle();
      expect(rowNames(widget)).toEqual(['b.txt']);
      expect(widget.node.contains(document.activeElement)).toBe(true);
    });

    it('a toggle leaves a focus outside the panel where it was', async () => {
      showVolumesOn();
      const widget = await openAttached(sourcedRoutes());
      const outside = document.createElement('input');
      document.body.appendChild(outside);
      outside.focus();

      widget.toggleShowVolumes();
      expect(sections(widget)).toHaveLength(0);
      expect(document.activeElement).toBe(outside);
      outside.remove();
    });
  });

  // ACC-SCOPE-101-EMPTY-BINS
  it('names the clean of every source Empty All Bins', async () => {
    const widget = await open(sourcedRoutes());
    expect((widget as any)._commands.label('trash:clean-all')).toBe(
      'Empty All Bins'
    );
  });
});

describe('trash buttons', () => {
  const LOCATION = 'location:/mnt/data/.Trash-1000';
  const LISTING = 'list?source=location%3A%2Fmnt%2Fdata%2F.Trash-1000';

  /** An empty XDG trash and a location trash holding two entries. */
  function locationOnlyRoutes(count = 2): Record<string, Route> {
    return {
      sources: [
        sourceOf('xdg', 0, '0 B'),
        sourceOf(LOCATION, count, count ? '3 KB' : '0 B')
      ],
      list: listOf([]),
      [LISTING]: listOf(
        [file('a.txt'), file('b.txt')].slice(0, count),
        count ? '3 KB' : '0 B'
      )
    };
  }

  /** The sourced routes plus a location trash holding two entries. */
  function bandRoutes(): Record<string, Route> {
    const routes = sourcedRoutes();
    routes.sources = [
      ...(routes.sources as ISource[]),
      sourceOf(LOCATION, 2, '3 KB')
    ];
    routes[LISTING] = listOf([file('a.txt'), file('b.txt')], '3 KB');
    return routes;
  }

  const bandEmpty = (widget: TrashWidget, id: string) =>
    sectionOf(widget, id).querySelector<HTMLButtonElement>(
      '.jp-TrashPanel-sectionEmpty'
    )!;

  const emptyCalls = () =>
    request.mock.calls.filter(call => call[0] === 'empty');

  it.each([
    ['off', false],
    ['on', true]
  ])(
    'shows the header button for a location holding items over an empty XDG trash with Show Volumes %s; accept posts scope all after listing every source',
    async (_, on) => {
      if (on) {
        showVolumesOn();
      }
      const widget = await open(locationOnlyRoutes());
      expect(emptyButton(widget).disabled).toBe(false);

      (showDialog as jest.Mock).mockResolvedValue({ button: { accept: true } });
      serve({
        ...locationOnlyRoutes(),
        empty: { success: true, deleted_count: 2, sources: [] }
      });
      emptyButton(widget).click();
      await settle();

      const dialog = (showDialog as jest.Mock).mock.calls[0][0];
      expect(dialog.title).toBe('Empty All Bins');
      expect(dialog.body).toContain('Trash (0 items, 0 B)');
      expect(dialog.body).toContain('/mnt/data (2 items, 3 KB)');
      expect(emptyCalls()).toHaveLength(1);
      expect(JSON.parse(emptyCalls()[0][2].body)).toEqual({ scope: 'all' });
    }
  );

  it('disables the header button once every source holds 0 items', async () => {
    showVolumesOn();
    const widget = await open(locationOnlyRoutes());
    expect(emptyButton(widget).disabled).toBe(false);

    serve(locationOnlyRoutes(0));
    void widget.refresh();
    await settle();
    expect(emptyButton(widget).hidden).toBe(false);
    expect(emptyButton(widget).disabled).toBe(true);
  });

  it('empties one source from its band after a dialog naming it, leaving the fold state and the other sources', async () => {
    showVolumesOn();
    const widget = await openAttached(bandRoutes());
    (showDialog as jest.Mock).mockResolvedValue({ button: { accept: true } });
    const routes = bandRoutes();
    routes.empty = { success: true, deleted_count: 2 };
    serve(routes);

    const button = bandEmpty(widget, LOCATION);
    button.focus();
    press(button, 'Enter');
    click(button);
    await settle();

    const dialogs = (showDialog as jest.Mock).mock.calls.map(call => call[0]);
    expect(dialogs).toHaveLength(1);
    expect(dialogs[0].title).toBe('Empty Trash in /mnt/data');
    expect(dialogs[0].body).toContain('/mnt/data (2 items, 3 KB)');
    expect(dialogs[0].body).not.toContain('/home/cache');
    expect(emptyCalls()).toHaveLength(1);
    expect(JSON.parse(emptyCalls()[0][2].body)).toEqual({
      scope: 'source',
      source: LOCATION
    });

    // Neither the click nor Enter folded a section, and the reload ran
    for (const id of ['cache', 'home:alice', LOCATION]) {
      expect(sectionHeader(widget, id).getAttribute('aria-expanded')).toBe(
        'true'
      );
    }
    expect(window.localStorage.getItem(COLLAPSED_KEY)).toBeNull();
    expect(sectionRows(widget, 'cache')).toHaveLength(1);
    expect(
      request.mock.calls.filter(call => call[0] === 'sources').length
    ).toBeGreaterThan(1);
  });

  it('gives the focus to the fold toggle when a keyboard empty disables the band button', async () => {
    showVolumesOn();
    const widget = await openAttached(bandRoutes());
    (showDialog as jest.Mock).mockResolvedValue({ button: { accept: true } });
    const routes = bandRoutes();
    routes.sources = (routes.sources as ISource[]).map(source =>
      source.id === LOCATION ? sourceOf(LOCATION, 0, '0 B') : source
    );
    routes[LISTING] = listOf([]);
    routes.empty = { success: true, deleted_count: 2 };
    serve(routes);

    const button = bandEmpty(widget, LOCATION);
    button.focus();
    press(button, 'Enter');
    click(button);
    await settle();
    expect(button.hidden).toBe(false);
    expect(button.disabled).toBe(true);
    expect(document.activeElement).toBe(sectionHeader(widget, LOCATION));
  });

  it('reports a failed source empty as the cleans report theirs', async () => {
    showVolumesOn();
    const widget = await open(bandRoutes());
    (showDialog as jest.Mock).mockResolvedValue({ button: { accept: true } });
    const routes = bandRoutes();
    routes.empty = () => Promise.reject(new Error('Unknown trash source'));
    serve(routes);

    click(bandEmpty(widget, LOCATION));
    await settle();
    expect(showErrorMessage).toHaveBeenCalledWith(
      'Empty Trash in /mnt/data Failed',
      'Unknown trash source'
    );
  });

  it('disables the band button of a source holding 0 items and enables it at 1 item', async () => {
    showVolumesOn();
    const routes = bandRoutes();
    routes.sources = [
      sourceOf('xdg', 1, '5 B'),
      sourceOf('cache', 0, '0 B'),
      sourceOf('home:alice', 1, '2 KB')
    ];
    routes['list?source=cache'] = listOf([]);
    const widget = await open(routes);

    expect(bandEmpty(widget, 'cache').hidden).toBe(false);
    expect(bandEmpty(widget, 'cache').disabled).toBe(true);
    expect(bandEmpty(widget, 'cache').title).toBe('Empty Trash in /home/cache');
    expect(bandEmpty(widget, 'home:alice').hidden).toBe(false);
    expect(bandEmpty(widget, 'home:alice').disabled).toBe(false);
  });

  // DEF-PANEL-43-STALE-COUNT
  it.each([
    ['answers', true],
    ['fails', false]
  ])(
    'a delete of the only row of a band that %s sets the band count, its button and the total before /sources answers',
    async (_, ok) => {
      showVolumesOn();
      const routes: Record<string, Route> = {
        sources: [
          { ...sourceOf('xdg', 1, '1.0 KB'), total_bytes: 1024 },
          { ...sourceOf(LOCATION, 2, '3.0 KB'), total_bytes: 3072 }
        ],
        list: {
          ...listOf([{ ...file('a.txt'), size: 1024 }]),
          total_size: 1024
        },
        [LISTING]: listOf([file('b.txt'), file('c.txt')], '3.0 KB'),
        delete: ok
          ? { success: true }
          : () => Promise.reject(new Error('denied'))
      };
      const widget = await open(routes);
      expect(sectionLabel(widget, 'xdg').textContent).toBe(
        'Trash (1 item, 1.0 KB)'
      );
      expect(summary(widget).textContent).toBe('3 items · 4.0 KB');

      const held = deferred<unknown>();
      serve({ ...routes, sources: () => held.promise });
      (showDialog as jest.Mock).mockResolvedValue({ button: { accept: true } });
      await (widget as any)._deleteItems([(widget as any)._items[0]]);
      await settle();
      expect(sectionLabel(widget, 'xdg').textContent).toBe(
        ok ? 'Trash (0 items, 0 B)' : 'Trash (1 item, 1.0 KB)'
      );
      expect(bandEmpty(widget, 'xdg').disabled).toBe(ok);
      expect(summary(widget).textContent).toBe(
        ok ? '2 items · 3.0 KB' : '3 items · 4.0 KB'
      );
      held.resolve(routes.sources);
      await settle();
    }
  );

  // ACC-SCOPE-104-VOLUME-BANDS: the home band button empties the XDG trash alone
  const homeEmpty = (widget: TrashWidget) => bandEmpty(widget, 'xdg');

  /** Band routes whose XDG trash answers empty once the empty has run. */
  function xdgEmptiedRoutes(): Record<string, Route> {
    const routes = bandRoutes();
    routes.sources = (routes.sources as ISource[]).map(source =>
      source.id === 'xdg' ? sourceOf('xdg', 0, '0 B') : source
    );
    routes.list = listOf([]);
    routes.empty = { success: true, deleted_count: 1 };
    return routes;
  }

  it('with Show Volumes on, the home band button posts scope source xdg after a dialog naming the XDG trash', async () => {
    showVolumesOn();
    const widget = await open(bandRoutes());
    const button = homeEmpty(widget);
    expect(button.hidden).toBe(false);
    expect(button.disabled).toBe(false);
    expect(button.getAttribute('type')).toBe('button');
    expect(button.title).toBe('Empty Trash in Trash');
    expect(button.querySelector('svg')!.dataset.icon).toBe('trash');
    expect(sectionHeader(widget, 'xdg').nextElementSibling).toBe(button);
    expect(summary(widget).querySelector('button')).toBeNull();

    (showDialog as jest.Mock).mockResolvedValue({ button: { accept: true } });
    serve(xdgEmptiedRoutes());
    click(button);
    await settle();

    const dialogs = (showDialog as jest.Mock).mock.calls.map(call => call[0]);
    expect(dialogs).toHaveLength(1);
    expect(dialogs[0].title).toBe('Empty Trash in Trash');
    expect(dialogs[0].body).toContain('Trash (1 item, 5 B)');
    expect(dialogs[0].body).not.toContain('/home/cache');
    expect(dialogs[0].body).not.toContain('/mnt/data');
    expect(emptyCalls()).toHaveLength(1);
    expect(JSON.parse(emptyCalls()[0][2].body)).toEqual({
      scope: 'source',
      source: 'xdg'
    });
    expect(rows(widget)).toHaveLength(0);
    expect(button.hidden).toBe(false);
    expect(button.disabled).toBe(true);
    expect(veil(widget).hidden).toBe(true);
    // The other trashes keep their rows
    expect(sectionRows(widget, LOCATION)).toHaveLength(2);
  });

  it('disables the home band button at 0 items and has no home band while Show Volumes is off', async () => {
    const homeBand = (widget: TrashWidget) =>
      widget.node.querySelector('[data-source="xdg"]');
    const off = await open(bandRoutes());
    expect(rows(off).length).toBeGreaterThan(0);
    expect(homeBand(off)).toBeNull();

    showVolumesOn();
    const on = await open(bandRoutes());
    expect(homeEmpty(on).hidden).toBe(false);
    serve(bandRoutes());
    await (on as any)._commands.execute('trash:show-volumes');
    expect(homeBand(on)).toBeNull();

    showVolumesOn();
    const empty = await open(xdgEmptiedRoutes());
    expect(homeEmpty(empty).hidden).toBe(false);
    expect(homeEmpty(empty).disabled).toBe(true);
  });

  it('keeps the focus in the panel after a keyboard empty from the home band', async () => {
    showVolumesOn();
    const widget = await openAttached(bandRoutes());
    (showDialog as jest.Mock).mockResolvedValue({ button: { accept: true } });
    serve(xdgEmptiedRoutes());

    const button = homeEmpty(widget);
    button.focus();
    press(button, 'Enter');
    click(button);
    await settle();
    expect(button.disabled).toBe(true);
    // The disabled button hands the focus to its fold toggle, never to the
    // page body
    expect(document.activeElement).toBe(sectionHeader(widget, 'xdg'));
  });

  // ACC-SCOPE-104-VOLUME-BANDS: the home band names the XDG trash, the summary
  // bar keeps the total
  const XDG_LABEL = '~';
  const summaryText = (widget: TrashWidget) =>
    find(widget, '.jp-TrashPanel-summaryText');

  function labelledRoutes(): Record<string, Route> {
    const routes = bandRoutes();
    routes.sources = (routes.sources as ISource[]).map(source =>
      source.id === 'xdg' ? { ...source, label: XDG_LABEL } : source
    );
    return routes;
  }

  it('with Show Volumes on, the home band carries the XDG label, which its tooltip holds and the ellipsis shortens, and the summary text carries none', async () => {
    showVolumesOn();
    const widget = await open(labelledRoutes());
    expect(summaryText(widget).textContent).toBe('16 items \u00B7 0 B');
    expect(summaryText(widget).children).toHaveLength(0);
    // The band's one-line parts: the label shortens, the count never shrinks
    const band = sectionLabel(widget, 'xdg');
    const label = band.querySelector<HTMLElement>(
      ':scope > .jp-TrashPanel-sectionText'
    )!;
    expect(label.textContent).toBe(XDG_LABEL);
    expect(label.title).toBe(XDG_LABEL);
    expect(
      band.querySelector(':scope > .jp-TrashPanel-sectionCount')!.textContent
    ).toBe(' (1 item, 5 B)');
  });

  it('with Show Volumes off, the summary text is the count and size only, and turning it off drops the total', async () => {
    const off = await open(labelledRoutes());
    expect(summaryText(off).textContent).toBe('5 items \u00B7 0 B');
    expect(summaryText(off).children).toHaveLength(0);

    showVolumesOn();
    const widget = await open(labelledRoutes());
    const text = summaryText(widget);
    expect(text.textContent).toBe('16 items \u00B7 0 B');
    serve(labelledRoutes());
    await (widget as any)._commands.execute('trash:show-volumes');
    await settle();
    expect(text.textContent).toBe('5 items \u00B7 0 B');
    expect(text.children).toHaveLength(0);
  });

  it('keeps the focus in the panel after a keyboard empty from the header button', async () => {
    showVolumesOn();
    const widget = await openAttached(locationOnlyRoutes(1));
    (showDialog as jest.Mock).mockResolvedValue({ button: { accept: true } });
    serve({
      ...locationOnlyRoutes(0),
      empty: { success: true, deleted_count: 1, sources: [] }
    });

    const button = emptyButton(widget);
    button.focus();
    press(button, 'Enter');
    click(button);
    await settle();
    expect(button.disabled).toBe(true);
    // The main list is already hidden, so the button hands the focus to the
    // refresh button, never to the page body
    expect(document.activeElement).toBe(refreshButton(widget));
  });

  it('puts the band button beside the fold toggle button, not inside it', async () => {
    showVolumesOn();
    const widget = await open(bandRoutes());
    const header = sectionHeader(widget, 'cache');
    const button = bandEmpty(widget, 'cache');

    expect(button.tagName).toBe('BUTTON');
    expect(button.getAttribute('type')).toBe('button');
    expect(button.title).toBe('Empty Trash in /home/cache');
    expect(button.closest('.jp-TrashPanel-sectionHeader')).toBeNull();
    expect(header.contains(button)).toBe(false);
    expect(button.parentElement).toBe(header.parentElement);
    expect(header.nextElementSibling).toBe(button);
    expect(button.querySelector('svg')!.dataset.icon).toBe('trash');
  });

  // DEF-PANEL-41-SECTION-EMPTY: an expanded empty band says Trash is empty
  const emptyLine = (widget: TrashWidget, id: string) =>
    sectionOf(widget, id).querySelector<HTMLElement>('.jp-TrashPanel-empty')!;

  /** Band routes whose /home/cache trash holds 0 items. */
  function emptyCacheRoutes(): Record<string, Route> {
    const routes = bandRoutes();
    routes.sources = (routes.sources as ISource[]).map(source =>
      source.id === 'cache' ? sourceOf('cache', 0, '0 B') : source
    );
    routes['list?source=cache'] = listOf([]);
    return routes;
  }

  it('shows Trash is empty under an expanded band whose trash lists 0 items, and drops it when the trash gains an item', async () => {
    showVolumesOn();
    const widget = await open(emptyCacheRoutes());
    const line = emptyLine(widget, 'cache');
    expect(line.hidden).toBe(false);
    expect(line.textContent).toBe('Trash is empty');
    expect(line.previousElementSibling).toBe(sectionList(widget, 'cache'));
    expect(emptyLine(widget, 'home:alice').hidden).toBe(true);

    serve(bandRoutes());
    void widget.refresh();
    await settle();
    expect(sectionRows(widget, 'cache')).toHaveLength(1);
    expect(line.hidden).toBe(true);
  });

  it('shows no Trash is empty line under a folded band or while the band listing is pending', async () => {
    showVolumesOn();
    const routes = emptyCacheRoutes();
    const pending = deferred<unknown>();
    routes['list?source=cache'] = () => pending.promise;
    const widget = await open(routes);
    expect(emptyLine(widget, 'cache').hidden).toBe(true);

    pending.resolve(listOf([]));
    await settle();
    expect(emptyLine(widget, 'cache').hidden).toBe(false);

    click(sectionHeader(widget, 'cache'));
    expect(sectionHeader(widget, 'cache').getAttribute('aria-expanded')).toBe(
      'false'
    );
    expect(emptyLine(widget, 'cache').hidden).toBe(true);
    click(sectionHeader(widget, 'cache'));
    expect(emptyLine(widget, 'cache').hidden).toBe(false);
  });

  it('shows no Trash is empty line under a band that shows an error', async () => {
    showVolumesOn();
    const failing = emptyCacheRoutes();
    failing['list?source=cache'] = () => Promise.reject(httpError(500));
    const widget = await open(failing);
    expect(sectionLabel(widget, 'cache').textContent).toContain('HTTP 500');
    expect(emptyLine(widget, 'cache').hidden).toBe(true);

    const unreadable = emptyCacheRoutes();
    unreadable.sources = (unreadable.sources as ISource[]).map(source =>
      source.id === 'cache'
        ? sourceOf('cache', 0, '0 B', 'Permission denied')
        : source
    );
    const denied = await open(unreadable);
    expect(sectionLabel(denied, 'cache').textContent).toContain(
      'Permission denied'
    );
    expect(emptyLine(denied, 'cache').hidden).toBe(true);
  });
});

// ACC-SCOPE-104-VOLUME-BANDS: with Show Volumes on, the summary bar totals
// every trash and the home band ~ folds the main list
describe('home band', () => {
  const LOCATION = 'location:/mnt/data/.Trash-1000';

  /** The home trash holding two entries and a location trash holding three. */
  function homeRoutes(): Record<string, Route> {
    return {
      sources: [
        { ...sourceOf('xdg', 2, '2.0 KB'), label: '~', total_bytes: 2048 },
        { ...sourceOf(LOCATION, 3, '1.0 KB'), total_bytes: 1024 }
      ],
      list: listOf([file('a.txt'), file('b.txt')], '2.0 KB'),
      'list?source=location%3A%2Fmnt%2Fdata%2F.Trash-1000': listOf(
        [file('c.txt'), file('d.txt'), file('e.txt')],
        '1.0 KB'
      )
    };
  }

  const columnHeader = (widget: TrashWidget) =>
    find(widget, '.jp-TrashPanel-columnHeader');

  it('with Show Volumes on, the summary bar totals every trash with no trash button, and the home band shows ~, its count and an enabled trash button', async () => {
    showVolumesOn();
    const widget = await open(homeRoutes());

    expect(summary(widget).textContent).toBe('5 items \u00B7 3.0 KB');
    expect(summary(widget).querySelector('button')).toBeNull();

    // The home band sits between the summary bar and the breadcrumb
    const home = sectionOf(widget, 'xdg');
    expect(summary(widget).nextElementSibling).toBe(home);
    expect(home.nextElementSibling).toBe(breadcrumb(widget));
    expect(sectionLabel(widget, 'xdg').textContent).toBe('~ (2 items, 2.0 KB)');
    const button = home.querySelector<HTMLButtonElement>(
      '.jp-TrashPanel-sectionEmpty'
    )!;
    expect(button.disabled).toBe(false);
    expect(button.title).toBe('Empty Trash in ~');
    // Its rows are the main list's, shown once
    expect(rowNames(widget).sort()).toEqual(['a.txt', 'b.txt']);
    expect(sectionRows(widget, LOCATION)).toHaveLength(3);
  });

  it('folding the home band hides the column header and the main list and saves xdg as folded; a reload keeps it folded', async () => {
    showVolumesOn();
    const widget = await open(homeRoutes());
    expect(columnHeader(widget).style.display).toBe('flex');
    expect(listBox(widget).style.display).toBe('block');

    click(sectionHeader(widget, 'xdg'));
    expect(sectionHeader(widget, 'xdg').getAttribute('aria-expanded')).toBe(
      'false'
    );
    expect(columnHeader(widget).style.display).toBe('none');
    expect(listBox(widget).style.display).toBe('none');
    expect(sectionOf(widget, 'xdg').classList).toContain('jp-mod-collapsed');
    // The other bands take the free height
    expect(widget.node.classList).toContain('jp-mod-empty');
    expect(JSON.parse(window.localStorage.getItem(COLLAPSED_KEY)!)).toContain(
      'xdg'
    );

    const again = await open(homeRoutes());
    expect(sectionHeader(again, 'xdg').getAttribute('aria-expanded')).toBe(
      'false'
    );
    expect(columnHeader(again).style.display).toBe('none');
    expect(listBox(again).style.display).toBe('none');

    click(sectionHeader(again, 'xdg'));
    expect(columnHeader(again).style.display).toBe('flex');
    expect(listBox(again).style.display).toBe('block');
    expect(rowNames(again).sort()).toEqual(['a.txt', 'b.txt']);
  });

  // DEF-PANEL-41-SECTION-EMPTY, home half: the main list's empty line
  it('shows Trash is empty under the expanded home band of an empty home trash, and none while it is folded', async () => {
    showVolumesOn();
    const routes = homeRoutes();
    routes.sources = [
      { ...sourceOf('xdg', 0, '0 B'), label: '~' },
      (routes.sources as ISource[])[1]
    ];
    routes.list = listOf([]);
    const widget = await open(routes);
    const line = find(widget, ':scope > .jp-TrashPanel-empty');
    expect(line.textContent).toBe('Trash is empty');
    expect(line.style.display).toBe('');

    click(sectionHeader(widget, 'xdg'));
    expect(line.style.display).toBe('none');
    click(sectionHeader(widget, 'xdg'));
    expect(line.style.display).toBe('');
  });

  it('builds the home band alone, with no list or Trash is empty line of its own', async () => {
    showVolumesOn();
    const widget = await open(homeRoutes());

    const home = sectionOf(widget, 'xdg');
    expect(home.children).toHaveLength(1);
    expect(home.firstElementChild!.className).toBe('jp-TrashPanel-sectionBand');
    // Its rows are the main list, so no detached list or line is held either
    const parts = (widget as any)._sectionParts.get('xdg');
    expect(parts.section).toBe(home);
    expect(parts).not.toHaveProperty('list');
    expect(parts).not.toHaveProperty('none');
    // A location band keeps the list it shows
    expect(
      sectionOf(widget, LOCATION).querySelector('.jp-TrashPanel-sectionList')
    ).toBe((widget as any)._sectionParts.get(LOCATION).list);
  });

  it('with Show Volumes off, there is no home band and the summary bar reads the merged count as before, even with the home band saved folded', async () => {
    window.localStorage.setItem(COLLAPSED_KEY, JSON.stringify(['xdg']));
    const widget = await open(homeRoutes());

    expect(widget.node.querySelector('[data-source="xdg"]')).toBeNull();
    expect(sections(widget)).toHaveLength(0);
    expect(summary(widget).nextElementSibling).toBe(breadcrumb(widget));
    expect(summary(widget).textContent).toBe('5 items \u00B7 0 B');
    expect(summary(widget).querySelector('button')).toBeNull();
    expect(listBox(widget).style.display).toBe('block');
    expect(rowNames(widget).sort()).toEqual([
      'a.txt',
      'b.txt',
      'c.txt',
      'd.txt',
      'e.txt'
    ]);
  });
});
