import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');
const bundlePath = path.join(rootDir, 'gemini-bridge.user.js');
const PORT = 8787;

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.setHeader('Content-Type', 'application/javascript; charset=utf-8');

  if (fs.existsSync(bundlePath)) {
    const content = fs.readFileSync(bundlePath, 'utf8');
    res.writeHead(200);
    res.end(content);
    console.log(`[Dev Server] Served fresh bundle (${(content.length / 1024).toFixed(1)} KB) at ${new Date().toLocaleTimeString()}`);
  } else {
    res.writeHead(404);
    res.end('// gemini-bridge.user.js not found');
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log('===================================================');
  console.log(`  Gemini Bridge Local Dev Server running!`);
  console.log(`  URL: http://127.0.0.1:${PORT}/gemini-bridge.user.js`);
  console.log('===================================================');
  console.log('In Tampermonkey use:');
  console.log(`// @require http://127.0.0.1:${PORT}/gemini-bridge.user.js`);
  console.log('\nReady! Press Ctrl+C to stop.');
});
