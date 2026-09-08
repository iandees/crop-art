export interface Piece {
    id: string;
    title: string;
    artist?: string;
    hometown?: string;
    description?: string;
    /** e.g. "First Premium, Class 3 — Artistic, dyed or painted, amateur" */
    ribbon?: string;
    /** Filename under /photos/, e.g. "loon.jpg" */
    photo?: string;
    /**
     * Normalized crop rectangle [x, y, w, h] (each 0-1, top-left origin) within `photo`
     * to show in the public detail modal instead of the full frame. Undefined means show
     * the whole photo. Drawn/edited in the F2 editor; cleared whenever `photo` changes to
     * a different file, since a crop only makes sense against the photo it was drawn on.
     */
    photoCrop?: [number, number, number, number];
    /** Undefined until placed in the 3D scene via the F2 editor. */
    position?: [number, number, number];
}

const STORAGE_KEY = 'crop-art-splat:pieces';

async function loadBundled(): Promise<Piece[]> {
    const res = await fetch('/data/pieces.json');
    if (!res.ok) return [];
    return (await res.json()) as Piece[];
}

export async function loadPieces(): Promise<Piece[]> {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) {
        try {
            return JSON.parse(stored) as Piece[];
        } catch {
            // fall through to bundled data
        }
    }
    return loadBundled();
}

/** Discards local edits and reloads the checked-in public/data/pieces.json. */
export async function reloadFromBundled(): Promise<Piece[]> {
    const pieces = await loadBundled();
    savePieces(pieces);
    return pieces;
}

export function savePieces(pieces: Piece[]): void {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(pieces));
}

export function exportPiecesFile(pieces: Piece[]): void {
    const blob = new Blob([JSON.stringify(pieces, null, 4)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'pieces.json';
    a.click();
    URL.revokeObjectURL(url);
}
