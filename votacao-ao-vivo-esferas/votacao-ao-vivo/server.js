'use strict';
/*
 * Votação ao vivo — servidor único, sem dependências (Node 18+).
 *
 *   /           página do participante (celular)
 *   /screen     telão: QR Code, barras em tempo real, cronômetro e vencedor
 *   /admin      controle do apresentador (celular ou segundo computador)
 *   /events     stream SSE (tempo real)
 *   /api/vote   voto do participante
 *   /api/admin  ações do apresentador (exigem a chave de admin)
 *
 * Tempo real via Server-Sent Events: o navegador reconecta sozinho e passa
 * por qualquer proxy/túnel HTTPS sem configuração especial.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = Number(process.env.PORT) || 3000;
const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const QUESTIONS_FILE = process.env.QUESTIONS_FILE || path.join(ROOT, 'questions.json');
const STATE_FILE = process.env.STATE_FILE || path.join(ROOT, 'data', 'state.json');
// No Render, RENDER_EXTERNAL_URL já traz o endereço público (ex.: https://yesquestions.onrender.com).
const PUBLIC_URL = (process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || '').replace(/\/+$/, '');
const GRACE_MS = 500; // tolerância para votos em trânsito quando o tempo acaba

/* ------------------------------------------------------------------ config */

function fail(msg) {
  console.error('\n[erro] ' + msg + '\n');
  process.exit(1);
}

function loadConfig() {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(QUESTIONS_FILE, 'utf8'));
  } catch (e) {
    fail(`Não consegui ler ${QUESTIONS_FILE}: ${e.message}`);
  }
  if (!raw || !Array.isArray(raw.questions) || raw.questions.length === 0) {
    fail('questions.json precisa ter a lista "questions" com pelo menos uma pergunta.');
  }
  raw.questions.forEach((q, i) => {
    const n = i + 1;
    if (!q || typeof q.text !== 'string' || !q.text.trim()) fail(`Pergunta ${n}: falta o campo "text".`);
    if (!Array.isArray(q.options) || q.options.length < 2 || q.options.length > 8) {
      fail(`Pergunta ${n}: "options" precisa ter de 2 a 8 opções.`);
    }
    q.options.forEach((o, j) => {
      if (typeof o !== 'string' || !o.trim()) fail(`Pergunta ${n}, opção ${j + 1}: texto vazio.`);
    });
    if (q.correct !== undefined && q.correct !== null) {
      if (!Number.isInteger(q.correct) || q.correct < 0 || q.correct >= q.options.length) {
        fail(`Pergunta ${n}: "correct" precisa ser o número da opção certa (0 = A, 1 = B, ...).`);
      }
    }
  });
  return {
    title: String(raw.title || 'Votação ao vivo'),
    voteSeconds: Math.max(5, Math.min(600, Number(process.env.VOTE_SECONDS) || Number(raw.voteSeconds) || 40)),
    questions: raw.questions.map((q) => ({
      title: typeof q.title === 'string' ? q.title.trim() : '',
      text: q.text.trim(),
      options: q.options.map((o) => o.trim()),
      correct: Number.isInteger(q.correct) ? q.correct : null,
    })),
  };
}

const config = loadConfig();
const questions = config.questions;
const TOTAL = questions.length;
const VOTE_SECONDS = config.voteSeconds;
const SIGNATURE = crypto.createHash('sha1').update(JSON.stringify(questions)).digest('hex');

const ADMIN_KEY = process.env.ADMIN_KEY || crypto.randomBytes(4).toString('hex');
const ADMIN_KEY_HASH = crypto.createHash('sha256').update(ADMIN_KEY).digest();

function isAdminKey(k) {
  if (typeof k !== 'string' || !k) return false;
  const h = crypto.createHash('sha256').update(k).digest();
  return crypto.timingSafeEqual(h, ADMIN_KEY_HASH);
}

/* ------------------------------------------------------------------- state */
/*
 * phase: lobby (aguardando início) → ready (pergunta na tela) → voting
 *        (cronômetro rodando) → closed (resultado) → ... → finished
 */

