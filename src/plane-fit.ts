import { Quat, Vec3 } from 'playcanvas';

/** Returns the rotation that maps `v` onto world +Y, leaving yaw (spin around the
 * resulting vertical axis) unconstrained. Shared by both the floor-plane and
 * column-axis leveling tools below — either one hands this whichever real-world-vertical
 * vector it derived, and this does the actual "point it up" math. */
function alignVectorToUp(v: Vec3, upHint: Vec3): Quat {
    const aligned = v.clone();
    if (aligned.dot(upHint) < 0) aligned.mulScalar(-1);

    const worldUp = Vec3.UP;
    const dot = Math.min(1, Math.max(-1, aligned.dot(worldUp)));
    const q = new Quat();
    if (dot > 0.99999) {
        return q; // already level (identity)
    }
    if (dot < -0.99999) {
        // Exactly upside down — any axis perpendicular to `aligned` works for a 180° flip.
        const axis = Math.abs(aligned.x) < 0.9 ? new Vec3(1, 0, 0) : new Vec3(0, 0, 1);
        const perp = new Vec3().cross(aligned, axis).normalize();
        q.setFromAxisAngle(perp, 180);
        return q;
    }
    const axis = new Vec3().cross(aligned, worldUp).normalize();
    const angle = (Math.acos(dot) * 180) / Math.PI;
    q.setFromAxisAngle(axis, angle);
    return q;
}

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
 *
 * Caveat: this trusts the floor to actually be flat. A real floor (and the splat
 * reconstruction of it) can have genuine unevenness across the room, which a 3-point
 * plane can't see past — see computeColumnAlignRotation below for a more reliable
 * alternative when the room has straight vertical structural columns.
 */
export function computeLevelingRotation(p0: Vec3, p1: Vec3, p2: Vec3, upHint: Vec3 = Vec3.UP): Quat {
    const v1 = new Vec3().sub2(p1, p0);
    const v2 = new Vec3().sub2(p2, p0);
    const normal = new Vec3().cross(v1, v2).normalize();
    return alignVectorToUp(normal, upHint);
}

/**
 * Given 2 points clicked along a real structural column/pillar (base and top, or any two
 * points along its length) in splat-native-local-space, returns the rotation that makes
 * that column's axis vertical — i.e. aligned with world +Y — leaving yaw unconstrained.
 *
 * A building column is guaranteed straight and plumb by construction, which the floor
 * itself isn't necessarily (a real floor can have genuine unevenness, and the splat
 * reconstruction of it even more so) — so this is generally a more reliable "what's
 * vertical" reference than 3 floor points when the room has visible columns to click.
 *
 * `upHint` disambiguates direction the same way computeLevelingRotation's does.
 */
export function computeColumnAlignRotation(base: Vec3, top: Vec3, upHint: Vec3 = Vec3.UP): Quat {
    const axis = new Vec3().sub2(top, base).normalize();
    return alignVectorToUp(axis, upHint);
}
