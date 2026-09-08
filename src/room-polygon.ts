export interface RoomPolygon {
    /** Vertices in hotspotsRoot-local space (same space as piece positions), in click
     * order around the walkable floor area's perimeter. Transformed to world space at
     * collision time so it stays correct if worldRoot's rotation changes later. */
    points: [number, number, number][];
    /** World-space floor height this boundary was traced at — the median of where each
     * vertex was actually clicked, self-calibrated from the user's own aim rather than an
     * automatic (and less reliable) estimate from splat density. Used to correct the
     * camera's vertical floor clamp to match. */
    floorY?: number;
}

const STORAGE_KEY = 'crop-art-splat:roomPolygon';

/** Per-browser override drawn in the editor (F2 → Room boundary). */
export function loadLocalRoomPolygon(): RoomPolygon | null {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return null;
        const parsed = JSON.parse(raw) as RoomPolygon;
        if (!Array.isArray(parsed?.points) || parsed.points.length < 3) return null;
        return parsed;
    } catch {
        return null;
    }
}

export function saveLocalRoomPolygon(polygon: RoomPolygon | null): void {
    if (!polygon) {
        localStorage.removeItem(STORAGE_KEY);
        return;
    }
    localStorage.setItem(STORAGE_KEY, JSON.stringify(polygon));
}

let bundledCache: RoomPolygon | null | undefined;

/** The shipped default boundary (public/data/room-polygon.json), used for every visitor
 * until baked into a new build. Absent until one has actually been baked in. */
async function loadBundledRoomPolygon(): Promise<RoomPolygon | null> {
    if (bundledCache !== undefined) return bundledCache;
    try {
        const res = await fetch('/data/room-polygon.json');
        bundledCache = res.ok ? ((await res.json()) as RoomPolygon) : null;
    } catch {
        bundledCache = null;
    }
    return bundledCache;
}

/** A per-browser override (drawn locally in the editor) wins; otherwise fall back to the
 * shipped default every visitor gets. */
export async function resolveRoomPolygon(): Promise<RoomPolygon | null> {
    const local = loadLocalRoomPolygon();
    if (local) return local;
    return loadBundledRoomPolygon();
}
