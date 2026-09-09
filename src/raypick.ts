import { Vec3 } from 'playcanvas';

/**
 * CPU ray-vs-point-cloud pick against the splat's own gaussian centers. Gaussian splats
 * don't support GPU depth-buffer picking the way meshes do (alpha-blended, no single
 * "surface" depth per pixel), so instead we walk every splat center directly: for each one,
 * find how far along the ray its closest approach point is, and how far off-ray it sits at
 * that point. A splat counts as a hit if it's within a perspective-correct pixel radius of
 * the ray (so the threshold shrinks/grows sensibly with distance, matching how big a splat
 * looks on screen) — among hits, the nearest-along-the-ray one wins, approximating "the
 * first thing the ray would actually touch."
 *
 * `rayOrigin`/`rayDir` and the returned point are all in the same local space `centers` is
 * defined in (worldRoot-local — see scene.ts). Returns null if nothing was within range.
 *
 * `projScaleY` is the perspective projection's Y-scale term (`cot(fovY/2)`, i.e. a PlayCanvas
 * camera's `projectionMatrix.data[5]`) — equivalently `2*fy/heightPx` for a pinhole camera
 * with focal length `fy` in pixels, which lets this be reused for a *synthetic* camera (e.g.
 * a calibrated training photo, see reprojection.ts) with no live PlayCanvas camera entity.
 */
export function pickSplatSurface(
    centers: Float32Array,
    rayOrigin: Vec3,
    rayDir: Vec3,
    projScaleY: number,
    canvasHeightPx: number,
    pixelRadius = 10
): Vec3 | null {
    const ox = rayOrigin.x;
    const oy = rayOrigin.y;
    const oz = rayOrigin.z;
    const dx = rayDir.x;
    const dy = rayDir.y;
    const dz = rayDir.z;

    const n = centers.length / 3;

    let bestT = Infinity;
    let bestX = 0;
    let bestY = 0;
    let bestZ = 0;
    let found = false;

    for (let i = 0; i < n; i++) {
        const base = i * 3;
        const cx = centers[base];
        const cy = centers[base + 1];
        const cz = centers[base + 2];

        const vx = cx - ox;
        const vy = cy - oy;
        const vz = cz - oz;
        const t = vx * dx + vy * dy + vz * dz;
        // Behind the camera, or already farther along the ray than our current best hit.
        if (t <= 0 || t >= bestT) continue;

        const px = ox + dx * t;
        const py = oy + dy * t;
        const pz = oz + dz * t;
        const ddx = cx - px;
        const ddy = cy - py;
        const ddz = cz - pz;
        const perpDistSq = ddx * ddx + ddy * ddy + ddz * ddz;

        const worldRadius = (pixelRadius / canvasHeightPx) * ((2 * t) / projScaleY);
        if (perpDistSq > worldRadius * worldRadius) continue;

        bestT = t;
        bestX = cx;
        bestY = cy;
        bestZ = cz;
        found = true;
    }

    return found ? new Vec3(bestX, bestY, bestZ) : null;
}
