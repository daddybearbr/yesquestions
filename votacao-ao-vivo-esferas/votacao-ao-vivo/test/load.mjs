// Teste de carga e de fluxo: sobe o servidor, conecta 300 participantes + telão + controle,
// roda as perguntas e confere se a contagem, o vencedor e as fases estão corretos.
//
//   node test/load.mjs            (usa 300 participantes)
//   VOTERS=500 node test/load.mjs
import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const PORT = 3100 + Math.floor(Math.random() * 400);
const KEY = 'chave-de-teste';
const VOTERS = Number(process.env.VOTERS) || 300;
const SECONDS = 6;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'votacao-'));
const agent = new http.Agent({ keepAlive: false, maxSockets: Infinity });

let failures = 0;
function check(cond, msg) {
  if (cond) console.log('  ok   ' + msg);
  else { failures++; console.log('  FALHA ' + msg); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const srv = spawn(process.execPath, [path.join(root, 'server.js')], {
  env: { ...process.env, PORT, ADMIN_KEY: KEY, VOTE_SECONDS: SECONDS, STATE_FILE: path.join(tmp, 'state.json') },
  stdio: ['ignore', 'pipe', 'inherit'],
});
await new Promise((resolve, reject) => {
  srv.stdout.on('data', (d) => { if (String(d).includes('Participantes')) resolve(); });
  srv.on('exit', (c) => reject(new Error('servidor saiu: ' + c)));
  setTimeout(() => reject(new Error('servidor não subiu')), 5000);
});

function request(method, p, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request({ host: '127.0.0.1', port: PORT, path: p, method, agent,
      headers: data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {} }, (res) => {
      let buf = '';
      res.on('data', (c) => (buf += c));
      res.on('end', () => { let j = null; try { j = JSON.parse(buf); } catch (_) {} resolve({ status: res.statusCode, body: j, raw: buf }); });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}
const admin = (action, key = KEY) => request('POST', '/api/admin', { action, key });

function openSSE(role, voterId) {
  const c = { role, voterId, state: null, counts: null, states: [], req: null, stamps: [] };
  const q = `role=${role}` + (voterId ? `&voter=${voterId}` : '');
  c.req = http.get({ host: '127.0.0.1', port: PORT, path: '/events?' + q, agent }, (res) => {
    let buf = '';
    res.setEncoding('utf8');
    res.on('data', (chunk) => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, i); buf = buf.slice(i + 2);
        const ev = /^event: (.+)$/m.exec(block); const dt = /^data: (.+)$/m.exec(block);
        if (!ev || !dt) continue;
        const data = JSON.parse(dt[1]);
        if (ev[1] === 'state') { c.state = data; c.states.push(data.phase + ':' + data.index); c.stamps.push(Date.now()); }
        if (ev[1] === 'counts') c.counts = data;
      }
    });
  });
  c.req.on('error', () => {});
  c.close = () => c.req.destroy();
  return c;
}

async function until(fn, timeout = 8000, label = '') {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) { if (fn()) return Date.now() - t0; await sleep(20); }
  throw new Error('timeout esperando: ' + label);
}

const vote = (voterId, qIndex, option) => request('POST', '/api/vote', { voterId, qIndex, option });
const sum = (a) => a.reduce((x, y) => x + y, 0);

