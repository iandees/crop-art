// One-off script: turns a COLMAP sparse reconstruction (TXT export) into
// public/data/photo-cameras.json — full per-photo camera calibration (position,
// orientation, intrinsics) in the app's worldRoot-local scene space, by fitting a
// similarity transform (rotation + uniform scale + translation) between COLMAP's arbitrary
// coordinate frame and the existing approximate positions in public/data/photo-poses.json.
//
// Usage: npx tsx scripts/calibrate-photo-cameras.ts <path-to-sparse-model-dir>
//   <path-to-sparse-model-dir> must contain cameras.txt and images.txt (TXT-exported via
//   `colmap model_converter --output_type TXT`), e.g. .colmap-work/sparse/0
//
// IMPORTANT: read the printed residual report before trusting the output. It should be
// comparable to or tighter than photo-poses.ts's documented ~0.2-0.5 scene-unit accuracy.
// If residuals are large (multiple units) or angular residuals are near 90/180 degrees,
// something is wrong (wrong component picked, axis-convention bug) — do not proceed to the
// UI/editor until scripts/test-colmap-math.ts also passes and this is investigated.

import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Vec3 } from 'playcanvas';
import {
    quatWXYZToMat3,
    colmapCameraCenter,
    cameraAxesWorld,
    fitSimilarityTransformRobust,
    applySimilarityToPoint,
    applySimilarityToDirection,
    type PhotoCamera
} from '../src/colmap-math.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');

const modelDir = process.argv[2];
if (!modelDir) {
    console.error('Usage: npx tsx scripts/calibrate-photo-cameras.ts <path-to-sparse-model-dir>');
    process.exit(1);
}

// --- Warn about sibling reconstruction components (a fractured reconstruction) -----------
const sparseParent = dirname(modelDir);
if (existsSync(sparseParent)) {
    const siblings = readdirSync(sparseParent).filter((name) => {
        const full = join(sparseParent, name);
        return statSync(full).isDirectory();
    });
    if (siblings.length > 1) {
        console.warn(
            `WARNING: found ${siblings.length} reconstruction components under ${sparseParent} (${siblings.join(
                ', '
            )}) — the reconstruction fractured into disconnected pieces. Only processing ${modelDir}; images` +
                ' registered in the other components are NOT calibrated and will be missing from the output.'
        );
        for (const name of siblings) {
            const imagesPath = join(sparseParent, name, 'images.txt');
            if (existsSync(imagesPath)) {
                const count = countRegisteredImages(readFileSync(imagesPath, 'utf8'));
                console.warn(`  ${name}: ${count} registered images`);
            }
        }
    }
}

function countRegisteredImages(text: string): number {
    // Same blank-line caveat as parseImagesTxt below — only comments are stripped.
    const lines = text.split('\n').filter((l) => !l.startsWith('#'));
    while (lines.length && lines[lines.length - 1].trim() === '') lines.pop();
    return Math.ceil(lines.length / 2);
}

// --- Parse cameras.txt (single SIMPLE_RADIAL camera, --ImageReader.single_camera 1) ------
interface CameraModel {
    width: number;
    height: number;
    fx: number;
    fy: number;
    cx: number;
    cy: number;
    k?: number;
}

function parseCamerasTxt(text: string): Map<string, CameraModel> {
    const byId = new Map<string, CameraModel>();
    for (const line of text.split('\n')) {
        if (!line.trim() || line.startsWith('#')) continue;
        const parts = line.trim().split(/\s+/);
        const [id, model, width, height, ...params] = parts;
        if (model !== 'SIMPLE_RADIAL') {
            console.warn(`WARNING: camera ${id} has model ${model}, expected SIMPLE_RADIAL — parsing anyway assuming (f, cx, cy, k) param order.`);
        }
        const [f, cx, cy, k] = params.map(Number);
        byId.set(id, { width: Number(width), height: Number(height), fx: f, fy: f, cx, cy, k });
    }
    return byId;
}