function freshState() {
  return {
    phase: 'lobby',
    index: -1,
    endsAt: 0,
    counts: questions.map((q) => q.options.map(() => 0)),
    voters: questions.map(() => ({})), // voterId -> índice da opção
  };
}

let state = freshState();
let closeTimer = null;
let dirty = false;

function markDirty() {
  dirty = true;
}

function saveNow() {
  if (!dirty) return;
  dirty = false;
  try {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    const tmp = STATE_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ signature: SIGNATURE, state }));
    fs.renameSync(tmp, STATE_FILE);
  } catch (e) {
    console.error('[aviso] não consegui salvar o estado:', e.message);
  }
}

function restore() {
  try {
    const saved = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    if (saved.signature !== SIGNATURE || !saved.state) return;
    const s = saved.state;
    if (!Array.isArray(s.counts) || s.counts.length !== TOTAL) return;
    state = s;
    if (state.phase === 'voting') {
      if (state.endsAt + GRACE_MS <= Date.now()) closeVoting();
      else armTimer();
    }
    console.log(`[ok] estado anterior restaurado (fase: ${state.phase}, pergunta ${state.index + 1}).`);
  } catch (_) {
    /* sem estado salvo */
  }
}

/* ---------------------------------------------------------------- results */

function sum(arr) {
  return arr.reduce((a, b) => a + b, 0);
}

function resultFor(i) {
  const counts = state.counts[i];
  const total = sum(counts);
  const max = Math.max(...counts);
  const winners = max > 0 ? counts.map((v, k) => (v === max ? k : -1)).filter((k) => k >= 0) : [];
  return { counts, total, winners, correct: questions[i].correct };
}

/* ---------------------------------------------------------------- clients */

const clients = new Set(); // { res, role, voterId }
const voterRefs = new Map(); // voterId -> conexões abertas

function participantCount() {
  return voterRefs.size;
}

function send(c, event, data) {
  try {
    if (c.res.writableLength > 256 * 1024) return c.res.destroy(); // cliente travado: ele reconecta
    c.res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  } catch (_) {
    /* conexão caiu; o 'close' limpa */
  }
}

function stateFor(c) {
  const q = state.index >= 0 && state.index < TOTAL ? questions[state.index] : null;
  const s = {
    phase: state.phase,
    index: state.index,
    total: TOTAL,
    title: config.title,
    voteSeconds: VOTE_SECONDS,
    endsAt: state.phase === 'voting' ? state.endsAt : 0,
    serverNow: Date.now(),
    question: q ? { title: q.title, text: q.text, options: q.options } : null,
  };
  if (c.role === 'vote') {
    const mine = q && c.voterId ? state.voters[state.index][c.voterId] : undefined;
    s.myVote = Number.isInteger(mine) ? mine : null;
  } else {
    s.connected = participantCount();
  }
  if (state.phase === 'closed' && q) s.result = resultFor(state.index);
  if (state.phase === 'finished') {
    s.summary = questions.map((qq, i) => ({ title: qq.title, text: qq.text, options: qq.options, ...resultFor(i) }));
  }
  return s;
}

function countsPayload() {
  const i = state.index;
  const counts = i >= 0 ? state.counts[i] : [];
  return { index: i, counts, totalVotes: sum(counts), connected: participantCount() };
}

function broadcastState() {
  for (const c of clients) send(c, 'state', stateFor(c));
  pushCounts();
}

function pushCounts() {
  const payload = countsPayload();
  for (const c of clients) if (c.role !== 'vote') send(c, 'counts', payload);
}

let countsTimer = null;
function scheduleCounts() {
  if (countsTimer) return;
  countsTimer = setTimeout(() => {
    countsTimer = null;
    pushCounts();
  }, 150);
}

/* ------------------------------------------------------------ transitions */

function armTimer() {
  clearTimeout(closeTimer);
  const ms = Math.max(0, state.endsAt + GRACE_MS - Date.now());
  closeTimer = setTimeout(closeVoting, ms);
}

function closeVoting() {
  if (state.phase !== 'voting') return false;
  clearTimeout(closeTimer);
  state.phase = 'closed';
  state.endsAt = 0;
  markDirty();
  broadcastState();
  return true;
}

