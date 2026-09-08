let cache: Record<string, string[]> | null = null;

/**
 * Candidate photo filenames for a piece, nearest-camera-first, derived from 3D distance
 * between the piece's placed position and each training photo's recovered camera position
 * (see scripts/find-photo-candidates.mjs and public/data/photo-poses.json). Used by the F2
 * editor to let the owner cycle through alternate photos of the same piece. Returns an
 * empty array if the piece has no position (never registered) or no candidates were found.
 */
export async function getPhotoCandidates(pieceId: string): Promise<string[]> {
    if (!cache) {
        const res = await fetch('/data/photo-candidates.json');
        cache = res.ok ? await res.json() : {};
    }
    return cache![pieceId] ?? [];
}
