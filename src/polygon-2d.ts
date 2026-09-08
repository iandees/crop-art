type Point = readonly [number, number];

/** Standard even-odd ray-casting point-in-polygon test. */
export function isInsidePolygon(x: number, z: number, poly: readonly Point[]): boolean {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
        const [xi, zi] = poly[i];
        const [xj, zj] = poly[j];
        const intersect = zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi;
        if (intersect) inside = !inside;
    }
    return inside;
}

function closestPointOnSegment(x: number, z: number, a: Point, b: Point): Point {
    const abx = b[0] - a[0];
    const abz = b[1] - a[1];
    const lenSq = abx * abx + abz * abz;
    const t = lenSq === 0 ? 0 : Math.max(0, Math.min(1, ((x - a[0]) * abx + (z - a[1]) * abz) / lenSq));
    return [a[0] + abx * t, a[1] + abz * t];
}

/** If (x,z) is inside the polygon, returns it unchanged; otherwise returns the nearest
 * point on the polygon's boundary — used to slide the camera along a wall rather than
 * stopping it dead or letting it pass through. */
export function clampToPolygon(x: number, z: number, poly: readonly Point[]): Point {
    if (isInsidePolygon(x, z, poly)) return [x, z];
    let best: Point = poly[0];
    let bestDistSq = Infinity;
    for (let i = 0; i < poly.length; i++) {
        const p = closestPointOnSegment(x, z, poly[i], poly[(i + 1) % poly.length]);
        const dx = p[0] - x;
        const dz = p[1] - z;
        const distSq = dx * dx + dz * dz;
        if (distSq < bestDistSq) {
            bestDistSq = distSq;
            best = p;
        }
    }
    return best;
}