function adminAction(action) {
  switch (action) {
    case 'next': {
      if (state.phase === 'lobby') {
        state.index = 0;
        state.phase = 'ready';
      } else if (state.phase === 'closed') {
        if (state.index + 1 >= TOTAL) {
          state.phase = 'finished';
        } else {
          state.index += 1;
          state.phase = 'ready';
        }
      } else {
        return { ok: false, error: 'Encerre a votação atual antes de avançar.' };
      }
      state.endsAt = 0;
      break;
    }
    case 'start': {
      if (state.phase !== 'ready') return { ok: false, error: 'A votação só pode começar com a pergunta na tela.' };
      state.phase = 'voting';
      state.endsAt = Date.now() + VOTE_SECONDS * 1000;
      armTimer();
      break;
    }
    case 'close': {
      if (state.phase !== 'voting') return { ok: false, error: 'Não há votação em andamento.' };
      closeVoting();
      return { ok: true };
    }
    case 'redo': {
      if (!['ready', 'voting', 'closed'].includes(state.phase)) {
        return { ok: false, error: 'Nada para refazer agora.' };
      }
      clearTimeout(closeTimer);
      state.counts[state.index] = questions[state.index].options.map(() => 0);
      state.voters[state.index] = {};
      state.phase = 'ready';
      state.endsAt = 0;
      break;
    }
    case 'back': {
      if (state.phase === 'ready' && state.index > 0) {
        state.index -= 1;
        state.phase = 'closed';
      } else if (state.phase === 'ready' && state.index === 0) {
        state.index = -1;
        state.phase = 'lobby';
      } else if (state.phase === 'finished') {
        state.index = TOTAL - 1;
        state.phase = 'closed';
      } else {
        return { ok: false, error: 'Só é possível voltar com a pergunta na tela (antes de iniciar a votação).' };
      }
      state.endsAt = 0;
      break;
    }
    case 'reset': {
      clearTimeout(closeTimer);
      state = freshState();
      break;
    }
    default:
      return { ok: false, error: 'Ação desconhecida.' };
  }
  markDirty();
  broadcastState();
  return { ok: true };
}

/* ------------------------------------------------------------------- http */

function readBody(req, limit = 4096) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (ch) => {
      size += ch.length;
      if (size > limit) {
        reject(new Error('payload'));
        req.destroy();
        return;
      }
      chunks.push(ch);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
      } catch (e) {
        reject(new Error('json'));
      }
    });
    req.on('error', reject);
  });
}

function json(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(data),
  });
  res.end(data);
}

const VOTER_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;

async function handleVote(req, res) {
  let body;
  try {
    body = await readBody(req);
  } catch (_) {
    return json(res, 400, { ok: false, error: 'Requisição inválida.' });
  }
  const { voterId, qIndex, option } = body;
  if (typeof voterId !== 'string' || !VOTER_ID_RE.test(voterId)) {
    return json(res, 400, { ok: false, error: 'Identificação inválida.' });
  }
  if (state.phase !== 'voting' || qIndex !== state.index || Date.now() > state.endsAt + GRACE_MS) {
    return json(res, 409, { ok: false, error: 'A votação está encerrada.' });
  }
  const opts = questions[state.index].options;
  if (!Number.isInteger(option) || option < 0 || option >= opts.length) {
    return json(res, 400, { ok: false, error: 'Opção inválida.' });
  }
  const voters = state.voters[state.index];
  if (Object.prototype.hasOwnProperty.call(voters, voterId)) {
    return json(res, 409, { ok: false, error: 'Você já votou nesta pergunta.', option: voters[voterId] });
  }
  voters[voterId] = option;
  state.counts[state.index][option] += 1;
  markDirty();
  scheduleCounts();
  return json(res, 200, { ok: true, option });
}

