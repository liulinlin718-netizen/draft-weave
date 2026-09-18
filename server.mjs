import http from 'node:http';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { readFile, writeFile, stat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { PROJECT_ROOT, checkedPath, runtimePaths } from './server/paths.mjs';
import { BridgeError, providerStatus, polish } from './server/model-bridge.mjs';

const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.md': 'text/plain; charset=utf-8', '.json': 'application/json; charset=utf-8' };
const BODY_LIMIT = 2_000_000;

function json(res, status, data) { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(data)); }
async function body(req, limit = BODY_LIMIT) {
  if (!(req.headers['content-type'] || '').toLowerCase().startsWith('application/json')) throw new BridgeError('CONTENT_TYPE', '请求必须为 application/json。', 415);
  let bytes = 0; const chunks = [];
  for await (const chunk of req) { bytes += chunk.length; if (bytes > limit) throw new BridgeError('INPUT_TOO_LARGE', `请求超过 ${Math.floor(limit / 1_000_000)} MB 上限。`, 413); chunks.push(chunk); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new BridgeError('INVALID_JSON', '请求 JSON 无效。'); }
}
function validRequestId(value) { return typeof value === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(value); }

export async function createApp({ env = process.env, polishImpl = polish, statusImpl = providerStatus } = {}) {
  const paths = await runtimePaths(env);
  const active = new Map();
  const server = http.createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
    try {
      const port = server.address().port;
      const allowedHosts = [`127.0.0.1:${port}`, `localhost:${port}`];
      if (!allowedHosts.includes(req.headers.host)) throw new BridgeError('BAD_HOST', '仅接受本机访问。', 403);
      const origin = req.headers.origin;
      if (origin && !allowedHosts.some(host => origin === `http://${host}`)) throw new BridgeError('BAD_ORIGIN', '拒绝其他网站发起的请求。', 403);
      if (req.headers['sec-fetch-site'] === 'cross-site') throw new BridgeError('BAD_ORIGIN', '拒绝跨站请求。', 403);
      const url = new URL(req.url, `http://127.0.0.1:${port}`);
      if (req.method === 'GET' && url.pathname === '/api/status') return json(res, 200, { providers: await statusImpl({ env }), paths: { exports: paths.exports, profile: paths.profile }, offline: true });
      if (req.method === 'POST' && url.pathname === '/api/polish') {
        const data = await body(req);
        if (!validRequestId(data.requestId)) throw new BridgeError('INVALID_REQUEST_ID', '润色请求 ID 无效。');
        if (active.has(data.requestId)) throw new BridgeError('REQUEST_EXISTS', '该润色请求已经在运行。', 409);
        if (active.size >= 2) throw new BridgeError('BUSY', '已有润色正在运行，请等待或取消。', 429);
        const controller = new AbortController(); active.set(data.requestId, controller);
        res.once('close', () => { if (!res.writableEnded) controller.abort(); });
        const started = Date.now();
        try { const result = await polishImpl(data.provider, data.input, { env, signal: controller.signal }); return json(res, 200, { ...result, requestId: data.requestId, elapsedMs: Date.now() - started }); }
        finally { active.delete(data.requestId); }
      }
      if (req.method === 'POST' && url.pathname === '/api/cancel') {
        const data = await body(req); if (!validRequestId(data.requestId)) throw new BridgeError('INVALID_REQUEST_ID', '润色请求 ID 无效。');
        const controller = active.get(data.requestId); controller?.abort(); return json(res, 200, { cancelled: Boolean(controller) });
      }
      if (req.method === 'POST' && url.pathname === '/api/export') {
        // JSON-stringified project content can expand because its newlines and quotes
        // are escaped a second time. Core accepts up to 50 MB project snapshots.
        const data = await body(req, 100_000_000);
        if (typeof data.content === 'string' && Buffer.byteLength(data.content, 'utf8') > 55_000_000) throw new BridgeError('INPUT_TOO_LARGE', '导出内容超过 55 MB 上限。', 413);
        if (typeof data.filename !== 'string' || typeof data.content !== 'string' || !/\.(md|json)$/i.test(data.filename)) throw new BridgeError('INVALID_EXPORT', '导出需要 .md 或 .json 文件名及文本内容。');
        if (data.filename.length > 120 || /[<>:"/\\|?*\x00-\x1f]/.test(data.filename) || /[. ]$/.test(data.filename) || /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(data.filename)) throw new BridgeError('INVALID_EXPORT', '导出文件名含不允许的字符。');
        const filename = `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}-${data.filename}`;
        const target = await checkedPath(path.join(paths.exports, filename), paths.dataRoot);
        await writeFile(target, data.content, { encoding: 'utf8', flag: 'wx' });
        return json(res, 201, { path: target, filename, downloadUrl: `/downloads/${encodeURIComponent(filename)}` });
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') throw new BridgeError('NOT_FOUND', '接口不存在。', 404);
      let file; let download = false;
      if (url.pathname.startsWith('/downloads/')) {
        const name = decodeURIComponent(url.pathname.slice('/downloads/'.length));
        if (!name || name !== path.basename(name) || /[/\\]/.test(name) || !/\.(md|json)$/i.test(name)) throw new BridgeError('NOT_FOUND', '文件不存在。', 404);
        file = await checkedPath(path.join(paths.exports, name), paths.dataRoot); download = true;
      } else {
        const name = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname);
        if (name.includes('\\') || name.split('/').some(part => part.startsWith('.'))) throw new BridgeError('NOT_FOUND', '文件不存在。', 404);
        file = await checkedPath(path.join(PROJECT_ROOT, 'public', name), path.join(PROJECT_ROOT, 'public'));
        if (!MIME[path.extname(file)]) throw new BridgeError('NOT_FOUND', '文件不存在。', 404);
      }
      const info = await stat(file); if (!info.isFile()) throw new BridgeError('NOT_FOUND', '文件不存在。', 404);
      const headers = { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' };
      if (download) headers['Content-Disposition'] = `attachment; filename*=UTF-8''${encodeURIComponent(path.basename(file))}`;
      res.writeHead(200, headers); res.end(req.method === 'HEAD' ? undefined : await readFile(file));
    } catch (error) {
      if (res.destroyed || res.writableEnded) return;
      const known = error instanceof BridgeError;
      const notFound = error.code === 'ENOENT';
      const unsafe = error.code === 'UNSAFE_PATH';
      json(res, known ? error.status : notFound ? 404 : unsafe ? 403 : 500, { error: { code: known || unsafe ? error.code : notFound ? 'NOT_FOUND' : 'SERVER_ERROR', message: known || unsafe ? error.message : notFound ? '文件不存在。' : '本地服务处理失败；成稿仍保留在画布。', retryable: Boolean(error.retryable) } });
    }
  });
  server.requestTimeout = 650000;
  server.headersTimeout = 10000;
  server.on('close', () => { for (const controller of active.values()) controller.abort(); });
  return server;
}

export async function startServer({ env = process.env } = {}) {
  const port = Number(env.DW_PORT || 6410);
  if (!Number.isInteger(port) || port < 6410 || port > 6419) throw new Error('DW_PORT 必须在 6410–6419。');
  const server = await createApp({ env });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  console.log(`文稿拼接画布 http://127.0.0.1:${port}`);
  console.log(`导出目录 ${path.join(path.resolve(env.DW_DATA_DIR || PROJECT_ROOT), 'outputs', 'exports')}`);
  return server;
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  startServer().catch(error => { console.error(error.code === 'EADDRINUSE' ? '端口已被占用；请设置 DW_PORT 为 6410–6419 中的其他端口。' : error.message); process.exitCode = 1; });
}
