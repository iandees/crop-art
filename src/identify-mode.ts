import { Vec3 } from 'playcanvas';
import { getAllCalibratedPhotos, getPhotoCamera } from './photo-cameras';
import { reprojectPointToPhoto, rayForInstance, triangulatePieceInstances } from './reprojection';
import { closestApproachDistance, pointToRayDistance, worldToPixel } from './colmap-math';
import { representativeAnchor, type AnnotatedPiece, type PieceInstance } from './annotated-pieces';
import { showToast } from './toast';

const SVG_NS = 'http://www.w3.org/2000/svg';
/** Scene units — see plan notes: comfortably below the measured minimum real spacing
 * (0.112) between distinct placed pieces. Used both for point-to-ray matching (once a piece
 * has a triangulated position from 2+ views) and ray-to-ray matching (a piece with just one
 * view so far) — two rays or a ray-and-point genuinely aimed at the same real point should
 * pass much closer than this. Retune here if links look wrong in practice. */
const MATCH_DISTANCE_THRESHOLD = 0.06;
/** Normalized-image-space click tolerance for "close the polygon by clicking the first vertex". */
const CLOSE_VERTEX_TOLERANCE = 0.02;
/** Along-ray sample depths (scene units) for drawing an epipolar guide line — the segment a
 * not-yet-triangulated piece's matching point must lie somewhere along, in a photo it hasn't
 * been drawn on yet. Bounds are conservative relative to the room's own measured extent
 * (x in [-3.54, 4.51], z in [-5.86, 4.94] — see README's "Scene scale" notes and the
 * placed-piece bounding box measured while planning the identify tool), not a guess: 0.05 is
 * "just past the camera," 14 comfortably exceeds the room's ~13.5-unit diagonal. */
const EPIPOLAR_NEAR_DEPTH = 0.05;
const EPIPOLAR_FAR_DEPTH = 14;
const PHOTO_INDEX_KEY = 'crop-art-splat:identifyPhotoIndex';

export interface IdentifyModeHandles {
    open(): void;
    isOpen(): boolean;
}

