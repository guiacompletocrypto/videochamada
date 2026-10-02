'use strict';
// Prosa — servidor de sinalização WebRTC + upload de arquivos. Zero dependências (Node >= 18).
const http = require('http'), https = require('https'), fs = require('fs'), os = require('os'),
  path = require('path'), crypto = require('crypto');
const PORT = +process.env.PORT || 3000, MAX = 25 * 1024 * 1024, GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const TYPES = {
  '.pdf': 'application/pdf', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.txt': 'text/plain; charset=utf-8', '.md': 'text/plain; charset=utf-8',
  '.csv': 'text/plain; charset=utf-8', '.mp4': 'video/mp4', '.webm': 'video/webm', '.mp3': 'audio/mpeg',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
};
const MAGIC = { // assinaturas (magic bytes) para validar o conteúdo real
  '.pdf': [0x25, 0x50, 0x44, 0x46], '.png': [0x89, 0x50, 0x4e, 0x47], '.jpg': [0xff, 0xd8, 0xff], '.jpeg': [0xff, 0xd8, 0xff],
  '.gif': [0x47, 0x49, 0x46], '.webp': [0x52, 0x49, 0x46, 0x46], '.docx': [0x50, 0x4b], '.pptx': [0x50, 0x4b], '.xlsx': [0x50, 0x4b]
};
const rooms = new Map();
const getRoom = id => { let r = rooms.get(id); if (!r) { r = { id, peers: new Map(), files: new Map(), presenting: null }; rooms.set(id, r); } return r; };
const bcast = (r, o, except) => r.peers.forEach(p => p.id !== except && p.send(o));
const json = (res, code, o) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
const pubFile = (r, f) => ({ id: f.id, name: f.name, size: f.size, ext: f.ext, url: `/files/${r.id}/${f.id}` });
const pubPeer = c => ({ id: c.id, name: c.name, state: c.state });
function present(r, c, f) {
  r.presenting = { by: c.id, byName: c.name, file: pubFile(r, f) };
  bcast(r, { type: 'present', ...r.presenting });
}

function upload(req, res, u) {
  const r = rooms.get(u.searchParams.get('room')), c = r && r.peers.get(req.headers['x-client']);
  if (!c) { req.resume(); return json(res, 403, { error: 'Sessão inválida' }); }
  let name = ''; try { name = decodeURIComponent(req.headers['x-filename'] || ''); } catch { }
  name = path.basename(name).replace(/[^\p{L}\p{N}._ -]/gu, '_').slice(0, 100) || 'arquivo';
  const ext = path.extname(name).toLowerCase();
  if (!TYPES[ext]) { req.resume(); return json(res, 415, { error: 'Tipo de arquivo não permitido' }); }
  if (+req.headers['content-length'] > MAX) { req.resume(); return json(res, 413, { error: 'Arquivo maior que 25 MB' }); }
  const chunks = []; let size = 0, big = false;
  req.on('data', d => { size += d.length; if (size > MAX) { big = true; chunks.length = 0; } else if (!big) chunks.push(d); });
  req.on('error', () => { });
  req.on('end', () => {
    if (big) return json(res, 413, { error: 'Arquivo maior que 25 MB' });
    if (!size) return json(res, 400, { error: 'Arquivo vazio' });
    const buf = Buffer.concat(chunks), m = MAGIC[ext];
    if (m && !m.every((b, i) => buf[i] === b)) return json(res, 415, { error: 'O conteúdo não corresponde à extensão' });
    if (['.txt', '.md', '.csv'].includes(ext) && buf.includes(0)) return json(res, 415, { error: 'Arquivo de texto inválido' });
    if (!rooms.has(r.id)) return json(res, 410, { error: 'Sala encerrada' });
    const f = { id: crypto.randomBytes(8).toString('hex'), name, size, ext, buf };
    r.files.set(f.id, f);
    bcast(r, { type: 'file', from: c.id, fname: c.name, file: pubFile(r, f), ts: Date.now() });
    if (u.searchParams.get('present') === '1') present(r, c, f);
    json(res, 200, pubFile(r, f));
  });
}

const findIndex = () => [path.join(__dirname, 'index.html'), path.join(process.cwd(), 'index.html')].find(p => fs.existsSync(p));
const handler = (req, res) => {
  const u = new URL(req.url, 'http://x'), p = u.pathname;
  if (req.method === 'POST' && p === '/upload') return upload(req, res, u);
  const fm = p.match(/^\/files\/([\w-]+)\/(\w+)$/);
  if (req.method === 'GET' && fm) {
    const r = rooms.get(fm[1]), f = r && r.files.get(fm[2]);
    if (!f) return json(res, 404, { error: 'Arquivo não encontrado' });
    res.writeHead(200, {
      'Content-Type': TYPES[f.ext], 'Content-Length': f.size, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'private, max-age=3600',
      'Content-Disposition': `${u.searchParams.get('dl') ? 'attachment' : 'inline'}; filename*=UTF-8''${encodeURIComponent(f.name)}`
    });
    return res.end(f.buf);
  }
  if (req.method === 'GET' && (p === '/' || p === '/index.html' || /^\/room\/[\w-]+$/.test(p))) {
    const ip = findIndex();
    if (!ip) return json(res, 500, { error: 'index.html não encontrado. Coloque-o na mesma pasta do server.js: ' + __dirname });
    return fs.readFile(ip, (e, d) => {
      if (e) return json(res, 500, { error: 'Não foi possível ler o index.html' });
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'X-Content-Type-Options': 'nosniff', 'Permissions-Policy': 'camera=(self), microphone=(self), display-capture=(self)' });
      res.end(d);
    });
  }
  json(res, 404, { error: 'Não encontrado' });
};

