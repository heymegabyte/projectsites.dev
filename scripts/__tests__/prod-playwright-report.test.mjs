import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

// Evaluate the actual configs with only Playwright's identity helper/device data
// substituted. No browser, production credentials or installed packages needed.
function loadConfig(path, ci) {
  const source = readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8')
    .replace("import { defineConfig, devices } from '@playwright/test';",
      "const defineConfig = (config) => config; const devices = { 'Desktop Chrome': {} };");
  const url = `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
  return JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e',
    `const { default: config } = await import(${JSON.stringify(url)}); process.stdout.write(JSON.stringify(config));`,
  ], { encoding: 'utf8', env: { ...process.env, CI: ci, PW_WORKERS: '', CF_BROWSER_WS_ENDPOINT: '' } }));
}

for (const path of [
  'apps/project-sites/playwright.prod.config.ts',
  'apps/project-sites/frontend/playwright.prod.config.ts',
]) {
  test(`${path}: CI creates the report directory uploaded by Actions`, () => {
    const config = loadConfig(path, 'true');
    assert.ok(Array.isArray(config.reporter), 'CI must configure terminal and HTML reporters');
    assert.ok(config.reporter.some((reporter) => Array.isArray(reporter) && reporter[0] === 'line'));
    const html = config.reporter.find((reporter) => Array.isArray(reporter) && reporter[0] === 'html');
    assert.ok(html, 'production CI must generate an HTML report, including failed runs');
    assert.equal(html[1].outputFolder, 'playwright-report');
    assert.equal(html[1].open, 'never');
    assert.equal(config.use.trace, 'retain-on-failure');
  });
  test(`${path}: local runs retain concise terminal output`, () => {
    const config = loadConfig(path, '');
    assert.deepEqual(typeof config.reporter === 'string' ? [[config.reporter]] : config.reporter, [['line']]);
  });
}
