import {
    AppBase,
    AppOptions,
    Asset,
    AssetListLoader,
    CameraComponentSystem,
    Color,
    Entity,
    FILLMODE_FILL_WINDOW,
    GSPLAT_RENDERER_AUTO,
    GSplatComponentSystem,
    GSplatHandler,
    KEY_A,
    KEY_D,
    KEY_E,
    KEY_Q,
    KEY_S,
    KEY_W,
    Keyboard,
    Mouse,
    RESOLUTION_AUTO,
    RenderComponentSystem,
    ScriptComponentSystem,
    TextureHandler,
    TouchDevice,
    Vec3,
    createGraphicsDevice
} from 'playcanvas';
import { CameraControls } from 'playcanvas/scripts/esm/camera-controls.mjs';
import { Annotation, AnnotationManager } from 'playcanvas/scripts/esm/annotations.mjs';
import { loadWorldRotation } from './world-rotation';
import { computeRoomBounds } from './room-bounds';
import { resolveRoomPolygon, type RoomPolygon } from './room-polygon';
import { clampToPolygon } from './polygon-2d';

/** URL the compressed-ply splat is loaded from. Set VITE_SPLAT_URL for production (e.g. an R2 bucket URL). */
const SPLAT_URL = import.meta.env.VITE_SPLAT_URL ?? '/splat/splat-trained-compressed.ply';

export interface SceneHandles {
    app: AppBase;
    /** Everything (splat + hotspots) lives under this entity, so a single rotation here fixes up-axis. */
    worldRoot: Entity;
    hotspotsRoot: Entity;
    camera: Entity;
    annotationManager: unknown;
    /** Tell the render-throttle "something changed, keep rendering for a bit" — see setupRenderThrottle. */
    wake: () => void;
    /** Raw splat center positions (x,y,z per splat), in worldRoot-local space. For CPU ray-picking — see raypick.ts. */
    splatCenters: Float32Array;
    /** The CameraControls script instance — call `.reset(focus, position)` to teleport the camera. */
    cameraControls: unknown;
    /** Turn floor/wall/ceiling collision on or off — off while placing hotspots near a surface. */
    setCollisionEnabled: (enabled: boolean) => void;
    /** Replace the auto-fitted rectangular wall bounds with a custom floor polygon (or null to go back to the rectangle). */
    setRoomPolygon: (polygon: RoomPolygon | null) => void;
    /** World-space Y of the literal splat floor surface (not the raised collision floor) — used to snap room-boundary clicks onto the floor plane. */
    getFloorY: () => number;
}

