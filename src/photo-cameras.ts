import type { PhotoCamera } from './colmap-math';

export type { PhotoCamera };

let cache: Record<string, PhotoCamera> | null = null;

async function loadAll(): Promise<Record<string, PhotoCamera>> {
    if (!cache) {
        const res = await fetch('/data/photo-cameras.json');
        cache = res.ok ? await res.json() : {};
    }
    return cache!;
}

/**
 * Full camera calibration (position + orientation + intrinsics, all in worldRoot-local scene
 * space) for each training photo, derived from a real COLMAP sparse reconstruction — see
 * scripts/calibrate-photo-cameras.ts. Unlike photo-poses.ts's approximate eye/focus point,
 * this is precise enough to backproject a specific pixel (see reprojection.ts). Returns null
 * if we have no calibration for that photo (e.g. it wasn't registered by COLMAP).
 */
export async function getPhotoCamera(photo: string): Promise<PhotoCamera | null> {
    const all = await loadAll();
    return all[photo] ?? null;
}

/** Every calibrated photo's filename, sorted — filenames embed a capture timestamp, so
 * lexical sort order is also capture-chronological order (see identify-mode.ts, which walks
 * photos in this order on the assumption that consecutive photos likely overlap). */
export async function getAllCalibratedPhotos(): Promise<string[]> {
    const all = await loadAll();
    return Object.keys(all).sort();
}
