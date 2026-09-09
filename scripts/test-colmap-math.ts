// Synthetic self-test for src/colmap-math.ts, runnable before any real COLMAP data exists:
// npx tsx scripts/test-colmap-math.ts
//
// Two independent checks, both against known ground truth (not real photos):
//   1. fitSimilarityTransform recovers a known rotation/scale/translation from noisy points.
//   2. pixelToWorldRay + worldToPixel round-trip recovers the original pixel on a synthetic
//      camera, confirming the OpenCV-basis pixel<->ray math is self-consistent.
//
// This must pass before scripts/calibrate-photo-cameras.ts is trusted with real data.

import { Vec3, Quat } from 'playcanvas';
import {
    fitSimilarityTransform,
    fitSimilarityTransformRobust,
    applySimilarityToPoint,
    pixelToWorldRay,
    worldToPixel,
    type PhotoCamera
} from '../src/colmap-math.ts';

let failures = 0;

function assertClose(label: string, actual: number, expected: number, tolerance: number): void {
    const diff = Math.abs(actual - expected);
    if (diff > tolerance) {
        failures++;
        console.error(`FAIL ${label}: got ${actual}, expected ${expected} (diff ${diff} > tolerance ${tolerance})`);
    } else {
        console.log(`ok   ${label}: ${actual.toFixed(6)} (expected ${expected.toFixed(6)}, diff ${diff.toExponential(2)})`);
    }
}