export async function createScene(canvas: HTMLCanvasElement): Promise<SceneHandles> {
    const gfxOptions = {
        deviceTypes: ['webgpu', 'webgl2'],
        antialias: false
    };
    const device = await createGraphicsDevice(canvas, gfxOptions);
    const isMobile = /Mobi|Android/i.test(navigator.userAgent);
    device.maxPixelRatio = Math.min(window.devicePixelRatio, isMobile ? 1 : 2);

    const createOptions = new AppOptions();
    createOptions.graphicsDevice = device;
    createOptions.mouse = new Mouse(canvas);
    createOptions.touch = new TouchDevice(canvas);
    createOptions.keyboard = new Keyboard(window);

    createOptions.componentSystems = [
        RenderComponentSystem,
        CameraComponentSystem,
        ScriptComponentSystem,
        GSplatComponentSystem
    ];
    createOptions.resourceHandlers = [TextureHandler, GSplatHandler];

    const app = new AppBase(canvas);
    app.init(createOptions);
    app.setCanvasFillMode(FILLMODE_FILL_WINDOW);
    app.setCanvasResolution(RESOLUTION_AUTO);

    const resize = () => app.resizeCanvas();
    window.addEventListener('resize', resize);

    const assets = {
        splat: new Asset('crop-art-splat', 'gsplat', { url: SPLAT_URL })
    };
    await new Promise<void>((resolve) => {
        new AssetListLoader(Object.values(assets), app.assets).load(() => resolve());
    });

    app.start();
    app.scene.gsplat.renderer = GSPLAT_RENDERER_AUTO;
    // The trained splat has ~8.3M gaussians — too many to sort/render smoothly on phone
    // GPUs. Cap the budget on mobile; desktop can handle the full scene.
    app.scene.gsplat.splatBudget = isMobile ? 1_200_000 : 4_000_000;

    // Everything lives under worldRoot so a single rotation/offset here re-orients the
    // whole scene (splat + hotspots stay aligned) if the trained splat's up-axis is off.
    const worldRoot = new Entity('world-root');
    worldRoot.setLocalEulerAngles(...loadWorldRotation());
    app.root.addChild(worldRoot);

    const splatEntity = new Entity('crop-art-splat');
    splatEntity.addComponent('gsplat', { asset: assets.splat });
    worldRoot.addChild(splatEntity);

    // The camera must exist in the hierarchy *before* AnnotationManager.initialize()
    // runs (right below) — it locks onto app.root.findComponent('camera') once, at
    // creation time, and never looks again.
    const camera = new Entity('camera');
    camera.addComponent('camera', {
        clearColor: new Color(0.05, 0.05, 0.05),
        nearClip: 0.01,
        farClip: 50,
        fov: 65
    });
    // The trainer exports in a small normalized scale (~1 unit spans the whole scene),
    // not real-world meters — start near the median splat position, not "eye height".
    // These are WORLD-space (camera has no parent transform), so they're tied to the
    // current worldRoot rotation in world-rotation.ts — re-tune if that rotation changes.
    camera.setLocalPosition(1.53, 0.21, 2.09);
    camera.addComponent('script');
    const cameraControls = camera.script!.create(CameraControls, {
        properties: {
            enableFly: true,
            enableOrbit: false,
            enablePan: false,
            moveSpeed: 0.7,
            focusPoint: new Vec3(-0.37, -0.09, 0.63)
        }
    });
    app.root.addChild(camera);

    const hotspotsRoot = new Entity('hotspots');
    worldRoot.addChild(hotspotsRoot);
    hotspotsRoot.addComponent('script');
    const annotationManager = hotspotsRoot.script!.create(AnnotationManager);

    const wake = setupRenderThrottle(app, canvas);

    // CPU-side copy of every splat's center, for ray-picking against the actual splat
    // surface (see raypick.ts) instead of guessing a fixed distance in front of the camera.
    const splatCenters: Float32Array = (assets.splat.resource as { centers: Float32Array }).centers;

    const initialPolygon = await resolveRoomPolygon();
    const collision = setupCollision(
        app,
        camera,
        worldRoot,
        splatCenters,
        cameraControls as unknown as { reset: (focus: Vec3, position: Vec3) => void },
        initialPolygon
    );

    return {
        app,
        worldRoot,
        hotspotsRoot,
        camera,
        annotationManager,
        wake,
        splatCenters,
        cameraControls,
        setCollisionEnabled: collision.setEnabled,
        setRoomPolygon: collision.setPolygon,
        getFloorY: collision.getFloorY
    };
}

/** Projects a RoomPolygon's local vertices into world-space (X,Z) via worldRoot's current
 * transform — recomputed whenever the polygon or worldRoot's rotation changes, so a
 * user-authored polygon stays correct even if the orientation sliders get tweaked later. */
function polygonToWorldXZ(worldRoot: Entity, polygon: RoomPolygon): [number, number][] {
    const wt = worldRoot.getWorldTransform();
    const tmp = new Vec3();
    return polygon.points.map(([x, y, z]) => {
        wt.transformPoint(tmp.set(x, y, z), tmp);
        return [tmp.x, tmp.z];
    });
}

/**
 * Keeps the camera at a fixed eye height above the floor — an "FPS shooter" camera rather
 * than a floating-head fly camera — and, for the horizontal extent, either the auto-fitted
 * rectangular wall bounds (see room-bounds.ts) or a custom user-drawn floor polygon (see
 * room-polygon.ts, polygon-2d.ts). Disabled while placing hotspots (see editor.ts) since
 * getting flush against a wall/floor surface, and adjusting height freely, matters there.
 *
 * CameraControls' fly mode still drives WASD/mouse-look normally (including whatever
 * vertical drift looking up/down or pressing Q/E would otherwise cause) — the height gets
 * pinned back to floor level every frame by writing the entity's Y directly, which is safe
 * because nothing downstream reads Y back out of the entity into the controller's internal
 * state. Horizontal wall clamping is different: that has to go through the controller's
 * reset() API (see below) so its internal target position doesn't keep pushing into the
 * wall and produce a laggy "stuck" feeling — but reset() also force-detaches/reattaches the
 * fly controller's leading target position, which erases its momentum. Doing that every
 * single frame (as a naive height clamp would, since Y drifts from pitch on nearly every
 * frame of movement) throttles WASD speed to whatever the lerp catches up to *this* frame,
 * making moveSpeed nearly irrelevant — hence the direct-write instead.
 */
