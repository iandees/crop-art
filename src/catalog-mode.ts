import {
    polygonBBox01,
    isCataloged,
    exportAnnotatedPiecesAsPiecesFile,
    representativeAnchor,
    type AnnotatedPiece
} from './annotated-pieces';
import { retriangulatePiece } from './reprojection';

const SVG_NS = 'http://www.w3.org/2000/svg';
function pointsAttr(poly: [number, number][]): string {
    return poly.map(([x, y]) => `${x},${y}`).join(' ');
}

export interface CatalogModeHandles {
    open(): void;
    isOpen(): boolean;
}

export function setupCatalogMode(
    getAnnotated: () => AnnotatedPiece[],
    setAnnotated: (next: AnnotatedPiece[]) => void,
    onChange: () => void
): CatalogModeHandles {
    let isOpen = false;
    /** Piece ids checked for merging — cleared on a successful merge or when leaving the queue. */
    let selectedForMerge = new Set<string>();

    const panel = document.createElement('div');
    panel.className = 'editor-panel catalog-panel';
    panel.hidden = true;
    document.getElementById('ui-root')!.appendChild(panel);

    function persist(annotated: AnnotatedPiece[]): void {
        setAnnotated(annotated);
        onChange();
    }

    async function mergeSelected(): Promise<void> {
        if (selectedForMerge.size < 2) return;
        const annotated = getAnnotated();
        // The survivor is whichever selected piece appears first in the list — its id,
        // title/artist/etc., and canonicalInstanceIndex (still valid, since its own
        // instances keep their original indices; only the merged-in instances get
        // appended after them) all carry over unchanged.
        const selected = annotated.filter((p) => selectedForMerge.has(p.id));
        const survivor = selected[0];
        const others = selected.slice(1);
        if (!confirm(`Merge ${selected.length} entries into one ("${survivor.title || '(uncataloged)'}")? This can't be undone.`)) return;
        for (const other of others) {
            survivor.instances.push(...other.instances);
        }
        await retriangulatePiece(survivor);
        const remaining = annotated.filter((p) => !others.some((o) => o.id === p.id));
        selectedForMerge = new Set();
        persist(remaining);
        renderQueue();
    }

    function renderQueue(): void {
        const annotated = getAnnotated();
        const uncatalogedCount = annotated.filter((p) => !isCataloged(p)).length;
        panel.innerHTML = `
            <h3>Catalog pieces</h3>
            <div class="editor-hint">${annotated.length} piece(s) identified, ${uncatalogedCount} awaiting details.</div>
            <div class="editor-hint">Check 2+ entries that are actually the same piece of art, then merge them.</div>
            <ul class="catalog-list"></ul>
            <button class="f-catalog-merge">Merge selected</button>
            <button class="primary f-catalog-export">Export pieces.json</button>
            <button class="f-catalog-close">Close</button>
        `;
        const list = panel.querySelector('.catalog-list') as HTMLUListElement;
        for (const piece of annotated) {
            const li = document.createElement('li');
            const checkbox = document.createElement('input');
            checkbox.type = 'checkbox';
            checkbox.checked = selectedForMerge.has(piece.id);
            checkbox.onchange = () => {
                if (checkbox.checked) selectedForMerge.add(piece.id);
                else selectedForMerge.delete(piece.id);
                mergeBtn.disabled = selectedForMerge.size < 2;
                mergeBtn.textContent = selectedForMerge.size >= 2 ? `Merge selected (${selectedForMerge.size})` : 'Merge selected';
            };
            li.appendChild(checkbox);
            const label = document.createElement('span');
            label.textContent = piece.title || `(uncataloged, ${piece.instances.length} view${piece.instances.length === 1 ? '' : 's'})`;
            li.appendChild(label);
            const btn = document.createElement('button');
            btn.textContent = isCataloged(piece) ? 'Edit' : 'Catalog';
            btn.onclick = () => renderDetail(piece.id);
            li.appendChild(btn);
            list.appendChild(li);
        }
        const mergeBtn = panel.querySelector('.f-catalog-merge') as HTMLButtonElement;
        mergeBtn.disabled = selectedForMerge.size < 2;
        if (selectedForMerge.size >= 2) mergeBtn.textContent = `Merge selected (${selectedForMerge.size})`;
        mergeBtn.onclick = () => mergeSelected();
        (panel.querySelector('.f-catalog-export') as HTMLButtonElement).onclick = () => {
            if (uncatalogedCount > 0) {
                if (!confirm(`${uncatalogedCount} piece(s) aren't cataloged yet and will be skipped from the export. Continue?`)) return;
            }
            exportAnnotatedPiecesAsPiecesFile(getAnnotated());
        };
        (panel.querySelector('.f-catalog-close') as HTMLButtonElement).onclick = () => close();
    }

    function renderDetail(pieceId: string): void {
        const annotated = getAnnotated();
        const piece = annotated.find((p) => p.id === pieceId);
        if (!piece) return renderQueue();

        let instanceIndex = piece.canonicalInstanceIndex ?? 0;

        const noPositionWarning = representativeAnchor(piece)
            ? ''
            : `<div class="editor-hint" style="color:#f2a65a">This piece's 3D position isn't confirmed yet (needs a second linked photo) — it can still be cataloged, but will be skipped on export until that's resolved.</div>`;

        panel.innerHTML = `
            <h3>Catalog piece</h3>
            ${noPositionWarning}
            <label>Title</label>
            <input type="text" class="f-title" value="${piece.title ?? ''}">
            <label>Artist</label>
            <input type="text" class="f-artist" value="${piece.artist ?? ''}">
            <label>Hometown</label>
            <input type="text" class="f-hometown" value="${piece.hometown ?? ''}">
            <label>Ribbon (optional)</label>
            <input type="text" class="f-ribbon" value="${piece.ribbon ?? ''}">
            <label>Description</label>
            <textarea class="f-desc">${piece.description ?? ''}</textarea>
            <div class="photo-picker">
                <label>Photo (${piece.instances.length} view${piece.instances.length === 1 ? '' : 's'})</label>
                <div class="candidate-nav">
                    <button type="button" class="f-cand-prev">&#9664; Prev</button>
                    <span class="cand-counter"></span>
                    <button type="button" class="f-cand-next">Next &#9654;</button>
                </div>
                <div class="crop-wrap">
                    <img class="candidate-preview-img">
                    <svg class="crop-svg" viewBox="0 0 1 1" preserveAspectRatio="none"></svg>
                    <div class="crop-box"></div>
                </div>
                <div class="editor-hint">Dashed outline is the polygon actually drawn for this view. Drag on the photo to set/adjust the rectangle shown to visitors.</div>
                <button type="button" class="f-set-canonical">Set as canonical photo</button>
                <div class="editor-hint f-canonical-status"></div>
            </div>
            <div>
                <button class="primary f-save">Save</button>
                <button class="f-save-next">Save &amp; next uncataloged</button>
                <button class="f-cancel">Back to list</button>
            </div>
        `;

        const wrap = panel.querySelector('.crop-wrap') as HTMLDivElement;
        const img = panel.querySelector('.candidate-preview-img') as HTMLImageElement;
        const svg = panel.querySelector('.crop-svg') as unknown as SVGSVGElement;
        const cropBox = panel.querySelector('.crop-box') as HTMLDivElement;
        const counterEl = panel.querySelector('.cand-counter') as HTMLElement;
        const prevBtn = panel.querySelector('.f-cand-prev') as HTMLButtonElement;
        const nextBtn = panel.querySelector('.f-cand-next') as HTMLButtonElement;
        const setCanonicalBtn = panel.querySelector('.f-set-canonical') as HTMLButtonElement;
        const canonicalStatus = panel.querySelector('.f-canonical-status') as HTMLDivElement;

        function setRect(rect: [number, number, number, number]): void {
            const [x, y, w, h] = rect;
            cropBox.style.left = `${x * 100}%`;
            cropBox.style.top = `${y * 100}%`;
            cropBox.style.width = `${w * 100}%`;
            cropBox.style.height = `${h * 100}%`;
        }

        const renderInstance = (): void => {
            const instance = piece.instances[instanceIndex];
            img.src = `/photos/${instance.photo}`;
            counterEl.textContent = `${instanceIndex + 1} / ${piece.instances.length}`;
            prevBtn.disabled = piece.instances.length < 2;
            nextBtn.disabled = piece.instances.length < 2;
            svg.innerHTML = '';
            const poly = document.createElementNS(SVG_NS, 'polygon');
            poly.setAttribute('points', pointsAttr(instance.polygon));
            poly.setAttribute('class', 'catalog-poly-shape');
            svg.appendChild(poly);
            setRect(polygonBBox01(instance.polygon));
            canonicalStatus.textContent = piece.canonicalInstanceIndex === instanceIndex ? 'This is the current canonical photo.' : '';
        };
        renderInstance();

        prevBtn.onclick = () => {
            instanceIndex = (instanceIndex - 1 + piece.instances.length) % piece.instances.length;
            renderInstance();
        };
        nextBtn.onclick = () => {
            instanceIndex = (instanceIndex + 1) % piece.instances.length;
            renderInstance();
        };

        let dragStart: [number, number] | null = null;
        function fractionFromEvent(e: PointerEvent): [number, number] {
            const rect = wrap.getBoundingClientRect();
            return [
                Math.min(Math.max((e.clientX - rect.left) / rect.width, 0), 1),
                Math.min(Math.max((e.clientY - rect.top) / rect.height, 0), 1)
            ];
        }
        wrap.addEventListener('pointerdown', (e) => {
            dragStart = fractionFromEvent(e);
            wrap.setPointerCapture(e.pointerId);
        });
        wrap.addEventListener('pointermove', (e) => {
            if (!dragStart) return;
            const [cx, cy] = fractionFromEvent(e);
            const x = Math.min(dragStart[0], cx);
            const y = Math.min(dragStart[1], cy);
            const w = Math.abs(cx - dragStart[0]);
            const h = Math.abs(cy - dragStart[1]);
            setRect([x, y, w, h]);
        });
        wrap.addEventListener('pointerup', async () => {
            if (!dragStart) return;
            dragStart = null;
            const left = parseFloat(cropBox.style.left) / 100;
            const top = parseFloat(cropBox.style.top) / 100;
            const width = parseFloat(cropBox.style.width) / 100;
            const height = parseFloat(cropBox.style.height) / 100;
            if (width < 0.02 || height < 0.02) return;
            piece.instances[instanceIndex].polygon = [
                [left, top],
                [left + width, top],
                [left + width, top + height],
                [left, top + height]
            ];
            // Redrawing the rectangle replaces this instance's polygon outright, which
            // moves its centroid (hence its ray) — re-triangulate rather than leaving a
            // stale position computed from the old shape.
            await retriangulatePiece(piece);
            renderInstance();
            persist(annotated);
        });

        setCanonicalBtn.onclick = () => {
            piece.canonicalInstanceIndex = instanceIndex;
            persist(annotated);
            canonicalStatus.textContent = 'This is the current canonical photo.';
        };

        const saveFields = (): void => {
            piece.title = (panel.querySelector('.f-title') as HTMLInputElement).value.trim();
            piece.artist = (panel.querySelector('.f-artist') as HTMLInputElement).value.trim() || undefined;
            piece.hometown = (panel.querySelector('.f-hometown') as HTMLInputElement).value.trim() || undefined;
            piece.ribbon = (panel.querySelector('.f-ribbon') as HTMLInputElement).value.trim() || undefined;
            piece.description = (panel.querySelector('.f-desc') as HTMLTextAreaElement).value.trim() || undefined;
            if (piece.canonicalInstanceIndex === undefined) piece.canonicalInstanceIndex = instanceIndex;
            persist(annotated);
        };

        (panel.querySelector('.f-save') as HTMLButtonElement).onclick = () => {
            saveFields();
            renderQueue();
        };
        (panel.querySelector('.f-save-next') as HTMLButtonElement).onclick = () => {
            saveFields();
            const next = getAnnotated().find((p) => p.id !== piece.id && !isCataloged(p));
            if (next) renderDetail(next.id);
            else renderQueue();
        };
        (panel.querySelector('.f-cancel') as HTMLButtonElement).onclick = () => renderQueue();
    }

    function close(): void {
        isOpen = false;
        panel.hidden = true;
    }

    return {
        open() {
            isOpen = true;
            panel.hidden = false;
            renderQueue();
        },
        isOpen: () => isOpen
    };
}
