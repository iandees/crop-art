import { Vec3, Quat, Mat3 } from 'playcanvas';

/** SIMPLE_RADIAL camera intrinsics (COLMAP's `cameras.txt`), in pixel units. */
export interface Intrinsics {
    width: number;
    height: number;
    fx: number;
    fy: number;
    cx: number;
    cy: number;
    /** Radial distortion coefficient. Omit or ~0 for an already-undistorted/ideal camera. */
    k?: number;
}

/**
 * Inverts SIMPLE_RADIAL's forward distortion model (`x_d = x_u * (1 + k*r^2)`, r^2 measured
 * on the undistorted coords) via fixed-point iteration — converges fast for the small `k`
 * (~+-0.05) typical of phone cameras. Skipped entirely (identity) when `k` is negligible.
 */
export function undistortNormalized(x: number, y: number, k: number | undefined): { x: number; y: number } {
    if (!k || Math.abs(k) < 1e-4) return { x, y };
    let xu = x;
    let yu = y;
    for (let i = 0; i < 5; i++) {
        const r2 = xu * xu + yu * yu;
        const factor = 1 + k * r2;
        xu = x / factor;
        yu = y / factor;
    }
    return { x: xu, y: yu };
}

/** Camera-local ray direction (OpenCV convention: X right, Y down, Z forward) for pixel (u,v). */
export function pixelToLocalCV(u: number, v: number, intr: Intrinsics): Vec3 {
    const xd = (u - intr.cx) / intr.fx;
    const yd = (v - intr.cy) / intr.fy;
    const { x, y } = undistortNormalized(xd, yd, intr.k);
    return new Vec3(x, y, 1);
}

/** `cot(fovY/2)` equivalent for a pinhole camera — matches raypick.ts's `projectionMatrix.data[5]`. */
export function projScaleYFromIntrinsics(intr: Intrinsics): number {
    return (2 * intr.fy) / intr.height;
}

/**
 * Builds the world-to-camera rotation matrix from COLMAP's `images.txt` quaternion.
 * NOTE: COLMAP writes (QW, QX, QY, QZ); PlayCanvas's `Quat` constructor takes (x, y, z, w) —
 * opposite order. Getting this backwards silently produces a garbage-but-plausible-looking
 * rotation, so the argument order below is deliberate, not a typo.
 */
export function quatWXYZToMat3(qw: number, qx: number, qy: number, qz: number): Mat3 {
    const q = new Quat(qx, qy, qz, qw);
    return new Mat3().setFromQuat(q);
}

/** COLMAP images.txt stores world-to-camera (R, t): X_cam = R*X_world + t. Camera center in
 * world space is therefore -R^T * t, not -R*t. */
export function colmapCameraCenter(rCw: Mat3, t: Vec3): Vec3 {
    const rt = new Mat3().transpose(rCw);
    return mulMat3Vec3(rt, t).mulScalar(-1);
}

function mulMat3Vec3(m: Mat3, v: Vec3): Vec3 {
    const d = m.data;
    // Mat3.data is column-major: d[0..2] = column 0, d[3..5] = column 1, d[6..8] = column 2.
    return new Vec3(
        d[0] * v.x + d[3] * v.y + d[6] * v.z,
        d[1] * v.x + d[4] * v.y + d[7] * v.z,
        d[2] * v.x + d[5] * v.y + d[8] * v.z
    );
}

/** The three columns of a world-to-camera matrix's transpose (camera-to-world), i.e. the
 * camera's own right/down/forward axes expressed in world space (OpenCV convention). */
export function cameraAxesWorld(rCw: Mat3): { right: Vec3; down: Vec3; forward: Vec3 } {
    const rWc = new Mat3().transpose(rCw);
    const d = rWc.data;
    return {
        right: new Vec3(d[0], d[1], d[2]),
        down: new Vec3(d[3], d[4], d[5]),
        forward: new Vec3(d[6], d[7], d[8])
    };
}

export interface SimilarityTransform {
    rotation: Quat;
    scale: number;
    translation: Vec3;
}

/**
 * Finds the eigenvector of the LARGEST (most positive, not largest-magnitude) eigenvalue of
 * a symmetric 4x4 matrix, via power iteration. Horn's method specifically requires the most
 * positive eigenvalue's eigenvector — plain power iteration converges to whichever eigenvalue
 * has the largest *absolute* value, which is the wrong one whenever the most-negative
 * eigenvalue outweighs the most-positive one. Fixed by first shifting the matrix by a
 * Gershgorin bound (N' = N + s*I) so every eigenvalue becomes non-negative — this leaves
 * eigenvectors unchanged and makes the largest-magnitude eigenvalue of N' unambiguously the
 * same one as the largest (most positive) eigenvalue of N.
 *
 * We only ever need this one eigenvector (see fitSimilarityTransform), so power iteration is
 * preferred over a full Jacobi eigen-decomposition — far less code, far less surface for a
 * sign/index bug — and a healthy eigenvalue gap is expected given the many well-spread point
 * correspondences this is used against.
 */
