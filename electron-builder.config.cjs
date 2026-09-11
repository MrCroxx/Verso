module.exports = {
  appId: 'io.github.mrcroxx.verso',
  productName: 'Verso',
  directories: { app: '.desktop/app', output: 'dist/desktop' },
  files: ['desktop/main.mjs', 'desktop/backend.mjs', 'desktop/protocol.mjs', 'package.json', '!**/node_modules/**/*'],
  extraResources: [
    { from: '.desktop/server', to: 'server', filter: ['**/*'] },
    // electron-builder skips a file set's root node_modules directory.
    { from: '.desktop/server/node_modules', to: 'server/node_modules', filter: ['**/*'] },
    { from: '.desktop/native', to: 'native', filter: ['**/*'] },
    { from: 'desktop/server.mjs', to: 'server.mjs' },
  ],
  asar: true,
  npmRebuild: false,
  // The standalone server already contains its production dependencies.
  nodeGypRebuild: false,
  mac: {
    category: 'public.app-category.books',
    icon: '.desktop/icon.png',
    target: ['dmg', 'zip'],
    identity: process.env.VERSO_MAC_UNSIGNED === '1' ? '-' : undefined,
    hardenedRuntime: process.env.VERSO_MAC_UNSIGNED !== '1',
    entitlements: 'desktop/entitlements.mac.plist',
    entitlementsInherit: 'desktop/entitlements.mac.plist',
    notarize: Boolean(process.env.APPLE_API_KEY || process.env.APPLE_ID),
  },
  artifactName: 'Verso-${version}-${arch}.${ext}',
};
