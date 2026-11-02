/**
 * Unit tests for the trash panel widget, with the server replaced by a mock.
 */

import { ServerConnection } from '@jupyterlab/services';
import { PageConfig } from '@jupyterlab/coreutils';
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

interface ISource {
  id: string;
  label: string;
  item_count: number;
  total_size: string;
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
        : `/home/${id.slice('home:'.length)}`;
  return { id, label, item_count: itemCount, total_size: totalSize, error };
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
  });

  it('hides Empty Trash while the trash holds no item', async () => {
    const widget = await open({ list: listOf([]) });
    expect(emptyButton(widget).hidden).toBe(true);
  });

  it('keeps Empty Trash inside an empty folder', async () => {
    const widget = await open({
      list: listOf([folder('a')]),
      'list?path=a': listOf([])
    });
    doubleClick(rows(widget)[0]);
    await settle();
    expect(emptyButton(widget).hidden).toBe(false);
  });

  it('keeps the same buttons across loads', async () => {
    const widget = await open({ list: listOf([file('one.txt')]) });
    const before = refreshButton(widget);
    void widget.refresh();
    await settle();
    expect(refreshButton(widget)).toBe(before);
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
    expect(message.style.display).toBe('flex');
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
    list.focus();
    press(list, 'ArrowDown');
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

  it('still reports the rows that could not be restored', async () => {
    const widget = await open({ list: listOf([file('one.txt')]) });
    serve(failing('restore'));

    await expect(
      (widget as any)._restoreItems((widget as any)._items)
    ).rejects.toThrow('HTTP 500');
    expect(showErrorMessage).toHaveBeenCalledWith(
      'Restore Failed',
      'one.txt: denied'
    );
  });

  it('still reports the rows that could not be deleted', async () => {
    const widget = await open({ list: listOf([file('one.txt')]) });
    (showDialog as jest.Mock).mockResolvedValue({ button: { accept: true } });
    serve(failing('delete'));

    await expect(
      (widget as any)._deleteItems((widget as any)._items)
    ).rejects.toThrow('HTTP 500');
    expect(showErrorMessage).toHaveBeenCalledWith(
      'Delete Failed',
      'one.txt: denied'
    );
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
        errors: ['one.txt: denied']
      }
    });

    emptyButton(widget).click();
    await settle();
    expect(showErrorMessage).toHaveBeenCalledWith(
      'Empty Trash Failed',
      'one.txt: denied'
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
  it('renders the returned sources in order below the main list, absent ones omitted', async () => {
    const widget = await open(sourcedRoutes());

    // The xdg trash stays the main listing
    expect(rowNames(widget)).toEqual(['one.txt']);
    expect(widget.node.querySelector('[data-source="xdg"]')).toBeNull();

    // A section per extra source, in the order the server returned them
    expect(sections(widget).map(element => element.dataset.source)).toEqual([
      'cache',
      'home:alice'
    ]);
    expect(listBox(widget).compareDocumentPosition(sections(widget)[0])).toBe(
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
    expect(dialog.title).toBe('Clean All Sources');
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