export function setupIdentifyMode(
    getAnnotated: () => AnnotatedPiece[],
    setAnnotated: (next: AnnotatedPiece[]) => void
): IdentifyModeHandles {
    let photos: string[] = [];
    let photoIndex = Number(localStorage.getItem(PHOTO_INDEX_KEY)) || 0;
    let isOpen = false;
    let vertices: [number, number][] = [];
    /** id of the instance-on-this-photo currently in vertex-edit mode, if any. */
    let editingInstanceKey: string | null = null;

    const overlay = document.createElement('div');
    overlay.className = 'identify-overlay';
    overlay.hidden = true;
    overlay.innerHTML = `
        <div class="identify-nav">
            <button class="id-prev" type="button">&#9664; Prev</button>
            <span class="id-counter"></span>
            <button class="id-next" type="button">Next &#9654;</button>
            <button class="id-done primary" type="button">Done</button>
        </div>
        <div class="identify-wrap">
            <img class="identify-img">
            <svg class="identify-svg" viewBox="0 0 1 1" preserveAspectRatio="none"></svg>
        </div>
        <div class="identify-draw-controls">
            <button class="id-close-shape primary" type="button" disabled>Close shape (needs 3+ points)</button>
            <button class="id-undo-point" type="button" disabled>Undo last point</button>
        </div>
        <div class="editor-hint">Click to add a polygon vertex around a piece of art, then click "Close shape" (or press Enter, or click the first larger vertex again). Escape cancels the in-progress shape. Dashed magenta dots are pieces already identified elsewhere — click one to confirm it's also in this photo.</div>
        <div class="identify-status"></div>
        <ul class="identify-piece-list"></ul>
    `;
    document.getElementById('ui-root')!.appendChild(overlay);

    const wrap = overlay.querySelector('.identify-wrap') as HTMLDivElement;
    const img = overlay.querySelector('.identify-img') as HTMLImageElement;
    const svg = overlay.querySelector('.identify-svg') as SVGSVGElement;
    const counterEl = overlay.querySelector('.id-counter') as HTMLElement;
    const statusEl = overlay.querySelector('.identify-status') as HTMLElement;
    const listEl = overlay.querySelector('.identify-piece-list') as HTMLUListElement;
    const prevBtn = overlay.querySelector('.id-prev') as HTMLButtonElement;
    const nextBtn = overlay.querySelector('.id-next') as HTMLButtonElement;
    const doneBtn = overlay.querySelector('.id-done') as HTMLButtonElement;
    const closeShapeBtn = overlay.querySelector('.id-close-shape') as HTMLButtonElement;
    const undoPointBtn = overlay.querySelector('.id-undo-point') as HTMLButtonElement;

    closeShapeBtn.onclick = () => closePolygon();
    undoPointBtn.onclick = () => {
        vertices.pop();
        renderInProgress();
    };

    /** Plain absolutely-positioned divs layered on top of the svg — see identify-mode's
     * plan notes: circles inside a non-uniformly-scaled (preserveAspectRatio="none") SVG
     * viewBox render as ellipses, but a div sized/positioned in real pixels doesn't. */
    const dotLayer = document.createElement('div');
    dotLayer.className = 'identify-dot-layer';
    wrap.appendChild(dotLayer);

    function currentPhoto(): string {
        return photos[photoIndex];
    }

    function svgEl(tag: 'polygon' | 'polyline'): SVGElement {
        return document.createElementNS(SVG_NS, tag);
    }

    function pointsAttr(poly: [number, number][]): string {
        return poly.map(([x, y]) => `${x},${y}`).join(' ');
    }

    function fractionFromEvent(e: PointerEvent | MouseEvent): [number, number] {
        const rect = wrap.getBoundingClientRect();
        const x = Math.min(Math.max((e.clientX - rect.left) / rect.width, 0), 1);
        const y = Math.min(Math.max((e.clientY - rect.top) / rect.height, 0), 1);
        return [x, y];
    }

    function addDot(
        pos: [number, number],
        className: string,
        onClick?: (e: MouseEvent) => void
    ): HTMLDivElement {
        const dot = document.createElement('div');
        dot.className = className;
        dot.style.left = `${pos[0] * 100}%`;
        dot.style.top = `${pos[1] * 100}%`;
        if (onClick) {
            dot.style.pointerEvents = 'auto';
            dot.onclick = (e) => {
                e.stopPropagation();
                onClick(e);
            };
        }
        dotLayer.appendChild(dot);
        return dot;
    }

    /** Recomputes a piece's real multi-view triangulated position from all its instances'
     * rays (see reprojection.ts) — call after any change to a piece's instance list or any
     * instance's polygon (which shifts that instance's centroid, hence its ray). With fewer
     * than 2 instances this just clears any stale triangulation. */
    async function retriangulate(piece: AnnotatedPiece): Promise<void> {
        if (piece.instances.length < 2) {
            piece.triangulatedPosition = undefined;
            return;
        }
        const tri = await triangulatePieceInstances(piece.instances);
        piece.triangulatedPosition = tri ? [tri.x, tri.y, tri.z] : undefined;
    }

    async function closePolygon(): Promise<void> {
        if (vertices.length < 3) return;
        const drawn = vertices;
        statusEl.textContent = 'Computing…';
        const photo = currentPhoto();
        const newRay = await rayForInstance({ photo, polygon: drawn });
        vertices = [];
        if (!newRay) {
            statusEl.textContent = "This photo has no COLMAP calibration, so it can't be used here. Try a different photo.";
            return;
        }
        const annotated = getAnnotated();

        // Match by comparing the new ray against each existing piece's best-known position:
        // once a piece has triangulated from 2+ views, checking the new ray's distance to
        // that consensus point is more robust than comparing against any single old ray
        // (pointToRayDistance); with just one prior view, fall back to ray-to-ray closest
        // approach (closestApproachDistance) against that lone ray. Either way this is pure
        // camera geometry — no splat picking anywhere in the match.
        let match: AnnotatedPiece | undefined;
        let bestDist = Infinity;
        for (const p of annotated) {
            if (p.triangulatedPosition) {
                const d = pointToRayDistance(new Vec3(...p.triangulatedPosition), newRay);
                if (d < MATCH_DISTANCE_THRESHOLD && d < bestDist) {
                    match = p;
                    bestDist = d;
                }
            } else {
                for (const inst of p.instances) {
                    const instRay = await rayForInstance(inst);
                    if (!instRay) continue;
                    const d = closestApproachDistance(newRay, instRay);
                    if (d < MATCH_DISTANCE_THRESHOLD && d < bestDist) {
                        match = p;
                        bestDist = d;
                    }
                }
            }
        }

        const instance: PieceInstance = { photo, polygon: drawn };
        let targetPiece: AnnotatedPiece;
        if (match) {
            const existingIdx = match.instances.findIndex((i) => i.photo === photo);
            const priorInstance = existingIdx >= 0 ? match.instances[existingIdx] : undefined;
            const priorCount = match.instances.length;
            if (existingIdx >= 0) match.instances[existingIdx] = instance;
            else match.instances.push(instance);
            targetPiece = match;
            await retriangulate(targetPiece);
            setAnnotated(annotated);
            renderPhoto();
            showToast(`Linked to a piece already seen in ${priorCount} other photo(s)`, {
                actionLabel: 'Undo',
                onAction: async () => {
                    // "Undo" here means "these are actually two different pieces" — the
                    // merge already happened, so splitting them back out is the only
                    // useful interpretation once we're past this point.
                    const current = getAnnotated();
                    const m = current.find((p) => p.id === match!.id);
                    if (m) {
                        const idx = m.instances.findIndex((i) => i.photo === photo);
                        if (priorInstance) {
                            if (idx >= 0) m.instances[idx] = priorInstance;
                        } else if (idx >= 0) {
                            m.instances.splice(idx, 1);
                        }
                        await retriangulate(m);
                    }
                    current.push({ id: crypto.randomUUID(), instances: [instance] });
                    setAnnotated(current);
                    renderPhoto();
                }
            });
        } else {
            targetPiece = { id: crypto.randomUUID(), instances: [instance] };
            annotated.push(targetPiece);
            setAnnotated(annotated);
            renderPhoto();
        }

        statusEl.textContent = representativeAnchor(targetPiece)
            ? ''
            : "Added — this piece needs one more view to pin down its position. Draw a matching polygon for it on another photo (further apart in the walk works better than an adjacent frame — see the epipolar guide line) to triangulate it.";
    }

    async function linkGhost(piece: AnnotatedPiece, u01: number, v01: number): Promise<void> {
        const half = 0.03;
        const x0 = Math.max(0, u01 - half);
        const y0 = Math.max(0, v01 - half);
        const x1 = Math.min(1, u01 + half);
        const y1 = Math.min(1, v01 + half);
        const placeholderSquare: [number, number][] = [
            [x0, y0],
            [x1, y0],
            [x1, y1],
            [x0, y1]
        ];
        const annotated = getAnnotated();
        const p = annotated.find((a) => a.id === piece.id)!;
        const existingIdx = p.instances.findIndex((i) => i.photo === currentPhoto());
        const instance: PieceInstance = { photo: currentPhoto(), polygon: placeholderSquare, placeholder: true };
        if (existingIdx >= 0) p.instances[existingIdx] = instance;
        else p.instances.push(instance);
        await retriangulate(p);
        setAnnotated(annotated);
        renderPhoto();
    }

    async function deleteInstance(piece: AnnotatedPiece, photo: string): Promise<void> {
        const annotated = getAnnotated();
        const p = annotated.find((a) => a.id === piece.id);
        if (!p) return;
        if (p.instances.length <= 1) {
            if (!confirm('This is the only photo for this piece — deleting it removes the whole piece. Continue?')) return;
            setAnnotated(annotated.filter((a) => a.id !== p.id));
        } else {
            p.instances = p.instances.filter((i) => i.photo !== photo);
            await retriangulate(p);
            setAnnotated(annotated);
        }
        if (editingInstanceKey === `${piece.id}:${photo}`) editingInstanceKey = null;
        renderPhoto();
    }

    function renderVertexEditor(piece: AnnotatedPiece, instance: PieceInstance): void {
        instance.polygon.forEach((v, i) => {
            const dot = addDot(v, 'vertex-dot vertex-dot-edit');
            dot.style.pointerEvents = 'auto';
            dot.onpointerdown = (e) => {
                e.stopPropagation();
                dot.setPointerCapture(e.pointerId);
                const onMove = (ev: PointerEvent) => {
                    const [x, y] = fractionFromEvent(ev);
                    instance.polygon[i] = [x, y];
                    dot.style.left = `${x * 100}%`;
                    dot.style.top = `${y * 100}%`;
                    updateClosedPolygonElement(piece.id, instance.photo, instance.polygon);
                };
                const onUp = () => {
                    dot.removeEventListener('pointermove', onMove);
                    dot.removeEventListener('pointerup', onUp);
                    // Dragging a vertex moves this instance's centroid, hence its ray —
                    // re-triangulate before persisting rather than leaving a stale position.
                    retriangulate(piece).then(() => setAnnotated(getAnnotated()));
                };
                dot.addEventListener('pointermove', onMove);
                dot.addEventListener('pointerup', onUp);
            };
        });
    }

    const closedPolygonElements = new Map<string, SVGElement>();

    function updateClosedPolygonElement(pieceId: string, photo: string, polygon: [number, number][]): void {
        const el = closedPolygonElements.get(`${pieceId}:${photo}`);
        if (el) el.setAttribute('points', pointsAttr(polygon));
    }

    async function renderPhoto(): Promise<void> {
        const photo = currentPhoto();
        img.src = `/photos/${photo}`;
        counterEl.textContent = `Photo ${photoIndex + 1} / ${photos.length} — ${getAnnotated().length} piece(s) identified so far`;
        svg.innerHTML = '';
        dotLayer.innerHTML = '';
        closedPolygonElements.clear();
        listEl.innerHTML = '';

        const annotated = getAnnotated();
        const onThisPhoto: { piece: AnnotatedPiece; instance: PieceInstance }[] = [];
        const elsewhere: AnnotatedPiece[] = [];
        for (const p of annotated) {
            const inst = p.instances.find((i) => i.photo === photo);
            if (inst) onThisPhoto.push({ piece: p, instance: inst });
            else elsewhere.push(p);
        }

        // Closed polygons already on this photo.
        for (const { piece, instance } of onThisPhoto) {
            const el = svgEl('polygon');
            el.setAttribute('points', pointsAttr(instance.polygon));
            el.setAttribute('class', instance.placeholder ? 'poly-ghost-linked' : 'poly-closed');
            svg.appendChild(el);
            closedPolygonElements.set(`${piece.id}:${photo}`, el);

            const li = document.createElement('li');
            const label = document.createElement('span');
            label.textContent = instance.placeholder ? 'Linked piece (placeholder crop)' : 'Identified piece';
            li.appendChild(label);
            const btns = document.createElement('span');
            const editBtn = document.createElement('button');
            const key = `${piece.id}:${photo}`;
            editBtn.textContent = editingInstanceKey === key ? 'Done editing' : 'Edit vertices';
            editBtn.onclick = () => {
                editingInstanceKey = editingInstanceKey === key ? null : key;
                renderPhoto();
            };
            const delBtn = document.createElement('button');
            delBtn.textContent = 'Delete this view';
            delBtn.onclick = () => deleteInstance(piece, photo);
            btns.appendChild(editBtn);
            btns.appendChild(delBtn);
            li.appendChild(btns);
            listEl.appendChild(li);

            if (editingInstanceKey === key) renderVertexEditor(piece, instance);
        }

        // Pieces identified elsewhere but not yet on this photo split into two groups: ones
        // with a triangulated 3D position (2+ views) get a clickable ghost dot at the
        // reprojected point; ones with only a single view so far have no 3D point to
        // reproject yet, so they get an epipolar guide line instead — the ray from that one
        // existing view still tells you where in *this* photo the match must lie.
        const anchoredElsewhere = elsewhere.filter((p) => representativeAnchor(p) !== null);
        const unanchoredElsewhere = elsewhere.filter((p) => representativeAnchor(p) === null);

        const reprojections = await Promise.all(
            anchoredElsewhere.map((p) => reprojectPointToPhoto(photo, new Vec3(...representativeAnchor(p)!)))
        );
        anchoredElsewhere.forEach((p, i) => {
            const hit = reprojections[i];
            if (!hit) return;
            addDot([hit.u01, hit.v01], 'ghost-dot', () => linkGhost(p, hit.u01, hit.v01));
        });

        const currentCamera = await getPhotoCamera(photo);
        if (currentCamera) {
            for (const p of unanchoredElsewhere) {
                const guideRay = await rayForInstance(p.instances[0]);
                if (!guideRay) continue;
                const nearPoint = guideRay.origin.clone().add(guideRay.dir.clone().mulScalar(EPIPOLAR_NEAR_DEPTH));
                const farPoint = guideRay.origin.clone().add(guideRay.dir.clone().mulScalar(EPIPOLAR_FAR_DEPTH));
                const nearProj = worldToPixel(currentCamera, nearPoint);
                const farProj = worldToPixel(currentCamera, farPoint);
                if (!nearProj.inFront || !farProj.inFront) continue;
                const line = svgEl('polyline') as SVGElement;
                line.setAttribute(
                    'points',
                    `${nearProj.u / currentCamera.width},${nearProj.v / currentCamera.height} ${farProj.u / currentCamera.width},${farProj.v / currentCamera.height}`
                );
                line.setAttribute('class', 'epipolar-guide');
                svg.appendChild(line);
            }
        }

        renderInProgress();
    }

    function renderInProgress(): void {
        // Remove any previously-drawn in-progress elements (they're re-created each call).
        overlay.querySelectorAll('.poly-active, .vertex-dot-active').forEach((el) => el.remove());
        closeShapeBtn.disabled = vertices.length < 3;
        closeShapeBtn.textContent = vertices.length < 3 ? 'Close shape (needs 3+ points)' : `Close shape (${vertices.length} points)`;
        undoPointBtn.disabled = vertices.length === 0;
        if (vertices.length === 0) return;
        const line = svgEl('polyline') as SVGElement;
        line.setAttribute('points', pointsAttr(vertices));
        line.setAttribute('class', 'poly-active');
        svg.appendChild(line);
        vertices.forEach((v, i) => {
            const isFirst = i === 0;
            addDot(
                v,
                `vertex-dot-active${isFirst && vertices.length >= 3 ? ' vertex-dot-first' : ''}`,
                isFirst && vertices.length >= 3 ? () => closePolygon() : undefined
            );
        });
    }

    wrap.addEventListener('click', (e) => {
        if (!isOpen) return;
        const [x, y] = fractionFromEvent(e);
        if (vertices.length >= 3) {
            const [fx, fy] = vertices[0];
            if (Math.hypot(x - fx, y - fy) < CLOSE_VERTEX_TOLERANCE) {
                closePolygon();
                return;
            }
        }
        vertices.push([x, y]);
        renderInProgress();
    });

    document.addEventListener('keydown', (e) => {
        if (!isOpen) return;
        if (e.key === 'Enter' && vertices.length >= 3) {
            closePolygon();
        } else if (e.key === 'Escape') {
            vertices = [];
            renderInProgress();
        }
    });

    function goTo(index: number): void {
        photoIndex = Math.min(Math.max(index, 0), photos.length - 1);
        localStorage.setItem(PHOTO_INDEX_KEY, String(photoIndex));
        vertices = [];
        editingInstanceKey = null;
        statusEl.textContent = '';
        renderPhoto();
    }

    prevBtn.onclick = () => goTo(photoIndex - 1);
    nextBtn.onclick = () => goTo(photoIndex + 1);
    doneBtn.onclick = () => close();

    function close(): void {
        isOpen = false;
        overlay.hidden = true;
    }

    return {
        async open() {
            if (photos.length === 0) {
                photos = await getAllCalibratedPhotos();
                photoIndex = Math.min(photoIndex, Math.max(0, photos.length - 1));
            }
            isOpen = true;
            overlay.hidden = false;
            vertices = [];
            editingInstanceKey = null;
            renderPhoto();
        },
        isOpen: () => isOpen
    };
}
