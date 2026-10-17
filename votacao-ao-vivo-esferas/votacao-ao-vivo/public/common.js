/* Utilitários compartilhados: conexão em tempo real, relógio sincronizado, QR, controles. */
(function () {
  'use strict';

  var offset = 0; // servidor - cliente (ms)

  function serverNow() {
    return Date.now() + offset;
  }

  /* ---------------------------------------------------------- tempo real */
  function connect(role, opts) {
    opts = opts || {};
    var es = null;
    var everOpened = false;

    function open() {
      var q = 'role=' + encodeURIComponent(role);
      if (opts.voterId) q += '&voter=' + encodeURIComponent(opts.voterId);
      es = new EventSource('/events?' + q);
      es.onopen = function () {
        everOpened = true;
        if (opts.onStatus) opts.onStatus(true);
      };
      es.onerror = function () {
        if (opts.onStatus) opts.onStatus(false);
        // EventSource reconecta sozinho; se o navegador desistir, reabrimos.
        if (es.readyState === 2) {
          es.close();
          setTimeout(open, 1500);
        }
      };
      es.addEventListener('state', function (ev) {
        var s = JSON.parse(ev.data);
        offset = s.serverNow - Date.now();
        if (opts.onState) opts.onState(s);
      });
      es.addEventListener('counts', function (ev) {
        if (opts.onCounts) opts.onCounts(JSON.parse(ev.data));
      });
    }
    open();
    // Ao voltar para a aba/tela, garante que a conexão ainda existe.
    document.addEventListener('visibilitychange', function () {
      if (!document.hidden && es && es.readyState === 2) {
        es.close();
        open();
      }
    });
  }

  /* ----------------------------------------------------- identificação */
  function getVoterId() {
    var key = 'votacao:voterId';
    var id = null;
    try { id = localStorage.getItem(key); } catch (e) {}
    if (!id || !/^[A-Za-z0-9_-]{8,64}$/.test(id)) {
      if (window.crypto && crypto.randomUUID) id = crypto.randomUUID();
      else id = 'v' + Date.now().toString(36) + Math.random().toString(36).slice(2, 12);
      try { localStorage.setItem(key, id); } catch (e) {}
    }
    return id;
  }

  /* ------------------------------------------------------------------ QR */
  function qrSvg(text) {
    var qr = new window.QRCode(-1, window.QRErrorCorrectLevel.M);
    qr.addData(text);
    qr.make();
    var n = qr.getModuleCount();
    var margin = 2;
    var d = '';
    for (var r = 0; r < n; r++) {
      for (var c = 0; c < n; c++) {
        if (qr.isDark(r, c)) d += 'M' + (c + margin) + ' ' + (r + margin) + 'h1v1h-1z';
      }
    }
    var size = n + margin * 2;
    return (
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + size + ' ' + size + '" shape-rendering="crispEdges">' +
      '<rect width="100%" height="100%" fill="#fff"/><path d="' + d + '" fill="#000"/></svg>'
    );
  }

  function joinUrl(publicUrl) {
    return (publicUrl || location.origin).replace(/\/+$/, '') + '/';
  }

  function prettyUrl(u) {
    return u.replace(/^https?:\/\//, '').replace(/\/$/, '');
  }

  /* ------------------------------------------------------------ controle */
  function post(action, key) {
    return fetch('/api/admin', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: action, key: key }),
    }).then(function (r) {
      return r.json().catch(function () { return { ok: false, error: 'Falha de comunicação.' }; });
    }).catch(function () {
      return { ok: false, error: 'Sem conexão com o servidor.' };
    });
  }

  function primaryAction(s) {
    switch (s.phase) {
      case 'lobby': return { action: 'next', label: 'Começar — mostrar pergunta 1', kind: 'primary' };
      case 'ready': return { action: 'start', label: 'Iniciar votação (' + s.voteSeconds + 's)', kind: 'go' };
      case 'voting': return { action: 'close', label: 'Encerrar agora', kind: 'stop' };
      case 'closed':
        return s.index + 1 < s.total
          ? { action: 'next', label: 'Próxima pergunta →', kind: 'primary' }
          : { action: 'next', label: 'Finalizar', kind: 'primary' };
      default: return null;
    }
  }

  function secondaryActions(s, totalVotes) {
    var list = [];
    if (s.phase === 'ready' || s.phase === 'finished') list.push({ action: 'back', label: '← Voltar' });
    if (s.phase === 'ready' || s.phase === 'voting' || s.phase === 'closed') {
      list.push({
        action: 'redo',
        label: 'Refazer pergunta',
        confirm: totalVotes > 0 ? 'Apagar os ' + totalVotes + ' votos desta pergunta e refazer?' : null,
      });
    }
    list.push({ action: 'reset', label: 'Reiniciar tudo', confirm: 'Apagar TODOS os votos e voltar ao início?', danger: true });
    return list;
  }

  // Uma requisição leve a cada 4 min: hospedagens gratuitas hibernam sem tráfego de entrada.
  function keepAlive() {
    setInterval(function () {
      fetch('/healthz', { cache: 'no-store' }).catch(function () {});
    }, 4 * 60 * 1000);
  }

  function fmtSeconds(ms) {
    return Math.max(0, Math.ceil(ms / 1000));
  }

  window.Live = {
    connect: connect,
    serverNow: serverNow,
    getVoterId: getVoterId,
    qrSvg: qrSvg,
    joinUrl: joinUrl,
    prettyUrl: prettyUrl,
    post: post,
    primaryAction: primaryAction,
    secondaryActions: secondaryActions,
    fmtSeconds: fmtSeconds,
    keepAlive: keepAlive,
  };
})();
