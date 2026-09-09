import { Vec3 } from 'playcanvas';
import type { SceneHandles } from './scene';
import { pickSplatSurface } from './raypick';
import { getPhotoCamera } from './photo-cameras';
import { pixelToWorldRay, worldToPixel, projScaleYFromIntrinsics } from './colmap-math';

/**
 * Computes the 3D scene position a normalized (0-1) click on a training photo corresponds
 * to, by casting a ray from that photo's calibrated camera through the splat point cloud —
 * the same pick used for live 3D-view clicks (see raypick.ts), just with a photo-derived ray
 * instead of one from the live PlayCanvas camera. Returns null if the photo has no
 * calibration (not registered by COLMAP) or the ray doesn't hit any splat.
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
    return pickSplatSurface(scene.splatCenters, origin, dir, projScaleYFromIntrinsics(camera), camera.height);
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
