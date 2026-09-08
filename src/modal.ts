import type { Piece } from './pieces';
import { suggestEditUrl } from './github-issue';

export function showPieceModal(piece: Piece): void {
    const backdrop = document.createElement('div');
    backdrop.className = 'modal-backdrop';

    const modal = document.createElement('div');
    modal.className = 'modal';
    modal.style.position = 'relative';

    const closeBtn = document.createElement('button');
    closeBtn.className = 'close-btn';
    closeBtn.textContent = '✕';
    closeBtn.onclick = () => backdrop.remove();
    modal.appendChild(closeBtn);

    if (piece.photo) {
        if (piece.photoCrop) {
            const [x, y, w, h] = piece.photoCrop;
            const frame = document.createElement('div');
            frame.className = 'modal-photo-crop';
            const img = document.createElement('img');
            img.alt = piece.title;
            // Scale the image up so the cropped region fills the frame, then shift it so
            // that region's top-left lands at the frame's origin. Both size and position
            // are expressed as percentages of the (scaled) image, so this works regardless
            // of the frame's actual pixel dimensions.
            img.style.width = `${100 / w}%`;
            img.style.height = `${100 / h}%`;
            img.style.left = `${-(x * 100) / w}%`;
            img.style.top = `${-(y * 100) / h}%`;
            // w/h are fractions of width/height independently, so their ratio only equals
            // the crop's true visual aspect ratio if the source photo is square — these
            // photos are portrait (e.g. 1400x1859), so the frame's size must be computed
            // from the photo's actual pixel dimensions once known, or a square-looking
            // fraction (like 0.5/0.5) renders as a squashed/stretched square instead of the
            // portrait-shaped region it actually is.
            img.onload = () => {
                const cropAspect = (w * img.naturalWidth) / (h * img.naturalHeight);
                // Fit within the same footprint a non-cropped photo gets (.modal img: full
                // modal width, capped at 55vh tall) — computed here instead of via CSS
                // aspect-ratio + max-height together, since those two fight each other
                // (max-height clips the height without shrinking the width back down to
                // match, silently changing the box's effective aspect ratio and stretching
                // the image inside it, which is positioned by percentages of this box).
                const maxWidth = modal.clientWidth;
                const maxHeight = window.innerHeight * 0.55;
                let width = maxWidth;
                let height = width / cropAspect;
                if (height > maxHeight) {
                    height = maxHeight;
                    width = height * cropAspect;
                }
                frame.style.width = `${width}px`;
                frame.style.height = `${height}px`;
            };
            img.src = `/photos/${piece.photo}`;
            frame.appendChild(img);
            modal.appendChild(frame);
        } else {
            const img = document.createElement('img');
            img.src = `/photos/${piece.photo}`;
            img.alt = piece.title;
            modal.appendChild(img);
        }
    }

    const body = document.createElement('div');
    body.className = 'modal-body';

    const h2 = document.createElement('h2');
    h2.textContent = piece.title;
    body.appendChild(h2);

    if (piece.artist) {
        const artist = document.createElement('div');
        artist.className = 'artist';
        artist.textContent = piece.hometown ? `by ${piece.artist} — ${piece.hometown}` : `by ${piece.artist}`;
        body.appendChild(artist);
    }

    if (piece.description) {
        const p = document.createElement('p');
        p.textContent = piece.description;
        body.appendChild(p);
    }

    if (piece.ribbon) {
        const ribbon = document.createElement('div');
        ribbon.className = 'ribbon';
        ribbon.textContent = piece.ribbon;
        body.appendChild(ribbon);
    }

    const suggestLink = document.createElement('a');
    suggestLink.className = 'suggest-edit-link';
    suggestLink.href = suggestEditUrl(piece);
    suggestLink.target = '_blank';
    suggestLink.rel = 'noopener';
    suggestLink.textContent = 'Something wrong here? Suggest a fix →';
    body.appendChild(suggestLink);

    modal.appendChild(body);
    backdrop.appendChild(modal);

    backdrop.addEventListener('click', (e) => {
        if (e.target === backdrop) backdrop.remove();
    });
    document.addEventListener('keydown', function onKey(e) {
        if (e.key === 'Escape') {
            backdrop.remove();
            document.removeEventListener('keydown', onKey);
        }
    });

    document.getElementById('ui-root')!.appendChild(backdrop);
}
