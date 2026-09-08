import type { Piece } from './pieces';

const REPO = 'iandees/crop-art';

/**
 * A GitHub "issue forms" template prefills its fields from query params matching each
 * field's `id` (see .github/ISSUE_TEMPLATE/suggest-edit.yml) — so a visitor clicking this
 * from a piece's modal lands on a report that already carries the piece's id/title/artist/
 * photo, without them having to type or even know that identifying info.
 */
export function suggestEditUrl(piece: Piece): string {
    const params = new URLSearchParams({
        template: 'suggest-edit.yml',
        title: `[Edit] ${piece.title}`,
        piece_id: piece.id,
        current_title: piece.title,
        current_artist: piece.artist ?? '',
        current_photo: piece.photo ?? ''
    });
    return `https://github.com/${REPO}/issues/new?${params.toString()}`;
}

export function reportMissingPieceUrl(): string {
    const params = new URLSearchParams({ template: 'missing-piece.yml' });
    return `https://github.com/${REPO}/issues/new?${params.toString()}`;
}
