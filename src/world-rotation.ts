const KEY = 'crop-art-splat:worldRotation';

export type Rotation = [number, number, number];

/** Fixes the splat's up-axis — see scene.ts. Adjustable live via the F2 editor.
 * Derived via the 3-point floor-leveling tool (plane-fit.ts) rather than hand-tuned. */
export const DEFAULT_ROTATION: Rotation = [-6.5, -47.5, -166];

export function loadWorldRotation(): Rotation {
    try {
        const stored = localStorage.getItem(KEY);
        if (stored) {
            const parsed = JSON.parse(stored);
            if (Array.isArray(parsed) && parsed.length === 3) return parsed as Rotation;
        }
    } catch {
        // fall through to default
    }
    return DEFAULT_ROTATION;
}

export function saveWorldRotation(r: Rotation): void {
    localStorage.setItem(KEY, JSON.stringify(r));
}
