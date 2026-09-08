#!/usr/bin/env node
// One-off script: for every piece with a `position`, find the nearest few photos (by 3D
// distance from the piece's position to each candidate photo's recovered camera position
// in photo-poses.json) as candidate photos for the detail-view picker in the F2 editor.
//
// Writes public/data/photo-candidates.json as { [pieceId]: string[] } (filenames, nearest
// first). Does NOT modify pieces.json.
//
// Usage: node scripts/find-photo-candidates.mjs [topN]
//   topN defaults to 5; pass 3 to shrink the candidate pool if it pulls in too many new photos.

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');

const topN = Number(process.argv[2]) || 5;

const pieces = JSON.parse(readFileSync(join(root, 'public/data/pieces.json'), 'utf8'));
const poses = JSON.parse(readFileSync(join(root, 'public/data/photo-poses.json'), 'utf8'));

const poseEntries = Object.entries(poses); // [filename, { position, focus }][]

function dist2(a, b) {
    const dx = a[0] - b[0];
    const dy = a[1] - b[1];
    const dz = a[2] - b[2];
    return dx * dx + dy * dy + dz * dz;
}

const result = {};
let piecesWithPosition = 0;

for (const piece of pieces) {
    if (!piece.position) continue;
    piecesWithPosition++;

    const ranked = poseEntries
        .map(([filename, pose]) => ({ filename, d2: dist2(piece.position, pose.position) }))
        .sort((a, b) => a.d2 - b.d2)
        .slice(0, topN)
        .map((r) => r.filename);

    result[piece.id] = ranked;
}

writeFileSync(join(root, 'public/data/photo-candidates.json'), JSON.stringify(result, null, 4));

const uniqueFilenames = new Set(Object.values(result).flat());
console.log(`Pieces with position: ${piecesWithPosition}`);
console.log(`Top-N per piece: ${topN}`);
console.log(`Unique candidate filenames referenced: ${uniqueFilenames.size}`);
console.log('Wrote public/data/photo-candidates.json');
