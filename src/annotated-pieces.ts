import type { Piece } from './pieces';
import { exportPiecesFile } from './pieces';
import { median } from './median';

/** One photo's view of a piece, captured while identifying it in the F2 editor. */
export interface PieceInstance {
    /** Filename under /photos/ — must be a key in photo-cameras.json for reprojection to work. */
    photo: string;
    /** Normalized (0-1, top-left origin) polygon vertices in click order, image space. Always
     * >= 3. A rectangle (e.g. one set via the catalog step's crop box) is just a 4-vertex
     * polygon here too — there's no separate crop field, this IS the crop source. */
    polygon: [number, number][];
    /** 3D scene-space point (worldRoot-local, same space Piece.position uses), computed via
     * placePieceFromPhotoClick on this polygon's centroid — or, for a ghost-linked instance,
     * copied directly from the piece's representativeAnchor() at link time. Undefined when
     * the centroid didn't land near any splat (common on thin/sparse surfaces, e.g. a flat
     * poster) — the piece's real position then depends on triangulating against another
     * instance of the same piece from a different photo (see reprojection.ts's
     * triangulatePieceInstances and identify-mode.ts's ray-based matching fallback). */
    anchor?: [number, number, number];
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
     * reprojection.ts's triangulatePieceInstances) — preferred over any single instance's
     * splat-pick anchor wherever a piece's position is needed, since it's derived from
     * actual camera geometry rather than a guess against splat density. Recomputed (and
     * possibly cleared back to undefined) every time this piece's instances change. */
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

/** The best current estimate of a piece's 3D position, or null if none exists yet (a single
 * instance whose centroid never landed near a splat, with no second view to triangulate
 * against — genuinely no 3D information available). Prefers real multi-view triangulation
 * (`triangulatedPosition`) over the per-axis median of whichever instances have their own
 * splat-pick anchor (same robustness idiom as editor.ts's reflattenBoundary — median of
 * clicked floor heights — for the same reason: resist one drifted/mis-clicked instance
 * pulling the estimate off). */
export function representativeAnchor(piece: AnnotatedPiece): [number, number, number] | null {
    if (piece.triangulatedPosition) return piece.triangulatedPosition;
    const anchors = piece.instances.map((i) => i.anchor).filter((a): a is [number, number, number] => !!a);
    if (anchors.length === 0) return null;
    return [median(anchors.map((a) => a[0])), median(anchors.map((a) => a[1])), median(anchors.map((a) => a[2]))];
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
 * chosen yet, or with no resolvable position at all (triangulated or per-instance), are
 * skipped (with a console warning for the latter, since it's a real gap rather than just
 * "not cataloged yet") — the catalog UI should warn about both before export. */
export function toPieces(annotated: AnnotatedPiece[]): Piece[] {
    const result: Piece[] = [];
    for (const ap of annotated) {
        if (ap.canonicalInstanceIndex === undefined) continue;
        const inst = ap.instances[ap.canonicalInstanceIndex];
        if (!inst) continue;
        const position = ap.triangulatedPosition ?? inst.anchor;
        if (!position) {
            console.warn(`Skipping "${ap.title ?? ap.id}" from export — no resolved 3D position (needs a second linked photo).`);
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
