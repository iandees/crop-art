# MN State Fair Crop Art — Splat Walkthrough

A walkthrough viewer for a Gaussian splat capture of the crop art display,
built on the [PlayCanvas engine](https://github.com/playcanvas/engine). Fly
around the scene and click hotspots on individual pieces to see a full photo,
title, artist, and description.

## Scene scale

The trained splat is normalized to a small scale — the whole room spans
roughly 1 unit, not real-world meters. Camera speed, near/far clip planes,
and hotspot placement distance in `src/scene.ts` / `src/editor.ts` are tuned
to that scale. If you retrain the splat and the new export uses a different
scale, re-derive it: parse the compressed-ply `chunk` element's per-chunk
`min_x/y/z` and `max_x/y/z` fields and look at the 5th–95th percentile of
chunk centers (the raw min/max across all chunks is dominated by stray
floater artifacts, not the real room bounds).

## Development

```bash
npm install

# Local dev needs the splat file available at local-splat/ (gitignored — it's
# ~130MB and lives outside the repo). It's deliberately NOT under public/,
# which Vite would copy verbatim into a production build. Symlink it once:
mkdir -p local-splat
ln -s "/path/to/splat-trained-compressed.ply" local-splat/splat-trained-compressed.ply

npm run dev
```

Open the printed localhost URL. Controls:

- **WASD** — move, **Q/E** — down/up, **click-drag** — look
- **F2** — toggle the hotspot editor

## Hotspot editor (F2)

This is how you catalog pieces — no backend, no auth, just you running the
dev server locally:

1. Press **F2**. A crosshair appears at screen center and a panel opens
   top-right.
2. Look at a spot on a piece. Use **[** / **]** to dial in how far in front
   of the camera the hotspot lands (shown in the panel).
3. Click to open the "New piece" form. Fill in title, artist, description,
   and a photo filename.
4. For the photo: pick a file to preview it, then **copy that file into
   `public/photos/`** yourself under the filename shown — there's no upload
   pipeline, it's just a static folder.
5. Repeat for each piece. Everything auto-saves to `localStorage` as you go
   (safe to close the tab and come back), and the sidebar lists what you've
   added so far with Edit/Delete.
6. When you're done (or periodically), click **Export pieces.json** to
   download the current dataset, then replace `public/data/pieces.json`
   with it and commit.

`public/data/pieces.json` is the checked-in source of truth; `localStorage`
is just a scratch buffer for the editing session.

### Piece data format

```json
[
  {
    "id": "uuid",
    "title": "Loon",
    "artist": "Jane Farmer",
    "description": "A loon made entirely of seeds, grown for the fair.",
    "photo": "loon.jpg",
    "position": [0.47, 0.21, 0.31]
  }
]
```

`photo` is a filename under `public/photos/`. `position` is in the same
local space as the splat itself (see Scene scale above).

## Production build

```bash
npm run build   # tsc -b && vite build, output in dist/
```

Set `VITE_SPLAT_URL` to the production splat URL at build time (see
Deployment below) — otherwise it falls back to the local dev path.

## Deployment (Cloudflare Workers + R2)

Live at: **https://crop-art-splat.<your-workers-subdomain>.workers.dev**
(run `npx wrangler deployments list` to find the exact URL, or check the
Cloudflare dashboard).

The splat file (~130MB) is too big to ship as a Worker static asset (25MB
limit), so it's served from an R2 bucket instead, loaded at runtime by URL.
This is already set up:

- R2 bucket `crop-art-splat`, public access enabled at its `r2.dev` URL
- The splat is uploaded there as `splat-trained-compressed.ply`
- The site itself deploys as a Worker with static assets (`wrangler.jsonc`'s
  `assets.directory` points at `dist/`)

**Re-deploying after code changes:**

```bash
npx wrangler deploy   # uses whatever's already in dist/ — run `npm run build` first if you changed src/
```

**Re-uploading after retraining the splat:**

```bash
npx wrangler r2 object put crop-art-splat/splat-trained-compressed.ply \
  --file "/path/to/new-splat-trained-compressed.ply" \
  --content-type application/octet-stream \
  --remote
```

The site's `VITE_SPLAT_URL` (baked in at build time) already points at the
R2 public URL, so as long as the object key stays the same, re-uploading is
enough — no rebuild needed. If you ever rebuild fresh, pass it explicitly:

```bash
VITE_SPLAT_URL="https://pub-ab5f11cab4bc4605891593a0b11799e4.r2.dev/splat-trained-compressed.ply" npm run build
npx wrangler deploy
```

**One-time setup, for reference** (already done — you shouldn't need to
repeat this unless starting a fresh Cloudflare account/bucket):

```bash
npx wrangler r2 bucket create crop-art-splat
npx wrangler r2 object put crop-art-splat/splat-trained-compressed.ply \
  --file "/path/to/splat-trained-compressed.ply" --content-type application/octet-stream --remote
npx wrangler r2 bucket dev-url enable crop-art-splat   # public r2.dev URL
```

`wrangler.jsonc` in this repo declares the Pages project and an R2 binding
for reference; the app itself only needs the splat's public URL at build
time (via `VITE_SPLAT_URL`), it doesn't call the Cloudflare API directly.

Piece photos (`public/photos/`) and `public/data/pieces.json` ship as part
of the static site build — no R2 needed for those unless they grow large.
