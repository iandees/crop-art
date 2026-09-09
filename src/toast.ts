export interface ToastOptions {
    actionLabel?: string;
    onAction?: () => void;
}

/** A small dismissible notification, e.g. for confirming a non-blocking auto-action (see
 * identify-mode.ts's auto-link-to-existing-piece flow) — appears, optionally offers one
 * action button, and disappears on its own so it never blocks the next thing you do. */
export function showToast(message: string, options: ToastOptions = {}): void {
    const toast = document.createElement('div');
    toast.className = 'toast';

    const text = document.createElement('span');
    text.textContent = message;
    toast.appendChild(text);

    if (options.actionLabel && options.onAction) {
        const btn = document.createElement('button');
        btn.className = 'undo-btn';
        btn.textContent = options.actionLabel;
        btn.onclick = () => {
            options.onAction!();
            toast.remove();
        };
        toast.appendChild(btn);
    }

    document.getElementById('ui-root')!.appendChild(toast);
    setTimeout(() => toast.remove(), 6000);
}
