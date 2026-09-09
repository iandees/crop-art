import { Vec3 } from 'playcanvas';
import { getPhotoCamera, getAllCalibratedPhotos } from './photo-cameras';
import { pixelToWorldRay, worldToPixel, triangulateRays, pointToRayDistance, type Ray3 } from './colmap-math';
import { polygonCentroid01, type AnnotatedPiece, type PieceInstance } from './annotated-pieces';

/**
 * Projects a world-space point (worldRoot-local, same space as Piece.position) onto a
 * calibrated training photo, returning normalized (0-1) pixel coordinates — used to overlay
 * "where this piece should be" on other candidate photos while cycling through them (see
 * editor.ts). Returns null if the photo has no calibration, the point is behind that
 * camera, or it projects outside the frame — all of which mean "not usefully visible here."
 */
export async function reprojectPointToPhoto(
    photo: string,
    worldPoint: Vec3
): Promise<{ u01: number; v01: number } | null> {
    const camera = await getPhotoCamera(photo);
    if (!camera) return null;
    const { u, v, inFront } = worldToPixel(camera, worldPoint);
    if (!inFront) return null;
    const u01 = u / camera.width;
    const v01 = v / camera.height;
    if (u01 < 0 || u01 > 1 || v01 < 0 || v01 > 1) return null;
    return { u01, v01 };
}

/** The world-space ray from a photo's calibrated camera through one of its polygon
 * instances' centroid — this is the only source of 3D information a polygon instance
 * carries (see annotated-pieces.ts's PieceInstance — deliberately no splat-derived position
 * at all). Null if the photo has no calibration. */
export async function rayForInstance(instance: Pick<PieceInstance, 'photo' | 'polygon'>): Promise<Ray3 | null> {
    const camera = await getPhotoCamera(instance.photo);
    if (!camera) return null;
    const [cu, cv] = polygonCentroid01(instance.polygon);
    return pixelToWorldRay(camera, cu * camera.width, cv * camera.height);
}

/**
 * Real multi-view triangulation across every instance of a piece that has a calibrated
 * photo — casts each instance's ray (see rayForInstance) and finds the 3D point that best
 * explains all of them at once (see colmap-math.ts's triangulateRays). This is the piece's
 * *only* source of a 3D position — no splat picking anywhere in this pipeline — and it
 * naturally improves as more instances (rays) join: each additional view tightens the
 * least-squares fit rather than just averaging in another independent guess. Returns null
 * with fewer than 2 usable rays, or if the rays are too close in angle to trust (see
 * triangulateRays' minAngleDeg guard).
 */
export async function triangulatePieceInstances(instances: PieceInstance[]): Promise<Vec3 | null> {
    const rays = await Promise.all(instances.map(rayForInstance));
    const valid = rays.filter((r): r is Ray3 => r !== null);
    return valid.length >= 2 ? triangulateRays(valid) : null;
}

/** Recomputes a piece's `triangulatedPosition` in place from its current instances — call
 * after any change to a piece's instance list (added, removed, merged in from another
 * piece) or to any instance's polygon (which shifts that instance's centroid, hence its
 * ray). With fewer than 2 instances this just clears any stale triangulation. Shared by
 * identify-mode.ts and catalog-mode.ts so both stay in sync with the same logic. */
export async function retriangulatePiece(piece: AnnotatedPiece): Promise<void> {
    if (piece.instances.length < 2) {
        piece.triangulatedPosition = undefined;
        return;
    }
    const tri = await triangulatePieceInstances(piece.instances);
    piece.triangulatedPosition = tri ? [tri.x, tri.y, tri.z] : undefined;
}

/** Root-mean-square perpendicular distance from a piece's triangulated position to each of
 * its instances' rays — a concrete "how well do all these views agree" error, in scene
 * units. Smaller is better; null if the piece has no triangulated position yet. Shown to the
 * user while reviewing candidate photos so they know when they've gathered enough views to
 * be confident of a piece's location (see identify-mode.ts). */
