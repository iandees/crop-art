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
const FLOOR_LIFT = 0.05;

/** How far (world units, XZ) around each polygon vertex to look for real floor splats when
 * measuring that vertex's local height. */
const SAMPLE_RADIUS = 0.6;

/** How far (world units, Y) around the polygon's overall floorY to still consider a splat
 * "part of the floor" rather than a table, plant, or piece of art sitting near it. */
const HEIGHT_BAND = 0.15;

const TARGET_SAMPLES = 300_000;

/**
 * Builds a polygon mesh standing in for the splat's own (blurry/noisy) floor reconstruction —
 * the splat itself does a much better job on the actual wall/table-mounted art than it does on
 * large plain surfaces like the floor, so we cover just the floor with clean geometry rather
 * than touching anything else.
 *
 * The floor is NOT forced flat to a single height. A real room's floor — and especially the
 * leveling rotation's own residual error — can leave a genuine few-cm slope across the room;
 * forcing every vertex to one exact global height then makes the mesh visibly float above the
 * real floor at one end and threaten to poke below it at the other, which reads as "the floor
 * is at the wrong height" / "at a weird angle relative to the room". Instead, each polygon
 * vertex samples the real splat floor height near its own (x,z) location and uses that —
 * letting the mesh's shape track whatever gentle real slope exists instead of fighting it.
 *
 * `polygon.points` are in the SAME local coordinate space as the splat/hotspots data (i.e.
 * "hotspotsRoot-local", pre-worldRoot-rotation) — see room-polygon.ts. `polygon.floorY` (used
 * only to pick out which nearby splats count as "floor" vs. clutter sitting on it) is captured
 * in WORLD space instead (after that rotation).
 */
export function createRoomFloor(app: AppBase, worldRoot: Entity, polygon: RoomPolygon, splatCenters: Float32Array): Entity {
    const floor = new Entity('room-floor');
    worldRoot.addChild(floor);

    const points = polygon.points;
    if (points.length < 3) return floor;

    const worldTransform = worldRoot.getWorldTransform();
    const invWorldTransform = worldTransform.clone().invert();
    const tmp = new Vec3();

    const worldPoints = points.map(([x, y, z]) => worldTransform.transformPoint(tmp.set(x, y, z), new Vec3()));

    // A hand-authored polygon (e.g. typed in rather than drawn in the editor) might omit
    // floorY — fall back to the average of the vertices' own world Y in that rare case; it's a
    // rough proxy, but better than nothing when there's no height to filter "floor-ish" splats.
    const nominalFloorY = polygon.floorY ?? worldPoints.reduce((sum, p) => sum + p.y, 0) / worldPoints.length;

    const localFloorYs = sampleLocalFloorHeights(worldTransform, splatCenters, worldPoints, nominalFloorY);

    const localPoints: Vec3[] = worldPoints.map((wp, i) => {
        tmp.set(wp.x, localFloorYs[i] + FLOOR_LIFT, wp.z);
        return invWorldTransform.transformPoint(tmp, new Vec3());
    });

    const positions: number[] = [];
    for (const p of localPoints) positions.push(p.x, p.y, p.z);

    // Simple fan triangulation from vertex 0 — the polygon is a hand-clicked room outline,
    // not arbitrary user geometry, so it doesn't need to handle non-convex shapes robustly.
    const indices: number[] = [];
    for (let i = 1; i < points.length - 1; i++) {
        indices.push(0, i, i + 1);
    }

    // The material below is unlit (emissive-only), so normals have no visual effect today —
    // this is just a reasonable placeholder in case lighting is ever added later.
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

/** For each of `worldPoints`, averages the world-space Y of nearby splats (within
 * SAMPLE_RADIUS in XZ and HEIGHT_BAND of `nominalFloorY`) to estimate the real local floor
 * height there — falling back to `nominalFloorY` if a vertex has no nearby floor-ish splats. */
function sampleLocalFloorHeights(
    worldTransform: ReturnType<Entity['getWorldTransform']>,
    splatCenters: Float32Array,
    worldPoints: Vec3[],
    nominalFloorY: number
): number[] {
    const m = worldTransform.data;
    const numPoints = splatCenters.length / 3;
    const stride = Math.max(1, Math.floor(numPoints / TARGET_SAMPLES));

    const sums = new Array(worldPoints.length).fill(0);
    const counts = new Array(worldPoints.length).fill(0);
    const radiusSq = SAMPLE_RADIUS * SAMPLE_RADIUS;

    for (let i = 0; i < numPoints; i += stride) {
        const base = i * 3;
        const x = splatCenters[base];
        const y = splatCenters[base + 1];
        const z = splatCenters[base + 2];
        const wx = m[0] * x + m[4] * y + m[8] * z + m[12];
        const wy = m[1] * x + m[5] * y + m[9] * z + m[13];
        const wz = m[2] * x + m[6] * y + m[10] * z + m[14];
        if (Math.abs(wy - nominalFloorY) > HEIGHT_BAND) continue;

        for (let v = 0; v < worldPoints.length; v++) {
            const dx = wx - worldPoints[v].x;
            const dz = wz - worldPoints[v].z;
            if (dx * dx + dz * dz <= radiusSq) {
                sums[v] += wy;
                counts[v]++;
            }
        }
    }

    return worldPoints.map((_, v) => (counts[v] > 0 ? sums[v] / counts[v] : nominalFloorY));
}