// --- Parse images.txt (odd lines: pose + name; even lines: 2D points, skipped) -----------
interface ImageEntry {
    name: string;
    cameraId: string;
    qw: number;
    qx: number;
    qy: number;
    qz: number;
    tx: number;
    ty: number;
    tz: number;
}

function parseImagesTxt(text: string): ImageEntry[] {
    // Each image is two lines: a pose line, then a POINTS2D line that lists that image's
    // matched keypoints — and is legitimately BLANK for an image with zero matches. Only
    // strip `#` header comments here, never blank lines, or every image after the first
    // zero-point one would silently misalign (its points line getting mistaken for the next
    // image's pose line). The file's own trailing newline can still leave one harmless empty
    // line at the very end, which is safe to drop since it only trims the tail, never
    // shifting the indices of any real pose line before it.
    const lines = text.split('\n').filter((l) => !l.startsWith('#'));
    while (lines.length && lines[lines.length - 1].trim() === '') lines.pop();

    const entries: ImageEntry[] = [];
    for (let i = 0; i < lines.length; i += 2) {
        const poseLine = lines[i].trim();
        if (!poseLine) continue;
        const parts = poseLine.split(/\s+/);
        const [, qw, qx, qy, qz, tx, ty, tz, cameraId, ...nameParts] = parts;
        entries.push({
            name: nameParts.join(' '),
            cameraId,
            qw: Number(qw),
            qx: Number(qx),
            qy: Number(qy),
            qz: Number(qz),
            tx: Number(tx),
            ty: Number(ty),
            tz: Number(tz)
        });
    }
    return entries;
}

const camerasById = parseCamerasTxt(readFileSync(join(modelDir, 'cameras.txt'), 'utf8'));
const images = parseImagesTxt(readFileSync(join(modelDir, 'images.txt'), 'utf8'));
console.log(`Parsed ${camerasById.size} camera(s), ${images.length} registered image(s).`);

// --- Compute each image's world-to-camera rotation + camera center in COLMAP space -------
interface Registered {
    name: string;
    center: Vec3;
    axes: { right: Vec3; down: Vec3; forward: Vec3 };
    camera: CameraModel;
}

const registered: Registered[] = [];
for (const img of images) {
    const camera = camerasById.get(img.cameraId);
    if (!camera) {
        console.warn(`WARNING: image ${img.name} references unknown camera id ${img.cameraId}, skipping.`);
        continue;
    }
    const rCw = quatWXYZToMat3(img.qw, img.qx, img.qy, img.qz);
    const t = new Vec3(img.tx, img.ty, img.tz);
    const center = colmapCameraCenter(rCw, t);
    const axes = cameraAxesWorld(rCw);
    registered.push({ name: img.name, center, axes, camera });
}

// --- Build correspondences against the existing approximate photo-poses.json -------------
const photoPoses: Record<string, { position: [number, number, number]; focus: [number, number, number] }> = JSON.parse(
    readFileSync(join(root, 'public/data/photo-poses.json'), 'utf8')
);

const sourcePoints: Vec3[] = [];
const targetPoints: Vec3[] = [];
const correspondenceNames: string[] = [];
for (const r of registered) {
    const pose = photoPoses[r.name];
    if (!pose) continue;
    sourcePoints.push(r.center);
    targetPoints.push(new Vec3(...pose.position));
    correspondenceNames.push(r.name);
}
console.log(`Found ${sourcePoints.length} correspondences with existing photo-poses.json (of ${registered.length} registered images).`);

if (sourcePoints.length < 10) {
    console.error('ERROR: too few correspondences to fit a reliable similarity transform. Aborting.');
    process.exit(1);
}

