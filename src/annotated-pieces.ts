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
     * copied directly from the piece's representativeAnchor() at link time. */
    anchor: [number, number, number];
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

/** Per-axis median of every instance's anchor — resists a single drifted-calibration or
 * mis-clicked instance pulling the estimate off, same robustness idiom as editor.ts's
 * reflattenBoundary (median of clicked floor heights) for the same reason. */
export function representativeAnchor(piece: AnnotatedPiece): [number, number, number] {
    const xs = piece.instances.map((i) => i.anchor[0]);
    const ys = piece.instances.map((i) => i.anchor[1]);
    const zs = piece.instances.map((i) => i.anchor[2]);
    return [median(xs), median(ys), median(zs)];
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
 * chosen yet are skipped — the catalog UI should warn about these before export. */
export function toPieces(annotated: AnnotatedPiece[]): Piece[] {
    const result: Piece[] = [];
    for (const ap of annotated) {
        if (ap.canonicalInstanceIndex === undefined) continue;
        const inst = ap.instances[ap.canonicalInstanceIndex];
        if (!inst) continue;
        result.push({
            id: ap.id,
            title: ap.title || 'Untitled piece',
            artist: ap.artist || undefined,
            hometown: ap.hometown || undefined,
            ribbon: ap.ribbon || undefined,
            description: ap.description || undefined,
            photo: inst.photo,
            photoCrop: polygonBBox01(inst.polygon),
            position: inst.anchor
        });
    }
    return result;
}

/** Reuses pieces.ts's exact download mechanism (Blob + hidden <a download>). */
export function exportAnnotatedPiecesAsPiecesFile(annotated: AnnotatedPiece[]): void {
    exportPiecesFile(toPieces(annotated));
}