function mulberry32(seed: number): () => number {
    let a = seed;
    return () => {
        a |= 0;
        a = (a + 0x6d2b79f5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

// ---------------------------------------------------------------------------------------
// Test 1: similarity-transform recovery
// ---------------------------------------------------------------------------------------
console.log('--- Test 1: fitSimilarityTransform recovers known ground truth ---');
{
    const rand = mulberry32(42);
    const trueRotation = new Quat().setFromEulerAngles(12, 33, -7).normalize();
    const trueScale = 2.35;
    const trueTranslation = new Vec3(1.2, -0.4, 3.1);

    const n = 40;
    const source: Vec3[] = [];
    const target: Vec3[] = [];
    for (let i = 0; i < n; i++) {
        const s = new Vec3((rand() - 0.5) * 10, (rand() - 0.5) * 10, (rand() - 0.5) * 10);
        const t = trueRotation
            .transformVector(s.clone())
            .mulScalar(trueScale)
            .add(trueTranslation);
        // Small noise, matching the ~0.2-0.5 unit noise this is designed to average out.
        t.add(new Vec3((rand() - 0.5) * 0.05, (rand() - 0.5) * 0.05, (rand() - 0.5) * 0.05));
        source.push(s);
        target.push(t);
    }

    const fit = fitSimilarityTransform(source, target);
    assertClose('scale', fit.scale, trueScale, 0.01);
    assertClose('translation.x', fit.translation.x, trueTranslation.x, 0.02);
    assertClose('translation.y', fit.translation.y, trueTranslation.y, 0.02);
    assertClose('translation.z', fit.translation.z, trueTranslation.z, 0.02);

    // Compare rotations by applying both to a probe vector rather than comparing quaternion
    // components directly (q and -q represent the same rotation).
    const probe = new Vec3(1, 0, 0);
    const trueRotated = trueRotation.transformVector(probe.clone());
    const fitRotated = fit.rotation.transformVector(probe.clone());
    assertClose('rotation probe.x', fitRotated.x, trueRotated.x, 0.01);
    assertClose('rotation probe.y', fitRotated.y, trueRotated.y, 0.01);
    assertClose('rotation probe.z', fitRotated.z, trueRotated.z, 0.01);

    // End-to-end: applying the fitted transform to a fresh (noise-free) source point should
    // land close to where the true transform would put it.
    const freshSource = new Vec3(3, -2, 5);
    const expected = trueRotation.transformVector(freshSource.clone()).mulScalar(trueScale).add(trueTranslation);
    const got = applySimilarityToPoint(freshSource, fit);
    assertClose('applied point x', got.x, expected.x, 0.05);
    assertClose('applied point y', got.y, expected.y, 0.05);
    assertClose('applied point z', got.z, expected.z, 0.05);
}

// ---------------------------------------------------------------------------------------
// Test 1b: fitSimilarityTransformRobust ignores gross outliers that corrupt the plain fit
// ---------------------------------------------------------------------------------------
// Real COLMAP correspondences aren't just noisy — a minority can be badly wrong (an image
// mis-registered against the wrong part of a repetitive scene, or a stray bad anchor in the
// existing approximate data). This must not be silently "fixed" by the plain fit above.
console.log('\n--- Test 1b: fitSimilarityTransformRobust survives ~20% gross outliers ---');
{
    const rand = mulberry32(99);
    const trueRotation = new Quat().setFromEulerAngles(-18, 50, 4).normalize();
    const trueScale = 0.81;
    const trueTranslation = new Vec3(0.6, -0.02, 0.27);

    const n = 60;
    const outlierCount = 12; // 20%
    const source: Vec3[] = [];
    const target: Vec3[] = [];
    for (let i = 0; i < n; i++) {
        const s = new Vec3((rand() - 0.5) * 10, (rand() - 0.5) * 10, (rand() - 0.5) * 10);
        const t = trueRotation.transformVector(s.clone()).mulScalar(trueScale).add(trueTranslation);
        t.add(new Vec3((rand() - 0.5) * 0.05, (rand() - 0.5) * 0.05, (rand() - 0.5) * 0.05));
        if (i < outlierCount) {
            // A gross mismatch, same magnitude as a real mis-registered image would produce.
            t.add(new Vec3((rand() - 0.5) * 8, (rand() - 0.5) * 8, (rand() - 0.5) * 8));
        }
        source.push(s);
        target.push(t);
    }

    const plainFit = fitSimilarityTransform(source, target);
    const plainProbe = plainFit.rotation.transformVector(new Vec3(1, 0, 0));
    const trueProbe = trueRotation.transformVector(new Vec3(1, 0, 0));
    const plainAngleError = (Math.acos(Math.min(1, Math.max(-1, plainProbe.dot(trueProbe)))) * 180) / Math.PI;
    console.log(`plain fit rotation error vs. ground truth: ${plainAngleError.toFixed(2)} deg (informational only, not asserted — least-squares doesn't always visibly break with only 20% outliers, but the transform below must still be exact)`);

    const { transform: robustFit, inlierIndices } = fitSimilarityTransformRobust(source, target, {
        targetMaxResidual: 0.1
    });
    assertClose('robust fit scale', robustFit.scale, trueScale, 0.02);
    const robustProbe = robustFit.rotation.transformVector(new Vec3(1, 0, 0));
    const robustAngleError = (Math.acos(Math.min(1, Math.max(-1, robustProbe.dot(trueProbe)))) * 180) / Math.PI;
    if (robustAngleError > 1) {
        failures++;
        console.error(`FAIL robust fit rotation error: ${robustAngleError.toFixed(2)} deg (expected < 1 deg)`);
    } else {
        console.log(`ok   robust fit rotation error: ${robustAngleError.toFixed(4)} deg`);
    }
    const outlierIndicesSet = new Set(Array.from({ length: outlierCount }, (_, i) => i));
    const survivingOutliers = inlierIndices.filter((i) => outlierIndicesSet.has(i));
    if (survivingOutliers.length > 0) {
        failures++;
        console.error(`FAIL robust fit kept ${survivingOutliers.length} of the ${outlierCount} planted outliers as inliers`);
    } else {
        console.log(`ok   robust fit rejected all ${outlierCount} planted outliers (${inlierIndices.length}/${n} kept as inliers)`);
    }
}

// ---------------------------------------------------------------------------------------
// Test 2: pixel -> world ray -> pixel round-trip on a synthetic camera
// ---------------------------------------------------------------------------------------
console.log('\n--- Test 2: pixelToWorldRay / worldToPixel round-trip ---');
{
    // An arbitrary orthonormal basis (not axis-aligned, to actually exercise the math) plus
    // a plausible phone-camera intrinsics set.
    const rotation = new Quat().setFromEulerAngles(15, -40, 5).normalize();
    const right = rotation.transformVector(new Vec3(1, 0, 0));
    const down = rotation.transformVector(new Vec3(0, 1, 0));
    const forward = rotation.transformVector(new Vec3(0, 0, 1));

    const camera: PhotoCamera = {
        position: [2, 0.5, -1],
        right: [right.x, right.y, right.z],
        down: [down.x, down.y, down.z],
        forward: [forward.x, forward.y, forward.z],
        width: 4080,
        height: 3072,
        fx: 3000,
        fy: 3000,
        cx: 2040,
        cy: 1536
        // k omitted: round-trip test doesn't need distortion to validate the core basis math.
    };

    const testPixels: [number, number][] = [
        [2040, 1536], // principal point
        [500, 500],
        [3600, 2800],
        [100, 2900]
    ];

    for (const [u, v] of testPixels) {
        const { origin, dir } = pixelToWorldRay(camera, u, v);
        const depth = 4.7; // arbitrary positive depth along the ray
        const worldPoint = origin.clone().add(dir.clone().mulScalar(depth));
        const proj = worldToPixel(camera, worldPoint);
        if (!proj.inFront) {
            failures++;
            console.error(`FAIL pixel (${u},${v}): projected point reported behind camera`);
            continue;
        }
        assertClose(`pixel (${u},${v}) -> u`, proj.u, u, 0.01);
        assertClose(`pixel (${u},${v}) -> v`, proj.v, v, 0.01);
    }
}

console.log(failures === 0 ? '\nAll tests passed.' : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
