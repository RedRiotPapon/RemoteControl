const test = require('node:test');
const assert = require('node:assert/strict');
const { DockerService } = require('../host-app/dist/services/docker-service');
const { validateSessionConfig } = require('../shared/dist');

test('Browser resource limits use the saved CPU/RAM values and keep isolation intact', async () => {
  const service = new DockerService(); let options;
  service.docker = {
    info: async () => ({ NCPU: 12, MemTotal: 16 * 1024 ** 3 }),
    createContainer: async value => {
      options = value;
      return { id: 'qa-only', start: async () => {}, exec: async () => ({ start: async () => {} }) };
    },
  };
  service.waitForFiles = async () => {}; service.waitForVNC = async () => {};
  await service.startBrowser(validateSessionConfig({ cpuCores: 6, memoryLimitMB: 3072 }), 'synthetic-password');
  assert.equal(options.HostConfig.NanoCpus, 6_000_000_000);
  assert.equal(options.HostConfig.Memory, 3 * 1024 ** 3);
  assert.equal(options.HostConfig.MemorySwap, 5 * 1024 ** 3);
  assert.equal(options.HostConfig.Privileged, false);
  assert.equal(options.HostConfig.Binds, undefined);
  assert.equal(options.HostConfig.PortBindings['6901/tcp'][0].HostIp, '127.0.0.1');
  assert.deepEqual(options.HostConfig.CapDrop, ['ALL']);
});

test('An allocation beyond Docker capacity fails before creating a workspace', async () => {
  const service = new DockerService(); let created = false;
  service.docker = { info: async () => ({ NCPU: 2, MemTotal: 2 * 1024 ** 3 }), createContainer: async () => { created = true; } };
  await assert.rejects(service.startBrowser(validateSessionConfig({}), 'synthetic-password'), /Lower CPU\/RAM in Host Settings/);
  assert.equal(created, false); assert.equal(service.getContainerId(), null);
});
