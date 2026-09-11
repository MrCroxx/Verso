import assert from 'node:assert/strict';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createMacosDmg } from '../scripts/create-macos-dmg.mjs';

async function fixture(t, { busyAttempts = 0, disappear = false, iconError, unknownDevice = false } = {}) {
  const staging = await mkdtemp(path.join(tmpdir(), 'verso-dmg-test-'));
  t.after(() => rm(staging, { recursive: true, force: true }));
  const icon = path.join(staging, 'icon.icns');
  await writeFile(icon, 'test icon');
  const commands = [];
  const delays = [];
  let mount;
  let attached = false;
  let attempts = 0;
  const busy = new Error('Resource busy');
  const entities = [{ 'dev-entry': '/dev/disk42' }, { 'dev-entry': '/dev/disk42s1', 'mount-point': '/private/volume' }];
  const run = (tool, args, options) => {
    commands.push({ tool, args });
    if (tool === '/usr/bin/plutil') return options.input;
    if (tool === '/usr/bin/xcrun') {
      assert.equal(readFileSync(path.join(mount, '.VolumeIcon.icns'), 'utf8'), 'test icon');
      if (iconError) throw iconError;
      return;
    }
    if (tool === '/usr/bin/swift') return;
    assert.equal(tool, '/usr/bin/hdiutil');
    switch (args[0]) {
      case 'create': return;
      case 'attach':
        mount = args[args.indexOf('-mountpoint') + 1];
        t.after(() => rm(path.dirname(mount), { recursive: true, force: true }));
        attached = true;
        return JSON.stringify({ 'system-entities': unknownDevice ? [] : entities });
      case 'detach':
        assert.equal(args[1], '/dev/disk42', 'Detach the whole device even after the mountpoint disappears');
        attempts++;
        if (attempts <= busyAttempts) {
          rmSync(mount, { recursive: true, force: true });
          if (disappear) attached = false;
          throw busy;
        }
        attached = false;
        return;
      case 'info': return JSON.stringify({ images: attached ? [{ 'system-entities': entities }] : [] });
      case 'convert':
        assert.equal(attached, false, 'Never convert an attached image');
        return;
      default: assert.fail(`Unexpected hdiutil command: ${args[0]}`);
    }
  };
  return {
    build: () => createMacosDmg({ staging, destination: path.join(staging, 'Verso.dmg'), icon }, {
      run, wait: async delay => { delays.push(delay); },
    }),
    commands, delays, busy,
    temporary: () => path.dirname(mount),
    detaches: () => commands.filter(command => command.args[0] === 'detach').map(command => command.args),
  };
}

test('DMG packaging preserves icons and detaches before converting', async t => {
  const f = await fixture(t);
  await f.build();
  assert.deepEqual(f.detaches(), [['detach', '/dev/disk42']]);
  assert.deepEqual(f.delays, []);
  assert.ok(f.commands.some(command => command.tool === '/usr/bin/swift'));
  assert.equal(existsSync(f.temporary()), false);
});

test('DMG packaging retries a busy device after its mountpoint disappears', async t => {
  const f = await fixture(t, { busyAttempts: 2 });
  await f.build();
  assert.deepEqual(f.detaches(), Array(3).fill(['detach', '/dev/disk42']));
  assert.deepEqual(f.delays, [1000, 2000]);
  assert.equal(existsSync(f.temporary()), false);
});

test('DMG packaging forces detach only after bounded normal retries', async t => {
  const f = await fixture(t, { busyAttempts: 3 });
  await f.build();
  assert.deepEqual(f.detaches().at(-1), ['detach', '/dev/disk42', '-force']);
  assert.deepEqual(f.delays, [1000, 2000, 3000]);
});

test('DMG packaging accepts a failed detach only if the device is no longer attached', async t => {
  const f = await fixture(t, { busyAttempts: 1, disappear: true });
  await f.build();
  assert.equal(f.detaches().length, 1);
  assert.deepEqual(f.delays, []);
  assert.ok(f.commands.some(command => command.args[0] === 'convert'));
});

test('DMG packaging stops and preserves temporary files if detach remains unsuccessful', async t => {
  const f = await fixture(t, { busyAttempts: Infinity });
  await assert.rejects(f.build(), error => error === f.busy);
  assert.equal(f.detaches().length, 4);
  assert.equal(f.commands.some(command => command.args[0] === 'convert'), false);
  assert.equal(existsSync(f.temporary()), true);
});

test('DMG packaging cleans up after an icon failure without masking it', async t => {
  const iconError = new Error('SetFile failed');
  const f = await fixture(t, { iconError, busyAttempts: 1 });
  await assert.rejects(f.build(), error => error === iconError);
  assert.equal(f.detaches().length, 2);
  assert.equal(existsSync(f.temporary()), false);
});

test('DMG packaging reports both icon and cleanup failures', async t => {
  const iconError = new Error('SetFile failed');
  const f = await fixture(t, { iconError, busyAttempts: Infinity });
  await assert.rejects(f.build(), error => {
    assert.ok(error instanceof AggregateError);
    assert.deepEqual(error.errors, [iconError, f.busy]);
    return true;
  });
  assert.equal(existsSync(f.temporary()), true);
});

test('DMG packaging preserves an attachment whose device cannot be identified', async t => {
  const f = await fixture(t, { unknownDevice: true });
  await assert.rejects(f.build(), /Cannot identify the attached DMG device/);
  assert.equal(f.detaches().length, 0);
  assert.equal(existsSync(f.temporary()), true);
});
