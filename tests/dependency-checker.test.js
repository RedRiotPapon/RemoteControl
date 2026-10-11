const { test, describe } = require('node:test');
const assert = require('node:assert');
const { DependencyChecker } = require('../host-app/dist/services/dependency-checker');

describe('Dependency Checker', () => {
  test('checkAll returns valid status structure with docker, tailscale, and wsl', async () => {
    const checker = new DependencyChecker();
    const result = await checker.checkAll();

    assert.ok(result !== null);
    assert.strictEqual(typeof result.docker, 'object');
    assert.strictEqual(typeof result.docker.installed, 'boolean');
    assert.strictEqual(typeof result.docker.running, 'boolean');

    assert.strictEqual(typeof result.tailscale, 'object');
    assert.strictEqual(typeof result.tailscale.installed, 'boolean');
    assert.strictEqual(typeof result.tailscale.connected, 'boolean');

    assert.strictEqual(typeof result.wsl, 'object');
    assert.strictEqual(typeof result.wsl.installed, 'boolean');
  });

  test('DependencyChecker accurately reflects local environment', async () => {
    const checker = new DependencyChecker();
    const result = await checker.checkAll();

    // In our inspected environment, Docker is installed and WSL is installed
    assert.strictEqual(result.docker.installed, true);
    assert.strictEqual(result.wsl.installed, true);
  });
});