// ---------- WebSocket mínimo (RFC 6455) ----------
function frame(sock, op, payload) {
  if (sock.destroyed) return;
  const n = payload.length; let h;
  if (n < 126) h = Buffer.from([0x80 | op, n]);
  else if (n < 65536) { h = Buffer.alloc(4); h[0] = 0x80 | op; h[1] = 126; h.writeUInt16BE(n, 2); }
  else { h = Buffer.alloc(10); h[0] = 0x80 | op; h[1] = 127; h.writeBigUInt64BE(BigInt(n), 2); }
  sock.write(Buffer.concat([h, payload]));
}
function parse(c) {
  for (;;) {
    const b = c.buf; if (b.length < 2) return;
    let len = b[1] & 127, off = 2;
    if (len === 126) { if (b.length < 4) return; len = b.readUInt16BE(2); off = 4; }
    else if (len === 127) { if (b.length < 10) return; len = Number(b.readBigUInt64BE(2)); off = 10; }
    const masked = b[1] & 128; if (masked) off += 4;
    if (len > 1 << 20) return c.sock.destroy();
    if (b.length < off + len) return;
    const op = b[0] & 15, data = Buffer.from(b.subarray(off, off + len));
    if (masked) { const k = b.subarray(off - 4, off); for (let i = 0; i < len; i++) data[i] ^= k[i & 3]; }
    c.buf = b.subarray(off + len);
    if (op === 8) { frame(c.sock, 8, Buffer.alloc(0)); return c.sock.end(); }
    if (op === 9) frame(c.sock, 10, data);
    else if (op === 1) { try { onMsg(c, JSON.parse(data.toString())); } catch { } }
  }
}
function onUpgrade(req, sock) {
  const key = req.headers['sec-websocket-key'];
  if (!key || req.url.split('?')[0] !== '/ws') return sock.destroy();
  const acc = crypto.createHash('sha1').update(key + GUID).digest('base64');
  sock.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + acc + '\r\n\r\n');
  sock.setNoDelay(true);
  const c = {
    sock, buf: Buffer.alloc(0), id: crypto.randomBytes(4).toString('hex'), room: null, name: '',
    state: { mic: true, cam: true, share: false, hand: false }, send(o) { frame(sock, 1, Buffer.from(JSON.stringify(o))); }
  };
  sock.on('data', d => { c.buf = Buffer.concat([c.buf, d]); parse(c); });
  sock.on('close', () => leave(c));
  sock.on('error', () => sock.destroy());
}
function onMsg(c, m) {
  if (m.type === 'join') {
    if (c.room || typeof m.room !== 'string' || !/^[\w-]{3,40}$/.test(m.room)) return;
    c.name = String(m.name || '').trim().slice(0, 30) || 'Convidado';
    const r = getRoom(m.room); c.room = r;
    c.send({ type: 'welcome', id: c.id, peers: [...r.peers.values()].map(pubPeer), presenting: r.presenting });
    r.peers.set(c.id, c);
    return bcast(r, { type: 'peer-joined', peer: pubPeer(c) }, c.id);
  }
  const r = c.room; if (!r) return;
  switch (m.type) {
    case 'signal': { const t = r.peers.get(m.to); if (t) t.send({ type: 'signal', from: c.id, data: m.data }); break; }
    case 'chat': { const text = String(m.text || '').trim().slice(0, 2000); if (text) bcast(r, { type: 'chat', from: c.id, fname: c.name, text, ts: Date.now() }); break; }
    case 'state': c.state = { mic: !!m.mic, cam: !!m.cam, share: !!m.share, hand: !!m.hand }; bcast(r, { type: 'state', id: c.id, state: c.state }, c.id); break;
    case 'present': { const f = r.files.get(m.file); if (f) present(r, c, f); break; }
    case 'react': if (['👍', '👏', '❤️', '😂', '😮', '🎉'].includes(m.emoji)) bcast(r, { type: 'react', id: c.id, emoji: m.emoji }); break;
    case 'caption': { const text = String(m.text || '').slice(0, 300); if (text) bcast(r, { type: 'caption', id: c.id, name: c.name, text }, c.id); break; }
    case 'present-stop': r.presenting = null; bcast(r, { type: 'present-stop' }); break;
  }
}
function leave(c) {
  const r = c.room; if (!r) return; c.room = null;
  r.peers.delete(c.id); bcast(r, { type: 'peer-left', id: c.id });
  if (r.presenting && r.presenting.by === c.id) { r.presenting = null; bcast(r, { type: 'present-stop' }); }
  if (!r.peers.size) rooms.delete(r.id); // sala vazia: apaga arquivos da memória
}

