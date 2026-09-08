import type { Entity } from 'playcanvas';

export interface RoomBounds {
    /** Minimum camera height — raised above the literal floor for an eye-level feel. */
    floorY: number;
    /** Maximum camera height — lowered below the literal ceiling for headroom. */
    ceilingY: number;
    /** The literal splat floor surface (no inset) — use this for anything that should
     * visually sit on the floor, like snapping a room-boundary click. */
    surfaceFloorY: number;
    surfaceCeilingY: number;
    minX: number;
    maxX: number;
    minZ: number;
    maxZ: number;
}

const TARGET_SAMPLES = 200_000;

/**
 * Fits an axis-aligned room "shell" (floor/ceiling height + a wall bounding box) to the
 * splat point cloud, in world space (after worldRoot's rotation), so the camera can be
 * kept from flying through the floor, ceiling or walls — see the collision clamp in
 * scene.ts. Percentiles rather than literal min/max are used so a handful of stray or
 * noisy splats outside the real room don't blow the bounds out; the floor/ceiling are then
 * inset further to land at roughly eye level and headroom rather than exactly on the
 * splat's floor/ceiling surface.
 */
export function computeRoomBounds(worldRoot: Entity, splatCenters: Float32Array): RoomBounds {
    const m = worldRoot.getWorldTransform().data;
    const numPoints = splatCenters.length / 3;
    const stride = Math.max(1, Math.floor(numPoints / TARGET_SAMPLES));
    const sampleCount = Math.ceil(numPoints / stride);

    const xs = new Float32Array(sampleCount);
    const ys = new Float32Array(sampleCount);
    const zs = new Float32Array(sampleCount);
    let n = 0;
    for (let i = 0; i < numPoints; i += stride) {
        const base = i * 3;
        const x = splatCenters[base];
        const y = splatCenters[base + 1];
        const z = splatCenters[base + 2];
        xs[n] = m[0] * x + m[4] * y + m[8] * z + m[12];
        ys[n] = m[1] * x + m[5] * y + m[9] * z + m[13];
        zs[n] = m[2] * x + m[6] * y + m[10] * z + m[14];
        n++;
    }
    const usedXs = xs.subarray(0, n).sort();
    const usedYs = ys.subarray(0, n).sort();
    const usedZs = zs.subarray(0, n).sort();

    const pct = (sorted: Float32Array, p: number) => sorted[Math.floor((sorted.length - 1) * p)];

    // A fixed percentile (e.g. "3rd percentile = the floor") is thrown off by how densely
    // the floor happened to get reconstructed vs. stray noise below it — a large flat floor
    // is architecturally a tight, dense band of splats, so instead find that density PEAK
    // directly, which is robust to a sparse tail of outliers on either side.
    const loOutlier = pct(usedYs, 0.005);
    const hiOutlier = pct(usedYs, 0.995);
    const mid = (loOutlier + hiOutlier) / 2;
    const surfaceFloorY = findDensityPeak(usedYs, loOutlier, mid);
    const surfaceCeilingY = findDensityPeak(usedYs, mid, hiOutlier);
    const roomHeight = surfaceCeilingY - surfaceFloorY;

    return {
        floorY: surfaceFloorY + roomHeight * 0.24,
        ceilingY: surfaceCeilingY - roomHeight * 0.05,
        surfaceFloorY,
        surfaceCeilingY,
        minX: pct(usedXs, 0.02),
        maxX: pct(usedXs, 0.98),
        minZ: pct(usedZs, 0.02),
        maxZ: pct(usedZs, 0.98)
    };
}

/** Finds the Y value of the densest bin (the center of the biggest cluster of splats) within
 * [rangeLo, rangeHi] — used to locate the floor/ceiling as an actual architectural surface
 * rather than wherever a percentile cutoff happens to land among sparser stray splats. */
function findDensityPeak(sorted: Float32Array, rangeLo: number, rangeHi: number, binCount = 300): number {
    const lo = sorted[0];
    const hi = sorted[sorted.length - 1];
    const binWidth = (hi - lo) / binCount || 1;
    const counts = new Int32Array(binCount);
    for (let i = 0; i < sorted.length; i++) {
        const v = sorted[i];
        if (v < rangeLo || v > rangeHi) continue;
        const bin = Math.min(binCount - 1, Math.max(0, Math.floor((v - lo) / binWidth)));
        counts[bin]++;
    }
    let bestBin = Math.floor(((rangeLo + rangeHi) / 2 - lo) / binWidth);
    let bestCount = -1;
    for (let b = 0; b < binCount; b++) {
        const binCenter = lo + (b + 0.5) * binWidth;
        if (binCenter < rangeLo || binCenter > rangeHi) continue;
        if (counts[b] > bestCount) {
            bestCount = counts[b];
            bestBin = b;
        }
    }
    return lo + (bestBin + 0.5) * binWidth;
}
