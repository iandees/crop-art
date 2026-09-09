import { Vec3 } from 'playcanvas';
import { getPhotoCamera } from './photo-cameras';
import { pixelToWorldRay, worldToPixel, triangulateRays, type Ray3 } from './colmap-math';
import { polygonCentroid01, type PieceInstance } from './annotated-pieces';

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
