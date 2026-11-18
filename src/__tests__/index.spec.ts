/**
 * Unit test for the plugin activation: every command reaches the palette.
 */

import { CommandRegistry } from '@lumino/commands';
import plugin from '../index';
import { TrashWidget } from '../widget';

jest.mock('@jupyterlab/application', () => ({ ILabShell: {} }));
jest.mock('@jupyterlab/apputils', () => ({ ICommandPalette: {} }));
jest.mock('../request', () => ({ isTrashEnabled: jest.fn(async () => true) }));
jest.mock('../widget', () => ({ TrashWidget: jest.fn() }));

// The panel's own registry, whose changes the plugin passes on
const panelCommands = new CommandRegistry();
panelCommands.addCommand('trash:show-volumes', { execute: () => undefined });
(TrashWidget as any).prototype._commands = panelCommands;

it('adds every command to the command palette', async () => {
  const app = {
    serviceManager: { serverSettings: {} },
    commands: { addCommand: jest.fn() }
  };
  const palette = { addItem: jest.fn() };

  await plugin.activate(app as any, { add: jest.fn() } as any, palette as any);

  expect(palette.addItem.mock.calls.map(call => call[0].command)).toEqual([
    'trash:refresh',
    'trash:empty',
    'trash:clean-all',
    'trash:clean-workspace',
    'trash:show-volumes'
  ]);
  for (const call of palette.addItem.mock.calls) {
    expect(call[0].category).toBe('Trash');
  }
  const showVolumes = app.commands.addCommand.mock.calls.find(
    call => call[0] === 'trash:show-volumes'
  )![1];
  expect(showVolumes.label()).toBe('Show Volumes');
  expect(showVolumes.isToggled).toBeUndefined();
  // ACC-SCOPE-101-EMPTY-BINS
  const cleanAll = app.commands.addCommand.mock.calls.find(
    call => call[0] === 'trash:clean-all'
  )![1];
  expect(cleanAll.label).toBe('Empty All Bins');
});

it('runs Empty All Bins from the trash:empty command, as the header button does', async () => {
  const cleanSources = jest.fn();
  (TrashWidget as any).prototype._cleanSources = cleanSources;
  const app = {
    serviceManager: { serverSettings: {} },
    commands: { addCommand: jest.fn() }
  };

  await plugin.activate(app as any, { add: jest.fn() } as any, null as any);

  const empty = app.commands.addCommand.mock.calls.find(
    call => call[0] === 'trash:empty'
  )![1];
  empty.execute();
  expect(cleanSources).toHaveBeenCalledWith('all');
});

// ACC-SCOPE-103-HIDE-VOLUMES: the palette entry names what it does
it('labels trash:show-volumes Hide Volumes while the volumes show, with no check mark, and redraws it on a flip from the panel', async () => {
  const app = {
    serviceManager: { serverSettings: {} },
    commands: { addCommand: jest.fn(), notifyCommandChanged: jest.fn() }
  };

  await plugin.activate(app as any, { add: jest.fn() } as any, null as any);

  const { instances } = (TrashWidget as unknown as jest.Mock).mock;
  const widget = instances[instances.length - 1];
  const showVolumes = app.commands.addCommand.mock.calls.find(
    call => call[0] === 'trash:show-volumes'
  )![1];
  widget.showVolumes = true;
  expect(showVolumes.label()).toBe('Hide Volumes');
  widget.showVolumes = false;
  expect(showVolumes.label()).toBe('Show Volumes');
  expect(showVolumes.isToggled).toBeUndefined();

  panelCommands.notifyCommandChanged('trash:show-volumes');
  expect(app.commands.notifyCommandChanged).toHaveBeenCalledWith(
    'trash:show-volumes'
  );
});
