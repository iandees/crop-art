const KEY = 'crop-art-splat:worldRotation';

export type Rotation = [number, number, number];

/** Fixes the splat's up-axis — see scene.ts. Adjustable live via the F2 editor.
 * Derived via the 2-point column-leveling tool (plane-fit.ts) — more reliable than the
 * floor-leveling tool since a structural column is guaranteed plumb, while the real floor
 * (and its splat reconstruction) has measurable genuine unevenness. */
export const DEFAULT_ROTATION: Rotation = [-7, -65, -169];

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
