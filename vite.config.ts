import fs from 'node:fs';
import path from 'node:path';
import { defineConfig, type Plugin } from 'vite';

// Serves the local dev copy of the (large, gitignored) splat file at /splat/*
// during `vite dev` only. It intentionally lives outside public/ so it can
// never be copied into a production build (public/ is copied verbatim, and
// Cloudflare Workers rejects any static asset over 25MB).
function localSplatDevServer(): Plugin {
    const dir = path.resolve(__dirname, 'local-splat');
    return {
        name: 'local-splat-dev-server',
        configureServer(server) {
            server.middlewares.use((req, res, next) => {
                if (!req.url?.startsWith('/splat/')) return next();
                const filePath = path.join(dir, req.url.replace(/^\/splat\//, ''));
                if (!filePath.startsWith(dir) || !fs.existsSync(filePath)) return next();
                res.setHeader('Content-Type', 'application/octet-stream');
                // Without Content-Length the splat asset's 'progress' event never learns a
                // total, so the loading overlay's percentage stays stuck at 0% locally even
                // though it's fine against the real R2-hosted file in production.
                res.setHeader('Content-Length', fs.statSync(filePath).size);
                fs.createReadStream(filePath).pipe(res);
            });
        }
    };
}

export default defineConfig({
    plugins: [localSplatDevServer()],
    build: {
        target: 'es2022',
        chunkSizeWarningLimit: 2000
    }
});
