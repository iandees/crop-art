import type { Piece } from './pieces';
import { exportPiecesFile } from './pieces';

/** One photo's view of a piece, captured while identifying it in the F2 editor. Its 3D ray
 * (photo's camera through this polygon's centroid) is recomputed on demand from `photo` +
 * `polygon` — see reprojection.ts's rayForInstance — rather than stored, since it's cheap to
 * derive and storing it would just be a second source of truth. There is deliberately no
 * splat-derived position here at all: a piece's position comes entirely from triangulating
 * 2+ instances' rays against each other (see reprojection.ts's triangulatePieceInstances) —
 * real camera geometry, not a guess against however densely the trained splat happened to
 * reconstruct that surface. */
export interface PieceInstance {
    /** Filename under /photos/ — must be a key in photo-cameras.json for ray/reprojection math. */
    photo: string;
    /** Normalized (0-1, top-left origin) polygon vertices in click order, image space. Always
     * >= 3. A rectangle (e.g. one set via the catalog step's crop box) is just a 4-vertex
     * polygon here too — there's no separate crop field, this IS the crop source. */
    polygon: [number, number][];
    /** True for an instance created via the ghost-click fast path (a small synthesized
     * square, not a hand-drawn outline) — flags it in the UI as worth tightening later. */
    placeholder?: boolean;
}

/**
 * A piece identified via the photo-by-photo "Identify pieces" tool, gaining title/artist/
 * etc. once cataloged. This is a from-scratch catalog, deliberately not linked to the
 * existing (LLM-sourced) pieces.json entries — see README/commit history for why.
 */
export interface AnnotatedPiece {
    id: string;
    instances: PieceInstance[];
    /** Set once >=2 instances exist and real multi-view triangulation succeeds (see
     * reprojection.ts's triangulatePieceInstances) — the piece's only source of a 3D
     * position. With a single instance (or a triangulation too ill-conditioned to trust —
     * see colmap-math.ts's triangulateRays), this stays undefined and the piece has no
     * resolved position yet. Recomputed (and possibly cleared back to undefined) every time
     * this piece's instances change — see identify-mode.ts's retriangulate. */
    triangulatedPosition?: [number, number, number];
    // Cataloging fields — undefined until filled in. Names match Piece's exactly.
    title?: string;
    artist?: string;
    hometown?: string;
    ribbon?: string;
    description?: string;
    /** Index into `instances` chosen as the canonical view — its polygon's bounding box
     * becomes photoCrop, its anchor becomes position, its photo becomes photo. */
    canonicalInstanceIndex?: number;
}

const STORAGE_KEY = 'crop-art-splat:annotatedPieces';

export function loadAnnotatedPieces(): AnnotatedPiece[] {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (!stored) return [];
    try {
        return JSON.parse(stored) as AnnotatedPiece[];
    } catch {
        return [];
    }
}

export function saveAnnotatedPieces(pieces: AnnotatedPiece[]): void {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(pieces));
}

/** A piece's current 3D position, or null if it doesn't have one yet — true until at least 2
 * instances exist with rays that triangulate cleanly (see triangulatePieceInstances). There
 * is no other source of position: no splat picking, no fallback guess — just an alias for
 * `piece.triangulatedPosition` kept as a function so call sites read as "does this piece
 * have a resolved position" rather than reaching into the field directly. */
export function representativeAnchor(piece: AnnotatedPiece): [number, number, number] | null {
    return piece.triangulatedPosition ?? null;
}

export function polygonCentroid01(polygon: [number, number][]): [number, number] {
    const n = polygon.length;
    const sumX = polygon.reduce((s, p) => s + p[0], 0);
    const sumY = polygon.reduce((s, p) => s + p[1], 0);
    return [sumX / n, sumY / n];
}

/** [x, y, w, h] — matches Piece.photoCrop's shape exactly. */
export function polygonBBox01(polygon: [number, number][]): [number, number, number, number] {
    const xs = polygon.map((p) => p[0]);
    const ys = polygon.map((p) => p[1]);
    const minX = Math.min(...xs);
    const minY = Math.min(...ys);
    return [minX, minY, Math.max(...xs) - minX, Math.max(...ys) - minY];
}

export function isCataloged(piece: AnnotatedPiece): boolean {
    return !!piece.title && piece.canonicalInstanceIndex !== undefined;
}

/** Converts to the Piece[] shape the live site consumes. Pieces with no canonical instance
 * chosen yet, or with no triangulated position at all (needs a second linked photo), are
 * skipped (with a console warning for the latter, since it's a real gap rather than just
 * "not cataloged yet") — the catalog UI should warn about both before export. */
export function toPieces(annotated: AnnotatedPiece[]): Piece[] {
    const result: Piece[] = [];
    for (const ap of annotated) {
        if (ap.canonicalInstanceIndex === undefined) continue;
        const inst = ap.instances[ap.canonicalInstanceIndex];
        if (!inst) continue;
        const position = ap.triangulatedPosition;
        if (!position) {
            console.warn(`Skipping "${ap.title ?? ap.id}" from export — no triangulated 3D position (needs a second linked photo).`);
            continue;
        }
        result.push({
            id: ap.id,
            title: ap.title || 'Untitled piece',
            artist: ap.artist || undefined,
            hometown: ap.hometown || undefined,
            ribbon: ap.ribbon || undefined,
            description: ap.description || undefined,
            photo: inst.photo,
            photoCrop: polygonBBox01(inst.polygon),
            position
        });
    }
    return result;
}

/** Reuses pieces.ts's exact download mechanism (Blob + hidden <a download>). */
export function exportAnnotatedPiecesAsPiecesFile(annotated: AnnotatedPiece[]): void {
    exportPiecesFile(toPieces(annotated));
}