function dominantEigenvectorSymmetric4x4(n: number[][]): [number, number, number, number] {
    let shift = 0;
    for (let i = 0; i < 4; i++) {
        let rowAbsSum = 0;
        for (let j = 0; j < 4; j++) rowAbsSum += Math.abs(n[i][j]);
        shift = Math.max(shift, rowAbsSum);
    }
    const shifted = n.map((row, i) => row.map((value, j) => (i === j ? value + shift : value)));

    let v: [number, number, number, number] = [1, 0, 0, 0];
    for (let iter = 0; iter < 200; iter++) {
        const nv: [number, number, number, number] = [0, 0, 0, 0];
        for (let i = 0; i < 4; i++) {
            let sum = 0;
            for (let j = 0; j < 4; j++) sum += shifted[i][j] * v[j];
            nv[i] = sum;
        }
        const len = Math.hypot(nv[0], nv[1], nv[2], nv[3]);
        if (len < 1e-12) break;
        v = [nv[0] / len, nv[1] / len, nv[2] / len, nv[3] / len];
    }
    return v;
}

/**
 * Umeyama/Horn similarity-transform fit: finds the rotation + uniform scale + translation
 * that best maps `source` points onto `target` points in a least-squares sense (used here to
 * calibrate COLMAP's arbitrary coordinate frame into the app's scene space, using photos
 * present in both COLMAP's output and the existing approximate photo-poses.json as anchors).
 */
export function fitSimilarityTransform(source: Vec3[], target: Vec3[]): SimilarityTransform {
    const count = source.length;
    const sourceCentroid = new Vec3();
    const targetCentroid = new Vec3();
    for (let i = 0; i < count; i++) {
        sourceCentroid.add(source[i]);
        targetCentroid.add(target[i]);
    }
    sourceCentroid.mulScalar(1 / count);
    targetCentroid.mulScalar(1 / count);

    const c: Vec3[] = source.map((p) => new Vec3().sub2(p, sourceCentroid));
    const p: Vec3[] = target.map((q) => new Vec3().sub2(q, targetCentroid));

    let sxx = 0;
    let sxy = 0;
    let sxz = 0;
    let syx = 0;
    let syy = 0;
    let syz = 0;
    let szx = 0;
    let szy = 0;
    let szz = 0;
    for (let i = 0; i < count; i++) {
        sxx += c[i].x * p[i].x;
        sxy += c[i].x * p[i].y;
        sxz += c[i].x * p[i].z;
        syx += c[i].y * p[i].x;
        syy += c[i].y * p[i].y;
        syz += c[i].y * p[i].z;
        szx += c[i].z * p[i].x;
        szy += c[i].z * p[i].y;
        szz += c[i].z * p[i].z;
    }

    // Horn's symmetric 4x4 N matrix — its dominant eigenvector is the optimal rotation
    // quaternion (w,x,y,z) mapping the centered source points onto the centered target points.
    const n: number[][] = [
        [sxx + syy + szz, syz - szy, szx - sxz, sxy - syx],
        [syz - szy, sxx - syy - szz, sxy + syx, szx + sxz],
        [szx - sxz, sxy + syx, -sxx + syy - szz, syz + szy],
        [sxy - syx, szx + sxz, syz + szy, -sxx - syy + szz]
    ];
    const [qw, qx, qy, qz] = dominantEigenvectorSymmetric4x4(n);
    const rotation = new Quat(qx, qy, qz, qw).normalize();

    let numerator = 0;
    let denominator = 0;
    for (let i = 0; i < count; i++) {
        const rc = rotation.transformVector(c[i]);
        numerator += p[i].dot(rc);
        denominator += c[i].dot(c[i]);
    }
    const scale = denominator > 1e-12 ? numerator / denominator : 1;

    const rotatedScaledCentroid = rotation.transformVector(sourceCentroid.clone()).mulScalar(scale);
    const translation = new Vec3().sub2(targetCentroid, rotatedScaledCentroid);

    return { rotation, scale, translation };
}

/**
 * Robust variant of fitSimilarityTransform: a handful of badly-mismatched correspondences
 * (e.g. an image COLMAP registered against the wrong part of a repetitive scene, or a stray
 * bad anchor in the existing approximate data) can drag the plain least-squares fit off for
 * everyone else, even though most correspondences agree well. Iteratively refits while
 * dropping the worst-residual fraction each round, so the final transform reflects the
 * well-agreeing majority rather than being pulled toward a minority of outliers.
 */
