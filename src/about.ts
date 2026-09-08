import { reportMissingPieceUrl } from './github-issue';

/** A small always-visible "About" link plus its info modal — reuses the same
 * `.modal-backdrop`/`.modal`/`.modal-body` styling as the piece detail modal (modal.ts). */
export function setupAboutLink(): void {
    const link = document.createElement('button');
    link.className = 'about-link';
    link.textContent = 'About';
    link.onclick = showAboutModal;
    document.getElementById('ui-root')!.appendChild(link);
}

function showAboutModal(): void {
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

    const body = document.createElement('div');
    body.className = 'modal-body';
    body.innerHTML = `
        <h2>About this site</h2>
        <p>
            This is a walk-through 3D reconstruction of the crop art exhibit at the 2026
            Minnesota State Fair. It was built from hundreds of photos of the exhibit hall,
            processed with a technique called Gaussian Splatting to recreate the room in 3D —
            you're not looking at a video or a panorama, but an actual reconstructed 3D scene
            you can fly through.
        </p>
        <p>
            Move with <kbd>WASD</kbd> and look by dragging, same as walking through a
            first-person game. The glowing dots mark individual pieces of crop art — click one
            to see a clearer photo and details about the piece and its artist.
        </p>
        <p>
            The 3D reconstruction itself is a bit rough around the edges (that's the nature of
            this technique on a real, cluttered room), so the photo behind each dot is there to
            actually show you the art clearly.
        </p>
        <p>
            <strong>This is an independent personal project</strong> and is not affiliated
            with, endorsed by, or sponsored by the Minnesota State Fair or any of the artists
            whose work is shown here.
        </p>
        <p>
            Notice a piece that's missing, mislabeled, or missing its own hotspot?
            <a class="suggest-edit-link" href="${reportMissingPieceUrl()}" target="_blank" rel="noopener">Let me know on GitHub →</a>
        </p>
    `;
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
