import { Vec3 } from 'playcanvas';
import type { SceneHandles } from './scene';
import { pickSplatSurface } from './raypick';
import { getPhotoCamera } from './photo-cameras';
import { pixelToWorldRay, worldToPixel, projScaleYFromIntrinsics, triangulateRays, type Ray3 } from './colmap-math';
import { polygonCentroid01, type PieceInstance } from './annotated-pieces';

/** Tried in order until one finds a splat — see placePieceFromPhotoClick. The default (10)
 * matches the live 3D-view click-to-place tool's precision; a piece drawn from a photo often
 * lands on a thinly-reconstructed area (a flat poster, a dark frame) where nothing is within
 * that tight a radius even though the ray is clearly pointing at real, if sparse, geometry —
 * widening the search still derives the anchor from actual reconstructed data, it's just
 * more tolerant about how close a splat has to be to "count" as that data. */
const PICK_RADIUS_ATTEMPTS_PX = [10, 30, 80, 200];

/**
 * Computes the 3D scene position a normalized (0-1) click on a training photo corresponds
 * to, by casting a ray from that photo's calibrated camera through the splat point cloud —
 * the same pick used for live 3D-view clicks (see raypick.ts), just with a photo-derived ray
 * instead of one from the live PlayCanvas camera, and a progressively wider search radius
 * (see PICK_RADIUS_ATTEMPTS_PX) since a photo-drawn polygon is more likely to center on a
 * sparsely-reconstructed flat surface than a live 3D click is. Returns null if the photo has
 * no calibration, or the ray doesn't hit any splat even at the widest radius tried — meaning
 * it's pointing at genuinely unreconstructed space, which no amount of search radius can fix.
 */
export async function placePieceFromPhotoClick(
    scene: Pick<SceneHandles, 'splatCenters'>,
    photo: string,
    u01: number,
    v01: number
): Promise<Vec3 | null> {
    const camera = await getPhotoCamera(photo);
    if (!camera) return null;
    const u = u01 * camera.width;
    const v = v01 * camera.height;
    const { origin, dir } = pixelToWorldRay(camera, u, v);
    const projScaleY = projScaleYFromIntrinsics(camera);
    for (const pixelRadius of PICK_RADIUS_ATTEMPTS_PX) {
        const hit = pickSplatSurface(scene.splatCenters, origin, dir, projScaleY, camera.height, pixelRadius);
        if (hit) return hit;
    }
    return null;
}

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
 * instances' centroid — the same ray implicitly used by placePieceFromPhotoClick, exposed
 * here for matching/triangulating across multiple photos of the same piece. Null if the
 * photo has no calibration. */
export async function rayForInstance(instance: Pick<PieceInstance, 'photo' | 'polygon'>): Promise<Ray3 | null> {
    const camera = await getPhotoCamera(instance.photo);
    if (!camera) return null;
    const [cu, cv] = polygonCentroid01(instance.polygon);
    return pixelToWorldRay(camera, cu * camera.width, cv * camera.height);
}

/**
 * Real multi-view triangulation across every instance of a piece that has a calibrated
 * photo — casts each instance's ray (see rayForInstance) and finds the 3D point that best
 * explains all of them at once (see colmap-math.ts's triangulateRays). This is the actual
 * "two-photo geometry" the user asked for, independent of splat density entirely — it works
 * even where every instance's own splat-pick anchor came back empty. Returns null with
 * fewer than 2 usable rays, or if the rays are too degenerate to solve (e.g. near-parallel).
 */
export async function triangulatePieceInstances(instances: PieceInstance[]): Promise<Vec3 | null> {
    const rays = await Promise.all(instances.map(rayForInstance));
    const valid = rays.filter((r): r is Ray3 => r !== null);
    return valid.length >= 2 ? triangulateRays(valid) : null;
}
