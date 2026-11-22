import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: 'test/e2e',
  timeout: 30000,
  use: { baseURL: 'http://127.0.0.1:5288', viewport: { width: 1400, height: 1000 }, locale: 'ko-KR' },
  webServer: {
    command: 'rm -rf .e2e-work && DATA_DIR=.e2e-work PORT=5288 node src/server.js',
    url: 'http://127.0.0.1:5288/api/config',
    reuseExistingServer: false,
  },
});
