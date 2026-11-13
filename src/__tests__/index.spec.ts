/**
 * Unit test for the plugin activation: every command reaches the palette.
 */

import plugin from '../index';

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
    'trash:clean-workspace'
  ]);
});