export function fitSimilarityTransformRobust(
    source: Vec3[],
    target: Vec3[],
    options: { maxRounds?: number; keepFraction?: number; targetMaxResidual?: number } = {}
): { transform: SimilarityTransform; inlierIndices: number[] } {
    const maxRounds = options.maxRounds ?? 5;
    const keepFraction = options.keepFraction ?? 0.9;
    const targetMaxResidual = options.targetMaxResidual ?? Infinity;

    let indices = source.map((_, i) => i);
    let transform = fitSimilarityTransform(source, target);

    for (let round = 0; round < maxRounds; round++) {
        const residuals = indices.map((i) => applySimilarityToPoint(source[i], transform).distance(target[i]));
        if (Math.max(...residuals) <= targetMaxResidual) break;

        const sorted = [...residuals].sort((a, b) => a - b);
        const keepCount = Math.max(10, Math.round(indices.length * keepFraction));
        if (keepCount >= indices.length) break;
        const cutoff = sorted[keepCount - 1];

        indices = indices.filter((_, j) => residuals[j] <= cutoff);
        transform = fitSimilarityTransform(indices.map((i) => source[i]), indices.map((i) => target[i]));
    }

    return { transform, inlierIndices: indices };
}

export function applySimilarityToPoint(point: Vec3, sim: SimilarityTransform): Vec3 {
    return sim.rotation.transformVector(point.clone()).mulScalar(sim.scale).add(sim.translation);
}

export function applySimilarityToDirection(dir: Vec3, sim: SimilarityTransform): Vec3 {
    return sim.rotation.transformVector(dir.clone()).normalize();
}

/** A calibrated training-photo camera, fully in the app's worldRoot-local scene space. */
export interface PhotoCamera {
    position: [number, number, number];
    right: [number, number, number];
    down: [number, number, number];
    forward: [number, number, number];
    width: number;
    height: number;
    fx: number;
    fy: number;
    cx: number;
    cy: number;
    k?: number;
}

/** World-space ray for pixel (u,v) of a calibrated photo, in the same scene space as `PhotoCamera.position`. */
export function pixelToWorldRay(camera: PhotoCamera, u: number, v: number): { origin: Vec3; dir: Vec3 } {
    const local = pixelToLocalCV(u, v, camera);
    const right = new Vec3(...camera.right);
    const down = new Vec3(...camera.down);
    const forward = new Vec3(...camera.forward);
    const dir = new Vec3()
        .add(right.mulScalar(local.x))
        .add(down.mulScalar(local.y))
        .add(forward.mulScalar(local.z))
        .normalize();
    return { origin: new Vec3(...camera.position), dir };
}

/** Projects a world-space point into a calibrated photo's pixel space. `inFront: false` means
 * the point is behind the camera (u/v are meaningless in that case). */
export function worldToPixel(camera: PhotoCamera, point: Vec3): { u: number; v: number; inFront: boolean } {
    const origin = new Vec3(...camera.position);
    const right = new Vec3(...camera.right);
    const down = new Vec3(...camera.down);
    const forward = new Vec3(...camera.forward);
    const rel = new Vec3().sub2(point, origin);
    const zCv = rel.dot(forward);
    if (zCv <= 1e-6) return { u: 0, v: 0, inFront: false };
    const xCv = rel.dot(right);
    const yCv = rel.dot(down);
    return {
        u: (camera.fx * xCv) / zCv + camera.cx,
        v: (camera.fy * yCv) / zCv + camera.cy,
        inFront: true
    };
}

/** A 3D ray — `dir` is assumed already normalized by the caller. */
export interface Ray3 {
    origin: Vec3;
    dir: Vec3;
}

/**
 * Distance between the closest points on two (infinite) rays/lines — the standard
 * closest-point-between-two-lines formula. Two rays through the same real-world point from
 * different calibrated cameras should have a near-zero closest approach; used to match a
 * freshly-drawn polygon against an existing piece when neither has a splat-derived anchor to
 * compare by 3D position instead (see reprojection.ts / identify-mode.ts).
 *
 * Returns `Infinity` for (near-)parallel rays rather than a numerically unstable huge value —
 * parallel rays carry no triangulation signal regardless of how the degenerate case is
 * handled, so treating them as "definitely not a match" is both simpler and correct.
 */