async function handleAdmin(req, res) {
  let body;
  try {
    body = await readBody(req);
  } catch (_) {
    return json(res, 400, { ok: false, error: 'Requisição inválida.' });
  }
  if (!isAdminKey(body.key)) return json(res, 401, { ok: false, error: 'Chave de admin incorreta.' });
  if (body.action === 'check') return json(res, 200, { ok: true });
  const r = adminAction(body.action);
  return json(res, r.ok ? 200 : 409, r);
}

function handleEvents(req, res, url) {
  const role = ['vote', 'screen', 'admin'].includes(url.searchParams.get('role')) ? url.searchParams.get('role') : 'vote';
  let voterId = url.searchParams.get('voter') || '';
  if (!VOTER_ID_RE.test(voterId)) voterId = '';
  if (role !== 'vote') voterId = '';

  req.socket.setTimeout(0);
  req.socket.setNoDelay(true);
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('retry: 1500\n\n');

  const client = { res, role, voterId };
  clients.add(client);
  const firstOfVoter = voterId && !voterRefs.has(voterId);
  if (voterId) voterRefs.set(voterId, (voterRefs.get(voterId) || 0) + 1);

  send(client, 'state', stateFor(client));
  if (role !== 'vote') send(client, 'counts', countsPayload());
  if (firstOfVoter || role === 'vote') scheduleCounts();

  req.on('close', () => {
    clients.delete(client);
    if (voterId) {
      const n = (voterRefs.get(voterId) || 1) - 1;
      if (n <= 0) voterRefs.delete(voterId);
      else voterRefs.set(voterId, n);
      scheduleCounts();
    }
  });
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
};

const PAGES = { '/': 'index.html', '/screen': 'screen.html', '/admin': 'admin.html' };

function serveStatic(req, res, pathname) {
  const rel = PAGES[pathname] || decodeURIComponent(pathname).replace(/^\/+/, '');
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (file !== PUBLIC_DIR && !file.startsWith(PUBLIC_DIR + path.sep)) {
    res.writeHead(403).end('Proibido');
    return;
  }
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Não encontrado');
      return;
    }
    const ext = path.extname(file).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Content-Length': st.size,
      'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=300',
    });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).pipe(res);
  });
}

const server = http.createServer((req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  let url;
  try {
    url = new URL(req.url, 'http://localhost');
  } catch (_) {
    return res.writeHead(400).end();
  }
  const p = url.pathname;
  try {
    if (req.method === 'GET' && p === '/events') return handleEvents(req, res, url);
    if (req.method === 'POST' && p === '/api/vote') return void handleVote(req, res);
    if (req.method === 'POST' && p === '/api/admin') return void handleAdmin(req, res);
    if (req.method === 'GET' && p === '/api/config') {
      return json(res, 200, { title: config.title, voteSeconds: VOTE_SECONDS, publicUrl: PUBLIC_URL });
    }
    if (req.method === 'GET' && p === '/healthz') return json(res, 200, { ok: true });
    if (req.method === 'GET' || req.method === 'HEAD') return serveStatic(req, res, p);
    res.writeHead(405).end();
  } catch (e) {
    console.error(e);
    if (!res.headersSent) res.writeHead(500);
    res.end();
  }
});

// Mantém as conexões SSE vivas por trás de proxies/túneis com timeout de ociosidade.
setInterval(() => {
  for (const c of clients) {
    try {
      c.res.write(': ping\n\n');
    } catch (_) {
      /* ignora */
    }
  }
}, 20000).unref();

setInterval(saveNow, 2000).unref();

function shutdown() {
  saveNow();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

restore();
server.listen(PORT, '0.0.0.0', () => {
  const base = PUBLIC_URL || `http://localhost:${PORT}`;
  console.log('');
  console.log(`  ${config.title}  —  ${TOTAL} perguntas, ${VOTE_SECONDS}s por votação`);
  console.log('');
  console.log(`  Participantes : ${base}/`);
  console.log(`  Telão         : ${base}/screen?key=${ADMIN_KEY}`);
  console.log(`  Controle      : ${base}/admin?key=${ADMIN_KEY}`);
  console.log('');
  if (!process.env.ADMIN_KEY) {
    console.log('  (chave de admin gerada agora; defina ADMIN_KEY para fixar uma)');
    console.log('');
  }
});
