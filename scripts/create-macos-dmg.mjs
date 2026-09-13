import { execFileSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const runCommand = (tool, args, options = {}) => execFileSync(tool, args, { stdio: 'inherit', ...options });

function readPlist(run, args) {
  const input = run('/usr/bin/hdiutil', [...args, '-plist'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
  return JSON.parse(run('/usr/bin/plutil', ['-convert', 'json', '-o', '-', '-'], {
    input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'inherit'],
  }));
}

async function detachImage(device, run, wait) {
  // Intel runners can keep a newly created image busy beyond the first few seconds.
  // Allow 65 seconds of backoff, then make one final forced detach attempt.
  const attempts = 16;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      run('/usr/bin/hdiutil', ['detach', device, ...(attempt === attempts - 1 ? ['-force'] : [])]);
      return;
    } catch (error) {
      // A failed eject may already have unmounted the volume. Track the device, not the mountpoint.
      const { images } = readPlist(run, ['info']);
      if (!images.some(image => image['system-entities'].some(entity => entity['dev-entry'] === device))) return;
      if (error.status !== 16 || attempt === attempts - 1) throw error;
      const delay = Math.min(1000 * (attempt + 1), 5000);
      console.error(`DMG ${device} is still busy after detach attempt ${attempt + 1}/${attempts}; retrying in ${delay}ms.`);
      await wait(delay);
    }
  }
}

export async function createMacosDmg({ staging, destination, icon }, { run = runCommand, wait = setTimeout } = {}) {
  const temporary = await mkdtemp(path.join(tmpdir(), 'verso-dmg-'));
  const writable = path.join(temporary, 'writable.dmg');
  const mount = path.join(temporary, 'volume');
  let device;
  let mayBeAttached = false;
  try {
    await mkdir(mount);
    run('/usr/bin/hdiutil', ['create', '-format', 'UDRW', '-fs', 'HFS+', '-volname', 'Verso', '-srcfolder', staging, writable]);
    mayBeAttached = true;
    const attached = readPlist(run, ['attach', '-nobrowse', '-mountpoint', mount, writable]);
    device = attached['system-entities'].find(entity => /^\/dev\/disk\d+$/.test(entity['dev-entry']))?.['dev-entry'];
    if (!device) throw new Error('Cannot identify the attached DMG device');
    let iconError;
    try {
      await cp(icon, path.join(mount, '.VolumeIcon.icns'));
      // hdiutil does not preserve the source folder's custom-icon flag on the volume root.
      run('/usr/bin/xcrun', ['SetFile', '-a', 'C', mount]);
    } catch (error) {
      iconError = error;
      throw error;
    } finally {
      try {
        await detachImage(device, run, wait);
        mayBeAttached = false;
      } catch (error) {
        if (iconError) throw new AggregateError([iconError, error], 'Setting the DMG icon and detaching the image both failed');
        throw error;
      }
    }
    run('/usr/bin/hdiutil', ['convert', writable, '-ov', '-format', 'UDZO', '-o', destination]);
    run('/usr/bin/swift', [fileURLToPath(new URL('./set-macos-icon.swift', import.meta.url)), icon, destination]);
  } finally {
    // Never recursively remove a directory that may still contain a mounted filesystem.
    if (mayBeAttached) console.error(`DMG ${device ?? writable} may still be attached; preserving ${temporary}`);
    else await rm(temporary, { recursive: true, force: true });
  }
}
