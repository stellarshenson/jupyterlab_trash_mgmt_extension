/**
 * Unit test for the plugin activation: every command reaches the palette.
 */

import plugin from '../index';
import { TrashWidget } from '../widget';

jest.mock('@jupyterlab/application', () => ({ ILabShell: {} }));
jest.mock('@jupyterlab/apputils', () => ({ ICommandPalette: {} }));
jest.mock('../request', () => ({ isTrashEnabled: jest.fn(async () => true) }));
jest.mock('../widget', () => ({ TrashWidget: jest.fn() }));

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
  expect(showVolumes.label).toBe('Show Volumes');
  expect(typeof showVolumes.isToggled).toBe('function');
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
