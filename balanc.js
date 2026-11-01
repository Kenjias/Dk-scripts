// DK – Balanc surovin (verze pro RYCHLOU VOLBU / mobilní aplikaci)
// Spuštění z rychlé volby:
//   javascript:$.getScript('https://TVOJE-JMENO.github.io/REPOZITAR/balanc.js');void(0);

(function () {
  'use strict';

  const gd = window.game_data;
  if (!gd || !gd.player) { alert('Spusť to ve hře (Divoké kmeny).'); return; }
  if (window.__dkBalanc && window.__dkBalanc.open) { window.__dkBalanc.open(); return; }

  // ================= NASTAVENÍ =================
  const LS_KEY = 'dkBalanc_' + gd.world;
  const DEFAULTS = {
    off: [],          // vesnice, které se balancu neúčastní (neposílají ani nedostávají), id
    reserve: 0,       // kolik každé suroviny nechat v posílající vesnici
    cap: 1000,        // nosnost jednoho obchodníka
    minSend: 1000,    // menší zásilky neposílat
    tolerance: 3,     // rozdíl menší než tolik % skladu se neřeší
    pauseMin: 10,     // „Poslat vše“: náhodná pauza mezi zásilkami od … (s)
    pauseMax: 20,     // … do (s)
  };
  const RES = ['wood', 'stone', 'iron'];
  const RES_NAME = { wood: 'Dřevo', stone: 'Hlína', iron: 'Železo' };
  const RES_COLOR = { wood: '#8b5a2b', stone: '#c46a3a', iron: '#7a7f86' };
  const REQ_DELAY_MS = 250;

  // ================= POMOCNÉ =================
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmt = n => Math.round(n || 0).toLocaleString('cs-CZ');
  const pct = (a, b) => (b > 0 ? Math.round(a / b * 100) : 0);
  const num = t => { const n = parseInt(String(t || '').replace(/[^\d]/g, ''), 10); return isNaN(n) ? 0 : n; };
  const coordRe = /(\d{1,3})\|(\d{1,3})/;
  const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  const BOT_SEL = '#bot_check, .bot-protection-row, #botprotection_quest, #popup_box_bot_protection';

  function loadCfg() {
    try { return Object.assign({}, DEFAULTS, JSON.parse(localStorage.getItem(LS_KEY) || '{}')); }
    catch (e) { return { ...DEFAULTS }; }
  }
  const cfg = loadCfg();
  const saveCfg = () => { try { localStorage.setItem(LS_KEY, JSON.stringify(cfg)); } catch (e) { /* nic */ } };

  function gameMsg(text, isError) {
    try { if (window.UI) { isError ? window.UI.ErrorMessage(text, 4000) : window.UI.SuccessMessage(text, 2500); return; } } catch (e) { /* nic */ }
    console.log('[DK Balanc] ' + text);
  }

  function gameUrl(params, villageId) {
    const u = new URL('/game.php', location.origin);
    u.searchParams.set('village', villageId || gd.village.id);
    const t = new URLSearchParams(location.search).get('t');   // zástup
    if (t) u.searchParams.set('t', t);
    for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
    return u.toString();
  }

  async function fetchHtml(params, villageId) {
    const r = await fetch(gameUrl(params, villageId), { credentials: 'include' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const html = await r.text();
    const doc = new DOMParser().parseFromString(html, 'text/html');
    if (doc.querySelector(BOT_SEL)) throw new Error('Hra ukázala ochranu proti botům – vyřeš ji ve hře a načti znovu.');
    return { html, doc };
  }

  // ================= NAČTENÍ VESNIC =================
  // číslo suroviny: přímo v prvku (.res.wood), nebo hned ZA ikonkou (.icon.header.wood) – tak to je v aplikaci
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

  // Přehledy → Produkce (prémiový účet): všechny vesnice jedním načtením
  function parseProduction(doc) {
    const table = doc.querySelector('#production_table') || [...doc.querySelectorAll('table')].find(t => t.querySelector('.wood'));
    if (!table) return null;
    const head = [...(table.querySelector('tr') || { cells: [] }).cells];
    const storIdx = head.findIndex(th => /sklad|storage|kapacita/i.test(th.textContent) || th.querySelector('img[src*="storage"], .storage'));
    const out = [];
    for (const row of table.querySelectorAll('tr')) {
      if (row.querySelector('th')) continue;
      const link = row.querySelector('a[href*="village="]');
      const label = row.querySelector('.quickedit-label') || link;
      const text = label ? label.textContent : (row.cells[0] ? row.cells[0].textContent : '');
      const cm = coordRe.exec(text);
      if (!cm) continue;
      let id = 0;
      const dataId = row.querySelector('[data-id]');
      if (dataId) id = num(dataId.getAttribute('data-id'));
      if (!id && link) { const m = /village=(\d+)/.exec(link.getAttribute('href')); if (m) id = +m[1]; }
      if (!id) continue;
      const res = {};
      for (const r of RES) res[r] = resValue(row, r);
      if (RES.some(r => res[r] == null)) {
        for (const c of row.cells) {
          const nums = (c.textContent.match(/\d+(?:\.\d{3})*/g) || []).map(num);
          if (nums.length === 3 && !c.textContent.includes('/')) { [res.wood, res.stone, res.iron] = nums; break; }
        }
      }
      let merchants = null, merchantsAll = null;
      for (const c of row.cells) {
        const mm = /^(\d+)\/(\d+)$/.exec(c.textContent.replace(/\s+/g, ''));
        if (mm && c.querySelector('a[href*="market"]')) { merchants = +mm[1]; merchantsAll = +mm[2]; }
      }
      if (merchants == null) {
        for (const c of row.cells) {
          const mm = /^(\d+)\/(\d+)$/.exec(c.textContent.replace(/[\s.]/g, ''));
          if (mm && +mm[2] <= 300) { merchants = +mm[1]; merchantsAll = +mm[2]; break; }
        }
      }
      const storage = storIdx >= 0 && row.cells[storIdx] ? num(row.cells[storIdx].textContent) || null : null;
      out.push({ id, name: text.replace(/\s*\(\d{1,3}\|\d{1,3}\).*$/, '').trim(), x: +cm[1], y: +cm[2], ...res, merchants, merchantsAll, storage });
    }
    return out.length ? out : null;
  }

  // pojistka: tržiště každé vesnice (suroviny a sklad z dat hry, obchodníci z tržiště)
  async function loadViaMarket(list, onProgress) {
    const out = [];
    for (let i = 0; i < list.length; i++) {
      const v = list[i];
      onProgress && onProgress(`Načítám vesnici ${i + 1}/${list.length}…`);
      try {
        const { html, doc } = await fetchHtml({ screen: 'market', mode: 'send' }, v.id);
        const g = parseGameData(html);
        const gv = (g && g.village) || {};
        const mer = doc.querySelector('#market_merchant_available_count');
        const merAll = doc.querySelector('#market_merchant_total_count');
        out.push({ ...v,
          wood: gv.wood != null ? Math.floor(gv.wood) : (v.wood || 0),
          stone: gv.stone != null ? Math.floor(gv.stone) : (v.stone || 0),
          iron: gv.iron != null ? Math.floor(gv.iron) : (v.iron || 0),
          storage: gv.storage_max ? Math.floor(gv.storage_max) : (v.storage || null),
          merchants: mer ? num(mer.textContent) : (v.merchants ?? 0),
          merchantsAll: merAll ? num(merAll.textContent) : (v.merchantsAll ?? null) });
      } catch (e) {
        if (/botům/.test(e.message)) throw e;
        out.push({ ...v, err: e.message });
      }
      await sleep(REQ_DELAY_MS);
    }
    return out;
  }

  async function loadMyVillageList() {
    const r = await fetch('/map/village.txt', { credentials: 'include' });
    const txt = await r.text();
    const out = [];
    for (const line of txt.split('\n')) {
      const p = line.split(',');
      if (p.length < 5 || +p[4] !== +gd.player.id) continue;
      let name = p[1];
      try { name = decodeURIComponent(name.replace(/\+/g, ' ')); } catch (e) { /* nic */ }
      out.push({ id: +p[0], name, x: +p[2], y: +p[3] });
    }
    return out;
  }

  let villages = [];

  async function loadVillages(onProgress) {
    onProgress && onProgress('Načítám přehled produkce…');
    let list = null;
    try { const { doc } = await fetchHtml({ screen: 'overview_villages', mode: 'prod', page: -1 }); list = parseProduction(doc); }
    catch (e) { if (/botům/.test(e.message)) throw e; }
    // kontrola proti datům hry u aktuální vesnice – jiný formát přehledu (aplikace) se tím pozná
    const cur = list && list.find(v => v.id === +gd.village.id);
    const gv = gd.village || {};
    const broken = !list || list.every(v => !v.wood && !v.stone && !v.iron) || list.some(v => !v.storage || v.merchants == null) ||
      (cur && RES.some(r => gv[r] > 1000 && Math.abs((cur[r] || 0) - gv[r]) > Math.max(2000, gv[r] * 0.2)));
    if (broken) list = await loadViaMarket(list || await loadMyVillageList(), onProgress);
    villages = list.filter(v => !v.err);
    return villages;
  }

  // ================= VÝPOČET BALANCU =================
  // Pro každou surovinu: cílové zaplnění f = součet surovin / součet skladů (zúčastněných vesnic).
  // Cíl vesnice = f × její sklad. Nad cílem = přebytek, pod cílem = nedostatek.
  // Zásilky: dvojice (přebytek → nedostatek) od nejbližších; omezené obchodníky a nikdy nad cíl příjemce (= nikdy nad sklad).
  function computePlan() {
    const off = new Set(cfg.off.map(Number));
    const vs = villages.filter(v => !off.has(v.id) && v.storage > 0);
    const plan = { vs, f: {}, ships: [], after: new Map() };
    if (vs.length < 2) return plan;

    const sumS = vs.reduce((a, v) => a + v.storage, 0);
    const sur = new Map(), def = new Map();
    for (const r of RES) plan.f[r] = Math.min(1, vs.reduce((a, v) => a + (v[r] || 0), 0) / sumS);
    for (const v of vs) {
      const s = {}, d = {};
      const tol = v.storage * cfg.tolerance / 100;
      for (const r of RES) {
        const target = plan.f[r] * v.storage;
        const diff = (v[r] || 0) - target;
        s[r] = diff > tol ? Math.max(0, (v[r] || 0) - Math.max(target, cfg.reserve)) : 0;
        d[r] = -diff > tol ? -diff : 0;
      }
      sur.set(v, s); def.set(v, d);
    }
    const capLeft = new Map(vs.map(v => [v, (v.merchants || 0) * cfg.cap]));

    const pairs = [];
    for (const a of vs) {
      const sa = sur.get(a);
      if (!RES.some(r => sa[r] > 0) || !capLeft.get(a)) continue;
      for (const b of vs) {
        if (a === b) continue;
        const db = def.get(b);
        if (RES.some(r => sa[r] > 0 && db[r] > 0)) pairs.push({ a, b, d: dist(a, b) });
      }
    }
    pairs.sort((x, y) => x.d - y.d);

    for (const { a, b, d } of pairs) {
      const sa = sur.get(a), db = def.get(b);
      const cap = capLeft.get(a);
      if (cap < cfg.minSend) continue;
      const want = {};
      let total = 0;
      for (const r of RES) { want[r] = Math.min(sa[r], db[r]); total += want[r]; }
      if (total <= 0) continue;
      const k = total > cap ? cap / total : 1;   // málo obchodníků -> poměrně zkrátit
      const send = {};
      let sum = 0;
      for (const r of RES) { send[r] = Math.floor(want[r] * k / 100) * 100; sum += send[r]; }
      if (sum < cfg.minSend) continue;
      for (const r of RES) { sa[r] -= send[r]; db[r] -= send[r]; }
      capLeft.set(a, cap - sum);
      plan.ships.push({ v: a, to: b, d, send, total: sum, merchants: Math.ceil(sum / cfg.cap), key: a.id + '>' + b.id });
    }

    // stav po balancu (pro přehled vesnic)
    for (const v of vs) plan.after.set(v, { wood: v.wood || 0, stone: v.stone || 0, iron: v.iron || 0 });
    for (const s of plan.ships) {
      if (sent.get(s.key) === 'ok') continue;
      const fa = plan.after.get(s.v), fb = plan.after.get(s.to);
      for (const r of RES) { fa[r] -= s.send[r]; fb[r] += s.send[r]; }
    }
    return plan;
  }

  // ================= ODESLÁNÍ =================
  const sent = new Map();   // key "odkud>kam" -> 'ok' | 'err:…'
  let plan = { vs: [], f: {}, ships: [], after: new Map() };

  function sendShip(s) {
    return new Promise((resolve) => {
      if (!window.TribalWars || typeof window.TribalWars.post !== 'function') {
        resolve({ ok: false, msg: 'Hra nenabízí odeslání (TribalWars.post) – načti stránku hry znovu.' });
        return;
      }
      try {
        window.TribalWars.post('market', { ajaxaction: 'map_send', village: s.v.id },
          { target_id: s.to.id, wood: s.send.wood, stone: s.send.stone, iron: s.send.iron },
          (resp) => resolve({ ok: true, msg: (resp && resp.message) || 'Odesláno' }),
          (err) => resolve({ ok: false, msg: (err && (err.message || err.error)) || 'Odeslání se nepovedlo' }));
      } catch (e) { resolve({ ok: false, msg: e.message }); }
    });
  }

  // ================= UI =================
  let ui = null, busy = false, sendingAll = false;


  function injectStyles() {
    const st = document.createElement('style');
    st.textContent = `
      #dkb{position:fixed;inset:4vh 3vw;z-index:100001;background:#f4e4bc;border:2px solid #7d510f;border-radius:8px;display:none;flex-direction:column;
        font:13px Verdana,Arial,sans-serif;color:#000;box-shadow:0 4px 20px rgba(0,0,0,.5)}
      #dkb .hd{display:flex;align-items:center;gap:8px;padding:8px 10px;background:#c1a264;border-bottom:1px solid #7d510f;border-radius:6px 6px 0 0}
      #dkb .hd b{flex:1;font-size:15px}
      #dkb .bd{flex:1;overflow:auto;padding:8px 10px}
      #dkb .row2{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-bottom:8px}
      #dkb input[type=number]{font-size:14px;padding:3px}
      #dkb .btn{font-size:13px;padding:5px 10px}
      #dkb .big{font-size:16px !important;padding:10px 18px !important;font-weight:bold}
      #dkb .opts{background:#fff8e6;border:1px solid #e3d3a6;border-radius:4px;padding:6px 8px;margin-bottom:8px;display:flex;flex-wrap:wrap;gap:6px 14px}
      #dkb .sum{background:#fff8e6;border:1px solid #c1a264;border-radius:4px;padding:6px 8px;margin-bottom:8px}
      #dkb .o{color:#6b5a3a;font-size:11px}
      #dkb details{margin-bottom:8px}
      #dkb summary{cursor:pointer;font-weight:bold;padding:4px 0}
      #dkb table{width:100%;border-collapse:collapse}
      #dkb th{background:#c1a264;padding:4px;text-align:left;white-space:nowrap}
      #dkb td{padding:4px;border-bottom:1px solid #e3d3a6;white-space:nowrap}
      #dkb td.n{text-align:right}
      #dkb tr.off td{opacity:.45}
      #dkb tr.ok td{background:#d8f0c8}
      #dkb tr.err td{background:#f6d0c8}
      #dkb tr.next td{outline:2px solid #2e7d32;outline-offset:-2px}
      #dkb .bar{display:inline-block;width:56px;height:8px;background:#e3d3a6;border-radius:2px;vertical-align:middle;overflow:hidden;margin-right:3px}
      #dkb .bar i{display:block;height:100%}
      #dkb .ic{display:inline-block;width:12px;height:12px;vertical-align:middle;margin:0 2px 0 4px;border-radius:2px}
      #dkb .ft{padding:8px 10px;border-top:1px solid #7d510f;display:flex;flex-wrap:wrap;gap:8px;align-items:center;background:#ead6a6;border-radius:0 0 6px 6px}
      #dkb .ft .st{flex:1;min-width:160px}
      #dkb .optbox{margin-bottom:8px;background:#fff8e6;border:1px solid #e3d3a6;border-radius:4px;padding:2px 8px}
      #dkb .optbox > summary{cursor:pointer;font-weight:bold;padding:4px 0}
      #dkb .optbox .opts{border:none;background:none;padding:4px 0;margin:0}
      @media (max-width:700px){
        #dkb{inset:0;border-radius:0;font-size:12px}
        /* tlačítka hned pod nadpisem – dole je překrývá lišta aplikace (Menu / Hra / Mapa / Účet) */
        #dkb .hd{order:-2;padding:6px 8px}
        #dkb .ft{order:-1;border-top:none;border-bottom:1px solid #7d510f;border-radius:0;padding:6px 8px;gap:6px}
        #dkb .ft .st{flex-basis:100%;order:3;font-size:11px;min-width:0}
        #dkb .big{flex:1 1 0;width:auto;font-size:14px !important;padding:8px 6px !important;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
        #dkb .bd{padding:6px 8px 120px}
        #dkb .btn{font-size:12px;padding:4px 8px}
        #dkb table,#dkb thead,#dkb tbody,#dkb tr{display:block;width:auto}
        #dkb thead{display:none}
        #dkb tr{border:1px solid #e3d3a6;border-radius:6px;margin-bottom:4px;padding:3px 6px;background:#fff8e6}
        /* buňky vedle sebe -> karta má 2–3 řádky místo 6 */
        #dkb td{display:inline-block;border:none;padding:1px 8px 1px 0;white-space:nowrap;vertical-align:middle}
        #dkb td.n{text-align:left}
        #dkb td[data-l]::before{content:attr(data-l) ': ';color:#6b5a3a;font-size:10px}
        #dkb td:last-child .btn{padding:3px 10px}
        #dkb .sum{padding:4px 6px;font-size:12px}
        #dkb .sum .o{display:none}
      }`;
    document.head.appendChild(st);
  }

  function build() {
    injectStyles();
    const w = document.createElement('div');
    w.id = 'dkb';
    w.innerHTML = `
      <div class="hd"><b>⚖️ Balanc surovin</b><button type="button" class="btn" data-close>✖</button></div>
      <div class="bd">
        <details class="optbox"><summary>⚙️ Nastavení</summary>
          <div class="opts">
          <label>Nechat ve vesnici aspoň <input type="number" data-reserve min="0" step="1000" style="width:80px"> každé</label>
          <label>Neřešit rozdíl pod <input type="number" data-tol min="0" max="50" step="1" style="width:50px"> % skladu</label>
          <label>Min. zásilka <input type="number" data-min min="0" step="500" style="width:70px"></label>
          <label>Nosnost obchodníka <input type="number" data-cap min="100" step="100" style="width:70px"></label>
          <label>Pauza u „Poslat vše“ <input type="number" data-pmin min="0" style="width:50px"> – <input type="number" data-pmax min="0" style="width:50px"> s</label>
        </div>
        </details>
        <div class="row2">
          <button type="button" class="btn" data-load>🔄 Načíst vesnice</button>
        </div>
        <div class="sum" data-sum>Klikni na „Načíst vesnice“.</div>
        <details data-vbox><summary>Vesnice v balancu (zaškrtni, které se účastní)</summary>
          <div class="row2" style="margin-top:4px"><button type="button" class="btn" data-all>✔ všechny</button><button type="button" class="btn" data-none>✖ žádná</button></div>
          <div data-vlist></div></details>
        <div data-slist></div>
      </div>
      <div class="ft">
        <span class="st" data-st></span>
        <button type="button" class="btn big" data-next>▶ Poslat další</button>
        <button type="button" class="btn big" data-sendall>⏩ Poslat vše</button>
      </div>`;
    document.body.appendChild(w);
    ui = { w, q: s => w.querySelector(s) };

    ui.q('[data-close]').onclick = () => { w.style.display = 'none'; };
    ui.q('[data-load]').onclick = () => reload();
    ui.q('[data-next]').onclick = () => sendNext();
    ui.q('[data-sendall]').onclick = () => sendAll();
    ui.q('[data-all]').onclick = () => { cfg.off = []; saveCfg(); replan(); };
    ui.q('[data-none]').onclick = () => { cfg.off = villages.map(v => v.id); saveCfg(); replan(); };
    const bindNum = (sel, key, min) => {
      const el = ui.q(sel);
      el.value = cfg[key];
      el.onchange = () => { cfg[key] = Math.max(min, Math.round(Number(el.value) || 0)); el.value = cfg[key]; saveCfg(); replan(); };
    };
    bindNum('[data-reserve]', 'reserve', 0);
    bindNum('[data-tol]', 'tolerance', 0);
    bindNum('[data-min]', 'minSend', 0);
    bindNum('[data-cap]', 'cap', 100);
    bindNum('[data-pmin]', 'pauseMin', 0);
    bindNum('[data-pmax]', 'pauseMax', 0);
    w.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !/INPUT|SELECT|TEXTAREA/.test(document.activeElement.tagName)) { e.preventDefault(); sendNext(); }
    });
  }

  const setStatus = t => { if (ui) ui.q('[data-st]').textContent = t; };

  async function reload() {
    if (busy || sendingAll) return;
    busy = true;
    ui.q('[data-load]').disabled = true;
    try {
      await loadVillages(setStatus);
      sent.clear();
      setStatus(`Načteno ${villages.length} vesnic.`);
      replan();
    } catch (e) {
      setStatus('⚠️ ' + e.message);
    } finally {
      busy = false;
      ui.q('[data-load]').disabled = false;
      render();
    }
  }

  // přepočet plánu (po změně nastavení / výběru vesnic). Odeslané zásilky už jsou odečtené/přičtené v datech vesnic,
  // takže nový plán počítá jen se zbytkem.
  function replan() {
    sent.clear();
    plan = computePlan();
    render();
  }

  const bar = (p, r) => `<span class="bar"><i style="width:${Math.min(100, p)}%;background:${RES_COLOR[r]}"></i></span>`;

  function render() {
    if (!ui) return;
    const sumEl = ui.q('[data-sum]');
    const vlist = ui.q('[data-vlist]');
    const slist = ui.q('[data-slist]');
    if (!villages.length) { sumEl.textContent = 'Klikni na „Načíst vesnice“.'; vlist.innerHTML = ''; slist.innerHTML = ''; updateButtons(); return; }

    const off = new Set(cfg.off.map(Number));
    const todo = plan.ships.filter(s => !sent.has(s.key));
    const tot = { wood: 0, stone: 0, iron: 0 };
    for (const s of todo) for (const r of RES) tot[r] += s.send[r];
    sumEl.innerHTML = plan.vs.length < 2
      ? '<b>Vyber aspoň 2 vesnice.</b>'
      : `Cíl pro každou vesnici: ${RES.map(r => `${RES_NAME[r]} <b>${pct(plan.f[r], 1)} %</b>`).join(' · ')} skladu<br>` +
        (todo.length
          ? `Zbývá <b>${todo.length}</b> zásilek: ${RES.map(r => `${RES_NAME[r]} ${fmt(tot[r])}`).join(' · ')}`
          : (plan.ships.length ? '✅ Všechno odesláno.' : '✅ Vesnice jsou vyrovnané – není co posílat (nebo chybí volní obchodníci).')) +
        `<div class="o">Nikdy se nepošle víc, než se vejde do skladu příjemce. Suroviny, které už jsou na cestě, skript nevidí – po doručení klikni znovu na „Načíst“.</div>`;

    // vesnice: zaplnění teď → po balancu
    vlist.innerHTML = `<table><thead><tr><th></th><th>Vesnice</th><th>Sklad</th>${RES.map(r => `<th>${RES_NAME[r]} teď → potom</th>`).join('')}<th>Obch.</th></tr></thead><tbody>${
      villages.slice().sort((a, b) => a.name.localeCompare(b.name, 'cs')).map(v => {
        const inn = !off.has(v.id);
        const af = plan.after.get(v);
        return `<tr class="${inn ? '' : 'off'}"><td><input type="checkbox" data-vid="${v.id}"${inn ? ' checked' : ''}></td>
          <td data-l="Vesnice">${esc(v.name)} <span class="o">(${v.x}|${v.y})</span></td>
          <td class="n" data-l="Sklad">${fmt(v.storage)}</td>
          ${RES.map(r => `<td data-l="${RES_NAME[r]}">${bar(pct(v[r], v.storage), r)}${pct(v[r], v.storage)} %` +
            (af && inn ? ` → <b>${pct(af[r], v.storage)} %</b>` : '') + '</td>').join('')}
          <td class="n" data-l="Obchodníci">${v.merchants ?? '?'}${v.merchantsAll ? '/' + v.merchantsAll : ''}</td></tr>`;
      }).join('')}</tbody></table>`;
    vlist.querySelectorAll('[data-vid]').forEach(cb => {
      cb.onchange = () => {
        const s = new Set(cfg.off.map(Number));
        if (cb.checked) s.delete(+cb.dataset.vid); else s.add(+cb.dataset.vid);
        cfg.off = [...s]; saveCfg(); replan();
      };
    });

    // zásilky
    slist.innerHTML = plan.ships.length ? `<table><thead><tr><th>Z vesnice</th><th>Do vesnice</th><th>Vzdál.</th><th>Pošle se</th><th>Obch.</th><th></th></tr></thead><tbody>${
      plan.ships.map(s => {
        const st = sent.get(s.key);
        const cls = st === 'ok' ? 'ok' : st && st.startsWith('err') ? 'err' : '';
        return `<tr class="${cls}" data-key="${s.key}">
          <td data-l="Z">${esc(s.v.name)} <span class="o">(${s.v.x}|${s.v.y})</span></td>
          <td data-l="Do">${esc(s.to.name)} <span class="o">(${s.to.x}|${s.to.y})</span></td>
          <td class="n" data-l="Vzdálenost">${s.d.toFixed(1)}</td>
          <td data-l="Pošle se">${RES.filter(r => s.send[r]).map(r => `<span class="ic" style="background:${RES_COLOR[r]}"></span>${fmt(s.send[r])}`).join(' ')}</td>
          <td class="n" data-l="Obchodníci">${s.merchants}</td>
          <td>${st === 'ok' ? '✅' : st ? `<span title="${esc(st.slice(4))}">❌</span>` : `<button type="button" class="btn" data-send="${s.key}">Poslat</button>`}</td></tr>`;
      }).join('')}</tbody></table>` : '';
    slist.querySelectorAll('[data-send]').forEach(b => {
      b.onclick = () => { const s = plan.ships.find(x => x.key === b.dataset.send); if (s) doSend(s); };
    });
    updateButtons();
  }

  const nextShip = () => plan.ships.find(s => !sent.has(s.key));

  function updateButtons() {
    if (!ui) return;
    const left = plan.ships.filter(s => !sent.has(s.key)).length;
    const nx = nextShip();
    ui.w.querySelectorAll('tr.next').forEach(tr => tr.classList.remove('next'));
    if (nx) { const tr = ui.w.querySelector(`tr[data-key="${nx.key}"]`); if (tr) tr.classList.add('next'); }
    const b = ui.q('[data-next]');
    b.disabled = !nx || busy || sendingAll;
    b.textContent = nx ? `▶ Poslat další (${left})` : '▶ Poslat další';
    const a = ui.q('[data-sendall]');
    a.disabled = !sendingAll && !nx;
    a.textContent = sendingAll ? '⏹ Zastavit' : nx ? `⏩ Poslat vše (${left})` : '⏩ Poslat vše';
    a.style.background = sendingAll ? '#8b0000' : '';
    a.style.color = sendingAll ? '#fff' : '';
  }

  async function doSend(s) {
    if (busy) return { ok: false, msg: 'busy' };
    busy = true;
    updateButtons();
    setStatus(`Posílám ${s.v.name} → ${s.to.name}…`);
    const res = await sendShip(s);
    sent.set(s.key, res.ok ? 'ok' : 'err:' + res.msg);
    if (res.ok) {
      // odečíst / přičíst, ať další výpočty sedí
      for (const r of RES) { s.v[r] = Math.max(0, (s.v[r] || 0) - s.send[r]); s.to[r] = (s.to[r] || 0) + s.send[r]; }
      s.v.merchants = Math.max(0, (s.v.merchants || 0) - s.merchants);
    }
    busy = false;
    setStatus((res.ok ? '✅ ' : '❌ ') + `${s.v.name} → ${s.to.name}: ${res.msg}`);
    if (!sendingAll) gameMsg(`${s.v.name} → ${s.to.name}: ${res.msg}`, !res.ok);
    render();
    return res;
  }

  function sendNext() { const nx = nextShip(); if (nx) doSend(nx); }

  async function sendAll() {
    if (sendingAll) { sendingAll = false; setStatus('Zastavuji…'); return; }
    const todo = plan.ships.filter(s => !sent.has(s.key));
    if (!todo.length) return;
    const pMin = Math.min(cfg.pauseMin, cfg.pauseMax), pMax = Math.max(cfg.pauseMin, cfg.pauseMax);
    sendingAll = true;
    render();
    let fails = 0, done = 0, bad = 0;
    while (sendingAll) {
      const nx = nextShip();
      if (!nx) break;
      const res = await doSend(nx);
      if (res.ok) { done++; fails = 0; }
      else {
        bad++; fails++;
        if (/bot|ochran|captcha/i.test(res.msg)) { setStatus('⚠️ Ochrana proti botům – zastaveno. Vyřeš ji ve hře.'); break; }
        if (fails >= 3) { setStatus('⚠️ 3 chyby po sobě – zastaveno: ' + res.msg); break; }
      }
      if (sendingAll && nextShip()) {
        const end = Date.now() + (pMin + Math.random() * (pMax - pMin)) * 1000;
        while (sendingAll && Date.now() < end) {
          setStatus(`⏩ Odesláno ${done}/${todo.length}${bad ? ` (chyb ${bad})` : ''} · další za ${Math.ceil((end - Date.now()) / 1000)} s…`);
          await sleep(Math.min(500, Math.max(0, end - Date.now())));
        }
      }
    }
    const stopped = !sendingAll;
    sendingAll = false;
    const msg = `${stopped ? 'Zastaveno' : 'Hotovo'} – odesláno ${done} zásilek` + (bad ? `, ${bad} se nepovedlo` : '') + '.';
    if (!/⚠️/.test(ui.q('[data-st]').textContent)) setStatus((bad ? '⚠️ ' : '✅ ') + msg);
    gameMsg(msg, bad > 0);
    render();
  }

  function open() {
    if (!ui) build();
    ui.w.style.display = 'flex';
    if (!villages.length) reload(); else render();
  }

  // ================= START =================
  // z rychlé volby: okno se otevře hned; další kliknutí ho jen znovu otevře
  window.__dkBalanc = { open };
  open();
})();
