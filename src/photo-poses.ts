export interface PhotoPose {
    position: [number, number, number];
    focus: [number, number, number];
}

let cache: Record<string, PhotoPose> | null = null;

/**
 * Approximate camera pose (in worldRoot-local space) for each training photo, derived by
 * calibrating COLMAP's camera poses against ~20 pieces the user placed by hand (see
 * scripts used to build public/data/photo-poses.json). Accurate to roughly 0.2-0.5 scene
 * units — good enough to fly you to the right general area, not for precise placement.
 * Returns null if we have no pose for that photo (e.g. it wasn't registered by COLMAP).
 */
export async function getPhotoPose(photo: string): Promise<PhotoPose | null> {
    if (!cache) {
        const res = await fetch('/data/photo-poses.json');
        cache = res.ok ? await res.json() : {};
    }
    return cache![photo] ?? null;
}
