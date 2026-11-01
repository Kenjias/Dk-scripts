// DK – Hromadné posílání surovin (verze pro RYCHLOU VOLBU / mobilní aplikaci)
// Spuštění z rychlé volby:
//   javascript:$.getScript('https://TVOJE-JMENO.github.io/dk-skripty/suroviny.js');void(0);
// Každé kliknutí na „Poslat další“ = jedno odeslání z jedné vesnice.

(function () {
  'use strict';

  const gd = window.game_data;
  if (!gd || !gd.player) { alert('Spusť to ve hře (Divoké kmeny).'); return; }
  // druhé kliknutí v rychlé volbě jen znovu otevře okno
  if (window.__dkSuroviny && window.__dkSuroviny.open) { window.__dkSuroviny.open(); return; }

  // ================= NASTAVENÍ =================
  const LS_KEY = 'dkSuroviny_' + gd.world;
  const DEFAULTS = {
    targetId: 0,          // cílová vesnice (id)
    targetCoord: '',      // nebo souřadnice cizí vesnice (např. spoluhráče)
    off: [],              // vesnice, ze kterých se NEposílá (id) – noví členové jsou tak automaticky zapnutí
    ratio: 'third',       // third = 1/3 každé suroviny, coin = poměr na mince (28 000 : 30 000 : 25 000)
    reserve: 0,           // kolik surovin každého druhu nechat ve zdrojové vesnici
    cap: 1000,            // nosnost jednoho obchodníka
    redistribute: false,  // když jedné suroviny chybí, dorovnat ostatními
    noOverflow: true,     // nepřeplnit sklad cílové vesnice (jen vlastní cíl)
    minSend: 1000,        // menší zásilky neposílat
  };
  const COIN = { wood: 28000, stone: 30000, iron: 25000 };   // cena 1 mince na CZ světech
  const RES = ['wood', 'stone', 'iron'];
  const RES_NAME = { wood: 'Dřevo', stone: 'Hlína', iron: 'Železo' };
  const REQ_DELAY_MS = 250;

  // ================= POMOCNÉ =================
  const $ = (s, r = document) => r.querySelector(s);
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmt = n => Math.round(n || 0).toLocaleString('cs-CZ');
  const num = t => { const n = parseInt(String(t || '').replace(/[^\d]/g, ''), 10); return isNaN(n) ? 0 : n; };
  const coordRe = /(\d{1,3})\|(\d{1,3})/;
  const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

  function loadCfg() {
    try { return Object.assign({}, DEFAULTS, JSON.parse(localStorage.getItem(LS_KEY) || '{}')); }
    catch (e) { return { ...DEFAULTS }; }
  }
  const cfg = loadCfg();
  const saveCfg = () => { try { localStorage.setItem(LS_KEY, JSON.stringify(cfg)); } catch (e) { /* nic */ } };

  function gameMsg(text, isError) {
    try {
      if (window.UI) { isError ? window.UI.ErrorMessage(text, 4000) : window.UI.SuccessMessage(text, 2500); return; }
    } catch (e) { /* nic */ }
    console.log('[DK Suroviny] ' + text);
  }

  function gameUrl(params) {
    const u = new URL('/game.php', location.origin);
    u.searchParams.set('village', gd.village.id);
    const t = new URLSearchParams(location.search).get('t');   // zástup
    if (t) u.searchParams.set('t', t);
    for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
    return u.toString();
  }

  async function fetchDoc(params) {
    const r = await fetch(gameUrl(params), { credentials: 'include' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const doc = new DOMParser().parseFromString(await r.text(), 'text/html');
    if (doc.querySelector('#bot_check, .bot-protection-row, #botprotection_quest, #popup_box_bot_protection')) {
      throw new Error('Hra ukázala ochranu proti botům – vyřeš ji ve hře a načti znovu.');
    }
    return doc;
  }

  // ================= NAČTENÍ VESNIC =================
  // číslo suroviny v řádku: buď je přímo v prvku s třídou (.res.wood), nebo hned ZA ikonkou (.icon.header.wood)
  function resValue(row, r) {
    for (const el of row.querySelectorAll('.' + r)) {
      if (/\d/.test(el.textContent)) return num(el.textContent);
      let t = '', n = el.nextSibling;
      while (n) {
        if (n.nodeType === 1 && (n.matches('.wood, .stone, .iron') || n.querySelector('.wood, .stone, .iron'))) break;
        t += n.textContent;
        n = n.nextSibling;
      }
      const m = t.match(/\d+(?:\.\d{3})*/);
      if (m) return num(m[0]);
    }
    return null;
  }

  // data hry (game_data) z HTML libovolné stránky – suroviny a sklad vesnice, vždy spolehlivé
  function parseGameData(html) {
    for (const key of ['updateGameData(', 'game_data = ', 'game_data=']) {
      const i = html.indexOf(key);
      if (i < 0) continue;
      const start = html.indexOf('{', i);
      if (start < 0) continue;
      let depth = 0, inStr = false, bs = false;
      for (let j = start; j < html.length; j++) {
        const ch = html[j];
        if (inStr) { if (bs) bs = false; else if (ch === '\\') bs = true; else if (ch === '"') inStr = false; continue; }
        if (ch === '"') inStr = true;
        else if (ch === '{') depth++;
        else if (ch === '}' && --depth === 0) {
          try { const g = JSON.parse(html.slice(start, j + 1)); if (g && g.village) return g; } catch (e) { /* nic */ }
          break;
        }
      }
    }
    return null;
  }

  // 1) Přehledy → Produkce (všechny vesnice jedním načtením)
  function parseProduction(doc) {
    const table = doc.querySelector('#production_table') || [...doc.querySelectorAll('table')].find(t => t.querySelector('.res.wood, .wood'));
    if (!table) return null;
    const out = [];
    for (const row of table.querySelectorAll('tr')) {
      if (row.querySelector('th')) continue;
      const link = row.querySelector('a[href*="village="]');
      const label = row.querySelector('.quickedit-label') || link;
      const head = label ? label.textContent : row.cells[0] ? row.cells[0].textContent : '';
      const cm = coordRe.exec(head);
      if (!cm) continue;
      let id = 0;
      const dataId = row.querySelector('[data-id]');
      if (dataId) id = num(dataId.getAttribute('data-id'));
      if (!id && link) { const m = /village=(\d+)/.exec(link.getAttribute('href')); if (m) id = +m[1]; }
      if (!id) continue;

      const res = {};
      for (const r of RES) res[r] = resValue(row, r);
      if (RES.some(r => res[r] == null)) {
        // záloha: buňka se třemi čísly za sebou (tisíce oddělené tečkou)
        for (const c of row.cells) {
          const nums = (c.textContent.match(/\d+(?:\.\d{3})*/g) || []).map(num);
          if (nums.length === 3 && !c.textContent.includes('/')) { [res.wood, res.stone, res.iron] = nums; break; }
        }
      }
      let merchants = null, merchantsAll = null, storage = null;
      for (const c of row.cells) {
        const t = c.textContent.replace(/\s+/g, '');
        const mm = /^(\d+)\/(\d+)$/.exec(t);
        if (mm && c.querySelector('a[href*="market"]')) { merchants = +mm[1]; merchantsAll = +mm[2]; }
      }
      if (merchants == null) {
        // obchodníci bez odkazu: první buňka „x/y“, kde y je malé číslo (selský dvůr má tisíce)
        for (const c of row.cells) {
          const mm = /^(\d+)\/(\d+)$/.exec(c.textContent.replace(/[\s.]/g, ''));
          if (mm && +mm[2] <= 300) { merchants = +mm[1]; merchantsAll = +mm[2]; break; }
        }
      }
      // sklad: samostatné číslo v buňce s ikonkou skladu
      for (const c of row.cells) {
        if (c.querySelector('img[src*="storage"], .icon.header.ressources, [class*="storage"]') || /sklad/i.test(c.getAttribute('title') || '')) {
          const n = num(c.textContent); if (n) storage = n;
        }
      }
      if (storage == null) {
        const idx = [...(table.querySelector('tr') || { cells: [] }).cells]
          .findIndex(th => /sklad|storage|kapacita/i.test(th.textContent) || th.querySelector('img[src*="storage"]'));
        if (idx >= 0 && row.cells[idx]) storage = num(row.cells[idx].textContent);
      }
      out.push({ id, name: head.replace(/\s*\(\d{1,3}\|\d{1,3}\).*$/, '').trim(), x: +cm[1], y: +cm[2], ...res, merchants, merchantsAll, storage });
    }
    return out.length ? out : null;
  }

  // 2) Záloha: tržiště každé vesnice zvlášť
  async function loadViaMarket(ids, onProgress) {
    const out = [];
    for (let i = 0; i < ids.length; i++) {
      const v = ids[i];
      onProgress && onProgress(`Tržiště ${i + 1}/${ids.length}…`);
      try {
        const u = new URL('/game.php', location.origin);
        u.searchParams.set('village', v.id); u.searchParams.set('screen', 'market'); u.searchParams.set('mode', 'send');
        const r = await fetch(u, { credentials: 'include' });
        const html = await r.text();
        const doc = new DOMParser().parseFromString(html, 'text/html');
        if (doc.querySelector('#bot_check, .bot-protection-row, #botprotection_quest, #popup_box_bot_protection')) {
          throw new Error('Hra ukázala ochranu proti botům – vyřeš ji ve hře a načti znovu.');
        }
        const g = parseGameData(html);
        const gv = g && g.village;
        const res = {};
        for (const k of RES) {
          const el = doc.querySelector('#' + k);
          res[k] = gv && gv[k] != null ? Math.floor(gv[k]) : (el ? num(el.textContent) : 0);
        }
        const st = doc.querySelector('#storage');
        const mer = doc.querySelector('#market_merchant_available_count');
        const merAll = doc.querySelector('#market_merchant_total_count');
        out.push({ ...v, ...res,
          storage: gv && gv.storage_max ? Math.floor(gv.storage_max) : (st ? num(st.textContent) : v.storage ?? null),
          merchants: mer ? num(mer.textContent) : (v.merchants ?? 0),
          merchantsAll: merAll ? num(merAll.textContent) : (v.merchantsAll ?? null) });
      } catch (e) {
        if (/botům/.test(e.message)) throw e;
        out.push({ ...v, wood: 0, stone: 0, iron: 0, merchants: v.merchants ?? 0, err: e.message });
      }
      await sleep(REQ_DELAY_MS);
    }
    return out;
  }

  let villages = [];      // moje vesnice
  let worldIdx = null;    // "x|y" -> {id, name, owner}

  async function loadVillages(onProgress) {
    onProgress && onProgress('Načítám přehled produkce…');
    let list = null;
    try { list = parseProduction(await fetchDoc({ screen: 'overview_villages', mode: 'prod', page: -1 })); }
    catch (e) { if (/botům/.test(e.message)) throw e; }
    // kontrola: sedí suroviny z přehledu s aktuální vesnicí (game_data)? Když ne, přehled má jiný formát (např. v aplikaci)
    const cur = list && list.find(v => v.id === +gd.village.id);
    const gv = gd.village || {};
    const resBroken = list && (list.every(v => !v.wood && !v.stone && !v.iron) ||
      (cur && (gv.wood > 1000 || gv.stone > 1000 || gv.iron > 1000) &&
        RES.some(r => gv[r] != null && Math.abs((cur[r] || 0) - gv[r]) > Math.max(2000, gv[r] * 0.2))));
    if (!list || resBroken || list.some(v => v.merchants == null)) {
      // suroviny každé vesnice přímo z dat hry (tržiště vesnice); obchodníky z přehledu si nechá
      const idx = list ? null : await loadWorld();
      const mine = list || [...idx.values()].filter(v => v.owner === +gd.player.id).map(v => ({ id: v.id, name: v.name, x: v.x, y: v.y }));
      list = await loadViaMarket(mine, onProgress);
    }
    villages = list;
    return list;
  }

  async function loadWorld() {
    if (worldIdx) return worldIdx;
    const r = await fetch('/map/village.txt', { credentials: 'include' });
    const txt = await r.text();
    worldIdx = new Map();
    for (const line of txt.split('\n')) {
      const p = line.split(',');
      if (p.length < 5) continue;
      let name = p[1];
      try { name = decodeURIComponent(name.replace(/\+/g, ' ')); } catch (e) { /* nic */ }
      worldIdx.set(p[2] + '|' + p[3], { id: +p[0], name, x: +p[2], y: +p[3], owner: +p[4] });
    }
    return worldIdx;
  }

  // ================= VÝPOČET ZÁSILEK =================
  function ratioOf() {
    return cfg.ratio === 'coin' ? COIN : { wood: 1, stone: 1, iron: 1 };
  }

  // cílová vesnice: vlastní (s daty o skladu) nebo cizí podle souřadnic
  function currentTarget() {
    if (cfg.targetCoord) {
      const m = coordRe.exec(cfg.targetCoord);
      if (!m) return null;
      const key = m[1] + '|' + m[2];
      const own = villages.find(v => v.x + '|' + v.y === key);
      if (own) return own;
      const w = worldIdx && worldIdx.get(key);
      return w ? { id: w.id, name: w.name, x: w.x, y: w.y, foreign: true } : { id: 0, name: '?', x: +m[1], y: +m[2], foreign: true, unknown: true };
    }
    return villages.find(v => v.id === cfg.targetId) || null;
  }

  function computePlan() {
    const target = currentTarget();
    if (!target) return { target: null, rows: [] };
    const off = new Set(cfg.off.map(Number));
    const ratio = ratioOf();
    const R = RES.reduce((s, r) => s + ratio[r], 0);
    // volné místo ve skladu cíle (jen u vlastní vesnice, kde známe sklad)
    const free = {};
    const canLimit = cfg.noOverflow && !target.foreign && target.storage;
    for (const r of RES) free[r] = canLimit ? Math.max(0, target.storage - (target[r] || 0)) : Infinity;

    const rows = villages
      .filter(v => v.id !== target.id)
      .map(v => ({ v, d: dist(v, target) }))
      .sort((a, b) => a.d - b.d)   // nejbližší první = dorazí nejdřív
      .map(({ v, d }) => {
        const row = { v, d, on: !off.has(v.id), send: { wood: 0, stone: 0, iron: 0 }, total: 0, merchants: 0, note: '' };
        if (!row.on) return row;
        const cap = (v.merchants || 0) * cfg.cap;
        if (!cap) { row.note = 'žádní volní obchodníci'; return row; }
        const avail = {};
        for (const r of RES) avail[r] = Math.max(0, (v[r] || 0) - cfg.reserve);
        // rozdělení kapacity podle poměru
        const s = {};
        for (const r of RES) s[r] = Math.min(Math.floor(cap * ratio[r] / R), avail[r], free[r]);
        if (cfg.redistribute) {
          // zbytek kapacity doplnit surovinami, kterých je dost
          let left = cap - RES.reduce((a, r) => a + s[r], 0);
          for (let guard = 0; left > 0 && guard < 5; guard++) {
            const room = RES.filter(r => Math.min(avail[r], free[r]) > s[r]);
            if (!room.length) break;
            const per = Math.floor(left / room.length);
            if (per <= 0) break;
            for (const r of room) { const add = Math.min(per, Math.min(avail[r], free[r]) - s[r]); s[r] += add; left -= add; }
          }
        }
        for (const r of RES) s[r] = Math.max(0, Math.floor(s[r] / 100) * 100);   // na stovky
        const total = RES.reduce((a, r) => a + s[r], 0);
        if (total < cfg.minSend) { row.note = total ? `méně než ${fmt(cfg.minSend)}` : (RES.every(r => avail[r] <= 0) ? 'nemá suroviny' : 'sklad cíle je plný'); return row; }
        row.send = s; row.total = total; row.merchants = Math.ceil(total / cfg.cap);
        for (const r of RES) free[r] -= s[r];
        return row;
      });
    return { target, rows, canLimit };
  }

  // ================= ODESLÁNÍ =================
  // Jedno kliknutí = jedno odeslání z jedné vesnice (stejně jako tlačítko „Poslat“ na tržišti).
  const sent = new Map();   // id zdrojové vesnice -> 'ok' | 'err:…'

  function sendRow(row, target) {
    return new Promise((resolve) => {
      if (!window.TribalWars || typeof window.TribalWars.post !== 'function') {
        resolve({ ok: false, msg: 'Hra nenabízí odeslání (TribalWars.post) – načti stránku hry znovu.' });
        return;
      }
      const data = { target_id: target.id, wood: row.send.wood, stone: row.send.stone, iron: row.send.iron };
      try {
        window.TribalWars.post('market', { ajaxaction: 'map_send', village: row.v.id }, data,
          (resp) => resolve({ ok: true, msg: (resp && resp.message) || 'Odesláno' }),
          (err) => resolve({ ok: false, msg: (err && (err.message || err.error)) || 'Odeslání se nepovedlo' }));
      } catch (e) { resolve({ ok: false, msg: e.message }); }
    });
  }

  // ================= UI =================
  function injectStyles() {
    const st = document.createElement('style');
    st.textContent = `
      #dks-btn{position:fixed;left:10px;bottom:10px;z-index:99998;padding:8px 12px;font:bold 14px Verdana,Arial;background:#c1a264;
        border:1px solid #7d510f;border-radius:6px;color:#3b2504;cursor:pointer;box-shadow:0 2px 6px rgba(0,0,0,.35)}
      #dks{position:fixed;inset:4vh 3vw;z-index:100001;background:#f4e4bc;border:2px solid #7d510f;border-radius:8px;display:none;flex-direction:column;
        font:13px Verdana,Arial,sans-serif;color:#000;box-shadow:0 4px 20px rgba(0,0,0,.5)}
      #dks .hd{display:flex;align-items:center;gap:8px;padding:8px 10px;background:#c1a264;border-bottom:1px solid #7d510f;border-radius:6px 6px 0 0}
      #dks .hd b{flex:1;font-size:15px}
      #dks .bd{flex:1;overflow:auto;padding:8px 10px}
      #dks .row2{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-bottom:8px}
      #dks select,#dks input[type=text],#dks input[type=number]{font-size:14px;padding:3px}
      #dks .btn{font-size:13px;padding:5px 10px}
      #dks .big{font-size:16px !important;padding:10px 18px !important;font-weight:bold}
      #dks .opts{background:#fff8e6;border:1px solid #e3d3a6;border-radius:4px;padding:6px 8px;margin-bottom:8px;display:flex;flex-wrap:wrap;gap:6px 14px}
      #dks .sum{background:#fff8e6;border:1px solid #c1a264;border-radius:4px;padding:6px 8px;margin-bottom:8px}
      #dks .o{color:#6b5a3a;font-size:11px}
      #dks .warn{color:#b00000}
      #dks table{width:100%;border-collapse:collapse}
      #dks th{background:#c1a264;padding:4px;text-align:left;white-space:nowrap;position:sticky;top:0}
      #dks td{padding:4px;border-bottom:1px solid #e3d3a6;white-space:nowrap}
      #dks td.n{text-align:right}
      #dks tr.off td{opacity:.45}
      #dks tr.ok td{background:#d8f0c8}
      #dks tr.err td{background:#f6d0c8}
      #dks tr.next td{outline:2px solid #2e7d32;outline-offset:-2px}
      #dks .ft{padding:8px 10px;border-top:1px solid #7d510f;display:flex;flex-wrap:wrap;gap:8px;align-items:center;background:#ead6a6;border-radius:0 0 6px 6px}
      #dks .ft .st{flex:1;min-width:160px}
      #dks .ic{display:inline-block;width:14px;height:14px;vertical-align:middle;margin-right:2px;border-radius:2px}
      @media (max-width:700px){
        #dks{inset:0;border-radius:0}
        #dks table,#dks thead,#dks tbody,#dks tr,#dks td{display:block;width:auto}
        #dks thead{display:none}
        #dks tr{border:1px solid #e3d3a6;border-radius:6px;margin-bottom:6px;padding:4px 6px;background:#fff8e6}
        #dks td{border:none;padding:2px 0;white-space:normal}
        #dks td.n{text-align:left}
        #dks td[data-l]::before{content:attr(data-l) ': ';color:#6b5a3a;font-size:11px}
        #dks .big{width:100%}
      }`;
    document.head.appendChild(st);
  }

  let ui = null;
  let busy = false;

  function build() {
    injectStyles();

    const w = document.createElement('div');
    w.id = 'dks';
    w.innerHTML = `
      <div class="hd"><b>💰 Hromadné posílání surovin</b><button type="button" class="btn" data-close>✖</button></div>
      <div class="bd">
        <div class="row2"><b>Cíl:</b>
          <select data-target style="max-width:260px"></select>
          <span>nebo souřadnice</span><input type="text" data-tcoord placeholder="500|500" style="width:80px">
          <span class="o" data-tinfo></span>
        </div>
        <div class="opts">
          <label>Poměr <select data-ratio><option value="third">1/3 dřevo · 1/3 hlína · 1/3 železo</option><option value="coin">na mince (28 : 30 : 25)</option></select></label>
          <label>Nechat ve vesnici <input type="number" data-reserve min="0" step="1000" style="width:80px"> každé</label>
          <label>Nosnost obchodníka <input type="number" data-cap min="100" step="100" style="width:70px"></label>
          <label>Min. zásilka <input type="number" data-min min="0" step="500" style="width:70px"></label>
          <label><input type="checkbox" data-redis> dorovnat, když jedné suroviny chybí</label>
          <label><input type="checkbox" data-noover> nepřeplnit sklad cíle</label>
        </div>
        <div class="row2">
          <button type="button" class="btn" data-load>🔄 Načíst vesnice</button>
          <button type="button" class="btn" data-all>✔ všechny</button>
          <button type="button" class="btn" data-none>✖ žádná</button>
        </div>
        <div class="sum" data-sum>Klikni na „Načíst vesnice“.</div>
        <div data-list></div>
      </div>
      <div class="ft">
        <span class="st" data-st></span>
        <button type="button" class="btn big" data-next>▶ Poslat další</button>
      </div>`;
    document.body.appendChild(w);
    ui = { w, q: s => w.querySelector(s) };

    ui.q('[data-close]').onclick = () => { w.style.display = 'none'; };
    ui.q('[data-load]').onclick = () => reload();
    ui.q('[data-next]').onclick = () => sendNext();
    ui.q('[data-all]').onclick = () => { cfg.off = []; saveCfg(); render(); };
    ui.q('[data-none]').onclick = () => { cfg.off = villages.map(v => v.id); saveCfg(); render(); };

    const bindNum = (sel, key, min) => {
      const el = ui.q(sel);
      el.value = cfg[key];
      el.onchange = () => { cfg[key] = Math.max(min, Math.round(Number(el.value) || 0)); el.value = cfg[key]; saveCfg(); render(); };
    };
    bindNum('[data-reserve]', 'reserve', 0);
    bindNum('[data-cap]', 'cap', 100);
    bindNum('[data-min]', 'minSend', 0);
    const bindChk = (sel, key) => { const el = ui.q(sel); el.checked = !!cfg[key]; el.onchange = () => { cfg[key] = el.checked; saveCfg(); render(); }; };
    bindChk('[data-redis]', 'redistribute');
    bindChk('[data-noover]', 'noOverflow');
    const ratio = ui.q('[data-ratio]');
    ratio.value = cfg.ratio;
    ratio.onchange = () => { cfg.ratio = ratio.value; saveCfg(); render(); };

    ui.q('[data-target]').onchange = (e) => { cfg.targetId = +e.target.value; cfg.targetCoord = ''; ui.q('[data-tcoord]').value = ''; saveCfg(); sent.clear(); render(); };
    const tc = ui.q('[data-tcoord]');
    tc.value = cfg.targetCoord || '';
    tc.onchange = async () => {
      cfg.targetCoord = coordRe.test(tc.value) ? coordRe.exec(tc.value)[0] : '';
      tc.value = cfg.targetCoord;
      saveCfg(); sent.clear();
      if (cfg.targetCoord) { try { await loadWorld(); } catch (e) { /* nic */ } }
      render();
    };

    // Enter = poslat další (na PC rychlé odklikávání)
    w.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !/INPUT|SELECT|TEXTAREA/.test(document.activeElement.tagName)) { e.preventDefault(); sendNext(); }
    });
  }

  function setStatus(t) { if (ui) ui.q('[data-st]').textContent = t; }

  async function reload() {
    if (busy) return;
    busy = true;
    ui.q('[data-load]').disabled = true;
    try {
      await loadVillages(setStatus);
      if (cfg.targetCoord) { try { await loadWorld(); } catch (e) { /* nic */ } }
      sent.clear();
      setStatus(`Načteno ${villages.length} vesnic.`);
      render();
    } catch (e) {
      setStatus('⚠️ ' + e.message);
    } finally {
      busy = false;
      ui.q('[data-load]').disabled = false;
    }
  }

  function render() {
    if (!ui) return;
    // výběr cíle
    const sel = ui.q('[data-target]');
    sel.innerHTML = '<option value="0">– vyber svoji vesnici –</option>' + villages
      .slice().sort((a, b) => a.name.localeCompare(b.name, 'cs'))
      .map(v => `<option value="${v.id}"${v.id === cfg.targetId && !cfg.targetCoord ? ' selected' : ''}>${esc(v.name)} (${v.x}|${v.y})</option>`).join('');

    const { target, rows, canLimit } = computePlan();
    const tinfo = ui.q('[data-tinfo]');
    if (!target) tinfo.textContent = '';
    else if (target.unknown) tinfo.innerHTML = '<span class="warn">vesnice na těchto souřadnicích nenalezena</span>';
    else if (target.foreign) tinfo.textContent = `cizí vesnice: ${target.name}`;
    else tinfo.innerHTML = target.storage ? `sklad ${fmt(target.storage)} · teď ${RES.map(r => fmt(target[r])).join(' / ')}` : '';

    const sumEl = ui.q('[data-sum]');
    const list = ui.q('[data-list]');
    if (!villages.length) { sumEl.textContent = 'Klikni na „Načíst vesnice“.'; list.innerHTML = ''; updateNext(rows, target); return; }
    if (!target || target.unknown) { sumEl.innerHTML = '<b>Vyber cílovou vesnici</b> – ze seznamu nebo napiš souřadnice.'; list.innerHTML = ''; updateNext(rows, target); return; }

    const todo = rows.filter(r => r.total > 0 && !sent.has(r.v.id));
    const tot = { wood: 0, stone: 0, iron: 0 };
    let merch = 0;
    for (const r of todo) { for (const k of RES) tot[k] += r.send[k]; merch += r.merchants; }
    const coins = Math.floor(Math.min(...RES.map(k => (tot[k] + (target.foreign ? 0 : (target[k] || 0))) / COIN[k])));
    sumEl.innerHTML = `Pošle se z <b>${todo.length}</b> vesnic do <b>${esc(target.name)} (${target.x}|${target.y})</b>: ` +
      RES.map(k => `${RES_NAME[k]} <b>${fmt(tot[k])}</b>`).join(' · ') + ` · obchodníků ${fmt(merch)}` +
      (target.foreign ? '' : `<div class="o">Po doručení bude v cíli suroviny zhruba na <b>${coins}</b> ${coins === 1 ? 'minci' : coins >= 2 && coins <= 4 ? 'mince' : 'mincí'}.</div>`) +
      (cfg.noOverflow && target.foreign ? '<div class="o">U cizí vesnice neznám sklad – hlídání přeplnění nefunguje.</div>' : '') +
      (canLimit ? '<div class="o">Zásilky jsou omezené volným místem ve skladu cíle (suroviny, které už jsou na cestě, nevidím).</div>' : '');

    list.innerHTML = `<table><thead><tr><th></th><th>Vesnice</th><th>Vzdál.</th><th>Má (dř / hl / žel)</th><th>Obch.</th>
      <th>Pošle se</th><th></th></tr></thead><tbody>${rows.map((r, i) => {
        const st = sent.get(r.v.id);
        const cls = !r.on ? 'off' : st === 'ok' ? 'ok' : st && st.startsWith('err') ? 'err' : '';
        const what = r.total ? RES.map(k => `<span class="ic" style="background:${k === 'wood' ? '#8b5a2b' : k === 'stone' ? '#c46a3a' : '#7a7f86'}"></span>${fmt(r.send[k])}`).join(' ') : `<span class="o">${esc(r.note || '–')}</span>`;
        return `<tr class="${cls}" data-i="${i}">
          <td><input type="checkbox" data-src="${r.v.id}"${r.on ? ' checked' : ''}></td>
          <td data-l="Vesnice">${esc(r.v.name)} <span class="o">(${r.v.x}|${r.v.y})</span></td>
          <td class="n" data-l="Vzdálenost">${r.d.toFixed(1)}</td>
          <td class="n" data-l="Má">${fmt(r.v.wood)} / ${fmt(r.v.stone)} / ${fmt(r.v.iron)}</td>
          <td class="n" data-l="Obchodníci">${r.v.merchants ?? '?'}${r.v.merchantsAll ? '/' + r.v.merchantsAll : ''}</td>
          <td data-l="Pošle se">${what}</td>
          <td>${st === 'ok' ? '✅' : st && st.startsWith('err') ? `<span class="warn" title="${esc(st.slice(4))}">❌</span>` :
            r.total && r.on ? `<button type="button" class="btn" data-send="${r.v.id}">Poslat</button>` : ''}</td>
        </tr>`;
      }).join('')}</tbody></table>`;

    list.querySelectorAll('[data-src]').forEach(cb => {
      cb.onchange = () => {
        const s = new Set(cfg.off.map(Number));
        if (cb.checked) s.delete(+cb.dataset.src); else s.add(+cb.dataset.src);
        cfg.off = [...s]; saveCfg(); render();
      };
    });
    list.querySelectorAll('[data-send]').forEach(b => {
      b.onclick = () => { const r = rows.find(x => x.v.id === +b.dataset.send); if (r) doSend(r, target); };
    });
    updateNext(rows, target);
  }

  function nextRow(rows) {
    return rows.find(r => r.on && r.total > 0 && !sent.has(r.v.id));
  }

  function updateNext(rows, target) {
    const b = ui.q('[data-next]');
    const left = rows.filter(r => r.on && r.total > 0 && !sent.has(r.v.id)).length;
    const nx = target && !target.unknown ? nextRow(rows) : null;
    ui.w.querySelectorAll('tr.next').forEach(tr => tr.classList.remove('next'));
    if (nx) {
      const tr = ui.w.querySelector(`[data-src="${nx.v.id}"]`);
      if (tr) tr.closest('tr').classList.add('next');
    }
    b.disabled = !nx || busy;
    b.textContent = nx ? `▶ Poslat další (${left}) – ${nx.v.name}` : '▶ Poslat další';
  }

  async function doSend(row, target) {
    if (busy || !target || !target.id) return;
    busy = true;
    ui.q('[data-next]').disabled = true;
    setStatus(`Posílám z ${row.v.name}…`);
    const res = await sendRow(row, target);
    sent.set(row.v.id, res.ok ? 'ok' : 'err:' + res.msg);
    if (res.ok) {
      // odečíst odeslané a obchodníky, ať se další výpočty hned upraví
      for (const k of RES) row.v[k] = Math.max(0, (row.v[k] || 0) - row.send[k]);
      row.v.merchants = Math.max(0, (row.v.merchants || 0) - row.merchants);
      if (!target.foreign) for (const k of RES) target[k] = (target[k] || 0) + row.send[k];
    }
    busy = false;
    setStatus((res.ok ? '✅ ' : '❌ ') + `${row.v.name}: ${res.msg}`);
    gameMsg(`${row.v.name}: ${res.msg}`, !res.ok);
    render();
  }

  function sendNext() {
    const { target, rows } = computePlan();
    const nx = target ? nextRow(rows) : null;
    if (nx) doSend(nx, target);
  }

  function open() {
    if (!ui) build();
    ui.w.style.display = 'flex';
    if (!villages.length) reload(); else render();
  }

  // ================= START =================
  // z rychlé volby: okno se otevře hned
  window.__dkSuroviny = { open };
  open();
})();