export function closestApproachDistance(a: Ray3, b: Ray3): number {
    const w0 = new Vec3().sub2(a.origin, b.origin);
    const bDotB = 1; // dirs are normalized
    const aDotA = 1;
    const aDotB = a.dir.dot(b.dir);
    const aDotW0 = a.dir.dot(w0);
    const bDotW0 = b.dir.dot(w0);
    const denom = aDotA * bDotB - aDotB * aDotB;
    if (Math.abs(denom) < 1e-9) return Infinity;
    const t1 = (aDotB * bDotW0 - bDotB * aDotW0) / denom;
    const t2 = (aDotA * bDotW0 - aDotB * aDotW0) / denom;
    const p1 = a.origin.clone().add(a.dir.clone().mulScalar(t1));
    const p2 = b.origin.clone().add(b.dir.clone().mulScalar(t2));
    return p1.distance(p2);
}

/** Gaussian elimination with partial pivoting for a 3x3 linear system. Returns null if the
 * matrix is singular (e.g. all rays parallel in triangulateRays' use of this). */
function solve3x3(a: number[][], b: number[]): number[] | null {
    const m = a.map((row, i) => [...row, b[i]]);
    for (let col = 0; col < 3; col++) {
        let pivot = col;
        for (let row = col + 1; row < 3; row++) {
            if (Math.abs(m[row][col]) > Math.abs(m[pivot][col])) pivot = row;
        }
        if (Math.abs(m[pivot][col]) < 1e-9) return null;
        [m[col], m[pivot]] = [m[pivot], m[col]];
        for (let row = 0; row < 3; row++) {
            if (row === col) continue;
            const factor = m[row][col] / m[col][col];
            for (let k = col; k < 4; k++) m[row][k] -= factor * m[col][k];
        }
    }
    return [m[0][3] / m[0][0], m[1][3] / m[1][1], m[2][3] / m[2][2]];
}

/**
 * Least-squares 3D point minimizing the total squared perpendicular distance to every given
 * ray — the standard multi-view triangulation formula (accumulate the projection matrix
 * `I - dir*dirᵀ` for each ray and solve the resulting 3x3 linear system). With exactly two
 * rays that don't quite intersect (the normal case for real clicks), this is the midpoint of
 * their closest-approach segment; with more rays it's the point best explaining all of them
 * at once. Returns null with fewer than 2 rays, if the rays are too degenerate (e.g. all
 * parallel) to solve, or if every pair of rays is narrower than `minAngleDeg` apart.
 *
 * That last check matters in practice, not just in theory: two photos taken back-to-back
 * during a walk can be almost the same viewpoint (confirmed on real data — two photos 0.015
 * scene units apart in camera position, looking at a piece 0.34 units away, only ~1.9
 * degrees apart, triangulated to a point over half a unit from either photo's own
 * independent splat-pick guess). The least-squares solve below will happily produce *a*
 * number for a baseline that narrow, but the depth it implies is wildly sensitive to tiny
 * click or calibration noise — a splat-pick median is more trustworthy than a triangulation
 * this ill-conditioned, so this rejects it (returns null) rather than reporting a falsely
 * precise-looking answer.
 */
export function triangulateRays(rays: Ray3[], minAngleDeg = 3): Vec3 | null {
    if (rays.length < 2) return null;
    let maxAngleRad = 0;
    for (let i = 0; i < rays.length; i++) {
        for (let j = i + 1; j < rays.length; j++) {
            const dot = Math.min(1, Math.max(-1, rays[i].dir.dot(rays[j].dir)));
            maxAngleRad = Math.max(maxAngleRad, Math.acos(dot));
        }
    }
    if ((maxAngleRad * 180) / Math.PI < minAngleDeg) return null;

    let m00 = 0;
    let m01 = 0;
    let m02 = 0;
    let m11 = 0;
    let m12 = 0;
    let m22 = 0;
    let bx = 0;
    let by = 0;
    let bz = 0;
    for (const { origin, dir } of rays) {
        const d = dir.clone().normalize();
        const a00 = 1 - d.x * d.x;
        const a01 = -d.x * d.y;
        const a02 = -d.x * d.z;
        const a11 = 1 - d.y * d.y;
        const a12 = -d.y * d.z;
        const a22 = 1 - d.z * d.z;
        m00 += a00;
        m01 += a01;
        m02 += a02;
        m11 += a11;
        m12 += a12;
        m22 += a22;
        bx += a00 * origin.x + a01 * origin.y + a02 * origin.z;
        by += a01 * origin.x + a11 * origin.y + a12 * origin.z;
        bz += a02 * origin.x + a12 * origin.y + a22 * origin.z;
    }
    const solved = solve3x3(
        [
            [m00, m01, m02],
            [m01, m11, m12],
            [m02, m12, m22]
        ],
        [bx, by, bz]
    );
    return solved ? new Vec3(solved[0], solved[1], solved[2]) : null;
}
