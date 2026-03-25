/**
 * server.js — WebSocket relay server for ±Quantum entanglement.
 *
 * Two browser clients (role=A, role=B) connect.
 * When one measures tiles, collapse events are relayed to the partner.
 *
 * Also serves static files so no separate http-server is needed.
 *
 * Usage: node server.js [port]
 */

import { createServer } from 'http';
import { readFile } from 'fs/promises';
import { extname, join } from 'path';
import { fileURLToPath } from 'url';
import { WebSocketServer } from 'ws';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const PORT = parseInt(process.env.PORT || process.argv[2] || '8080', 10);

// ─── MIME types ──────────────────────────────────────────────────

const MIME = {
  '.html': 'text/html',
  '.css':  'text/css',
  '.js':   'application/javascript',
  '.json': 'application/json',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.svg':  'image/svg+xml',
  '.ico':  'image/x-icon',
  '.woff': 'font/woff',
  '.woff2':'font/woff2',
};

// ─── HTTP static file server ─────────────────────────────────────

const httpServer = createServer(async (req, res) => {
  // Strip query string from URL for file lookup
  const urlPath = new URL(req.url, `http://${req.headers.host}`).pathname;
  let filePath = join(__dirname, urlPath === '/' ? '/static.html' : urlPath);

  // Security: prevent path traversal
  if (!filePath.startsWith(__dirname)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  try {
    const data = await readFile(filePath);
    const ext = extname(filePath);
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  } catch {
    res.writeHead(404);
    res.end('Not Found');
  }
});

// ─── WebSocket server ────────────────────────────────────────────

const wss = new WebSocketServer({ server: httpServer, path: '/ws' });

/** @type {Map<string, WebSocket>} role → socket */
const clients = new Map();

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const role = (url.searchParams.get('role') || 'A').toUpperCase();

  if (role !== 'A' && role !== 'B') {
    ws.close(4001, 'Invalid role. Use ?role=A or ?role=B');
    return;
  }

  // Disconnect existing client with same role
  if (clients.has(role)) {
    console.log(`[ws] Replacing existing client ${role}`);
    clients.get(role).close(4002, 'Replaced by new connection');
  }

  clients.set(role, ws);
  const partner = role === 'A' ? 'B' : 'A';
  console.log(`[ws] Client ${role} connected. Clients: ${[...clients.keys()].join(', ')}`);

  // Send role assignment
  ws.send(JSON.stringify({
    type: 'assigned',
    role,
    partnerConnected: clients.has(partner),
  }));

  // Notify partner
  if (clients.has(partner)) {
    const partnerWs = clients.get(partner);
    if (partnerWs.readyState === 1) {
      partnerWs.send(JSON.stringify({ type: 'partner_connected' }));
    }
  }

  // Handle messages
  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data);

      // Relay collapse events to partner
      if (msg.type === 'collapse' || msg.type === 'collapse_batch') {
        if (clients.has(partner)) {
          const partnerWs = clients.get(partner);
          if (partnerWs.readyState === 1) {
            partnerWs.send(data.toString());
          }
        }
      }
    } catch (e) {
      console.error(`[ws] Parse error from ${role}:`, e.message);
    }
  });

  ws.on('close', () => {
    if (clients.get(role) === ws) {
      clients.delete(role);
      console.log(`[ws] Client ${role} disconnected`);

      // Notify partner
      if (clients.has(partner)) {
        const partnerWs = clients.get(partner);
        if (partnerWs.readyState === 1) {
          partnerWs.send(JSON.stringify({ type: 'partner_disconnected' }));
        }
      }
    }
  });

  ws.on('error', (err) => {
    console.error(`[ws] Error from ${role}:`, err.message);
  });
});

// ─── Start ───────────────────────────────────────────────────────

httpServer.listen(PORT, '0.0.0.0', () => {
  console.log(`\n  ±Quantum Server listening on port ${PORT}`);
  console.log(`  http://localhost:${PORT}/static.html?role=A`);
  console.log(`  http://localhost:${PORT}/static.html?role=B\n`);
});
