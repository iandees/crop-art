export interface LoadingOverlay {
    hide(): void;
}

export function setupLoadingOverlay(): LoadingOverlay {
    const el = document.getElementById('loading-overlay')!;
    return {
        hide() {
            el.classList.add('loading-overlay-hidden');
            // Match the CSS opacity transition duration before removing, so it doesn't
            // just vanish — see #loading-overlay's `transition` in style.css.
            setTimeout(() => el.remove(), 400);
        }
    };
}