export async function triangulationResidual(piece: AnnotatedPiece): Promise<number | null> {
    if (!piece.triangulatedPosition) return null;
    const rays = await Promise.all(piece.instances.map(rayForInstance));
    const valid = rays.filter((r): r is Ray3 => r !== null);
    if (valid.length === 0) return null;
    const point = new Vec3(...piece.triangulatedPosition);
    const sumSq = valid.reduce((sum, r) => sum + pointToRayDistance(point, r) ** 2, 0);
    return Math.sqrt(sumSq / valid.length);
}

/** Along-ray sample depths (scene units) for epipolar-line/candidate-photo math below. Bounds
 * are conservative relative to the room's own measured extent (x in [-3.54, 4.51], z in
 * [-5.86, 4.94] — see README's "Scene scale" notes and the placed-piece bounding box
 * measured while planning the identify tool), not a guess: 0.05 is "just past the camera,"
 * 14 comfortably exceeds the room's ~13.5-unit diagonal. */
const EPIPOLAR_NEAR_DEPTH = 0.05;
const EPIPOLAR_FAR_DEPTH = 14;

/** Where a ray (from one photo's camera through a not-yet-triangulated piece's one existing
 * view) would appear in a *different* calibrated photo — the segment the matching point must
 * lie somewhere along, if this piece is visible there at all. Null if that photo has no
 * calibration or the segment isn't in front of its camera at all (a strong "definitely not
 * visible here" signal, not just "off to the side"). */
export async function epipolarSegmentInPhoto(
    ray: Ray3,
    photo: string
): Promise<{ near: { u01: number; v01: number }; far: { u01: number; v01: number } } | null> {
    const camera = await getPhotoCamera(photo);
    if (!camera) return null;
    const nearPoint = ray.origin.clone().add(ray.dir.clone().mulScalar(EPIPOLAR_NEAR_DEPTH));
    const farPoint = ray.origin.clone().add(ray.dir.clone().mulScalar(EPIPOLAR_FAR_DEPTH));
    const nearProj = worldToPixel(camera, nearPoint);
    const farProj = worldToPixel(camera, farPoint);
    if (!nearProj.inFront || !farProj.inFront) return null;
    return {
        near: { u01: nearProj.u / camera.width, v01: nearProj.v / camera.height },
        far: { u01: farProj.u / camera.width, v01: farProj.v / camera.height }
    };
}

export interface RayCandidate {
    photo: string;
    /** Distance from this candidate's camera to the original view's camera — used to rank
     * candidates, farther first: two photos taken back-to-back give a near-parallel, poorly
     * conditioned triangulation (confirmed on real data — see colmap-math.ts's
     * triangulateRays doc comment), so a photo taken from meaningfully further away is a
     * much more useful second view than the very next frame in the sequence. */
    baselineDistance: number;
    near: { u01: number; v01: number };
    far: { u01: number; v01: number };
}

/** Scans every calibrated photo (except `excludePhotos`) for ones whose epipolar segment for
 * `ray` plausibly crosses through or near the visible frame, ranked by baseline distance
 * from `originCamera` (farthest first — see RayCandidate). This is what lets "draw one
 * outline, then only check the photos that could plausibly show it" work: instead of relying
 * on stumbling across the same piece while browsing in order, every calibrated photo gets
 * screened up front. */
export async function findRayCandidates(
    ray: Ray3,
    originCamera: Vec3,
    excludePhotos: ReadonlySet<string>
): Promise<RayCandidate[]> {
    const allPhotos = await getAllCalibratedPhotos();
    const results: RayCandidate[] = [];
    for (const photo of allPhotos) {
        if (excludePhotos.has(photo)) continue;
        const seg = await epipolarSegmentInPhoto(ray, photo);
        if (!seg) continue;
        // Generous margin (not a strict [0,1] frame check) — a segment that clips just past
        // the edge is still a reasonable candidate to check by eye, and the near/far depth
        // guess is approximate anyway.
        const near = (u: number, v: number) => u > -0.5 && u < 1.5 && v > -0.5 && v < 1.5;
        if (!near(seg.near.u01, seg.near.v01) && !near(seg.far.u01, seg.far.v01)) continue;
        const camera = await getPhotoCamera(photo);
        if (!camera) continue;
        const baselineDistance = new Vec3(...camera.position).distance(originCamera);
        results.push({ photo, baselineDistance, near: seg.near, far: seg.far });
    }
    results.sort((a, b) => b.baselineDistance - a.baselineDistance);
    return results;
}
