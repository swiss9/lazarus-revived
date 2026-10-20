#!/usr/bin/env node

import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, 'dist', 'chromium');

const files = [
  'manifest.json',
  'background.js',
  'content.js',
  'popup.html',
  'popup.css',
  'popup.js',
  'options.html',
  'options.css',
  'options.js',
  'LICENSE.txt',
  'icons',
  'donate-qr.png',
  'donate-qr2.png'
];

async function build() {
  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });

  for (const entry of files) {
    await cp(path.join(root, entry), path.join(outDir, entry), { recursive: true });
  }

  const manifestPath = path.join(outDir, 'manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));

  manifest.background = { service_worker: 'background.js' };
  manifest.minimum_chrome_version = '121';
  delete manifest.browser_specific_settings;

  await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n');

  console.log('Chromium build written to ' + path.relative(root, outDir));
}

build().catch(error => {
  console.error('Chromium build failed:', error);
  process.exitCode = 1;
});
