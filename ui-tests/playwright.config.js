/**
 * Configuration for Playwright using default from @jupyterlab/galata.
 *
 * The port is read from one variable so a developer with their own lab on
 * 8888 can run the suite: JUPYTER_TEST_PORT=8889 jlpm playwright test.
 * Galata pins the test server to a port and sets no retries, so the server
 * config reads the same variable.
 */
const baseConfig = require('@jupyterlab/galata/lib/playwright-config');

const PORT = process.env.JUPYTER_TEST_PORT || '8888';
const BASE_URL = `http://localhost:${PORT}`;

module.exports = {
  ...baseConfig,
  use: {
    ...baseConfig.use,
    baseURL: BASE_URL
  },
  webServer: {
    command: 'jlpm start',
    url: `${BASE_URL}/lab`,
    timeout: 120 * 1000,
    reuseExistingServer: false
  }
};
