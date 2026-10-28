/**
 * Configuration for Playwright using default from @jupyterlab/galata.
 *
 * The port is read from one variable so a developer with their own lab on
 * 8888 can run the suite: JUPYTER_TEST_PORT=8889 jlpm playwright test.
 * Galata pins the test server to a port and sets no retries, so the server
 * config reads the same variable.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const baseConfig = require('@jupyterlab/galata/lib/playwright-config');

const PORT = process.env.JUPYTER_TEST_PORT || '8888';
const BASE_URL = `http://localhost:${PORT}`;

const PROJECT_ROOT = path.resolve(__dirname, '..');
const TRASH_HOME = path.join(__dirname, '.trash-home');
// Created here, before the web server starts: bwrap needs the bind source.
fs.mkdirSync(TRASH_HOME, { recursive: true });

// Empty Trash of the seeded trash deletes about 18,000 entries; without a
// delay that finishes in ~0.4 s, too short to see a blocked server. The shim
// adds TRASH_SLOW_US per removal on the test server only, so the window is
// measurable and the same for the fixed and the old handler.
const SHIM_SRC = path.join(__dirname, 'slow-removal.c');
const SHIM_SO = path.join(__dirname, 'slow-removal.so');
if (
  !fs.existsSync(SHIM_SO) ||
  fs.statSync(SHIM_SO).mtimeMs < fs.statSync(SHIM_SRC).mtimeMs
) {
  try {
    execFileSync('gcc', [
      '-shared',
      '-fPIC',
      '-O2',
      '-o',
      SHIM_SO,
      SHIM_SRC,
      '-ldl'
    ]);
  } catch (error) {
    if (error.code === 'ENOENT') {
      throw new Error(
        'gcc is required to build ui-tests/slow-removal.so for the trash performance test; install gcc (build-essential).'
      );
    }
    throw error;
  }
}

// The released wheel is installed in site-packages; the working tree must win
// so the server imports the routes.py under review. An externally supplied
// PYTHONPATH stays ahead of it, so a run can shadow the package entirely.
const PYTHONPATH = [process.env.PYTHONPATH, PROJECT_ROOT]
  .filter(Boolean)
  .join(path.delimiter);

// bwrap hides the developer's real ~/.local/share/Trash even if a code path
// ignores XDG_DATA_HOME. Same path inside and outside: the seeded trash.
// A CI runner may refuse unprivileged user namespaces, and a home without
// ~/.local/share has nothing to bind, so both are probed first. Without
// bwrap the XDG_DATA_HOME env below still keeps the real trash out of reach.
const HOME_DATA = path.join(os.homedir(), '.local', 'share');
// GALATA_NO_BWRAP=1 reproduces the CI runner, where bwrap cannot start.
let useBwrap = process.env.GALATA_NO_BWRAP !== '1' && fs.existsSync(HOME_DATA);
if (useBwrap) {
  try {
    execFileSync('bwrap', ['--dev-bind', '/', '/', 'true'], {
      stdio: 'ignore'
    });
  } catch (error) {
    // Namespaces refused: fall through to a plain start.
    useBwrap = false;
  }
}

const command = useBwrap
  ? [
      'bwrap --dev-bind / /',
      `--bind ${TRASH_HOME} ${HOME_DATA}`,
      `--setenv XDG_DATA_HOME ${TRASH_HOME}`,
      'jlpm start'
    ].join(' ')
  : 'jlpm start';

module.exports = {
  ...baseConfig,
  use: {
    ...baseConfig.use,
    baseURL: BASE_URL
  },
  webServer: {
    command,
    url: `${BASE_URL}/lab`,
    timeout: 120 * 1000,
    reuseExistingServer: false,
    env: {
      XDG_DATA_HOME: TRASH_HOME,
      PYTHONPATH,
      LD_PRELOAD: SHIM_SO,
      TRASH_SLOW_PREFIX: path.join(TRASH_HOME, 'Trash') + path.sep,
      TRASH_SLOW_US: '60'
    }
  }
};
