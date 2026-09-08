import { Quat, Vec3 } from 'playcanvas';

/**
 * Given 3 points that lie on the (splat-native-local-space) floor, returns the rotation
 * that makes that plane horizontal — i.e. its normal aligned with world +Y — leaving yaw
 * (spin around the resulting vertical axis) unconstrained, since it doesn't affect
 * levelness. Much more reliable than hand-tuning Euler sliders: three points aimed
 * directly at the real floor fully determine "flat" in one step.
 *
 * `upHint` disambiguates which of the two normal directions is "up" (the raw cross
 * product can point either way depending on click order) — pass the current rotation's
 * local up direction so re-leveling after a rough manual guess doesn't flip the room.
 */
export function computeLevelingRotation(p0: Vec3, p1: Vec3, p2: Vec3, upHint: Vec3 = Vec3.UP): Quat {
    const v1 = new Vec3().sub2(p1, p0);
    const v2 = new Vec3().sub2(p2, p0);
    const normal = new Vec3().cross(v1, v2).normalize();
    if (normal.dot(upHint) < 0) normal.mulScalar(-1);

    const worldUp = Vec3.UP;
    const dot = Math.min(1, Math.max(-1, normal.dot(worldUp)));
    const q = new Quat();
    if (dot > 0.99999) {
        return q; // already level (identity)
    }
    if (dot < -0.99999) {
        // Exactly upside down — any axis perpendicular to normal works for a 180° flip.
        const axis = Math.abs(normal.x) < 0.9 ? new Vec3(1, 0, 0) : new Vec3(0, 0, 1);
        const perp = new Vec3().cross(normal, axis).normalize();
        q.setFromAxisAngle(perp, 180);
        return q;
    }
    const axis = new Vec3().cross(normal, worldUp).normalize();
    const angle = (Math.acos(dot) * 180) / Math.PI;
    q.setFromAxisAngle(axis, angle);
    return q;
}
