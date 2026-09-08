import { Color, CULLFACE_NONE, Entity, Mesh, MeshInstance, StandardMaterial, Vec3 } from 'playcanvas';
import type { AppBase } from 'playcanvas';
import type { RoomPolygon } from './room-polygon';

/** Muted warm grey — reads as a clean, unobtrusive floor without competing with the art. */
const FLOOR_COLOR = new Color(0.42, 0.4, 0.37);

/** How far above the true floor height to draw the clean floor mesh, in WORLD units. The real
 * splat floor is reconstructed as a noisy few-cm-thick band of gaussians rather than a single
 * surface, so drawing exactly at the measured floor height still z-fights/pokes through in
 * spots — lifting the mesh clear of that band (tuned empirically against a screenshot) makes
 * it read as solid ground instead of flickering with the splat underneath it. */
const FLOOR_LIFT = 0.15;

/**
 * Builds a flat, ordinary polygon mesh standing in for the splat's own (blurry/noisy) floor
 * reconstruction — the splat itself does a much better job on the actual wall/table-mounted
 * art than it does on large plain surfaces like the floor, so we cover just the floor with
 * clean geometry rather than touching anything else.
 *
 * `polygon.points` are in the SAME local coordinate space as the splat/hotspots data (i.e.
 * "hotspotsRoot-local", pre-worldRoot-rotation) — see room-polygon.ts. `polygon.floorY` is
 * captured in WORLD space instead (after that rotation).
 *
 * worldRoot's rotation isn't just a spin about the vertical axis — it also corrects pitch/roll
 * (see world-rotation.ts's DEFAULT_ROTATION, which has non-zero X and Z components), so it
 * mixes local Y into world X/Z and vice versa. That means "local Y" isn't a proxy for "world
 * height" at all: these 7 points' local Y values actually range from about -0.02 to 1.4, while
 * their world Y (computed below) clusters tightly around the -0.44…-0.58 the polygon's
 * `floorY` implies. So simply averaging local Y and using it as a constant would NOT produce a
 * flat plane once worldRoot's rotation is applied — it would warp into a tilted, displaced
 * surface. Instead, each point is transformed to world space, its world Y is snapped to the
 * known floor height (+ lift), and the result is transformed back to local space — guaranteed
 * to land exactly on a flat, horizontal world-space floor once worldRoot's rotation is
 * (re-)applied at render time.
 */
export function createRoomFloor(app: AppBase, worldRoot: Entity, polygon: RoomPolygon): Entity {
    const floor = new Entity('room-floor');
    worldRoot.addChild(floor);

    const points = polygon.points;
    if (points.length < 3) return floor;

    // A hand-authored polygon (e.g. typed in rather than drawn in the editor) might omit
    // floorY — fall back to the naive local-Y average in that rare case; it's a rough proxy,
    // but better than nothing when there's no world-space height to anchor to at all.
    const worldFloorY =
        polygon.floorY ?? points.reduce((sum, p) => sum + p[1], 0) / points.length;

    const worldTransform = worldRoot.getWorldTransform();
    const invWorldTransform = worldTransform.clone().invert();
    const tmp = new Vec3();

    const localPoints: Vec3[] = points.map(([x, y, z]) => {
        worldTransform.transformPoint(tmp.set(x, y, z), tmp);
        tmp.y = worldFloorY + FLOOR_LIFT;
        invWorldTransform.transformPoint(tmp, tmp);
        return tmp.clone();
    });

    const positions: number[] = [];
    for (const p of localPoints) positions.push(p.x, p.y, p.z);

    // Simple fan triangulation from vertex 0 — the polygon is a hand-clicked room outline,
    // not arbitrary user geometry, so it doesn't need to handle non-convex shapes robustly.
    const indices: number[] = [];
    for (let i = 1; i < points.length - 1; i++) {
        indices.push(0, i, i + 1);
    }

    // Flat-shaded normal from the first triangle (all vertices share it) — the material is
    // unlit/double-sided below, so this mostly matters only if someone later adds real lights.
    const edge1 = new Vec3().sub2(localPoints[1], localPoints[0]);
    const edge2 = new Vec3().sub2(localPoints[2], localPoints[0]);
    const faceNormal = new Vec3().cross(edge1, edge2).normalize();
    const normals: number[] = [];
    for (let i = 0; i < localPoints.length; i++) normals.push(faceNormal.x, faceNormal.y, faceNormal.z);

    const mesh = new Mesh(app.graphicsDevice);
    mesh.setPositions(positions);
    mesh.setNormals(normals);
    mesh.setIndices(indices);
    mesh.update();

    const material = new StandardMaterial();
    // The scene has no light entities (see scene.ts) and the default scene ambient light is
    // black, so an ordinary lit diffuse color would render pure black. Emissive is immune to
    // both — it always shows regardless of lighting — so use it as a simple unlit color.
    material.useLighting = false;
    material.diffuse = new Color(0, 0, 0);
    material.emissive = FLOOR_COLOR;
    // Winding direction of a hand-clicked polygon isn't guaranteed, and it doesn't matter for
    // an unlit flat color — render both faces so the floor is never accidentally invisible.
    material.cull = CULLFACE_NONE;
    material.update();

    const meshInstance = new MeshInstance(mesh, material, floor);
    // No lights exist to cast/receive shadows from; skip the extra draw calls.
    meshInstance.castShadow = false;
    meshInstance.receiveShadow = false;
    floor.addComponent('render', { meshInstances: [meshInstance] });

    return floor;
}
