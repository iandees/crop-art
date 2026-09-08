import { Vec3 } from 'playcanvas';
import type { SceneHandles } from './scene';

const AXES = [
    { key: 'x', color: '#ff5555', dir: new Vec3(1, 0, 0) },
    { key: 'y', color: '#55ff55', dir: new Vec3(0, 1, 0) },
    { key: 'z', color: '#5599ff', dir: new Vec3(0, 0, 1) }
] as const;

const ARM_LENGTH = 0.12;
const PROBE_DISTANCE = 0.05;

export interface RepositionGizmo {
    destroy(): void;
}

/**
 * Three draggable screen-space handles (one per local axis of hotspotsRoot) that let you
 * fine-tune a placed piece's position by eye, instead of re-clicking the crosshair.
 */
export function createRepositionGizmo(
    scene: SceneHandles,
    getLocalPosition: () => [number, number, number],
    onMove: (newLocalPosition: [number, number, number]) => void
): RepositionGizmo {
    const root = document.getElementById('ui-root')!;
    const handles = AXES.map((axis) => {
        const el = document.createElement('div');
        el.className = 'gizmo-handle';
        el.style.background = axis.color;
        root.appendChild(el);
        const line = document.createElement('div');
        line.className = 'gizmo-line';
        line.style.background = axis.color;
        root.appendChild(line);
        return { axis, el, line };
    });

    let dragging: {
        axis: (typeof AXES)[number];
        startMouse: { x: number; y: number };
        startWorldPos: Vec3;
        screenDir: { x: number; y: number };
        pixelsPerWorldUnit: number;
    } | null = null;

    function worldOf(localPos: [number, number, number]): Vec3 {
        return scene.hotspotsRoot.getWorldTransform().transformPoint(new Vec3(...localPos));
    }
    function localOf(worldPos: Vec3): [number, number, number] {
        const local = scene.hotspotsRoot.getWorldTransform().clone().invert().transformPoint(worldPos);
        return [local.x, local.y, local.z];
    }
    function axisWorldDir(localDir: Vec3): Vec3 {
        const transform = scene.hotspotsRoot.getWorldTransform();
        const origin = transform.transformPoint(new Vec3(0, 0, 0));
        const tip = transform.transformPoint(localDir.clone());
        return tip.sub(origin).normalize();
    }
    function isInFrontOfCamera(worldPos: Vec3): boolean {
        const camPos = scene.camera.getPosition();
        const forward = new Vec3();
        scene.camera.getWorldTransform().transformVector(new Vec3(0, 0, -1), forward);
        return worldPos.clone().sub(camPos).dot(forward) > 0;
    }
    function project(worldPos: Vec3): { x: number; y: number } | null {
        if (!isInFrontOfCamera(worldPos)) return null;
        const screen = scene.camera.camera!.worldToScreen(worldPos);
        return { x: screen.x, y: screen.y };
    }

    function update(): void {
        const localPos = getLocalPosition();
        const centerWorld = worldOf(localPos);
        const centerScreen = project(centerWorld);
        if (!centerScreen) {
            handles.forEach(({ el, line }) => {
                el.hidden = true;
                line.hidden = true;
            });
            return;
        }
        for (const h of handles) {
            const dir = axisWorldDir(h.axis.dir);
            const tipWorld = centerWorld.clone().add(dir.mulScalar(ARM_LENGTH));
            const tipScreen = project(tipWorld);
            if (!tipScreen) {
                h.el.hidden = true;
                h.line.hidden = true;
                continue;
            }
            h.el.hidden = false;
            h.line.hidden = false;
            h.el.style.left = `${tipScreen.x - 8}px`;
            h.el.style.top = `${tipScreen.y - 8}px`;

            const dx = tipScreen.x - centerScreen.x;
            const dy = tipScreen.y - centerScreen.y;
            const len = Math.hypot(dx, dy);
            const angle = Math.atan2(dy, dx) * (180 / Math.PI);
            h.line.style.left = `${centerScreen.x}px`;
            h.line.style.top = `${centerScreen.y}px`;
            h.line.style.width = `${len}px`;
            h.line.style.transform = `rotate(${angle}deg)`;
        }
    }

    handles.forEach((h) => {
        h.el.addEventListener('pointerdown', (e) => {
            e.stopPropagation();
            scene.wake();
            const startWorldPos = worldOf(getLocalPosition());
            const dir = axisWorldDir(h.axis.dir);
            const p0 = project(startWorldPos);
            const p1 = project(startWorldPos.clone().add(dir.clone().mulScalar(PROBE_DISTANCE)));
            if (!p0 || !p1) return;
            const screenDx = p1.x - p0.x;
            const screenDy = p1.y - p0.y;
            const screenLen = Math.hypot(screenDx, screenDy) || 1;
            dragging = {
                axis: h.axis,
                startMouse: { x: e.clientX, y: e.clientY },
                startWorldPos,
                screenDir: { x: screenDx / screenLen, y: screenDy / screenLen },
                pixelsPerWorldUnit: screenLen / PROBE_DISTANCE
            };
            (e.target as HTMLElement).setPointerCapture(e.pointerId);
        });
    });

    function onPointerMove(e: PointerEvent): void {
        if (!dragging) return;
        scene.wake();
        const dx = e.clientX - dragging.startMouse.x;
        const dy = e.clientY - dragging.startMouse.y;
        const scalarPixels = dx * dragging.screenDir.x + dy * dragging.screenDir.y;
        const worldDelta = scalarPixels / dragging.pixelsPerWorldUnit;
        const dir = axisWorldDir(dragging.axis.dir);
        const newWorldPos = dragging.startWorldPos.clone().add(dir.mulScalar(worldDelta));
        onMove(localOf(newWorldPos));
        update();
    }
    function onPointerUp(): void {
        dragging = null;
    }
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);

    scene.app.on('update', update);
    update();

    return {
        destroy() {
            scene.app.off('update', update);
            window.removeEventListener('pointermove', onPointerMove);
            window.removeEventListener('pointerup', onPointerUp);
            handles.forEach(({ el, line }) => {
                el.remove();
                line.remove();
            });
        }
    };
}
