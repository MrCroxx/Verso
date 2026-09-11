import { execFileSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export async function createMacosDmg({ staging, destination, icon }) {
  const temporary = await mkdtemp(path.join(tmpdir(), 'verso-dmg-'));
  const writable = path.join(temporary, 'writable.dmg');
  const mount = path.join(temporary, 'volume');
  const run = (tool, args) => execFileSync(tool, args, { stdio: 'inherit' });
  let mounted = false;
  try {
    await mkdir(mount);
    run('/usr/bin/hdiutil', ['create', '-format', 'UDRW', '-fs', 'HFS+', '-volname', 'Verso', '-srcfolder', staging, writable]);
    run('/usr/bin/hdiutil', ['attach', '-nobrowse', '-mountpoint', mount, writable]);
    mounted = true;
    await cp(icon, path.join(mount, '.VolumeIcon.icns'));
    // hdiutil does not preserve the source folder's custom-icon flag on the volume root.
    run('/usr/bin/xcrun', ['SetFile', '-a', 'C', mount]);
    run('/usr/bin/hdiutil', ['detach', mount]);
    mounted = false;
    run('/usr/bin/hdiutil', ['convert', writable, '-ov', '-format', 'UDZO', '-o', destination]);
    run('/usr/bin/swift', [fileURLToPath(new URL('./set-macos-icon.swift', import.meta.url)), icon, destination]);
  } finally {
    if (mounted) run('/usr/bin/hdiutil', ['detach', mount]);
    await rm(temporary, { recursive: true, force: true });
  }
}