// ---------- HTTPS automático (câmera/microfone exigem contexto seguro) ----------
const net = require('net');
const lanIPs = () => Object.values(os.networkInterfaces()).flat().filter(i => i && i.family === 'IPv4' && !i.internal).map(i => i.address);
const der = (tag, ...c) => { const b = Buffer.concat(c), l = b.length; return Buffer.concat([Buffer.from([tag, ...(l < 128 ? [l] : l < 256 ? [0x81, l] : [0x82, l >> 8, l & 255])]), b]); };
const oid = h => Buffer.from(h, 'hex');
function selfSigned(list) { // certificado X.509 autoassinado, só com o módulo crypto
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const alg = der(0x30, oid('06092a864886f70d01010b'), Buffer.from([5, 0]));
  const name = der(0x30, der(0x31, der(0x30, oid('0603550403'), der(0x0c, Buffer.from('Prosa')))));
  const t = d => der(0x17, Buffer.from(d.toISOString().replace(/[-:T]/g, '').slice(2, 14) + 'Z'));
  const now = Date.now();
  const san = der(0x30, der(0x82, Buffer.from('localhost')), der(0x87, Buffer.from([127, 0, 0, 1])), ...list.map(ip => der(0x87, Buffer.from(ip.split('.').map(Number)))));
  const ext = der(0xa3, der(0x30, der(0x30, oid('0603551d11'), der(0x04, san))));
  const tbs = der(0x30, Buffer.from([0xa0, 3, 2, 1, 2]), der(0x02, Buffer.concat([Buffer.from([1]), crypto.randomBytes(8)])), alg, name,
    der(0x30, t(new Date(now - 864e5)), t(new Date(now + 365 * 864e5))), name, publicKey.export({ type: 'spki', format: 'der' }), ext);
  const sig = crypto.sign('sha256', tbs, privateKey);
  const cert = der(0x30, tbs, alg, der(0x03, Buffer.concat([Buffer.from([0]), sig])));
  return { key: privateKey.export({ type: 'pkcs8', format: 'pem' }), cert: '-----BEGIN CERTIFICATE-----\n' + cert.toString('base64').match(/.{1,64}/g).join('\n') + '\n-----END CERTIFICATE-----\n' };
}
function tlsOpts() {
  if (process.env.SSL_KEY && process.env.SSL_CERT) return { key: fs.readFileSync(process.env.SSL_KEY), cert: fs.readFileSync(process.env.SSL_CERT) };
  const dir = path.join(__dirname, '.cert'), id = lanIPs().sort().join(',');
  try { if (fs.readFileSync(dir + '/ips.txt', 'utf8') === id) return { key: fs.readFileSync(dir + '/key.pem'), cert: fs.readFileSync(dir + '/cert.pem') }; } catch { }
  const o = selfSigned(lanIPs()); // regenera se os IPs da máquina mudarem
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(dir + '/key.pem', o.key); fs.writeFileSync(dir + '/cert.pem', o.cert); fs.writeFileSync(dir + '/ips.txt', id);
  return o;
}
function banner(proto) {
  if (!findIndex()) console.log('\n*** ATENÇÃO: index.html não encontrado. Coloque-o na mesma pasta do server.js:\n    ' + __dirname + '\n');
  console.log(`Prosa rodando em ${proto}://localhost:${PORT}`);
  lanIPs().forEach(ip => console.log(`Na rede local:     ${proto}://${ip}:${PORT}`));
  if (proto === 'https' && !process.env.SSL_KEY) console.log('\nPrimeiro acesso: o navegador avisa que o certificado não é confiável.\nClique em "Avançado" → "Continuar" (é seu próprio certificado, gerado localmente).');
}
if (process.env.HTTP === '1') { // modo HTTP puro (só localhost tem câmera/microfone)
  const s = http.createServer(handler); s.on('upgrade', onUpgrade); s.listen(PORT, () => banner('http'));
} else { // HTTPS e HTTP na mesma porta: quem abrir http:// é redirecionado para https://
  const tls = https.createServer(tlsOpts(), handler); tls.on('upgrade', onUpgrade);
  const redir = http.createServer((req, res) => { res.writeHead(301, { Location: 'https://' + (req.headers.host || 'localhost') + req.url }); res.end(); });
  net.createServer(s => {
    s.on('error', () => { });
    s.once('data', d => { s.pause(); s.unshift(d); (d[0] === 0x16 ? tls : redir).emit('connection', s); process.nextTick(() => s.resume()); });
  }).listen(PORT, () => banner('https'));
}
