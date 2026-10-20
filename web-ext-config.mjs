export default {
  sourceDir: '.',
  artifactsDir: 'web-ext-artifacts',
  ignoreFiles: [
    '.git/**',
    'node_modules/**',
    'dist/**',
    'web-ext-artifacts/**',
    'scripts/**',
    'package.json',
    'package-lock.json',
    'README.md',
    'CHANGELOG.md',
    'PRIVACY.md',
    'web-ext-config.mjs',
    '*.zip'
  ],
  build: {
    overwriteDest: true
  }
};
