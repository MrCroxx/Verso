import { readFileSync } from 'node:fs';
import path from 'node:path';

export function createPackagerOptions({ platform = 'darwin', arch = process.arch, env = process.env } = {}) {
  const root = process.cwd();
  const { version, devDependencies } = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
  const unsigned = env.VERSO_MAC_UNSIGNED === '1';
  let osxNotarize;
  if (!unsigned && env.APPLE_API_KEY) {
    osxNotarize = { appleApiKey: env.APPLE_API_KEY, appleApiKeyId: env.APPLE_API_KEY_ID, appleApiIssuer: env.APPLE_API_ISSUER };
  } else if (!unsigned && env.APPLE_ID) {
    osxNotarize = { appleId: env.APPLE_ID, appleIdPassword: env.APPLE_APP_SPECIFIC_PASSWORD, teamId: env.APPLE_TEAM_ID };
  }
  return {
    dir: path.join(root, '.desktop/app'),
    out: path.join(root, '.desktop/packaged'),
    name: 'Verso', executableName: 'verso', appVersion: version,
    appBundleId: 'io.github.mrcroxx.verso',
    appCategoryType: 'public.app-category.books',
    electronVersion: devDependencies.electron,
    platform, arch, overwrite: true, asar: true, prune: false,
    ignore: [/^\/node_modules(?:\/|$)/, /^\/desktop\/(?:server\.mjs|entitlements\.mac\.plist)$/],
    extraResource: ['.desktop/server', '.desktop/native', '.desktop/icon.png', 'desktop/server.mjs'].map((entry) => path.join(root, entry)),
    ...(platform === 'darwin' ? {
      executableName: 'Verso',
      icon: path.join(root, '.desktop/icon.icns'),
      darwinDarkModeSupport: true,
      osxSign: {
        identity: unsigned ? '-' : env.VERSO_MAC_SIGN_IDENTITY,
        identityValidation: !unsigned,
        optionsForFile: () => ({
          entitlements: path.join(root, 'desktop/entitlements.mac.plist'),
          hardenedRuntime: !unsigned,
        }),
      },
      osxNotarize,
    } : {}),
  };
}