// A minority of correspondences can be badly wrong (an image COLMAP registered against the
// wrong part of a repetitive scene, or a stray bad anchor in the existing approximate data)
// without the majority being wrong at all — a plain least-squares fit lets those drag the
// whole transform off for everyone. Fit robustly instead, dropping the worst-agreeing
// correspondences rather than trusting all of them equally (see fitSimilarityTransformRobust
// and its synthetic outlier test in scripts/test-colmap-math.ts).
const { transform: sim, inlierIndices } = fitSimilarityTransformRobust(sourcePoints, targetPoints, {
    targetMaxResidual: 0.6
});
const outlierCount = sourcePoints.length - inlierIndices.length;
console.log(
    `\nFitted similarity transform: scale=${sim.scale.toFixed(4)}, translation=(${sim.translation.x.toFixed(3)}, ${sim.translation.y.toFixed(3)}, ${sim.translation.z.toFixed(3)})`
);
console.log(`Used ${inlierIndices.length} of ${sourcePoints.length} correspondences as inliers (${outlierCount} rejected as outliers).`);
if (outlierCount > 0) {
    const outlierNames = sourcePoints
        .map((_, i) => i)
        .filter((i) => !inlierIndices.includes(i))
        .map((i) => correspondenceNames[i]);
    console.log(`Rejected: ${outlierNames.join(', ')}`);
}

// --- Residual report — READ THIS before trusting the output ------------------------------
console.log('\n--- Residual report (recomputed positions vs. existing photo-poses.json, INLIERS ONLY) ---');
const positionResiduals: number[] = [];
const angularResidualsDeg: number[] = [];
for (const i of inlierIndices) {
    const recomputed = applySimilarityToPoint(sourcePoints[i], sim);
    const residual = recomputed.distance(targetPoints[i]);
    positionResiduals.push(residual);

    const name = correspondenceNames[i];
    const r = registered.find((entry) => entry.name === name)!;
    const recomputedForward = applySimilarityToDirection(r.axes.forward, sim);
    const existingFocus = new Vec3(...photoPoses[name].focus);
    const existingPosition = new Vec3(...photoPoses[name].position);
    const existingDir = new Vec3().sub2(existingFocus, existingPosition).normalize();
    const cosAngle = Math.min(1, Math.max(-1, recomputedForward.dot(existingDir)));
    angularResidualsDeg.push((Math.acos(cosAngle) * 180) / Math.PI);
}
positionResiduals.sort((a, b) => a - b);
angularResidualsDeg.sort((a, b) => a - b);
const mean = (arr: number[]) => arr.reduce((a, b) => a + b, 0) / arr.length;
const median = (arr: number[]) => arr[Math.floor(arr.length / 2)];

console.log(
    `Position residuals (scene units): mean=${mean(positionResiduals).toFixed(4)}, median=${median(positionResiduals).toFixed(4)}, max=${positionResiduals[positionResiduals.length - 1].toFixed(4)}`
);
console.log(
    `Angular residuals (degrees):      mean=${mean(angularResidualsDeg).toFixed(2)}, median=${median(angularResidualsDeg).toFixed(2)}, max=${angularResidualsDeg[angularResidualsDeg.length - 1].toFixed(2)}`
);
console.log(
    '(Compare against photo-poses.ts\'s documented ~0.2-0.5 unit accuracy. Large residuals or angular residuals near 90/180 degrees indicate a bug — stop and investigate before using the output below.)'
);

// --- Write public/data/photo-cameras.json for every registered image ---------------------
const output: Record<string, PhotoCamera> = {};
let written = 0;
for (const r of registered) {
    const position = applySimilarityToPoint(r.center, sim);
    const right = applySimilarityToDirection(r.axes.right, sim);
    const down = applySimilarityToDirection(r.axes.down, sim);
    const forward = applySimilarityToDirection(r.axes.forward, sim);
    output[r.name] = {
        position: [position.x, position.y, position.z],
        right: [right.x, right.y, right.z],
        down: [down.x, down.y, down.z],
        forward: [forward.x, forward.y, forward.z],
        width: r.camera.width,
        height: r.camera.height,
        fx: r.camera.fx,
        fy: r.camera.fy,
        cx: r.camera.cx,
        cy: r.camera.cy,
        k: r.camera.k
    };
    written++;
}

writeFileSync(join(root, 'public/data/photo-cameras.json'), JSON.stringify(output, null, 4));
console.log(`\nWrote public/data/photo-cameras.json: ${written} camera(s) (of ${registered.length} registered, ${images.length - registered.length} skipped for unknown camera id).`);
