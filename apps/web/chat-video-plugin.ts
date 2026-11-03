import { createReadStream, statSync } from 'node:fs';
import { join, normalize, sep } from 'node:path';
import type { Connect, Plugin } from 'vite';

/** Serves `VIDEO_DIR` at `/chatvideo/` for dev and `vite preview`, including byte ranges. */
export function chatVideoPlugin(root: string): Plugin {
  const base = normalize(root);
  const handler: Connect.NextHandleFunction = (req, res, next) => {
    const raw = req.url?.split('?')[0] ?? '';
    if (!raw.startsWith('/chatvideo/')) return next();
    let rel: string;
    try {
      rel = decodeURIComponent(raw.slice('/chatvideo/'.length));
    } catch {
      res.statusCode = 400;
      res.end();
      return;
    }
    const file = normalize(join(base, rel));
    if (file !== base && !file.startsWith(base + sep)) {
      res.statusCode = 400;
      res.end();
      return;
    }
    let size: number;
    try {
      const stat = statSync(file);
      if (!stat.isFile()) throw new Error('not a file');
      size = stat.size;
    } catch {
      res.statusCode = 404;
      res.end();
      return;
    }
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Content-Type', 'video/mp4');
    const range = req.headers.range;
    if (!range) {
      res.setHeader('Content-Length', size);
      createReadStream(file).pipe(res);
      return;
    }
    const match = /bytes=(\d+)-(\d*)/.exec(range);
    const start = match ? Number(match[1]) : NaN;
    const end = match && match[2] ? Number(match[2]) : size - 1;
    if (!match || start >= size || end >= size || start > end) {
      res.statusCode = 416;
      res.setHeader('Content-Range', `bytes */${size}`);
      res.end();
      return;
    }
    res.statusCode = 206;
    res.setHeader('Content-Range', `bytes ${start}-${end}/${size}`);
    res.setHeader('Content-Length', end - start + 1);
    createReadStream(file, { start, end }).pipe(res);
  };
  return {
    name: 'chatvideo',
    configureServer(server) {
      server.middlewares.use(handler);
    },
    configurePreviewServer(server) {
      server.middlewares.use(handler);
    },
  };
}
