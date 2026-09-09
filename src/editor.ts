import { Color, Entity, Vec3 } from 'playcanvas';
import { Annotation } from 'playcanvas/scripts/esm/annotations.mjs';
import type { SceneHandles } from './scene';
import type { Piece } from './pieces';
import { loadPieces, savePieces, exportPiecesFile, reloadFromBundled } from './pieces';
import { showPieceModal } from './modal';
import { createRepositionGizmo, type RepositionGizmo } from './gizmo';
import { loadWorldRotation, saveWorldRotation, type Rotation } from './world-rotation';
import { pickSplatSurface } from './raypick';
import { getPhotoPose } from './photo-poses';
import { getPhotoCandidates } from './photo-candidates';
import { placePieceFromPhotoClick, reprojectPointToPhoto } from './reprojection';
import { resolveRoomPolygon, saveLocalRoomPolygon, type RoomPolygon } from './room-polygon';
import { computeColumnAlignRotation, computeLevelingRotation } from './plane-fit';

const tmpForward = new Vec3();
const tmpWorldPoint = new Vec3();

function median(values: number[]): number {
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export async function setupHotspots(scene: SceneHandles): Promise<void> {
    let pieces = await loadPieces();

    let editMode = false;
    // Scene is normalized to a tiny scale (~1 unit spans the whole room) — see scene.ts.
    let placementDistance = 0.3;
    /** When set, the next clean click in the 3D view places THIS piece instead of creating a new one. */
    let armedPieceId: string | null = null;
    /** When set, a drag gizmo is fine-tuning this already-placed piece's position. */
    let repositioningId: string | null = null;
    let gizmo: RepositionGizmo | null = null;
    const hotspotEntities = new Map<string, Entity>();

    /** When true, clicks add vertices to the walkable-area boundary instead of placing a hotspot. */
    let boundaryMode = false;
    let boundaryPoints: [number, number, number][] = (await resolveRoomPolygon())?.points ?? [];
    /** Raw (unflattened) world Y of each boundary click, index-matched to boundaryPoints —
     * kept so the shared floor height (see reflattenBoundary below) can be recomputed as a
     * running median as points are added or undone, rather than trusting a single sample
     * or an unreliable splat-density estimate. */
    let boundaryRawWorldYs: number[] = boundaryPoints.map((p) => localToWorld(p).y);

    /** When set, the next clicks are collected as leveling reference points and used to
     * auto-level the scene rotation, instead of hand-tuning the Euler sliders (see
     * plane-fit.ts). 'floor' needs 3 points on a flat floor area (a plane); 'column' needs
     * 2 points along a real vertical structural column (base + top) — more reliable than
     * the floor when the room has one, since a column is guaranteed straight/plumb while a
     * real floor (and its splat reconstruction) can have genuine unevenness. */
    let levelingKind: 'floor' | 'column' | null = null;
    let levelingPoints: [number, number, number][] = [];
    const LEVELING_POINTS_NEEDED = { floor: 3, column: 2 } as const;

    const hud = document.createElement('div');
    hud.className = 'hud';
    document.getElementById('ui-root')!.appendChild(hud);

    function renderHud(): void {
        if (!editMode) {
            hud.innerHTML = '<div><kbd>WASD</kbd> move &middot; drag to look</div>';
        } else if (levelingKind) {
            const needed = LEVELING_POINTS_NEEDED[levelingKind];
            const what = levelingKind === 'floor' ? 'a flat floor area' : 'a straight vertical column (base, then top)';
            hud.innerHTML = `<div>Click ${needed} points on ${what} to level the scene (${levelingPoints.length}/${needed}) — <kbd>Esc</kbd> to cancel</div>`;
        } else if (boundaryMode) {
            hud.innerHTML = `<div>Click floor corners to outline the walkable area (${boundaryPoints.length} so far) — <kbd>Esc</kbd> to stop</div>`;
        } else if (armedPieceId) {
            const piece = pieces.find((p) => p.id === armedPieceId);
            hud.innerHTML = `<div>Click to place: <strong>${piece?.title ?? ''}</strong> (<kbd>Esc</kbd> to cancel)</div>`;
        } else {
            hud.innerHTML =
                '<div>Click directly on a piece to place a hotspot there, or pick "Place" on a piece in the list</div>';
        }
    }
    renderHud();

    const crosshair = document.createElement('div');
    crosshair.className = 'crosshair';
    crosshair.hidden = true;
    document.getElementById('ui-root')!.appendChild(crosshair);

    const referencePanel = document.createElement('div');
    referencePanel.className = 'reference-photo';
    referencePanel.hidden = true;
    referencePanel.innerHTML = `
        <button class="close-btn">✕</button>
        <img>
        <div class="caption"></div>
    `;
    (referencePanel.querySelector('.close-btn') as HTMLButtonElement).onclick = () => {
        referencePanel.hidden = true;
    };
    document.getElementById('ui-root')!.appendChild(referencePanel);

    function showReferencePhoto(piece: Piece): void {
        if (!piece.photo) return;
        (referencePanel.querySelector('img') as HTMLImageElement).src = `/photos/${piece.photo}`;
        referencePanel.querySelector('.caption')!.textContent = piece.title || '(untitled)';
        referencePanel.hidden = false;
    }

    const editorPanel = document.createElement('div');
    editorPanel.className = 'editor-panel';
    editorPanel.hidden = true;
    document.getElementById('ui-root')!.appendChild(editorPanel);

    function worldToLocal(worldPoint: Vec3): [number, number, number] {
        const local = scene.hotspotsRoot.getWorldTransform().clone().invert().transformPoint(worldPoint);
        return [local.x, local.y, local.z];
    }

    // photo-poses.json stores camera poses in hotspotsRoot-local space (same space as
    // piece positions), but CameraControls.reset() sets the camera — a child of app.root,
    // not worldRoot — in world space. Must apply worldRoot's rotation before using them.
    function localToWorld(local: [number, number, number]): Vec3 {
        return scene.hotspotsRoot.getWorldTransform().transformPoint(new Vec3(...local));
    }

    // Visualize the (in-progress or saved) walkable-area boundary as a line loop while in
    // edit mode. Immediate-mode lines are cleared every frame, so this must redraw each tick.
    const boundaryLineColor = new Color(1, 0.8, 0, 1);
    scene.app.on('update', () => {
        if (!editMode || boundaryPoints.length < 2) return;
        for (let i = 0; i < boundaryPoints.length - 1; i++) {
            scene.app.drawLine(localToWorld(boundaryPoints[i]), localToWorld(boundaryPoints[i + 1]), boundaryLineColor, false);
        }
        if (boundaryPoints.length >= 3) {
            scene.app.drawLine(
                localToWorld(boundaryPoints[boundaryPoints.length - 1]),
                localToWorld(boundaryPoints[0]),
                boundaryLineColor,
                false
            );
        }
    });

    // Keeps every boundary vertex on one shared, flat floor height — the median of where
    // each point was actually clicked — instead of an unreliable global splat-density
    // estimate. XZ is left exactly where the user aimed; only Y is normalized.
    function reflattenBoundary(): void {
        if (boundaryRawWorldYs.length === 0) return;
        const flatY = median(boundaryRawWorldYs);
        boundaryPoints = boundaryPoints.map((p) => {
            tmpWorldPoint.copy(localToWorld(p));
            tmpWorldPoint.y = flatY;
            return worldToLocal(tmpWorldPoint);
        });
    }

    function renderBoundaryUI(): void {
        const countEl = editorPanel.querySelector('.boundary-count');
        if (countEl) countEl.textContent = String(boundaryPoints.length);
        const toggleBtn = editorPanel.querySelector('.f-boundary-toggle') as HTMLButtonElement | null;
        if (toggleBtn) {
            toggleBtn.textContent = boundaryMode ? 'Stop outlining' : 'Edit room boundary';
            toggleBtn.classList.toggle('primary', boundaryMode);
        }
        const saveBtn = editorPanel.querySelector('.f-boundary-save') as HTMLButtonElement | null;
        if (saveBtn) saveBtn.disabled = boundaryPoints.length < 3;
        const copyBtn = editorPanel.querySelector('.f-boundary-copy') as HTMLButtonElement | null;
        if (copyBtn) copyBtn.disabled = boundaryPoints.length < 3;
    }

    function setBoundaryMode(on: boolean): void {
        boundaryMode = on;
        if (on) {
            armedPieceId = null;
            levelingKind = null;
            levelingPoints = [];
            closeForm();
        }
        renderHud();
        renderBoundaryUI();
        renderLevelingUI();
    }

    function renderLevelingUI(): void {
        const floorBtn = editorPanel.querySelector('.f-level-floor') as HTMLButtonElement | null;
        const columnBtn = editorPanel.querySelector('.f-level-column') as HTMLButtonElement | null;
        if (floorBtn) {
            floorBtn.textContent =
                levelingKind === 'floor' ? `Click floor (${levelingPoints.length}/3)` : 'Level via floor (3-point)';
            floorBtn.classList.toggle('primary', levelingKind === 'floor');
        }
        if (columnBtn) {
            columnBtn.textContent =
                levelingKind === 'column' ? `Click column (${levelingPoints.length}/2)` : 'Level via column (2-point)';
            columnBtn.classList.toggle('primary', levelingKind === 'column');
        }
    }

    function setLevelingMode(kind: 'floor' | 'column' | null): void {
        levelingKind = kind;
        levelingPoints = [];
        if (kind) {
            armedPieceId = null;
            boundaryMode = false;
            closeForm();
        }
        renderHud();
        renderLevelingUI();
    }

    function createHotspotEntity(piece: Piece): void {
        if (!piece.position) return;
        const entity = new Entity(piece.id);
        entity.setLocalPosition(piece.position[0], piece.position[1], piece.position[2]);
        entity.addComponent('script');
        const annotation = entity.script!.create(Annotation, {
            properties: {
                label: '',
                title: piece.title || '(untitled)',
                text: piece.artist ? `by ${piece.artist}` : ''
            }
        });
        annotation!.on('show', () => showPieceModal(piece));
        scene.hotspotsRoot.addChild(entity);
        hotspotEntities.set(piece.id, entity);
    }

    function removeHotspotEntity(id: string): void {
        const entity = hotspotEntities.get(id);
        entity?.destroy();
        hotspotEntities.delete(id);
    }

    function stopReposition(): void {
        gizmo?.destroy();
        gizmo = null;
        repositioningId = null;
    }

    function toggleReposition(piece: Piece): void {
        if (repositioningId === piece.id) {
            stopReposition();
            persist();
            return;
        }
        stopReposition();
        repositioningId = piece.id;
        gizmo = createRepositionGizmo(
            scene,
            () => piece.position!,
            (newPos) => {
                piece.position = newPos;
                hotspotEntities.get(piece.id)?.setLocalPosition(newPos[0], newPos[1], newPos[2]);
            }
        );
        renderList();
    }

    function rebuildAllHotspots(): void {
        hotspotEntities.forEach((entity) => entity.destroy());
        hotspotEntities.clear();
        pieces.filter((p) => p.position).forEach(createHotspotEntity);
    }

    rebuildAllHotspots();

    function persist(): void {
        savePieces(pieces);
        renderList();
    }

    function renderList(): void {
        const unplacedList = editorPanel.querySelector('.unplaced-list');
        const placedList = editorPanel.querySelector('.placed-list');
        const unplacedCount = editorPanel.querySelector('.unplaced-count');
        const placedCount = editorPanel.querySelector('.placed-count');
        if (!unplacedList || !placedList) return;

        const unplaced = pieces.filter((p) => !p.position);
        const placed = pieces.filter((p) => p.position);
        if (unplacedCount) unplacedCount.textContent = String(unplaced.length);
        if (placedCount) placedCount.textContent = String(placed.length);

        unplacedList.innerHTML = '';
        unplaced.forEach((piece) => {
            const li = document.createElement('li');
            const label = document.createElement('span');
            label.textContent = piece.title || '(untitled)';
            if (piece.photo) {
                label.className = 'has-photo';
                label.onclick = () => showReferencePhoto(piece);
            }
            li.appendChild(label);

            const btns = document.createElement('span');
            if (piece.photo) {
                const jumpBtn = document.createElement('button');
                jumpBtn.textContent = 'Jump here';
                jumpBtn.title = 'Fly to roughly where this photo was taken (approximate — derived from your placements)';
                jumpBtn.onclick = async () => {
                    const pose = await getPhotoPose(piece.photo!);
                    if (!pose) {
                        jumpBtn.textContent = 'No estimate';
                        setTimeout(() => (jumpBtn.textContent = 'Jump here'), 1500);
                        return;
                    }
                    const cameraControls = scene.cameraControls as { reset: (focus: Vec3, position: Vec3) => void };
                    cameraControls.reset(localToWorld(pose.focus), localToWorld(pose.position));
                    // reset() eases the camera in over ~1-2s (damped fly), not an instant
                    // teleport — keep the render-throttle awake for the whole flight, or the
                    // view freezes mid-flight and only snaps to the end once the user next
                    // interacts (see setupRenderThrottle in scene.ts).
                    const flightStart = performance.now();
                    const keepAwake = () => {
                        scene.wake();
                        if (performance.now() - flightStart < 2000) requestAnimationFrame(keepAwake);
                    };
                    keepAwake();
                };
                btns.appendChild(jumpBtn);
            }
            const placeBtn = document.createElement('button');
            placeBtn.textContent = armedPieceId === piece.id ? 'Click scene…' : 'Place';
            placeBtn.className = armedPieceId === piece.id ? 'primary' : '';
            placeBtn.onclick = () => {
                armedPieceId = armedPieceId === piece.id ? null : piece.id;
                if (armedPieceId) {
                    boundaryMode = false;
                    levelingKind = null;
                    levelingPoints = [];
                    renderBoundaryUI();
                    renderLevelingUI();
                    showReferencePhoto(piece);
                }
                renderHud();
                renderList();
            };
            if (piece.photo) {
                const photoPlaceBtn = document.createElement('button');
                photoPlaceBtn.textContent = 'Place from photo';
                photoPlaceBtn.title = 'Draw a box around this piece on its assigned photo instead of clicking in the 3D view';
                photoPlaceBtn.onclick = () => openForm(piece);
                btns.appendChild(photoPlaceBtn);
            }
            const delBtn = document.createElement('button');
            delBtn.textContent = 'Delete';
            delBtn.onclick = () => {
                pieces = pieces.filter((p) => p.id !== piece.id);
                if (armedPieceId === piece.id) armedPieceId = null;
                persist();
                renderHud();
            };
            btns.appendChild(placeBtn);
            btns.appendChild(delBtn);
            li.appendChild(btns);
            unplacedList.appendChild(li);
        });

        placedList.innerHTML = '';
        placed.forEach((piece) => {
            const li = document.createElement('li');
            const label = document.createElement('span');
            label.textContent = piece.title || '(untitled)';
            if (piece.photo) {
                label.className = 'has-photo';
                label.onclick = () => showReferencePhoto(piece);
            }
            li.appendChild(label);

            const btns = document.createElement('span');
            const moveBtn = document.createElement('button');
            moveBtn.textContent = repositioningId === piece.id ? 'Done' : 'Move';
            moveBtn.className = repositioningId === piece.id ? 'primary' : '';
            moveBtn.onclick = () => toggleReposition(piece);
            const editBtn = document.createElement('button');
            editBtn.textContent = 'Edit';
            editBtn.onclick = () => openForm(piece);
            const unplaceBtn = document.createElement('button');
            unplaceBtn.textContent = 'Unplace';
            unplaceBtn.title = 'Remove the hotspot but keep this piece in the catalog to place again later';
            unplaceBtn.onclick = () => {
                if (repositioningId === piece.id) stopReposition();
                removeHotspotEntity(piece.id);
                piece.position = undefined;
                persist();
            };
            btns.appendChild(moveBtn);
            btns.appendChild(editBtn);
            btns.appendChild(unplaceBtn);
            li.appendChild(btns);
            placedList.appendChild(li);
        });
    }

    let pendingForm: HTMLElement | null = null;

    function closeForm(): void {
        pendingForm?.remove();
        pendingForm = null;
    }

    function openForm(existing: Piece | null, position?: [number, number, number]): void {
        closeForm();

        const form = document.createElement('div');
        form.innerHTML = `
            <h3>${existing ? 'Edit piece' : 'New piece'}</h3>
            <label>Title</label>
            <input type="text" class="f-title" value="${existing?.title ?? ''}">
            <label>Artist</label>
            <input type="text" class="f-artist" value="${existing?.artist ?? ''}">
            <label>Hometown</label>
            <input type="text" class="f-hometown" value="${existing?.hometown ?? ''}">
            <label>Ribbon (optional)</label>
            <input type="text" class="f-ribbon" placeholder="e.g. First Premium, Class 3" value="${existing?.ribbon ?? ''}">
            <label>Description</label>
            <textarea class="f-desc">${existing?.description ?? ''}</textarea>
            <label>Photo filename (place file in public/photos/)</label>
            <input type="text" class="f-photo" placeholder="e.g. loon.jpg" value="${existing?.photo ?? ''}">
            <div class="editor-hint">Pick a file to preview it below (you still need to copy it into public/photos/ yourself).</div>
            <input type="file" class="f-photo-preview" accept="image/*">
            <img class="f-preview-img" style="max-width:100%;margin-top:8px;display:none;">
            ${existing ? `
            <div class="photo-picker" hidden>
                <label>Photo candidates (nearby camera positions)</label>
                <div class="candidate-nav">
                    <button type="button" class="f-cand-prev">&#9664; Prev</button>
                    <span class="cand-counter"></span>
                    <button type="button" class="f-cand-next">Next &#9654;</button>
                </div>
                <div class="crop-wrap">
                    <img class="candidate-preview-img">
                    <div class="crop-box" hidden></div>
                    <div class="reproj-marker" hidden></div>
                </div>
                <div class="editor-hint f-crop-hint">Drag on the photo above to draw a crop — that's what visitors will see in the detail popup instead of the full frame.</div>
                <div class="place-status"></div>
                <div>
                    <button type="button" class="f-use-photo">Use this photo</button>
                    <button type="button" class="primary f-save-crop">Save crop</button>
                    <button type="button" class="f-clear-crop">Clear crop</button>
                </div>
            </div>
            ` : ''}
            <div>
                <button class="primary f-save">${existing ? 'Save' : 'Add'}</button>
                <button class="f-cancel">Cancel</button>
            </div>
        `;
        form.style.marginTop = '12px';
        form.style.borderTop = '1px solid #333';
        form.style.paddingTop = '12px';

        const previewImg = form.querySelector('.f-preview-img') as HTMLImageElement;
        const photoInput = form.querySelector('.f-photo') as HTMLInputElement;
        const filePicker = form.querySelector('.f-photo-preview') as HTMLInputElement;
        filePicker.addEventListener('change', () => {
            const file = filePicker.files?.[0];
            if (!file) return;
            if (!photoInput.value) photoInput.value = file.name;
            previewImg.src = URL.createObjectURL(file);
            previewImg.style.display = 'block';
        });

        if (existing) {
            const pickerPanel = form.querySelector('.photo-picker') as HTMLDivElement;
            const wrap = form.querySelector('.crop-wrap') as HTMLDivElement;
            const candidateImg = form.querySelector('.candidate-preview-img') as HTMLImageElement;
            const cropBox = form.querySelector('.crop-box') as HTMLDivElement;
            const reprojMarker = form.querySelector('.reproj-marker') as HTMLDivElement;
            const cropHint = form.querySelector('.f-crop-hint') as HTMLDivElement;
            const placeStatus = form.querySelector('.place-status') as HTMLDivElement;
            const counterEl = form.querySelector('.cand-counter') as HTMLElement;
            const prevBtn = form.querySelector('.f-cand-prev') as HTMLButtonElement;
            const nextBtn = form.querySelector('.f-cand-next') as HTMLButtonElement;
            const useBtn = form.querySelector('.f-use-photo') as HTMLButtonElement;
            const saveCropBtn = form.querySelector('.f-save-crop') as HTMLButtonElement;
            const clearCropBtn = form.querySelector('.f-clear-crop') as HTMLButtonElement;

            // Unplaced pieces reuse this same panel to get their first position (see
            // renderList's "Place from photo" button) — draw a box around the art here
            // instead of hunting for it in the live 3D view. Once placed, this collapses
            // back into an ordinary crop-drawing panel like any other piece's.
            function updatePlacementLabels(): void {
                if (existing!.position) {
                    saveCropBtn.textContent = 'Save crop';
                    cropHint.textContent =
                        "Drag on the photo above to draw a crop — that's what visitors will see in the detail popup instead of the full frame.";
                } else {
                    saveCropBtn.textContent = 'Place here';
                    cropHint.textContent =
                        'Drag a box around the piece in the photo above, then "Place here" to both position it in the 3D scene and set its crop.';
                }
            }
            updatePlacementLabels();

            // Seed with the piece's currently-assigned photo (if any) so it's always
            // browsable even before/if the async candidate list resolves; getPhotoCandidates
            // results are merged in below, nearest-first, skipping this duplicate.
            let candidateList: string[] = existing.photo ? [existing.photo] : [];
            let previewIndex = 0;
            /** Normalized [x,y,w,h] currently shown in the overlay, pending "Save crop". */
            let drawnRect: [number, number, number, number] | null = null;

            function setOverlayRect(rect: [number, number, number, number] | null): void {
                drawnRect = rect;
                if (!rect) {
                    cropBox.hidden = true;
                    return;
                }
                const [x, y, w, h] = rect;
                cropBox.hidden = false;
                cropBox.style.left = `${x * 100}%`;
                cropBox.style.top = `${y * 100}%`;
                cropBox.style.width = `${w * 100}%`;
                cropBox.style.height = `${h * 100}%`;
            }

            // Once the piece has a position (already placed, or just placed via "Place
            // here" below), overlay a dot showing where it should reproject onto whichever
            // candidate photo is currently previewed — a COLMAP-calibrated cross-check that
            // this really is a photo of the same piece, and a way to spot a bad/occluded
            // canonical photo without redrawing a crop on every candidate by hand.
            let reprojToken = 0;
            function updateReprojMarker(filename: string): void {
                if (!existing!.position) {
                    reprojMarker.hidden = true;
                    return;
                }
                const token = ++reprojToken;
                const worldPoint = new Vec3(...existing!.position);
                reprojectPointToPhoto(filename, worldPoint).then((hit) => {
                    if (token !== reprojToken) return; // a newer candidate was selected meanwhile
                    if (!hit) {
                        reprojMarker.hidden = true;
                        return;
                    }
                    reprojMarker.hidden = false;
                    reprojMarker.style.left = `${hit.u01 * 100}%`;
                    reprojMarker.style.top = `${hit.v01 * 100}%`;
                });
            }

            function renderCandidate(): void {
                if (candidateList.length === 0) {
                    pickerPanel.hidden = true;
                    return;
                }
                pickerPanel.hidden = false;
                const filename = candidateList[previewIndex];
                candidateImg.src = `/photos/${filename}`;
                counterEl.textContent = `${previewIndex + 1} / ${candidateList.length}`;
                prevBtn.disabled = candidateList.length < 2;
                nextBtn.disabled = candidateList.length < 2;
                // Only show a rectangle when previewing the piece's actual saved photo —
                // otherwise start blank so a drawn rect never gets misattributed.
                if (filename === existing!.photo && existing!.photoCrop) {
                    setOverlayRect(existing!.photoCrop);
                } else {
                    setOverlayRect(null);
                }
                updateReprojMarker(filename);
            }
            renderCandidate();

            getPhotoCandidates(existing.id).then((candidates) => {
                const merged = [...candidateList];
                for (const c of candidates) {
                    if (!merged.includes(c)) merged.push(c);
                }
                candidateList = merged;
                renderCandidate();
            });

            prevBtn.onclick = () => {
                previewIndex = (previewIndex - 1 + candidateList.length) % candidateList.length;
                renderCandidate();
            };
            nextBtn.onclick = () => {
                previewIndex = (previewIndex + 1) % candidateList.length;
                renderCandidate();
            };
            useBtn.onclick = () => {
                photoInput.value = candidateList[previewIndex];
                setOverlayRect(null);
            };

            let dragStart: { x: number; y: number } | null = null;
            const fractionFromEvent = (e: PointerEvent): { x: number; y: number } => {
                const rect = wrap.getBoundingClientRect();
                return {
                    x: Math.min(Math.max((e.clientX - rect.left) / rect.width, 0), 1),
                    y: Math.min(Math.max((e.clientY - rect.top) / rect.height, 0), 1)
                };
            };
            wrap.addEventListener('pointerdown', (e) => {
                dragStart = fractionFromEvent(e);
                wrap.setPointerCapture(e.pointerId);
            });
            wrap.addEventListener('pointermove', (e) => {
                if (!dragStart) return;
                const cur = fractionFromEvent(e);
                const x = Math.min(dragStart.x, cur.x);
                const y = Math.min(dragStart.y, cur.y);
                const w = Math.abs(cur.x - dragStart.x);
                const h = Math.abs(cur.y - dragStart.y);
                setOverlayRect([x, y, w, h]);
            });
            wrap.addEventListener('pointerup', () => {
                dragStart = null;
            });

            saveCropBtn.onclick = async () => {
                if (!drawnRect || drawnRect[2] < 0.02 || drawnRect[3] < 0.02) return;
                const filename = candidateList[previewIndex];

                if (!existing.position) {
                    const [x, y, w, h] = drawnRect;
                    const u01 = x + w / 2;
                    const v01 = y + h / 2;
                    saveCropBtn.disabled = true;
                    placeStatus.textContent = 'Placing…';
                    const worldPos = await placePieceFromPhotoClick(scene, filename, u01, v01);
                    saveCropBtn.disabled = false;
                    if (!worldPos) {
                        placeStatus.textContent =
                            "Couldn't place this — either this photo has no COLMAP calibration, or the box center doesn't land on any splat. Try a different box or candidate photo.";
                        return;
                    }
                    existing.position = [worldPos.x, worldPos.y, worldPos.z];
                    placeStatus.textContent = '';
                    updatePlacementLabels();
                    renderHud();
                    renderList();
                }

                photoInput.value = filename;
                existing.photo = filename;
                existing.photoCrop = drawnRect;
                removeHotspotEntity(existing.id);
                createHotspotEntity(existing);
                persist();
                updateReprojMarker(filename);
            };
            clearCropBtn.onclick = () => {
                setOverlayRect(null);
                if (candidateList[previewIndex] === existing.photo && existing.photoCrop) {
                    existing.photoCrop = undefined;
                    persist();
                }
            };
        }

        (form.querySelector('.f-cancel') as HTMLButtonElement).onclick = () => closeForm();
        (form.querySelector('.f-save') as HTMLButtonElement).onclick = () => {
            const title = (form.querySelector('.f-title') as HTMLInputElement).value.trim();
            const artist = (form.querySelector('.f-artist') as HTMLInputElement).value.trim();
            const hometown = (form.querySelector('.f-hometown') as HTMLInputElement).value.trim();
            const ribbon = (form.querySelector('.f-ribbon') as HTMLInputElement).value.trim();
            const description = (form.querySelector('.f-desc') as HTMLTextAreaElement).value.trim();
            const photo = photoInput.value.trim();

            if (existing) {
                const newPhoto = photo || undefined;
                // A crop rectangle is only meaningful against the photo it was drawn on —
                // if the filename changed by any path (typed, file picker, or the
                // candidate picker's "Use this photo"), drop the stale crop.
                if (newPhoto !== existing.photo) existing.photoCrop = undefined;
                existing.title = title;
                existing.artist = artist || undefined;
                existing.hometown = hometown || undefined;
                existing.ribbon = ribbon || undefined;
                existing.description = description || undefined;
                existing.photo = newPhoto;
                removeHotspotEntity(existing.id);
                createHotspotEntity(existing);
            } else if (position) {
                const piece: Piece = {
                    id: crypto.randomUUID(),
                    title: title || 'Untitled piece',
                    artist: artist || undefined,
                    hometown: hometown || undefined,
                    ribbon: ribbon || undefined,
                    description: description || undefined,
                    photo: photo || undefined,
                    position
                };
                pieces.push(piece);
                createHotspotEntity(piece);
            }
            persist();
            closeForm();
        };

        editorPanel.appendChild(form);
        form.scrollIntoView({ block: 'start' });
        pendingForm = form;
        form.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }

    editorPanel.innerHTML = `
        <h3>Hotspot editor</h3>
        <h4>Scene rotation</h4>
        <div class="editor-hint">Tilt to fix orientation. Values persist locally — copy them for me to bake in permanently.</div>
        <div class="rot-row"><label>X</label><input type="range" class="rot-x" min="-180" max="180" step="0.5"><span class="rot-x-val"></span></div>
        <div class="rot-row"><label>Y</label><input type="range" class="rot-y" min="-180" max="180" step="0.5"><span class="rot-y-val"></span></div>
        <div class="rot-row"><label>Z</label><input type="range" class="rot-z" min="-180" max="180" step="0.5"><span class="rot-z-val"></span></div>
        <button class="f-copy-rotation">Copy rotation values</button>
        <div class="editor-hint">Sliders are fiddly to get perfectly flat. Instead, aim the crosshair at 3 points on an
            obviously flat part of the floor and click each — the exact tilt gets computed from those points.</div>
        <button class="f-level-floor">Level via floor (3-point)</button>
        <div class="editor-hint">A real floor can have genuine unevenness the splat then reconstructs faithfully, which
            throws off floor-based leveling. If the room has a straight structural column, this is more reliable: aim the
            crosshair at its base and click, then <strong>rotate the view (drag) to aim at a point near its top</strong>
            and click again — like the floor tool, position on screen doesn't matter, only where the crosshair is
            pointing when you click.</div>
        <button class="f-level-column">Level via column (2-point)</button>
        <h4>Room boundary</h4>
        <div class="editor-hint">
            By default the camera is kept inside a rectangle auto-fitted to the splat, which can be too generous
            (lets you fly outside the actual walls). Outline the real walkable floor area instead: aim the crosshair
            at a floor corner and click to drop each vertex in order around the perimeter.
        </div>
        <div class="editor-hint"><span class="boundary-count">0</span> point(s) placed.</div>
        <button class="f-boundary-toggle">Edit room boundary</button>
        <button class="f-boundary-undo">Undo last point</button>
        <button class="primary f-boundary-save">Save boundary</button>
        <button class="f-boundary-clear">Clear (use rectangle)</button>
        <div class="editor-hint">Saved boundaries only apply in your own browser. Once it looks right, click below and send me the copied JSON to make it the default for everyone.</div>
        <button class="f-boundary-copy">Copy boundary JSON</button>
        <h4>To place (<span class="unplaced-count">0</span>)</h4>
        <div class="editor-hint">Click directly on a piece to place a hotspot on it. If the click misses every splat (e.g. open air), it falls back to <kbd>[</kbd>/<kbd>]</kbd>-adjustable distance (currently <span class="dist">0.30</span>). Click a title to preview its photo. Or use "Place from photo" to draw a box around the piece on its assigned photo instead — no need to find it in the 3D view first.</div>
        <button class="primary f-next-unplaced">Next unplaced &#8594;</button>
        <ul class="unplaced-list"></ul>
        <h4>Placed (<span class="placed-count">0</span>)</h4>
        <div class="editor-hint">"Move" shows drag handles (red=X, green=Y, blue=Z) to fine-tune position.</div>
        <ul class="placed-list"></ul>
        <button class="primary f-export">Export pieces.json</button>
        <button class="f-reload">Reload from pieces.json</button>
    `;
    (editorPanel.querySelector('.f-level-floor') as HTMLButtonElement).onclick = () =>
        setLevelingMode(levelingKind === 'floor' ? null : 'floor');
    (editorPanel.querySelector('.f-level-column') as HTMLButtonElement).onclick = () =>
        setLevelingMode(levelingKind === 'column' ? null : 'column');
    (editorPanel.querySelector('.f-boundary-toggle') as HTMLButtonElement).onclick = () => setBoundaryMode(!boundaryMode);
    (editorPanel.querySelector('.f-boundary-undo') as HTMLButtonElement).onclick = () => {
        boundaryPoints.pop();
        boundaryRawWorldYs.pop();
        reflattenBoundary();
        renderBoundaryUI();
    };
    (editorPanel.querySelector('.f-boundary-save') as HTMLButtonElement).onclick = () => {
        const polygon: RoomPolygon = { points: boundaryPoints, floorY: median(boundaryRawWorldYs) };
        saveLocalRoomPolygon(polygon);
        scene.setRoomPolygon(polygon);
        setBoundaryMode(false);
    };
    (editorPanel.querySelector('.f-boundary-clear') as HTMLButtonElement).onclick = () => {
        if (!confirm('Discard the custom boundary and go back to the auto-fitted rectangle?')) return;
        boundaryPoints = [];
        boundaryRawWorldYs = [];
        saveLocalRoomPolygon(null);
        scene.setRoomPolygon(null);
        setBoundaryMode(false);
    };
    (editorPanel.querySelector('.f-boundary-copy') as HTMLButtonElement).onclick = () => {
        const polygon: RoomPolygon = { points: boundaryPoints, floorY: median(boundaryRawWorldYs) };
        navigator.clipboard?.writeText(JSON.stringify(polygon));
    };
    renderBoundaryUI();
    renderLevelingUI();

    (editorPanel.querySelector('.f-next-unplaced') as HTMLButtonElement).onclick = () => {
        // Recomputed fresh each click (rather than tracking a stored index) since the
        // unplaced list shrinks as pieces get placed via this same flow.
        const next = pieces.find((p) => !p.position);
        if (!next) return;
        openForm(next);
    };
    (editorPanel.querySelector('.f-export') as HTMLButtonElement).onclick = () => exportPiecesFile(pieces);
    (editorPanel.querySelector('.f-reload') as HTMLButtonElement).onclick = async () => {
        if (!confirm('Discard local edits and reload public/data/pieces.json?')) return;
        pieces = await reloadFromBundled();
        armedPieceId = null;
        rebuildAllHotspots();
        renderHud();
        renderList();
    };

    const rotXInput = editorPanel.querySelector('.rot-x') as HTMLInputElement;
    const rotYInput = editorPanel.querySelector('.rot-y') as HTMLInputElement;
    const rotZInput = editorPanel.querySelector('.rot-z') as HTMLInputElement;
    const rotXVal = editorPanel.querySelector('.rot-x-val')!;
    const rotYVal = editorPanel.querySelector('.rot-y-val')!;
    const rotZVal = editorPanel.querySelector('.rot-z-val')!;

    function applyRotation(r: Rotation): void {
        scene.worldRoot.setLocalEulerAngles(r[0], r[1], r[2]);
        // Dragging a <input type="range"> doesn't touch the canvas or window listeners
        // the render-throttle wakes on, so without this the change looks frozen.
        scene.wake();
        rotXInput.value = String(r[0]);
        rotYInput.value = String(r[1]);
        rotZInput.value = String(r[2]);
        rotXVal.textContent = r[0].toFixed(1);
        rotYVal.textContent = r[1].toFixed(1);
        rotZVal.textContent = r[2].toFixed(1);
        saveWorldRotation(r);
    }
    applyRotation(loadWorldRotation());
    const onRotInput = () => applyRotation([Number(rotXInput.value), Number(rotYInput.value), Number(rotZInput.value)]);
    rotXInput.addEventListener('input', onRotInput);
    rotYInput.addEventListener('input', onRotInput);
    rotZInput.addEventListener('input', onRotInput);
    (editorPanel.querySelector('.f-copy-rotation') as HTMLButtonElement).onclick = () => {
        const text = `${rotXInput.value}, ${rotYInput.value}, ${rotZInput.value}`;
        navigator.clipboard?.writeText(text);
    };

    renderList();

    function setEditMode(on: boolean): void {
        editMode = on;
        crosshair.hidden = !on;
        editorPanel.hidden = !on;
        document.body.classList.toggle('edit-mode', on);
        scene.setCollisionEnabled(!on);
        if (!on) {
            armedPieceId = null;
            boundaryMode = false;
            levelingKind = null;
            levelingPoints = [];
            closeForm();
            stopReposition();
        }
        renderHud();
        renderList();
    }

    window.addEventListener('keydown', (e) => {
        if (e.key === 'F2') {
            setEditMode(!editMode);
        } else if (editMode && e.key === '[') {
            placementDistance = Math.max(0.05, placementDistance - 0.05);
            editorPanel.querySelector('.dist')!.textContent = placementDistance.toFixed(2);
        } else if (editMode && e.key === ']') {
            placementDistance += 0.05;
            editorPanel.querySelector('.dist')!.textContent = placementDistance.toFixed(2);
        } else if (e.key === 'Escape') {
            if (pendingForm) closeForm();
            else if (levelingKind) {
                setLevelingMode(null);
            } else if (boundaryMode) {
                setBoundaryMode(false);
            } else if (armedPieceId) {
                armedPieceId = null;
                renderHud();
                renderList();
            }
        }
    });

    // Only treat a mousedown->mouseup with minimal movement as a "click" — a fly-camera
    // drag-to-look gesture should never accidentally drop a hotspot.
    const canvas = scene.app.graphicsDevice.canvas as HTMLCanvasElement;
    let downPos: { x: number; y: number } | null = null;
    canvas.addEventListener('pointerdown', (e) => {
        downPos = { x: e.clientX, y: e.clientY };
    });
    canvas.addEventListener('pointerup', (e) => {
        if (!editMode || !downPos) {
            downPos = null;
            return;
        }
        const dx = e.clientX - downPos.x;
        const dy = e.clientY - downPos.y;
        downPos = null;
        if (Math.hypot(dx, dy) > 5) return;

        scene.camera.getWorldTransform().transformVector(new Vec3(0, 0, -1), tmpForward);
        tmpForward.normalize();

        // Try to land exactly on the splat surface under the cursor; only fall back to a
        // fixed guessed distance if the ray doesn't pass near any splat (e.g. clicked the sky).
        const invWorldRoot = scene.worldRoot.getWorldTransform().clone().invert();
        const localOrigin = invWorldRoot.transformPoint(scene.camera.getPosition());
        const localDir = new Vec3();
        invWorldRoot.transformVector(tmpForward, localDir);
        localDir.normalize();
        const canvasHeight = canvas.clientHeight;
        const picked = pickSplatSurface(
            scene.splatCenters,
            localOrigin,
            localDir,
            scene.camera.camera!.projectionMatrix.data[5],
            canvasHeight
        );

        let position: [number, number, number];
        if (picked) {
            position = [picked.x, picked.y, picked.z];
        } else {
            tmpWorldPoint.copy(scene.camera.getPosition()).add(tmpForward.mulScalar(placementDistance));
            position = worldToLocal(tmpWorldPoint);
        }

        if (levelingKind) {
            levelingPoints.push(position);
            if (levelingPoints.length === LEVELING_POINTS_NEEDED[levelingKind]) {
                // Points are in splat-native local space (unaffected by the current
                // rotation — see localToWorld/worldToLocal above), so this fully replaces
                // the old rotation rather than composing with it.
                let q;
                if (levelingKind === 'floor') {
                    // A floor plane's normal is direction-ambiguous (cross product could
                    // point either way) — disambiguate against the CURRENT rotation's
                    // notion of "up". This has no bearing on the computed tilt itself.
                    const upHintLocal = new Vec3();
                    invWorldRoot.transformVector(new Vec3(0, 1, 0), upHintLocal);
                    q = computeLevelingRotation(
                        new Vec3(...levelingPoints[0]),
                        new Vec3(...levelingPoints[1]),
                        new Vec3(...levelingPoints[2]),
                        upHintLocal
                    );
                } else {
                    // Clicking base-then-top already unambiguously says which way is up —
                    // no hint needed, and using one here could flip a correct result (see
                    // computeColumnAlignRotation's own comment).
                    q = computeColumnAlignRotation(new Vec3(...levelingPoints[0]), new Vec3(...levelingPoints[1]));
                }
                const euler = q.getEulerAngles();
                applyRotation([euler.x, euler.y, euler.z]);
                setLevelingMode(null);
            } else {
                renderHud();
                renderLevelingUI();
            }
        } else if (boundaryMode) {
            // Trust the user's own aim for where the floor is (they're clicking directly
            // on it) rather than an automatic splat-density estimate — just keep every
            // vertex flat at the running median height of all the clicks so far.
            boundaryPoints.push(position);
            boundaryRawWorldYs.push(localToWorld(position).y);
            reflattenBoundary();
            renderHud();
            renderBoundaryUI();
        } else if (armedPieceId) {
            const piece = pieces.find((p) => p.id === armedPieceId);
            if (piece) {
                piece.position = position;
                createHotspotEntity(piece);
                persist();
            }
            armedPieceId = null;
            renderHud();
        } else {
            openForm(null, position);
        }
    });
}