/** Fixed lift above the literal floor surface for an eye-level feel (mirrors the ~12% of
 * room height the auto-fit heuristic used, but as a plain constant since a user-drawn
 * polygon's floorY comes with no matching ceiling estimate to take a fraction of). */
const EYE_CLEARANCE = 0.7;

function setupCollision(
    app: AppBase,
    camera: Entity,
    worldRoot: Entity,
    splatCenters: Float32Array,
    cameraControls: { reset: (focus: Vec3, position: Vec3) => void },
    initialPolygon: RoomPolygon | null
): {
    setEnabled: (enabled: boolean) => void;
    setPolygon: (polygon: RoomPolygon | null) => void;
    getFloorY: () => number;
} {
    let bounds = computeRoomBounds(worldRoot, splatCenters);
    let polygon = initialPolygon;
    let worldPolygon = polygon ? polygonToWorldXZ(worldRoot, polygon) : null;
    let enabled = true;
    const clampedPos = new Vec3();
    const focus = new Vec3();

    // A polygon drawn by the user carries its own self-calibrated floor height (the
    // median of where they actually clicked) — trust that over the automatic splat-density
    // estimate, which can be thrown off by how sparsely the real floor got reconstructed.
    const surfaceFloorY = () => polygon?.floorY ?? bounds.surfaceFloorY;
    const collisionFloorY = () => (polygon?.floorY !== undefined ? polygon.floorY + EYE_CLEARANCE : bounds.floorY);

    app.on('update', () => {
        if (!enabled) return;
        const p = camera.getLocalPosition();
        let x: number;
        let z: number;
        if (worldPolygon) {
            [x, z] = clampToPolygon(p.x, p.z, worldPolygon);
        } else {
            x = Math.min(Math.max(p.x, bounds.minX), bounds.maxX);
            z = Math.min(Math.max(p.z, bounds.minZ), bounds.maxZ);
        }
        const y = collisionFloorY();
        const wallClamped = x !== p.x || z !== p.z;
        if (!wallClamped) {
            if (y !== p.y) camera.setLocalPosition(p.x, y, p.z);
            return;
        }
        clampedPos.set(x, y, z);
        focus.add2(camera.forward, clampedPos);
        cameraControls.reset(focus, clampedPos);
    });

    return {
        setEnabled: (value: boolean) => {
            enabled = value;
            // Rotation sliders in edit mode can change worldRoot's orientation — refit on
            // re-enable so the bounds/polygon match whatever orientation the user left it in.
            if (enabled) {
                bounds = computeRoomBounds(worldRoot, splatCenters);
                worldPolygon = polygon ? polygonToWorldXZ(worldRoot, polygon) : null;
            }
        },
        setPolygon: (value: RoomPolygon | null) => {
            polygon = value;
            worldPolygon = polygon ? polygonToWorldXZ(worldRoot, polygon) : null;
        },
        getFloorY: surfaceFloorY
    };
}

/**
 * GSplat re-sorts and redraws every frame by default, which pegs the GPU (and fans)
 * even while the camera sits still. Only render while the user is actually flying/
 * looking around or a held movement key is down; otherwise skip frames.
 *
 * Returns a `wake()` you can call whenever something changes off-canvas (a slider drag,
 * a gizmo drag) that should also keep the view rendering for a bit — setting
 * `app.renderNextFrame` directly wouldn't stick, since the `update` handler below
 * recomputes it from the idle timer every single tick.
 */
function setupRenderThrottle(app: AppBase, canvas: HTMLCanvasElement): () => void {
    app.autoRender = false;
    const moveKeys = [KEY_W, KEY_A, KEY_S, KEY_D, KEY_Q, KEY_E];
    const idleMs = 400;
    let lastActive = performance.now();
    let dragging = false;

    const wake = () => {
        lastActive = performance.now();
    };
    canvas.addEventListener('pointerdown', () => {
        dragging = true;
        wake();
    });
    window.addEventListener('pointerup', () => {
        dragging = false;
        wake();
    });
    canvas.addEventListener('pointermove', wake);
    canvas.addEventListener('wheel', wake);
    window.addEventListener('resize', wake);
    window.addEventListener('keydown', wake);

    app.on('update', () => {
        const holdingMoveKey = moveKeys.some((k) => app.keyboard?.isPressed(k));
        if (dragging || holdingMoveKey) lastActive = performance.now();
        app.renderNextFrame = performance.now() - lastActive < idleMs;
    });
    app.renderNextFrame = true;
    return wake;
}

export { Annotation };
