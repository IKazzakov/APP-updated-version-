import sharp from 'sharp';
import {readFile} from 'node:fs/promises';

const svg = await readFile('public/icon.svg', 'utf8');

// 1. Standard PNG icons (any purpose)
await sharp(Buffer.from(svg))
  .resize(192, 192)
  .png()
  .toFile('public/pwa-192x192.png');

await sharp(Buffer.from(svg))
  .resize(512, 512)
  .png()
  .toFile('public/pwa-512x512.png');

await sharp(Buffer.from(svg))
  .resize(180, 180)
  .png()
  .toFile('public/apple-touch-icon.png');

// 2. Maskable icon with safe zone padding (central 80% diameter, background full-bleed)
const maskableSvg = `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">
  <rect width="512" height="512" fill="#d1f782"/>
  <g transform="translate(102, 102) scale(4.8)">
    <path d="m18 46 28-28M18 18h28v28" stroke="#283522" stroke-width="5" fill="none" stroke-linecap="round" stroke-linejoin="round"/>
  </g>
</svg>
`;

await sharp(Buffer.from(maskableSvg))
  .resize(512, 512)
  .png()
  .toFile('public/pwa-maskable-512x512.png');

console.log('PWA Android icons successfully generated.');