try {
  console.log(`\nServidor na porta ${PORT} — ${VOTERS} participantes\n`);

  console.log('Conexões');
  const voters = Array.from({ length: VOTERS }, (_, i) => openSSE('vote', 'voter-' + String(i).padStart(5, '0') + '-xx'));
  const screen = openSSE('screen');
  const panel = openSSE('admin');
  await until(() => voters.every((v) => v.state) && screen.state && panel.state, 8000, 'conexões');
  await until(() => screen.counts && screen.counts.connected === VOTERS, 4000, 'contagem de conectados');
  check(true, `${VOTERS} participantes + telão + controle conectados`);
  check(screen.counts.connected === VOTERS, `telão mostra ${screen.counts.connected} conectados`);
  check(voters.every((v) => v.state.phase === 'lobby'), 'todos começam no lobby');

  console.log('\nSegurança básica');
  check((await admin('next', 'errada')).status === 401, 'chave errada é rejeitada (401)');
  check((await admin('start')).status === 409, 'iniciar votação fora de hora é recusado (409)');
  check((await vote('voter-00000-xx', 0, 0)).status === 409, 'voto fora da votação é recusado (409)');
  check((await vote('x', 0, 0)).status === 400, 'identificação inválida é recusada (400)');
  check((await request('GET', '/../server.js')).status !== 200, 'não serve arquivos fora de /public');

  const questions = JSON.parse(fs.readFileSync(path.join(root, 'questions.json'), 'utf8')).questions;
  const expected = [];

  for (let q = 0; q < questions.length; q++) {
    console.log(`\nPergunta ${q + 1}: ${questions[q].text}`);
    const nOpts = questions[q].options.length;

    let t = Date.now();
    check((await admin('next')).status === 200, 'avançar mostra a pergunta');
    const dReady = await until(() => voters.every((v) => v.state.phase === 'ready' && v.state.index === q), 4000, 'ready');
    check(true, `${VOTERS} celulares receberam "pergunta na tela" em ${dReady} ms`);

    check((await admin('start')).status === 200, 'iniciar votação');
    await until(() => voters.every((v) => v.state.phase === 'voting'), 4000, 'voting');
    const endsAt = voters[0].state.endsAt;
    check(Math.abs(endsAt - Date.now() - SECONDS * 1000) < 1500, `cronômetro de ${SECONDS}s definido pelo servidor`);

    // Cada participante vota (distribuição enviesada para existir um vencedor claro, exceto na 3ª: forçamos empate).
    const tally = new Array(nOpts).fill(0);
    const pick = (i) => (q === 2 ? i % nOpts : Math.random() < 0.5 ? 0 : Math.floor(Math.random() * nOpts));
    const results = await Promise.all(voters.map(async (v, i) => {
      await sleep(Math.random() * 2500);
      const opt = pick(i);
      const r = await vote(v.voterId, q, opt);
      if (r.status === 200) tally[opt]++;
      return r.status;
    }));
    check(results.every((s) => s === 200), `${VOTERS} votos aceitos`);

    // duplicados não contam
    const dup = await Promise.all(voters.slice(0, 40).map((v) => vote(v.voterId, q, (pick(0) + 1) % nOpts)));
    check(dup.every((r) => r.status === 409 && Number.isInteger(r.body.option)), '40 tentativas de voto duplicado recusadas (409)');

    // reconexão no meio da votação preserva "já votei"
    const probe = voters[7];
    probe.close();
    const re = openSSE('vote', probe.voterId);
    await until(() => re.state, 3000, 'reconexão');
    check(Number.isInteger(re.state.myVote), 'participante que reconecta continua marcado como "já votou"');
    voters[7] = re;

    await until(() => screen.counts && sum(screen.counts.counts) === VOTERS, 3000, 'contagem no telão');
    check(JSON.stringify(screen.counts.counts) === JSON.stringify(tally), `telão em tempo real bate com o total: ${tally.join(' / ')}`);
    check(!('counts' in voters[0].state) && !voters[0].state.result, 'celulares não recebem a parcial durante a votação');

    // espera o fechamento automático
    const dClose = await until(() => voters.every((v) => v.state.phase === 'closed'), 12000, 'fechamento');
    check(Date.now() >= endsAt, `votação encerrou sozinha ao fim dos ${SECONDS}s`);
    const late = await vote('voter-late-00001', q, 0);
    check(late.status === 409, 'voto atrasado é recusado');

    const res = screen.state.result;
    const max = Math.max(...tally);
    const winners = tally.map((v, i) => (v === max ? i : -1)).filter((i) => i >= 0);
    check(JSON.stringify(res.counts) === JSON.stringify(tally), 'resultado final confere com os votos enviados');
    check(res.correct === questions[q].correct, `resposta correta revelada só no fim: ${String.fromCharCode(65 + res.correct)}`);
    check(!voters.slice(0, 5).some((v) => JSON.stringify(v.states).includes('"correct"')), 'resposta correta não vaza durante a votação');
    check(JSON.stringify(res.winners) === JSON.stringify(winners), `vencedor correto: ${winners.map((i) => questions[q].options[i]).join(' + ')}${winners.length > 1 ? ' (empate)' : ''}`);
    check(voters.every((v) => v.state.result && v.state.result.winners.length === winners.length), 'todos os celulares receberam o resultado');
    expected.push({ winners, total: VOTERS });

    if (q === 1) {
      console.log('  — testando "refazer pergunta"');
      check((await admin('redo')).status === 200, 'refazer pergunta');
      await until(() => voters.every((v) => v.state.phase === 'ready' && v.state.myVote === null), 4000, 'redo');
      check(screen.counts.totalVotes === 0, 'votos da pergunta zerados');
      check((await admin('start')).status === 200, 'iniciar de novo');
      await until(() => voters.every((v) => v.state.phase === 'voting'), 4000, 'voting 2');
      const r2 = await Promise.all(voters.slice(0, 50).map((v) => vote(v.voterId, q, 1)));
      check(r2.every((r) => r.status === 200), '50 participantes conseguem votar de novo');
      check((await admin('close')).status === 200, 'encerrar antes do tempo funciona');
      await until(() => voters.every((v) => v.state.phase === 'closed'), 3000, 'closed manual');
      check(screen.state.result.counts[1] === 50, 'resultado refeito: 50 votos na opção B');
      expected[q] = { winners: [1], total: 50 };
    }
  }

  console.log('\nFinalização');
  check((await admin('next')).status === 200, 'finalizar');
  await until(() => voters.every((v) => v.state.phase === 'finished'), 4000, 'finished');
  const sumry = screen.state.summary;
  check(sumry.length === questions.length, 'telão recebe o resumo de todas as perguntas');
  check(sumry.every((s, i) => JSON.stringify(s.winners) === JSON.stringify(expected[i].winners) && s.total === expected[i].total), 'resumo final confere');

  console.log('\nPersistência');
  await sleep(2300);
  const saved = JSON.parse(fs.readFileSync(path.join(tmp, 'state.json'), 'utf8'));
  check(saved.state.phase === 'finished', 'estado salvo em disco (sobrevive a reinício)');

  voters.forEach((v) => v.close()); screen.close(); panel.close();
} catch (e) {
  failures++;
  console.log('\n  FALHA ' + e.message);
} finally {
  srv.kill('SIGTERM');
  await sleep(200);
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(failures ? `\n${failures} verificação(ões) falharam.\n` : '\nTudo certo.\n');
process.exit(failures ? 1 : 0);
