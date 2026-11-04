/* Ahogaditas Tapatío · Punto de venta para meseros
 * Toda la seguridad vive en el servidor (funciones de Supabase). Esta página
 * solo muestra lo que el servidor le devuelve a la persona que entró.
 * En el dispositivo solo se guarda: la clave del dispositivo, el menú
 * (precios de venta) y las órdenes pendientes de sincronizar. Nada de
 * costos, reportes, nómina ni ventas de otros. */
(() => {
'use strict';
const CFG = window.POS_CONFIG || {};
const VERSION = '1.0.0';

/* ================= utilidades ================= */
const $ = s => document.querySelector(s);
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const fmt = new Intl.NumberFormat('es-MX', {style:'currency', currency:'MXN', minimumFractionDigits:0, maximumFractionDigits:2});
const money = v => fmt.format(Number(v) || 0);
const r2 = v => Math.round((Number(v) || 0) * 100) / 100;
const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => { const r = crypto.getRandomValues(new Uint8Array(1))[0] & 15; return (c === 'x' ? r : (r & 3 | 8)).toString(16); }));
const hoyISO = () => new Date().toLocaleDateString('en-CA', {timeZone:'America/Monterrey'});
const addDays = (iso, n) => { const d = new Date(iso + 'T12:00:00'); d.setDate(d.getDate() + n); return d.toLocaleDateString('en-CA'); };
const minsAgo = t => Math.max(0, Math.round((Date.now() - new Date(t).getTime()) / 60000));
const fdate = s => new Date(String(s).length <= 10 ? s + 'T12:00:00' : s).toLocaleDateString('es-MX', {weekday:'short', day:'numeric', month:'short'});
const ftime = s => new Date(s).toLocaleString('es-MX', {day:'numeric', month:'short', hour:'2-digit', minute:'2-digit'});
const CANAL = {mesa:'Mesa', llevar:'Para llevar', rappi:'Rappi', didi:'DiDi Food', uber:'Uber Eats'};
const METODO = {efectivo:'Efectivo', tarjeta:'Tarjeta', transferencia:'Transferencia', plataforma:'Pagado en app'};
const CATS = ['Paquetes','Especialidades','Tacos','Bebidas','Postres','Extras'];
const ACCION = {cancelar_producto:'Canceló producto', cancelar_orden:'Canceló orden', descuento:'Descuento', corte_caja:'Corte de caja',
  bloqueo_pin:'Bloqueo por PIN', cambio_precio:'Cambio de precio', cambio_producto:'Cambio de producto', alta_producto:'Alta de producto',
  alta_personal:'Alta de personal', cambio_personal:'Cambio de personal', desbloquear:'Desbloqueo', cambio_ajuste:'Cambio de ajuste',
  anular_venta_cobrada:'Anuló venta cobrada', borrar_demo:'Borró datos demo'};
function etiquetaOrden(o){ return o.tipo === 'mesa' ? `Mesa ${o.mesa}` : o.tipo === 'llevar' ? `Llevar${o.cliente ? ' · ' + o.cliente : ''}` : CANAL[o.tipo]; }

const store = {
  get(k, d){ try { const v = localStorage.getItem('ahog_' + k); return v == null ? d : JSON.parse(v); } catch(e){ return d; } },
  set(k, v){ try { localStorage.setItem('ahog_' + k, JSON.stringify(v)); } catch(e){} },
  del(k){ try { localStorage.removeItem('ahog_' + k); } catch(e){} }
};
async function sha256(t){ const b = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(t)); return [...new Uint8Array(b)].map(x => x.toString(16).padStart(2,'0')).join(''); }

let toastT;
function toast(t, err){ const el = $('#toast'); el.textContent = t; el.className = 'toast' + (err ? ' err' : ''); el.hidden = false; clearTimeout(toastT); toastT = setTimeout(() => el.hidden = true, err ? 4200 : 2200); }

/* ================= estado ================= */
const S = {
  clave: store.get('clave', null),
  personal: [],
  ses: null,            // {token, staff, config, pinHash, salt}
  menu: store.get('menu', null),
  ordenes: {},          // abiertas visibles para esta persona
  mesasOcupadas: [],
  vista: 'inicio',
  o: null,              // orden en edición {id, tipo, mesa, cliente, items(server), nuevos[]}
  cat: 'Paquetes',
  cola: store.get('cola', []),
  errores: store.get('errores', []),
  online: navigator.onLine,
  admin: {tab:'resumen', desde:null, hasta:null, demo:false, rep:null, bit:null, per:null, prods:null, cfg:null},
};
const esDemo = () => !!S.ses?.staff?.es_demo;
const rol = () => S.ses?.staff?.rol;

/* ================= API (Supabase RPC) ================= */
class ApiError extends Error { constructor(code, msg){ super(msg); this.code = code; } }
// Llave "anon" (JWT, empieza con eyJ) o la nueva "publishable" (sb_publishable_…): ambas son públicas.
function cabeceras(){ const k = CFG.API_KEY || ''; const h = {'Content-Type': 'application/json', apikey: k}; if (k.startsWith('eyJ')) h.Authorization = 'Bearer ' + k; return h; }
async function rpc(fn, params){
  if (!CFG.API_URL) throw new ApiError('CONFIG', 'Falta configurar la dirección del servidor (config.js).');
  let res;
  try {
    res = await fetch(`${CFG.API_URL}/rpc/${fn}`, {method:'POST', headers: cabeceras(), body: JSON.stringify(params || {}), cache:'no-store'});
  } catch(e){ setOnline(false); throw new ApiError('RED', 'Sin conexión a internet.'); }
  setOnline(true);
  const txt = await res.text(); let body = null; try { body = txt ? JSON.parse(txt) : null; } catch(e){}
  if (!res.ok){
    const m = (body && body.message) || ('Error ' + res.status);
    const i = m.indexOf(': ');
    const code = i > 0 && /^[A-Z_]+$/.test(m.slice(0,i)) ? m.slice(0,i) : 'SERVIDOR';
    const msg = code === 'SERVIDOR' ? m : m.slice(i + 2);
    if (code === 'SESION' && S.ses) { setTimeout(() => cerrarSesion(msg), 0); }
    throw new ApiError(code, msg);
  }
  return body;
}
const call = (fn, p) => rpc(fn, {p_token: S.ses?.token, ...p});

/* ---------- cola sin internet: solo guardar orden y cobrar ---------- */
function setOnline(v){ if (S.online !== v){ S.online = v; pintaSync(); } }
function guardaCola(){ store.set('cola', S.cola); store.set('errores', S.errores); pintaSync(); }
function encola(fn, params){ S.cola.push({id: uuid(), staff: S.ses.staff.id, fn, params, ts: Date.now()}); guardaCola(); }
let flushing = false;
async function sincroniza(){
  if (flushing || !S.ses) return; flushing = true;
  try {
    for (const it of [...S.cola]){
      if (it.staff !== S.ses.staff.id) continue;
      try { await rpc(it.fn, {p_token: S.ses.token, ...it.params}); S.cola = S.cola.filter(x => x.id !== it.id); guardaCola(); }
      catch(e){
        if (e.code === 'RED') break;
        if (e.code === 'SESION') break;
        S.cola = S.cola.filter(x => x.id !== it.id);
        S.errores.push({ts: Date.now(), msg: e.message, fn: it.fn, staff: it.staff}); guardaCola();
        toast('Una operación guardada sin internet no se pudo registrar: ' + e.message, true);
      }
    }
  } finally { flushing = false; }
  if (!S.cola.some(x => x.staff === S.ses?.staff?.id)) await cargaOrdenes(true);
}
setInterval(() => { if (S.ses && S.cola.length) sincroniza(); }, 8000);
addEventListener('online', () => { S.online = true; sincroniza(); pintaSync(); });
addEventListener('offline', () => { S.online = false; pintaSync(); });
function pendientes(){ return S.cola.filter(x => x.staff === S.ses?.staff?.id).length; }
function syncInfo(){
  const p = pendientes(), otros = S.cola.length - p;
  if (S.errores.length && rol() && rol() !== 'mesero') return ['sync err', `${S.errores.length} con error`];
  if (!S.online) return ['sync off', p ? `Sin internet · ${p} por enviar` : 'Sin internet'];
  if (p) return ['sync off', `Enviando ${p}…`];
  return ['sync', otros ? `En línea · ${otros} de otro usuario` : 'En línea'];
}
function pintaSync(){ const el = $('#sync'); if (!el) return; const [c, t] = syncInfo(); el.className = c; el.textContent = t; }
/* ================= precio local (igual que el servidor) ================= */
function calculaItem(prod, opc, tipo){
  let precio = Number(prod.precio); const partes = [];
  for (const g of prod.grupos || []){
    const sel = opc?.[g.id];
    if (g.tipo === 'reparto'){
      const tot = g.opciones.reduce((a, o) => a + (Number(sel?.[o.id]) || 0), 0);
      if (!sel || tot !== g.total) return {error: `${g.nombre}: deben ser ${g.total}`};
      g.opciones.forEach(o => { if (sel[o.id] > 0) partes.push(`${o.nombre} ${sel[o.id]}`); });
    } else {
      const o = g.opciones.find(x => x.id === sel);
      if (!o) return {error: `Falta ${g.nombre.toLowerCase()}`};
      if (o.precio != null) precio = Number(o.precio);
      partes.push(o.nombre);
    }
  }
  if (['rappi','didi','uber'].includes(tipo)) precio = Math.ceil(precio * (1 + (Number(S.menu?.ajuste_plataforma?.[tipo]) || 0) / 100));
  return {precio, variante: partes.join(' · ')};
}
const prodById = id => (S.menu?.productos || []).find(p => p.id === id);
function totales(o){
  const items = [...(o.items || []).filter(i => i.estado !== 'cancelado'), ...(o.nuevos || [])];
  const sub = r2(items.reduce((a, i) => a + i.cantidad * i.precio_unit, 0));
  let d = o.descuento_tipo === 'pct' ? r2(sub * o.descuento_valor / 100) : o.descuento_tipo === 'monto' ? Number(o.descuento_valor) : 0;
  d = Math.min(d, sub);
  return {sub, desc: d, total: r2(sub - d)};
}

/* ================= sesión ================= */
let idleT = null, locked = false;
function tocar(){ if (!S.ses || locked) return; clearTimeout(idleT); idleT = setTimeout(bloquear, (Number(S.ses.config?.inactividad_min) || 3) * 60000); }
['pointerdown','keydown'].forEach(ev => addEventListener(ev, tocar, {passive:true}));
function bloquear(){
  if (!S.ses) return; locked = true; cierraModal();
  const el = document.createElement('div'); el.className = 'lock'; el.id = 'lock';
  el.innerHTML = `<div class="pinbox"><h2>Pantalla bloqueada</h2><p class="muted">${esc(S.ses.staff.nombre)}: escribe tu PIN para seguir.</p>
    <div class="dots" id="ldots"></div><div class="pad" id="lpad"></div><div class="msg" id="lmsg"></div>
    <button class="btn ghost block" id="lswitch" style="margin-top:12px">Cambiar de usuario</button></div>`;
  document.body.appendChild(el);
  // Datos de administración fuera de la memoria mientras está bloqueado
  S.admin.rep = S.admin.bit = S.admin.per = S.admin.prods = S.admin.cfg = S.admin.inv = null;
  if (S.vista === 'admin' || S.vista === 'corte') S.vista = 'inicio';
  padPin($('#lpad'), $('#ldots'), async pin => {
    if (S.online){
      const r = await rpc('pos_login', {p_clave: S.clave, p_staff: S.ses.staff.id, p_pin: pin}).catch(e => e);
      if (r instanceof ApiError && r.code === 'RED'){ return desbloqueoLocal(pin); }
      if (r instanceof ApiError){ $('#lmsg').textContent = r.message; return false; }
      if (!r.ok){ $('#lmsg').textContent = r.error; return false; }
      const viejo = S.ses.token; S.ses.token = r.token; rpc('pos_logout', {p_token: viejo}).catch(() => {});
      quitaLock(); return true;
    }
    return desbloqueoLocal(pin);
  });
  $('#lswitch').onclick = () => { quitaLock(); cerrarSesion(); };
}
async function desbloqueoLocal(pin){
  if (await sha256(S.ses.salt + pin) === S.ses.pinHash){ quitaLock(); toast('Sin internet: desbloqueado en este equipo'); return true; }
  $('#lmsg').textContent = 'PIN incorrecto.'; return false;
}
function quitaLock(){ locked = false; $('#lock')?.remove(); tocar(); render(); }
async function cerrarSesion(msg){
  const t = S.ses?.token; S.ses = null; S.o = null; S.ordenes = {}; S.vista = 'inicio';
  S.admin = {tab:'resumen', desde:null, hasta:null, demo:false};
  clearTimeout(idleT); $('#lock')?.remove(); locked = false; cierraModal();
  if (t) rpc('pos_logout', {p_token: t}).catch(() => {});
  render(); if (msg) toast(msg, true);
}

/* ================= vistas ================= */
const app = () => $('#app');
function barra(extra){
  const s = S.ses?.staff;
  return `<div class="bar noprint"><div class="brand">Ahogaditas <span>Tapatío</span></div>
    ${s ? `<div class="who">${esc(s.nombre)} ${s.es_demo ? '<span class="demo">DEMO</span>' : ''}</div>` : ''}
    <div class="spacer"></div>${extra || ''}${(([c, t]) => `<span id="sync" class="${c}">${esc(t)}</span>`)(syncInfo())}
    ${s ? '<button class="btn sm" data-act="salir">Salir</button>' : ''}</div>`;
}
function render(){
  if (!CFG.API_URL) return vSinConfig();
  if (!S.clave) return vClave();
  if (!S.ses) return vLogin();
  const v = {inicio: vInicio, tipo: vTipo, orden: vOrden, corte: vCorte, admin: vAdmin}[S.vista] || vInicio;
  v(); pintaSync();
}
function vSinConfig(){
  app().innerHTML = barra() + `<main><div class="banner crit">Falta configurar el servidor. Edita <b>config.js</b> con la dirección y la llave pública de Supabase (ver guía de instalación).</div></main>`;
}
function vClave(){
  app().innerHTML = barra() + `<main><div class="login"><h1>Autorizar este dispositivo</h1>
    <p class="muted">Solo se hace una vez por tablet. Pide la clave al administrador.</p>
    <label class="field">Clave del dispositivo<input id="clave" type="password" autocomplete="off" autocapitalize="off"></label>
    <div class="msg" id="cmsg"></div><button class="btn pri big block" id="cgo">Autorizar</button></div></main>`;
  const go = async () => {
    const c = $('#clave').value.trim(); if (!c) return;
    try { S.personal = await rpc('pos_personal', {p_clave: c}); S.clave = c; store.set('clave', c); render(); }
    catch(e){ $('#cmsg').textContent = e.message; }
  };
  $('#cgo').onclick = go; $('#clave').onkeydown = e => { if (e.key === 'Enter') go(); };
}
async function vLogin(sel){
  app().innerHTML = barra() + `<main><div class="login" id="lg"><p class="muted">Cargando…</p></div></main>`; pintaSync();
  try { S.personal = await rpc('pos_personal', {p_clave: S.clave}); }
  catch(e){
    if (e.code === 'DISPOSITIVO'){ S.clave = null; store.del('clave'); return render(); }
    $('#lg').innerHTML = `<div class="banner">${esc(e.message)} Para entrar se necesita internet.</div><button class="btn big" data-act="recargar">Reintentar</button>`; return;
  }
  if (!sel){
    const real = S.personal.filter(p => !p.es_demo), demo = S.personal.filter(p => p.es_demo);
    const card = p => `<button class="person" data-pick="${esc(p.id)}">${esc(p.nombre)}<small>${p.rol === 'mesero' ? 'mesero' : p.rol === 'encargada' ? 'encargada' : 'administrador'}</small></button>`;
    $('#lg').innerHTML = `<h1>¿Quién eres?</h1><div class="grid people">${real.map(card).join('')}</div>
      ${demo.length ? `<h3>Personal de prueba <span class="demo">DEMO</span></h3><div class="grid people">${demo.map(card).join('')}</div>` : ''}
      ${S.cola.length ? `<p class="banner" style="margin-top:16px">Hay ${S.cola.length} operación(es) guardadas sin internet. Se envían cuando entre la persona que las hizo.</p>` : ''}
      <p class="note">v${VERSION}</p>`;
    $('#lg').querySelectorAll('[data-pick]').forEach(b => b.onclick = () => vLogin(S.personal.find(p => p.id === b.dataset.pick)));
    return;
  }
  $('#lg').innerHTML = `<div class="pinbox"><h1>${esc(sel.nombre)}</h1><p class="muted">Escribe tu PIN</p><div class="dots" id="dots"></div><div class="pad" id="pad"></div><div class="msg" id="pmsg"></div>
    <button class="btn ghost block" id="back" style="margin-top:12px">← Otra persona</button></div>`;
  $('#back').onclick = () => vLogin();
  padPin($('#pad'), $('#dots'), async pin => {
    const r = await rpc('pos_login', {p_clave: S.clave, p_staff: sel.id, p_pin: pin}).catch(e => e);
    if (r instanceof ApiError){ $('#pmsg').textContent = r.message; return false; }
    if (!r.ok){ $('#pmsg').textContent = r.error; return false; }
    const salt = uuid();
    S.ses = {token: r.token, staff: r.staff, config: r.config, salt, pinHash: await sha256(salt + pin)};
    S.vista = 'inicio'; tocar();
    await cargaMenu(); render(); sincroniza();
    return true;
  });
}
function padPin(pad, dots, onOk){
  let pin = '', busy = false; const MAX = 6;
  const draw = () => dots.innerHTML = Array.from({length: Math.max(4, pin.length)}, (_, i) => `<i class="${i < pin.length ? 'on' : ''}"></i>`).join('');
  pad.innerHTML = [1,2,3,4,5,6,7,8,9].map(n => `<button data-k="${n}">${n}</button>`).join('') + `<button class="fn" data-k="del">Borrar</button><button data-k="0">0</button><button class="fn" data-k="ok" style="color:var(--accent);font-weight:800">Entrar</button>`;
  const press = async k => {
    if (busy) return;
    if (k === 'del') pin = pin.slice(0, -1);
    else if (k === 'ok'){ if (pin.length < 4) return; busy = true; const ok = await onOk(pin); busy = false; if (!ok){ pin = ''; } }
    else if (pin.length < MAX) pin += k;
    draw();
  };
  pad.onclick = e => { const b = e.target.closest('[data-k]'); if (b) press(b.dataset.k); };
  const kb = e => { if (!pad.isConnected){ removeEventListener('keydown', kb); return; } if (/^[0-9]$/.test(e.key)) press(e.key); else if (e.key === 'Backspace') press('del'); else if (e.key === 'Enter') press('ok'); };
  addEventListener('keydown', kb); draw();
}
async function cargaMenu(){
  try { S.menu = await call('pos_menu'); store.set('menu', S.menu); }
  catch(e){ if (!S.menu) toast('No se pudo cargar el menú: ' + e.message, true); }
}
async function cargaOrdenes(silencio){
  try {
    const r = await call('pos_ordenes_abiertas');
    S.ordenes = {}; r.ordenes.forEach(o => S.ordenes[o.id] = o); S.mesasOcupadas = r.mesas_ocupadas || [];
    // reaplica lo que siga en cola (sin internet)
    S.cola.filter(x => x.staff === S.ses.staff.id).forEach(aplicaLocal);
    if (!silencio || S.vista === 'inicio') render();
  } catch(e){ if (!silencio && e.code !== 'RED') toast(e.message, true); }
}
function aplicaLocal(it){
  if (it.fn === 'pos_guardar_orden'){
    const p = it.params.p_orden; let o = S.ordenes[p.id];
    if (!o){ o = S.ordenes[p.id] = {id: p.id, folio: null, tipo: p.tipo, mesa: p.mesa, cliente: p.cliente, estado: 'abierta', abierta_en: new Date(it.ts).toISOString(), items: [], mesero: S.ses.staff.nombre, pendiente: true, descuento_tipo: null, descuento_valor: 0}; if (p.mesa) S.mesasOcupadas.push(p.mesa); }
    for (const i of p.items){ if (o.items.some(x => x.id === i.id)) continue; const pr = prodById(i.producto_id); const c = pr ? calculaItem(pr, i.opciones, o.tipo) : {precio: 0, variante: ''};
      o.items.push({id: i.id, producto_id: i.producto_id, nombre: pr?.nombre || '¿?', variante: c.variante, opciones: i.opciones, cantidad: i.cantidad, precio_unit: c.precio, nota: i.nota, estado: 'activo', pendiente: true}); }
    o.pendiente = true;
  } else if (it.fn === 'pos_cobrar'){ delete S.ordenes[it.params.p_orden]; }
}

/* ---------- inicio ---------- */
function vInicio(){
  const r = rol(); const lista = Object.values(S.ordenes).sort((a, b) => String(a.abierta_en).localeCompare(String(b.abierta_en)));
  const mias = lista.filter(o => r === 'mesero' || o.mesero_id === S.ses.staff.id || o.pendiente);
  const otras = r === 'mesero' ? [] : lista.filter(o => !mias.includes(o));
  const card = o => { const t = totales(o); return `<button class="card order" data-open="${esc(o.id)}">
      <div class="row"><span class="tag ${o.tipo === 'mesa' ? 'mesa' : o.tipo === 'llevar' ? 'llevar' : 'app'}">${esc(CANAL[o.tipo])}</span>${o.pendiente ? '<span class="tag pend">Por enviar</span>' : ''}<span class="spacer"></span><span class="muted small">${o.folio ? 'Folio ' + o.folio : ''}</span></div>
      <b>${esc(etiquetaOrden(o))}</b><div class="row"><span class="t num">${money(t.total)}</span><span class="spacer"></span><span class="muted small">${minsAgo(o.abierta_en)} min${otras.length || r !== 'mesero' ? ' · ' + esc(o.mesero || '') : ''}</span></div></button>`; };
  const errs = r !== 'mesero' && S.errores.length ? `<div class="banner crit">${S.errores.length} operación(es) hechas sin internet no se registraron. <button class="btn sm" data-act="verErrores">Ver</button></div>` : '';
  app().innerHTML = barra() + `<main>${errs}
    <div class="row" style="margin-bottom:14px"><button class="btn pri big" data-act="nueva" style="flex:1;min-width:220px">+ Nueva orden</button>
      ${r !== 'mesero' ? '<button class="btn big" data-act="corte">Corte de caja</button>' : ''}${r === 'admin' ? '<button class="btn big" data-act="admin">Panel</button>' : ''}</div>
    <h3>${r === 'mesero' ? 'Mis órdenes abiertas' : 'Mis órdenes'}</h3>
    ${mias.length ? `<div class="grid cards">${mias.map(card).join('')}</div>` : '<div class="empty">No tienes órdenes abiertas.</div>'}
    ${r !== 'mesero' ? `<h3>Órdenes abiertas de los demás</h3>${otras.length ? `<div class="grid cards">${otras.map(card).join('')}</div>` : '<div class="empty">Ninguna.</div>'}` : ''}
    ${S.menu?.ajuste_confirmado === false && Object.values(S.menu?.ajuste_plataforma || {}).every(v => !v) ? '<p class="note">Precios de Rappi / DiDi / Uber: por confirmar (hoy se cobra igual que en local).</p>' : ''}
  </main>`;
  app().querySelectorAll('[data-open]').forEach(b => b.onclick = () => abreOrden(b.dataset.open));
}
function abreOrden(id){ const o = S.ordenes[id]; if (!o) return; S.o = {...o, items: [...(o.items || [])], nuevos: []}; S.cat = CATS[0]; S.vista = 'orden'; render(); }

/* ---------- tipo de orden ---------- */
let tipoSel = 'mesa';
function vTipo(){
  const n = Number(S.ses.config?.mesas) || 10;
  app().innerHTML = barra() + `<main><div class="row" style="margin-bottom:10px"><button class="btn" data-act="inicio">← Volver</button><h1 style="margin:0">Nueva orden</h1></div>
    <div class="grid types">${['mesa','llevar','rappi','didi','uber'].map(t => `<button class="tbtn" data-tipo="${t}" aria-pressed="${tipoSel === t}">${CANAL[t]}</button>`).join('')}</div>
    <div id="tipoBody" style="margin-top:16px"></div></main>`;
  app().querySelectorAll('[data-tipo]').forEach(b => b.onclick = () => { tipoSel = b.dataset.tipo; vTipo(); });
  const body = $('#tipoBody');
  if (tipoSel === 'mesa'){
    body.innerHTML = `<h3>Elige la mesa</h3><div class="grid mesas">${Array.from({length: n}, (_, i) => i + 1).map(m => { const occ = S.mesasOcupadas.includes(m);
      return `<button class="mesa ${occ ? 'occ' : ''}" data-mesa="${m}">${m}${occ ? '<small>ocupada</small>' : ''}</button>`; }).join('')}</div>`;
    body.querySelectorAll('[data-mesa]').forEach(b => b.onclick = () => {
      const m = Number(b.dataset.mesa);
      const ex = Object.values(S.ordenes).find(o => o.tipo === 'mesa' && o.mesa === m);
      if (ex) return abreOrden(ex.id);
      if (S.mesasOcupadas.includes(m)) return toast(`La mesa ${m} tiene una orden de otro mesero.`, true);
      nuevaOrden('mesa', m, null);
    });
  } else if (tipoSel === 'llevar'){
    body.innerHTML = `<label class="field">Nombre del cliente (opcional)<input id="cli" maxlength="40" autocomplete="off"></label><button class="btn pri big block" id="goLl" style="margin-top:12px">Empezar orden</button>`;
    $('#goLl').onclick = () => nuevaOrden('llevar', null, $('#cli').value.trim());
  } else {
    const aj = Number(S.menu?.ajuste_plataforma?.[tipoSel]) || 0;
    body.innerHTML = `<p class="muted">${aj ? `Precios de ${CANAL[tipoSel]}: ${aj > 0 ? '+' : ''}${aj}% sobre el menú.` : `Precios de ${CANAL[tipoSel]} por confirmar: hoy se usan los del menú.`} Se registra como pagado en la app.</p>
      <label class="field">Número de pedido o nombre (opcional)<input id="cli" maxlength="40" autocomplete="off"></label><button class="btn pri big block" id="goPl" style="margin-top:12px">Empezar orden</button>`;
    $('#goPl').onclick = () => nuevaOrden(tipoSel, null, $('#cli').value.trim());
  }
}
function nuevaOrden(tipo, mesa, cliente){
  S.o = {id: uuid(), nueva: true, tipo, mesa, cliente: cliente || null, estado: 'abierta', items: [], nuevos: [], descuento_tipo: null, descuento_valor: 0};
  S.cat = CATS[0]; S.vista = 'orden'; render();
}

/* ---------- orden ---------- */
function vOrden(){
  const o = S.o, prods = (S.menu?.productos || []);
  const cats = CATS.filter(c => prods.some(p => p.categoria === c));
  if (!cats.includes(S.cat)) S.cat = cats[0];
  const enCarrito = id => o.nuevos.filter(n => n.producto_id === id).reduce((a, n) => a + n.cantidad, 0);
  const t = totales(o);
  const lineas = [...o.items.map(i => ({...i, srv: true})), ...o.nuevos.map(i => ({...i, nuevo: true}))];
  app().innerHTML = barra() + `<main><div class="posgrid">
    <section><div class="row" style="margin-bottom:10px"><button class="btn" data-act="inicio">← Órdenes</button>
      <h2 style="margin:0">${esc(etiquetaOrden(o))}</h2><span class="muted">${o.folio ? 'Folio ' + o.folio : o.nueva ? 'Orden nueva' : ''}</span></div>
      <div class="cats">${cats.map(c => `<button class="cat" data-cat="${esc(c)}" aria-pressed="${c === S.cat}">${esc(c)}</button>`).join('')}</div>
      <div class="grid prods">${prods.filter(p => p.categoria === S.cat).map(p => { const q = enCarrito(p.id); const precio = rangoPrecio(p, o.tipo);
        return `<button class="prod" data-prod="${esc(p.id)}"><b>${esc(p.nombre)}</b><span class="p">${precio}</span>${p.grupos?.length ? '<span class="v">elegir</span>' : ''}${q ? `<span class="q">${q}</span>` : ''}</button>`; }).join('')}</div>
    </section>
    <aside class="ticket"><div class="hd row"><b>${esc(etiquetaOrden(o))}</b><span class="spacer"></span><span class="muted small">${lineas.filter(l => l.estado !== 'cancelado').length} producto(s)</span></div>
      <div class="bd">${lineas.length ? lineas.map(l => `<div class="line ${l.nuevo ? 'new' : ''} ${l.estado === 'cancelado' ? 'cx' : ''}">
          <span class="qty">${l.cantidad}×</span><div><div class="nm">${esc(l.nombre)}</div>${l.variante ? `<div class="vr">${esc(l.variante)}</div>` : ''}${l.nota ? `<div class="nt">${esc(l.nota)}</div>` : ''}${l.estado === 'cancelado' ? `<div class="vr">Cancelado: ${esc(l.cancel_motivo || '')}</div>` : ''}${l.pendiente ? '<div class="vr">por enviar</div>' : ''}</div>
          <div class="act"><span class="num">${money(l.cantidad * l.precio_unit)}</span>
          ${l.nuevo ? `<button class="ib" data-menos="${esc(l.id)}" aria-label="Quitar uno">−</button>` : (l.estado !== 'cancelado' && !l.pendiente ? `<button class="ib" data-cancel="${esc(l.id)}" aria-label="Cancelar producto" title="Cancelar (requiere autorización)">✕</button>` : '')}</div></div>`).join('')
        : '<div class="empty" style="margin:12px 0">Toca un producto para agregarlo.</div>'}</div>
      <div class="ft">${t.desc ? `<div class="tot"><span class="muted">Subtotal</span><span class="num">${money(t.sub)}</span></div><div class="tot"><span class="muted">Descuento</span><span class="num">−${money(t.desc)}</span></div>` : ''}
        <div class="tot"><span>Total</span><b class="num">${money(t.total)}</b></div>
        <button class="btn pri big" data-act="guardar" ${o.nuevos.length ? '' : 'disabled'}>Guardar orden${o.nuevos.length ? ` (${o.nuevos.reduce((a, n) => a + n.cantidad, 0)} nuevo${o.nuevos.length > 1 ? 's' : ''})` : ''}</button>
        <div class="row"><button class="btn ok big" data-act="cobrar" style="flex:1" ${lineas.some(l => l.estado !== 'cancelado') ? '' : 'disabled'}>Cobrar</button>
          ${!o.nueva ? `<button class="btn big" data-act="desc" title="Descuento (requiere autorización)">%</button><button class="btn big" data-act="cancelOrden" title="Cancelar orden">✕</button>` : ''}</div></div>
    </aside></div></main>`;
  app().querySelectorAll('[data-cat]').forEach(b => b.onclick = () => { S.cat = b.dataset.cat; vOrden(); pintaSync(); });
  app().querySelectorAll('[data-prod]').forEach(b => b.onclick = () => tocaProducto(b.dataset.prod));
  app().querySelectorAll('[data-menos]').forEach(b => b.onclick = () => { const n = o.nuevos.find(x => x.id === b.dataset.menos); if (n.cantidad > 1) n.cantidad--; else o.nuevos = o.nuevos.filter(x => x !== n); vOrden(); pintaSync(); });
  app().querySelectorAll('[data-cancel]').forEach(b => b.onclick = () => cancelarItem(b.dataset.cancel));
}
function rangoPrecio(p, tipo){
  const g = (p.grupos || []).find(g => g.opciones.some(o => o.precio != null));
  if (!g) return money(calculaItem({...p, grupos: []}, {}, tipo).precio);
  const ps = g.opciones.map(o => calculaItem({...p, precio: o.precio ?? p.precio, grupos: []}, {}, tipo).precio);
  return `${money(Math.min(...ps))}${Math.max(...ps) !== Math.min(...ps) ? ' – ' + money(Math.max(...ps)) : ''}`;
}
function tocaProducto(id){
  const p = prodById(id); if (!p) return;
  if (!p.grupos?.length){ // sin variantes: un toque = +1
    const ex = S.o.nuevos.find(n => n.producto_id === id && !n.nota);
    if (ex) ex.cantidad++; else { const c = calculaItem(p, {}, S.o.tipo); S.o.nuevos.push({id: uuid(), producto_id: id, nombre: p.nombre, variante: '', opciones: {}, cantidad: 1, precio_unit: c.precio, nota: null}); }
    vOrden(); pintaSync(); return;
  }
  hojaProducto(p);
}

/* ---------- hoja de variantes y notas ---------- */
const dlg = () => $('#dlg');
function abreModal(html){ const d = dlg(); d.innerHTML = html; if (!d.open) d.showModal(); return d; }
function cierraModal(){ const d = dlg(); if (d?.open) d.close(); }
function hojaProducto(p, cantidadInicial){
  const sel = {}; let cant = cantidadInicial || 1; const notas = new Set(); let libre = '';
  p.grupos.forEach(g => { if (g.tipo === 'reparto') sel[g.id] = null; });
  const QN = S.ses.config?.notas_rapidas || [];
  const draw = (marcarFaltantes) => {
    const c = calculaItem(p, sel, S.o.tipo);
    abreModal(`<div class="sheet"><div class="row"><h2 style="margin:0">${esc(p.nombre)}</h2><span class="spacer"></span><b class="num" style="font-size:22px">${c.error ? '' : money(c.precio * cant)}</b></div>
      ${p.grupos.map(g => { const miss = marcarFaltantes && (g.tipo === 'reparto' ? !sel[g.id] : !sel[g.id]);
        if (g.tipo === 'reparto'){
          const combos = Array.from({length: g.total + 1}, (_, k) => g.total - k);
          const [a, b] = g.opciones;
          return `<div class="grp ${miss ? 'miss' : ''}"><div class="gt"><span>${esc(g.nombre)}</span><span class="muted small">obligatorio</span></div><div class="opts">
            ${combos.map(k => { const v = {[a.id]: k, [b.id]: g.total - k}; const on = sel[g.id] && sel[g.id][a.id] === k;
              return `<button class="opt" data-rep="${esc(g.id)}" data-v='${esc(JSON.stringify(v))}' aria-pressed="${!!on}">${k ? `${k} ${esc(a.nombre)}` : ''}${k && g.total - k ? ' · ' : ''}${g.total - k ? `${g.total - k} ${esc(b.nombre)}` : ''}</button>`; }).join('')}</div></div>`;
        }
        return `<div class="grp ${miss ? 'miss' : ''}"><div class="gt"><span>${esc(g.nombre)}</span><span class="muted small">obligatorio</span></div><div class="opts">
          ${g.opciones.map(o => `<button class="opt" data-g="${esc(g.id)}" data-o="${esc(o.id)}" aria-pressed="${sel[g.id] === o.id}">${esc(o.nombre)}${o.precio != null ? `<small>${money(calculaItem({...p, precio: o.precio, grupos: []}, {}, S.o.tipo).precio)}</small>` : ''}</button>`).join('')}</div></div>`; }).join('')}
      <div class="grp"><div class="gt">Cantidad</div><div class="stepper"><button data-q="-1" aria-label="Menos">−</button><output class="num">${cant}</output><button data-q="1" aria-label="Más">+</button></div></div>
      <div class="grp"><div class="gt">Notas <span class="muted small">opcional</span></div><div class="chips">${QN.map(n => `<button class="chip" data-n="${esc(n)}" aria-pressed="${notas.has(n)}">${esc(n)}</button>`).join('')}</div>
        <input id="nlibre" class="field" style="margin-top:8px;font:17px var(--body);padding:10px;border-radius:10px;border:1.5px solid var(--line);background:var(--bg);color:var(--fg);width:100%" maxlength="60" placeholder="Otra nota…" value="${esc(libre)}"></div>
      <div class="foot"><button class="btn big" data-x="cancel">Cancelar</button><button class="btn pri big" data-x="add">Agregar</button></div></div>`);
    const d = dlg();
    d.querySelectorAll('[data-g]').forEach(b => b.onclick = () => { sel[b.dataset.g] = b.dataset.o; libre = $('#nlibre').value; draw(); });
    d.querySelectorAll('[data-rep]').forEach(b => b.onclick = () => { sel[b.dataset.rep] = JSON.parse(b.dataset.v); libre = $('#nlibre').value; draw(); });
    d.querySelectorAll('[data-q]').forEach(b => b.onclick = () => { cant = Math.max(1, Math.min(50, cant + Number(b.dataset.q))); libre = $('#nlibre').value; draw(); });
    d.querySelectorAll('[data-n]').forEach(b => b.onclick = () => { notas.has(b.dataset.n) ? notas.delete(b.dataset.n) : notas.add(b.dataset.n); libre = $('#nlibre').value; draw(); });
    d.querySelector('[data-x="cancel"]').onclick = cierraModal;
    d.querySelector('[data-x="add"]').onclick = () => {
      libre = $('#nlibre').value.trim();
      const r = calculaItem(p, sel, S.o.tipo);
      if (r.error){ toast(r.error, true); return draw(true); }
      const nota = [...notas, libre].filter(Boolean).join(', ').slice(0, 80) || null;
      S.o.nuevos.push({id: uuid(), producto_id: p.id, nombre: p.nombre, variante: r.variante, opciones: JSON.parse(JSON.stringify(sel)), cantidad: cant, precio_unit: r.precio, nota});
      cierraModal(); vOrden(); pintaSync();
    };
  };
  draw();
}

/* ---------- guardar / cobrar ---------- */
function payloadOrden(){
  const o = S.o;
  return {id: o.id, tipo: o.tipo, mesa: o.mesa, cliente: o.cliente, items: o.nuevos.map(n => ({id: n.id, producto_id: n.producto_id, cantidad: n.cantidad, opciones: n.opciones, nota: n.nota}))};
}
async function guardar(volver){
  const o = S.o; if (!o.nuevos.length) return true;
  const params = {p_orden: payloadOrden()};
  if (pendientes() || !S.online){ encola('pos_guardar_orden', params); aplicaLocal(S.cola[S.cola.length - 1]); postGuardar(S.ordenes[o.id], volver, true); return true; }
  try { const r = await call('pos_guardar_orden', params); S.ordenes[o.id] = r.orden; if (o.tipo === 'mesa' && !S.mesasOcupadas.includes(o.mesa)) S.mesasOcupadas.push(o.mesa); postGuardar(r.orden, volver); return true; }
  catch(e){
    if (e.code === 'RED'){ encola('pos_guardar_orden', params); aplicaLocal(S.cola[S.cola.length - 1]); postGuardar(S.ordenes[o.id], volver, true); return true; }
    toast(e.message, true); if (e.code === 'MENU') cargaMenu(); return false;
  }
}
function postGuardar(ord, volver, offline){
  toast(offline ? 'Guardada en la tablet. Se enviará al volver el internet.' : `Orden guardada${ord.folio ? ' · folio ' + ord.folio : ''}`);
  if (volver){ S.o = null; S.vista = 'inicio'; render(); }
  else { S.o = {...ord, items: [...ord.items], nuevos: []}; }
}
async function cobrar(){
  if (S.o.nuevos.length && !(await guardar(false))) return;
  const o = S.o; const t = totales(o);
  if (['rappi','didi','uber'].includes(o.tipo)) return confirmaPlataforma(o, t);
  hojaCobro(o, t);
}
function confirmaPlataforma(o, t){
  abreModal(`<div class="sheet"><h2>Cerrar orden de ${esc(CANAL[o.tipo])}</h2><div class="paybig num">${money(t.total)}</div><p class="muted" style="text-align:center">Se registra como pagada en la app de ${esc(CANAL[o.tipo])}.</p>
    <div class="foot"><button class="btn big" data-x="no">Volver</button><button class="btn ok big" data-x="si">Confirmar</button></div></div>`);
  dlg().querySelector('[data-x="no"]').onclick = cierraModal;
  dlg().querySelector('[data-x="si"]').onclick = () => enviaCobro(o, []);
}
function hojaCobro(o, t){
  const pagos = []; let metodo = 'efectivo'; let monto = ''; let recibido = ''; let partes = 1;
  const rest = () => r2(t.total - pagos.reduce((a, p) => a + p.monto, 0));
  const draw = () => {
    const falta = rest(); const m = monto === '' ? falta : Number(monto); const rec = recibido === '' ? null : Number(recibido);
    const cambio = metodo === 'efectivo' && rec != null ? r2(rec - m) : 0;
    abreModal(`<div class="sheet"><div class="row"><h2 style="margin:0">Cobrar · ${esc(etiquetaOrden(o))}</h2><span class="spacer"></span><button class="btn sm" data-x="close">Cerrar</button></div>
      <div class="paybig num">${money(t.total)}</div>
      ${pagos.length ? `<div class="paylist">${pagos.map((p, i) => `<div class="payrow"><span>${METODO[p.metodo]}${p.recibido ? ` · recibe ${money(p.recibido)}` : ''}</span><span class="num">${money(p.monto)} <button class="btn sm ghost" data-rm="${i}">quitar</button></span></div>`).join('')}
        <div class="payrow" style="background:var(--warn-bg);color:var(--warn)"><span>Falta</span><span class="num">${money(falta)}</span></div></div>` : ''}
      ${falta > 0 ? `<div class="opts">${['efectivo','tarjeta','transferencia'].map(k => `<button class="opt" data-m="${k}" aria-pressed="${metodo === k}">${METODO[k]}</button>`).join('')}</div>
        <div class="grid" style="grid-template-columns:1fr 1fr;gap:10px">
          <label class="field">Monto de este pago<input class="big num" id="pm" inputmode="decimal" value="${esc(monto === '' ? falta : monto)}"></label>
          ${metodo === 'efectivo' ? `<label class="field">Recibe<input class="big num" id="pr" inputmode="decimal" placeholder="${esc(m)}" value="${esc(recibido)}"></label>` : '<div></div>'}</div>
        ${metodo === 'efectivo' ? `<div class="chips">${billetes(m).map(v => `<button class="chip" data-rec="${v}">${v === m ? 'Exacto' : money(v)}</button>`).join('')}</div>` : ''}
        ${cambio > 0 ? `<div class="cambio">Cambio<b class="num">${money(cambio)}</b></div>` : ''}
        ${cambio < 0 ? `<div class="banner crit">Lo recibido es menor que el monto.</div>` : ''}
        <details><summary class="muted" style="padding:6px 0;cursor:pointer">Dividir cuenta</summary>
          <div class="row" style="margin-top:8px"><span>Entre</span><div class="stepper"><button data-p="-1">−</button><output class="num">${partes}</output><button data-p="1">+</button></div><span>personas: <b class="num">${money(r2(falta / partes))}</b> c/u</span>
          <button class="btn sm" data-x="usarParte">Cobrar una parte</button></div>
          <p class="note">También puedes cobrar con varias formas de pago: escribe el monto de este pago y toca “Agregar pago”.</p></details>` : ''}
      <div class="foot">${falta > 0 ? `<button class="btn big" data-x="addPago">Agregar pago</button><button class="btn ok big" data-x="fin">Cobrar ${money(falta)}</button>` : `<button class="btn ok big" data-x="fin">Confirmar cobro</button>`}</div></div>`);
    const d = dlg();
    d.querySelector('[data-x="close"]').onclick = cierraModal;
    d.querySelectorAll('[data-m]').forEach(b => b.onclick = () => { metodo = b.dataset.m; recibido = ''; draw(); });
    d.querySelectorAll('[data-rm]').forEach(b => b.onclick = () => { pagos.splice(Number(b.dataset.rm), 1); monto = ''; draw(); });
    d.querySelectorAll('[data-rec]').forEach(b => b.onclick = () => { monto = $('#pm').value; recibido = b.dataset.rec; draw(); });
    d.querySelectorAll('[data-p]').forEach(b => b.onclick = () => { partes = Math.max(1, Math.min(20, partes + Number(b.dataset.p))); draw(); });
    const pm = $('#pm'), pr = $('#pr');
    if (pm) pm.oninput = () => { monto = pm.value; };
    if (pr) pr.oninput = () => { recibido = pr.value; };
    if (pm) pm.onchange = draw; if (pr) pr.onchange = draw;
    const tomaPago = () => {
      const mm = r2(Number(String($('#pm').value).replace(/[^0-9.]/g, '')));
      const rr = metodo === 'efectivo' && $('#pr') && $('#pr').value !== '' ? r2(Number(String($('#pr').value).replace(/[^0-9.]/g, ''))) : null;
      if (!(mm > 0) || mm > rest() + 0.001){ toast('Monto no válido.', true); return false; }
      if (rr != null && rr < mm){ toast('Lo recibido es menor que el monto.', true); return false; }
      pagos.push({metodo, monto: mm, recibido: rr ?? (metodo === 'efectivo' ? mm : null)}); monto = ''; recibido = ''; return true;
    };
    const ap = d.querySelector('[data-x="addPago"]'); if (ap) ap.onclick = () => { if (tomaPago()) draw(); };
    const up = d.querySelector('[data-x="usarParte"]'); if (up) up.onclick = () => { monto = String(r2(rest() / partes)); partes = Math.max(1, partes - 1); draw(); };
    d.querySelector('[data-x="fin"]').onclick = () => {
      if (rest() > 0 && !tomaPago()) return;
      if (Math.abs(rest()) > 0.009){ toast('Los pagos no suman el total.', true); return draw(); }
      enviaCobro(o, pagos.map(p => ({metodo: p.metodo, monto: p.monto, recibido: p.metodo === 'efectivo' ? p.recibido : null})));
    };
  };
  draw();
}
function billetes(m){ // exacto + billetes con los que suele pagar el cliente
  const c = [m, Math.ceil(m / 50) * 50, Math.ceil(m / 100) * 100, Math.ceil(m / 200) * 200, Math.ceil(m / 500) * 500, 1000];
  return [...new Set(c)].filter(v => v >= m).sort((a, b) => a - b).slice(0, 5);
}
async function enviaCobro(o, pagos){
  const cambio = r2(pagos.reduce((a, p) => a + (p.metodo === 'efectivo' && p.recibido ? p.recibido - p.monto : 0), 0));
  const params = {p_orden: o.id, p_pagos: pagos};
  const fin = (offline) => {
    delete S.ordenes[o.id]; if (o.tipo === 'mesa') S.mesasOcupadas = S.mesasOcupadas.filter(m => m !== o.mesa);
    abreModal(`<div class="sheet" style="text-align:center"><h2>Cobrado ✓</h2><p class="muted">${esc(etiquetaOrden(o))}${offline ? ' · se registrará al volver el internet' : ''}</p>
      ${cambio > 0 ? `<div class="cambio">Cambio a entregar<b class="num">${money(cambio)}</b></div>` : ''}<div class="foot"><button class="btn pri big" data-x="ok">Listo</button></div></div>`);
    dlg().querySelector('[data-x="ok"]').onclick = () => { cierraModal(); S.o = null; S.vista = 'inicio'; render(); };
  };
  if (pendientes() || !S.online){ encola('pos_cobrar', params); return fin(true); }
  try { await call('pos_cobrar', params); fin(false); }
  catch(e){ if (e.code === 'RED'){ encola('pos_cobrar', params); return fin(true); } toast(e.message, true); }
}

/* ---------- autorizaciones (encargada / admin) ---------- */
function hojaAutoriza(titulo, detalle, motivos, extraHTML, onOk){
  if (!S.online){ toast('Para autorizar se necesita internet.', true); return; }
  const aut = S.personal.filter(p => p.rol !== 'mesero' && p.es_demo === esDemo());
  let quien = aut.find(p => p.id === S.ses.staff.id)?.id || (aut.length === 1 ? aut[0].id : null); let motivo = ''; let pin = '';
  const draw = (msg) => {
    abreModal(`<div class="sheet"><h2 style="margin:0">${esc(titulo)}</h2><p class="muted" style="margin:0">${esc(detalle)}</p>${extraHTML || ''}
      <div class="grp"><div class="gt">Motivo <span class="muted small">obligatorio</span></div><div class="chips">${motivos.map(m => `<button class="chip" data-mot="${esc(m)}" aria-pressed="${motivo === m}">${esc(m)}</button>`).join('')}</div>
        <input id="motl" style="margin-top:8px;font:17px var(--body);padding:10px;border-radius:10px;border:1.5px solid var(--line);background:var(--bg);color:var(--fg);width:100%" maxlength="100" placeholder="Otro motivo…" value="${esc(motivos.includes(motivo) ? '' : motivo)}"></div>
      <div class="grp"><div class="gt">Autoriza</div><div class="opts">${aut.map(p => `<button class="opt" data-aut="${esc(p.id)}" aria-pressed="${quien === p.id}">${esc(p.nombre)}</button>`).join('')}</div>
        <label class="field" style="margin-top:10px">PIN de quien autoriza<input id="apin" type="password" inputmode="numeric" maxlength="6" autocomplete="off" value="${esc(pin)}"></label></div>
      <div class="msg">${esc(msg || '')}</div>
      <div class="foot"><button class="btn big" data-x="no">Volver</button><button class="btn pri big" data-x="si">Autorizar</button></div></div>`);
    const d = dlg();
    const keep = () => { pin = $('#apin').value; if ($('#motl').value.trim()) motivo = $('#motl').value.trim(); };
    d.querySelectorAll('[data-mot]').forEach(b => b.onclick = () => { keep(); motivo = b.dataset.mot; $('#motl').value = ''; draw(); });
    d.querySelectorAll('[data-aut]').forEach(b => b.onclick = () => { keep(); quien = b.dataset.aut; draw(); });
    d.querySelector('[data-x="no"]').onclick = cierraModal;
    d.querySelector('[data-x="si"]').onclick = async () => {
      keep(); const libre = $('#motl').value.trim(); const mot = libre || motivo;
      if (mot.length < 3) return draw('Elige o escribe el motivo.');
      if (!quien) return draw('Elige quién autoriza.');
      if (pin.length < 4) return draw('Escribe el PIN.');
      try { const r = await onOk(quien, pin, mot, d); if (r && r.ok === false){ pin = ''; motivo = mot; return draw(r.error); } cierraModal(); }
      catch(e){ pin = ''; motivo = mot; draw(e.message); }
    };
  };
  draw();
}
function cancelarItem(itemId){
  const i = S.o.items.find(x => x.id === itemId);
  hojaAutoriza('Cancelar producto', `${i.cantidad}× ${i.nombre}${i.variante ? ' (' + i.variante + ')' : ''} · ${money(i.cantidad * i.precio_unit)}`,
    ['Error de captura', 'Cliente cambió', 'Se acabó', 'Tardó mucho'], '', async (quien, pin, mot) => {
      const r = await call('pos_cancelar_item', {p_item: itemId, p_autoriza: quien, p_pin: pin, p_motivo: mot});
      if (r.ok){ S.ordenes[S.o.id] = r.orden; S.o = {...r.orden, items: [...r.orden.items], nuevos: S.o.nuevos}; toast('Producto cancelado'); vOrden(); pintaSync(); }
      return r;
    });
}
function descuento(){
  const t = totales(S.o);
  const extra = `<div class="grp"><div class="gt">Descuento</div><div class="opts"><button class="opt" data-dt="pct" aria-pressed="true">%</button><button class="opt" data-dt="monto">$ pesos</button></div>
    <label class="field" style="margin-top:8px">Valor (0 quita el descuento)<input id="dval" class="big num" inputmode="decimal" value="${esc(S.o.descuento_valor || '')}"></label></div>`;
  let dt = S.o.descuento_tipo || 'pct';
  hojaAutoriza('Descuento', `Cuenta: ${money(t.sub)}`, ['Cortesía', 'Cliente frecuente', 'Queja', 'Promoción'], extra, async (quien, pin, mot) => {
    const v = Number($('#dval').value || 0);
    const r = await call('pos_descuento', {p_orden: S.o.id, p_tipo: dt, p_valor: v, p_autoriza: quien, p_pin: pin, p_motivo: mot});
    if (r.ok){ S.ordenes[S.o.id] = r.orden; S.o = {...r.orden, items: [...r.orden.items], nuevos: S.o.nuevos}; toast('Descuento aplicado'); vOrden(); pintaSync(); }
    return r;
  });
  const bind = () => dlg().querySelectorAll('[data-dt]').forEach(b => { b.setAttribute('aria-pressed', b.dataset.dt === dt); b.onclick = () => { dt = b.dataset.dt; bind(); }; });
  bind();
}
function cancelarOrden(){
  const t = totales(S.o);
  hojaAutoriza('Cancelar orden completa', `${etiquetaOrden(S.o)} · ${money(t.total)}`, ['Cliente se fue', 'Orden duplicada', 'Error de captura'], '', async (quien, pin, mot) => {
    const r = await call('pos_cancelar_orden', {p_orden: S.o.id, p_autoriza: quien, p_pin: pin, p_motivo: mot});
    if (r.ok){ delete S.ordenes[S.o.id]; if (S.o.tipo === 'mesa') S.mesasOcupadas = S.mesasOcupadas.filter(m => m !== S.o.mesa); S.o = null; S.vista = 'inicio'; toast('Orden cancelada'); render(); }
    return r;
  });
}

/* ---------- corte de caja ---------- */
let corteRes = null;
async function vCorte(){
  app().innerHTML = barra() + `<main><div class="row" style="margin-bottom:10px"><button class="btn" data-act="inicio">← Volver</button><h1 style="margin:0">Corte de caja</h1></div><div id="cbody"><p class="muted">Cargando…</p></div></main>`; pintaSync();
  if (corteRes) return pintaCorteHecho();
  let d; try { d = await call('pos_corte_resumen'); } catch(e){ $('#cbody').innerHTML = `<div class="banner crit">${esc(e.message)}</div>`; return; }
  const pm = d.por_metodo || {};
  $('#cbody').innerHTML = `${d.abiertas ? `<div class="banner">Hay ${d.abiertas} orden(es) abierta(s). Lo que no esté cobrado no entra en este corte.</div>` : ''}
    <div class="grid kpis">
      <div class="kpi"><div class="l">Desde</div><div class="v" style="font-size:22px">${d.desde ? ftime(d.desde) : '—'}</div></div>
      <div class="kpi"><div class="l">Órdenes cobradas</div><div class="v num">${d.ordenes}</div></div>
      <div class="kpi"><div class="l">Total del turno</div><div class="v num">${money(d.total)}</div></div>
      <div class="kpi"><div class="l">Cancelaciones</div><div class="v num">${d.cancelaciones}</div></div></div>
    <div class="two"><div><h3>Por forma de pago</h3><div class="tbl"><table><tbody>${['efectivo','tarjeta','transferencia','plataforma'].map(k => `<tr><td>${METODO[k]}</td><td class="n">${money(pm[k] || 0)}</td></tr>`).join('')}</tbody></table></div></div>
    <div><h3>Efectivo</h3><div class="card grid">
      <label class="field">Fondo de caja al iniciar<input id="fondo" class="big num" inputmode="decimal" value="${esc(d.fondo_sugerido ?? 0)}"></label>
      <div class="tot"><span class="muted">+ Ventas en efectivo</span><span class="num">${money(d.efectivo)}</span></div>
      <div class="tot"><span>= Efectivo esperado</span><b class="num" id="esp"></b></div>
      <label class="field">Efectivo contado en caja<input id="cont" class="big num" inputmode="decimal" placeholder="0"></label>
      <div class="tot"><span>Diferencia</span><b class="num" id="dif">—</b></div>
      <label class="field">Notas<input id="cnot" maxlength="200"></label>
      <button class="btn pri big" id="cerrar">Cerrar corte</button></div></div></div>`;
  const upd = () => { const f = Number($('#fondo').value) || 0, c = $('#cont').value; const esp = r2(f + d.efectivo); $('#esp').textContent = money(esp);
    if (c === ''){ $('#dif').textContent = '—'; $('#dif').className = 'num'; return; } const df = r2(Number(c) - esp); $('#dif').textContent = (df > 0 ? '+' : '') + money(df); $('#dif').className = 'num ' + (df < 0 ? 'neg' : df > 0 ? 'pos' : ''); };
  $('#fondo').oninput = upd; $('#cont').oninput = upd; upd();
  $('#cerrar').onclick = async () => {
    if ($('#cont').value === '') return toast('Captura el efectivo contado.', true);
    try { const r = await call('pos_corte_cerrar', {p_fondo: Number($('#fondo').value) || 0, p_contado: Number($('#cont').value), p_notas: $('#cnot').value.trim() || null});
      corteRes = r.corte; pintaCorteHecho(); }
    catch(e){ toast(e.message, true); }
  };
}
function pintaCorteHecho(){
  const c = corteRes; const pm = c.totales?.por_metodo || {};
  $('#cbody').innerHTML = `<div class="card" style="max-width:520px"><h2>Corte cerrado ✓</h2><p class="muted">${ftime(c.creado)} · ${esc(c.hecho_por)}</p>
    <div class="tbl"><table><tbody>${Object.entries(pm).map(([k, v]) => `<tr><td>${METODO[k] || k}</td><td class="n">${money(v)}</td></tr>`).join('')}
    <tr><td><b>Total</b></td><td class="n"><b>${money(c.totales?.total)}</b></td></tr><tr><td>Fondo</td><td class="n">${money(c.fondo)}</td></tr>
    <tr><td>Efectivo esperado</td><td class="n">${money(c.esperado)}</td></tr><tr><td>Efectivo contado</td><td class="n">${money(c.contado)}</td></tr>
    <tr><td><b>Diferencia</b></td><td class="n ${c.diferencia < 0 ? 'neg' : c.diferencia > 0 ? 'pos' : ''}"><b>${money(c.diferencia)}</b></td></tr></tbody></table></div>
    <div class="row noprint" style="margin-top:12px"><button class="btn" data-act="imprimir">Imprimir</button><button class="btn pri" id="cok">Listo</button></div></div>`;
  $('#cok').onclick = () => { corteRes = null; S.vista = 'inicio'; render(); };
}

/* ================= ADMINISTRADOR ================= */
function rango(k){
  const h = hoyISO(); const d = new Date(h + 'T12:00:00'); const dow = (d.getDay() + 6) % 7;
  if (k === 'hoy') return [h, h];
  if (k === 'ayer') return [addDays(h, -1), addDays(h, -1)];
  if (k === 'semana') return [addDays(h, -dow), h];
  if (k === 'semana_ant') return [addDays(h, -dow - 7), addDays(h, -dow - 1)];
  if (k === 'mes') return [h.slice(0, 8) + '01', h];
  return [h, h];
}
async function vAdmin(){
  const A = S.admin; if (!A.desde) [A.desde, A.hasta] = rango('semana');
  if (rol() !== 'admin'){ S.vista = 'inicio'; return render(); }
  const tabs = [['resumen','Ventas'],['productos','Por producto'],['inventario','Inventario'],['recetas','Recetas'],['cortes','Cortes'],['bitacora','Bitácora'],['personal','Personal'],['menu','Menú y precios'],['ajustes','Ajustes']];
  app().innerHTML = barra() + `<main><div class="row" style="margin-bottom:6px"><button class="btn" data-act="inicio">← POS</button><h1 style="margin:0">Panel de ventas</h1></div>
    <nav class="tabs">${tabs.map(([k, l]) => `<button data-tab="${k}" aria-current="${A.tab === k}">${l}</button>`).join('')}</nav>
    ${['resumen','productos','cortes','bitacora'].includes(A.tab) ? `<div class="row" style="margin-bottom:12px">
      ${[['hoy','Hoy'],['ayer','Ayer'],['semana','Esta semana'],['semana_ant','Semana pasada'],['mes','Este mes']].map(([k, l]) => `<button class="chip" data-rg="${k}" aria-pressed="${rango(k)[0] === A.desde && rango(k)[1] === A.hasta}">${l}</button>`).join('')}
      <input type="date" id="dd" class="cell w" value="${A.desde}"> <span>a</span> <input type="date" id="dh" class="cell w" value="${A.hasta}">
      <label class="row small" style="gap:6px"><input type="checkbox" id="vdemo" ${A.demo ? 'checked' : ''} style="width:22px;height:22px"> Ver datos <span class="demo">DEMO</span></label></div>` : ''}
    <div id="abody"><p class="muted">Cargando…</p></div></main>`;
  app().querySelectorAll('[data-tab]').forEach(b => b.onclick = () => { A.tab = b.dataset.tab; vAdmin(); pintaSync(); });
  app().querySelectorAll('[data-rg]').forEach(b => b.onclick = () => { [A.desde, A.hasta] = rango(b.dataset.rg); A.rep = A.bit = null; vAdmin(); pintaSync(); });
  const dd = $('#dd'), dh = $('#dh'), vd = $('#vdemo');
  if (dd) dd.onchange = () => { A.desde = dd.value; if (A.hasta < A.desde) A.hasta = A.desde; A.rep = A.bit = null; vAdmin(); };
  if (dh) dh.onchange = () => { A.hasta = dh.value; if (A.hasta < A.desde) A.desde = A.hasta; A.rep = A.bit = null; vAdmin(); };
  if (vd) vd.onchange = () => { A.demo = vd.checked; A.rep = A.bit = null; vAdmin(); };
  try { await ({resumen: aResumen, productos: aProductos, inventario: aInventario, recetas: aRecetas, cortes: aCortes, bitacora: aBitacora, personal: aPersonal, menu: aMenu, ajustes: aAjustes}[A.tab])(); }
  catch(e){ $('#abody').innerHTML = `<div class="banner crit">${esc(e.message)}</div>`; }
}
async function reporte(){ const A = S.admin; if (!A.rep) A.rep = await call('admin_reporte', {p_desde: A.desde, p_hasta: A.hasta, p_demo: A.demo}); return A.rep; }
const tabla = (cols, rows, vacio) => rows.length ? `<div class="tbl"><table><thead><tr>${cols.map(c => `<th class="${c[2] || ''}">${c[0]}</th>`).join('')}</tr></thead><tbody>
  ${rows.map(r => `<tr>${cols.map(c => `<td class="${c[2] || ''}">${c[1](r)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>` : `<div class="empty">${vacio || 'Sin datos en este periodo.'}</div>`;
function barras(rows, lab, val){
  const max = Math.max(...rows.map(val), 1);
  return `<div class="grid" style="gap:6px">${rows.map(r => `<div style="display:grid;grid-template-columns:110px minmax(0,1fr) 100px;gap:10px;align-items:center;font-size:14px">
    <span>${esc(lab(r))}</span><span style="height:16px;background:var(--sunk);border-radius:4px;overflow:hidden"><span style="display:block;height:100%;width:${(val(r) / max * 100).toFixed(1)}%;background:var(--accent);border-radius:4px"></span></span><b class="num" style="text-align:right">${money(val(r))}</b></div>`).join('')}</div>`;
}
async function aResumen(){
  const r = await reporte(); const h = hoyISO();
  const hoy = r.por_dia.find(d => d.fecha === h);
  $('#abody').innerHTML = `${S.admin.demo ? '<div class="banner">Estás viendo datos DEMO.</div>' : ''}
    <div class="grid kpis">
      <div class="kpi"><div class="l">Ventas del periodo</div><div class="v num">${money(r.ventas)}</div></div>
      <div class="kpi"><div class="l">Ventas de hoy</div><div class="v num">${money(hoy?.ventas || 0)}</div></div>
      <div class="kpi"><div class="l">Órdenes</div><div class="v num">${r.ordenes}</div></div>
      <div class="kpi"><div class="l">Ticket promedio</div><div class="v num">${money(r.ticket_promedio)}</div></div>
      <div class="kpi"><div class="l">Descuentos</div><div class="v num">${money(r.descuentos)}</div></div>
      <div class="kpi"><div class="l">Canceladas / abiertas</div><div class="v num">${r.canceladas} / ${r.abiertas}</div></div></div>
    <div class="two"><div><h3>Por día</h3>${r.por_dia.length ? barras(r.por_dia, d => fdate(d.fecha), d => d.ventas) : '<div class="empty">Sin ventas.</div>'}</div>
      <div><h3>Por mesero</h3>${tabla([['Mesero', x => esc(x.mesero)], ['Órdenes', x => x.ordenes, 'n'], ['Ticket', x => money(x.ticket), 'n'], ['Ventas', x => money(x.ventas), 'n']], r.por_mesero)}</div>
      <div><h3>Por forma de pago</h3>${tabla([['Forma', x => METODO[x.metodo] || x.metodo], ['Pagos', x => x.pagos, 'n'], ['Monto', x => money(x.monto), 'n']], r.por_metodo)}</div>
      <div><h3>Por canal</h3>${tabla([['Canal', x => CANAL[x.canal] || x.canal], ['Órdenes', x => x.ordenes, 'n'], ['Ventas', x => money(x.ventas), 'n']], r.por_canal)}</div></div>
    <h3>Anular una venta ya cobrada</h3><div class="card row"><input type="date" id="anf" class="cell w" value="${hoyISO()}"><input id="anfo" class="cell" inputmode="numeric" placeholder="Folio"><input id="anm" class="cell w" style="width:240px" placeholder="Motivo"><button class="btn" id="anb">Anular venta</button>
      <span class="note" style="margin:0">Queda en la bitácora. Si ya entró a un corte, la diferencia se verá en ese corte.</span></div>`;
  $('#anb').onclick = async () => {
    try { await call('admin_anular_venta', {p_fecha: $('#anf').value, p_folio: Number($('#anfo').value), p_motivo: $('#anm').value}); toast('Venta anulada'); S.admin.rep = null; aResumen(); }
    catch(e){ toast(e.message, true); }
  };
}
async function aProductos(){
  const r = await reporte();
  $('#abody').innerHTML = `<div class="row" style="margin-bottom:12px"><button class="btn pri" id="exInv">Exportar CSV para inventario (Excel)</button><button class="btn" id="exVar">Exportar ventas por producto (CSV)</button></div>
    <div class="two"><div><h3>Por producto</h3>${tabla([['Producto', x => esc(x.producto)], ['Categoría', x => esc(x.categoria)], ['Cant.', x => x.cantidad, 'n'], ['Importe', x => money(x.importe), 'n']], r.por_producto)}</div>
      <div><h3>Variantes (papa vs frijol, rojo vs blanco…)</h3>${tabla([['Elección', x => esc(x.grupo)], ['Opción', x => esc(x.opcion)], ['Piezas', x => x.cantidad, 'n']], r.por_opcion)}</div></div>
    <h3>Por producto y variante</h3>${tabla([['Código', x => `<code>${esc(x.codigo)}</code>`], ['Producto', x => esc(x.producto)], ['Variante', x => esc(x.variante) || '—', 'w'], ['Cant.', x => x.cantidad, 'n'], ['Importe neto', x => money(x.importe), 'n']], r.por_variante)}
    <p class="note">Importe neto = después de descuentos. El CSV de inventario trae un renglón por código de platillo y día, más los tacos (papa/frijol) y bebidas de los paquetes como “componente”, igual que la hoja VENTAS del Excel. Los códigos son provisionales: confírmalos en “Menú y precios”.</p>`;
  $('#exInv').onclick = async () => {
    const A = S.admin; const rows = await call('admin_export', {p_desde: A.desde, p_hasta: A.hasta, p_demo: A.demo});
    descargaCSV(`ventas_inventario_${A.desde}_${A.hasta}${A.demo ? '_DEMO' : ''}.csv`, [['Fecha','Codigo','Producto','Variante','Tipo','Cantidad','Importe'], ...rows.map(x => [x.fecha, x.codigo, x.producto, x.variante, x.tipo, x.cantidad, x.importe])]);
  };
  $('#exVar').onclick = () => { const A = S.admin; descargaCSV(`ventas_producto_${A.desde}_${A.hasta}${A.demo ? '_DEMO' : ''}.csv`, [['Codigo','Producto','Variante','Cantidad','Importe neto'], ...r.por_variante.map(x => [x.codigo, x.producto, x.variante, x.cantidad, x.importe])]); };
}
function descargaCSV(nombre, rows){
  const csv = '﻿' + rows.map(r => r.map(v => { const s = String(v ?? ''); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; }).join(',')).join('\r\n');
  const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([csv], {type: 'text/csv;charset=utf-8'})); a.download = nombre; document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  toast('Archivo descargado');
}
async function aCortes(){
  const r = await reporte();
  $('#abody').innerHTML = tabla([['Fecha y hora', x => ftime(x.creado)], ['Hizo', x => esc(x.hecho_por)], ['Total turno', x => money(x.total), 'n'], ['Efectivo ventas', x => money(x.efectivo_ventas), 'n'],
    ['Fondo', x => money(x.fondo), 'n'], ['Esperado', x => money(x.esperado), 'n'], ['Contado', x => money(x.contado), 'n'], ['Diferencia', x => `<b class="${x.diferencia < 0 ? 'neg' : x.diferencia > 0 ? 'pos' : ''}">${money(x.diferencia)}</b>`, 'n']], r.cortes, 'Sin cortes en este periodo.');
}
async function aBitacora(){
  const A = S.admin; if (!A.bit) A.bit = await call('admin_bitacora', {p_desde: A.desde, p_hasta: A.hasta, p_demo: A.demo});
  const det = d => Object.entries(d || {}).map(([k, v]) => `${esc(k.replace(/_/g, ' '))}: <b>${esc(typeof v === 'object' ? JSON.stringify(v) : v)}</b>`).join(' · ');
  $('#abody').innerHTML = tabla([['Cuándo', x => ftime(x.cuando)], ['Quién', x => esc(x.quien)], ['Acción', x => esc(ACCION[x.accion] || x.accion)], ['Detalle', x => det(x.detalle), 'w']], A.bit, 'Sin movimientos en este periodo.') +
    '<p class="note">La bitácora no se puede borrar ni editar desde el sistema.</p>';
}
async function aPersonal(){
  const A = S.admin; A.per = await call('admin_personal');
  $('#abody').innerHTML = `<div class="row" style="margin-bottom:12px"><button class="btn pri" id="pnew">+ Agregar persona</button></div>
    ${tabla([['Nombre', x => esc(x.nombre) + (x.es_demo ? ' <span class="demo">DEMO</span>' : '')], ['Rol', x => x.rol], ['Estado', x => x.activo ? 'Activo' : 'Baja'], ['Bloqueo', x => x.bloqueado ? `<b class="neg">Bloqueado</b> <button class="btn sm" data-unl="${esc(x.id)}">Desbloquear</button>` : (x.intentos ? x.intentos + ' intento(s) fallido(s)' : '—')], ['', x => `<button class="btn sm" data-ped="${esc(x.id)}">Editar</button>`]], A.per)}
    <p class="note">Mesero: PIN de 4 a 6 dígitos. Encargada y administrador: 6 dígitos. Nadie puede ver un PIN: solo se cambia. Dar de baja o cambiar el PIN cierra la sesión de esa persona.</p>
    ${A.per.some(p => p.es_demo) && !esDemo() ? `<div class="card" style="margin-top:16px"><h2>Datos de prueba</h2><p class="muted">Borra el personal DEMO con todas sus órdenes, cobros, cortes y bitácora. Los datos reales no se tocan.</p><button class="btn" id="bdemo" style="border-color:var(--crit);color:var(--crit)">Borrar datos demo</button></div>` : ''}`;
  app().querySelectorAll('[data-unl]').forEach(b => b.onclick = async () => { await call('admin_desbloquear', {p_staff: b.dataset.unl}); toast('Desbloqueado'); aPersonal(); });
  app().querySelectorAll('[data-ped]').forEach(b => b.onclick = () => formPersona(A.per.find(p => p.id === b.dataset.ped)));
  $('#pnew').onclick = () => formPersona(null);
  const bd = $('#bdemo'); if (bd) bd.onclick = async () => { if (!bd.dataset.sure){ bd.dataset.sure = 1; bd.textContent = '¿Seguro? Toca otra vez'; return; }
    try { const r = await call('admin_borrar_demo'); toast(`Datos demo borrados (${r.ordenes_borradas} órdenes)`); S.admin.rep = S.admin.bit = null; aPersonal(); } catch(e){ toast(e.message, true); } };
}
function formPersona(p){
  abreModal(`<div class="sheet"><h2>${p ? 'Editar' : 'Nueva'} persona</h2>
    <label class="field">Nombre<input id="fn" maxlength="40" value="${esc(p?.nombre || '')}"></label>
    <label class="field">Rol<select id="fr">${['mesero','encargada','admin'].map(r => `<option value="${r}" ${p?.rol === r ? 'selected' : ''}>${r === 'admin' ? 'administrador' : r}</option>`).join('')}</select></label>
    <label class="field">${p ? 'PIN nuevo (vacío = no cambiar)' : 'PIN'}<input id="fp" type="password" inputmode="numeric" maxlength="6" autocomplete="new-password"></label>
    <label class="row"><input type="checkbox" id="fa" ${!p || p.activo ? 'checked' : ''} style="width:22px;height:22px"> Activo</label>
    <div class="foot"><button class="btn big" data-x="no">Cancelar</button><button class="btn pri big" data-x="si">Guardar</button></div></div>`);
  dlg().querySelector('[data-x="no"]').onclick = cierraModal;
  dlg().querySelector('[data-x="si"]').onclick = async () => {
    try { await call('admin_personal_guardar', {p_id: p?.id || null, p_nombre: $('#fn').value, p_rol: $('#fr').value, p_activo: $('#fa').checked, p_pin: $('#fp').value || null});
      cierraModal(); toast('Guardado'); S.personal = await rpc('pos_personal', {p_clave: S.clave}); aPersonal(); }
    catch(e){ toast(e.message, true); }
  };
}
async function aMenu(){
  const A = S.admin; A.prods = await call('admin_productos');
  const filas = A.prods.map(p => { const g = (p.grupos || []).find(g => g.opciones.some(o => o.precio != null));
    return `<tr><td><input class="cell w" data-f="nombre" data-id="${esc(p.id)}" value="${esc(p.nombre)}" style="width:220px"></td><td>${esc(p.categoria)}</td>
      <td class="n">${g ? g.opciones.map(o => `<label class="small" style="display:inline-flex;gap:4px;align-items:center;margin-left:6px">${esc(o.nombre)} <input class="cell" data-op="${esc(g.id)}|${esc(o.id)}" data-id="${esc(p.id)}" inputmode="decimal" value="${esc(o.precio)}" style="width:76px"></label>`).join('')
        : `<input class="cell" data-f="precio" data-id="${esc(p.id)}" inputmode="decimal" value="${esc(p.precio)}">`}</td>
      <td><input class="cell w" data-f="codigo" data-id="${esc(p.id)}" value="${esc(p.codigo)}" style="width:110px"></td>
      <td><input type="checkbox" data-f="activo" data-id="${esc(p.id)}" ${p.activo ? 'checked' : ''} style="width:22px;height:22px"></td>
      <td class="w small muted">${esc(p.nota_admin || '')}</td><td><button class="btn sm" data-sv="${esc(p.id)}">Guardar</button></td></tr>`; }).join('');
  $('#abody').innerHTML = `<div class="tbl"><table><thead><tr><th>Producto</th><th>Categoría</th><th class="n">Precio</th><th>Código</th><th>Activo</th><th>Nota</th><th></th></tr></thead><tbody>${filas}</tbody></table></div>
    <p class="note">Cada cambio de precio queda en la bitácora (antes → nuevo). Los productos inactivos no aparecen a los meseros. Agua mineral y natural están inactivas hasta capturar su precio.</p>
    <h3>Agregar producto sencillo (sin variantes)</h3><div class="card row"><input id="nn" class="cell w" style="width:220px" placeholder="Nombre"><select id="nc" class="cell w">${CATS.map(c => `<option>${c}</option>`).join('')}</select>
      <input id="np" class="cell" inputmode="decimal" placeholder="Precio"><input id="ncod" class="cell w" style="width:110px" placeholder="Código"><button class="btn" id="nadd">Agregar</button></div>`;
  app().querySelectorAll('[data-sv]').forEach(b => b.onclick = async () => {
    const id = b.dataset.sv, p = A.prods.find(x => x.id === id); const v = f => app().querySelector(`[data-f="${f}"][data-id="${id}"]`);
    const po = {}; app().querySelectorAll(`[data-op][data-id="${id}"]`).forEach(i => { const [g, o] = i.dataset.op.split('|'); (po[g] = po[g] || {})[o] = Number(i.value); });
    const body = {id, nombre: v('nombre').value, categoria: p.categoria, precio: v('precio') ? Number(v('precio').value) : p.precio, codigo: v('codigo').value, activo: v('activo').checked, orden: p.orden, precios_opciones: po};
    if (!v('precio') && Object.keys(po).length){ const g = (p.grupos || []).find(g => po[g.id]); const ids = g.opciones.map(o => o.id); body.precio = po[g.id][ids[0]]; }
    if (body.activo && !(body.precio > 0) && !Object.keys(po).length) return toast('Captura el precio antes de activar.', true);
    try { await call('admin_producto_guardar', {p: body}); toast('Guardado'); await cargaMenu(); aMenu(); } catch(e){ toast(e.message, true); }
  });
  $('#nadd').onclick = async () => { try { await call('admin_producto_guardar', {p: {nombre: $('#nn').value, categoria: $('#nc').value, precio: Number($('#np').value), codigo: $('#ncod').value, activo: true}}); toast('Producto agregado'); await cargaMenu(); aMenu(); } catch(e){ toast(e.message, true); } };
}
async function aAjustes(){
  const c = S.admin.cfg = await call('admin_config'); const aj = c.ajuste_plataforma || {};
  $('#abody').innerHTML = `<div class="two"><div class="card grid">
      <h2>Mesas y caja</h2>
      <label class="field">Número de mesas<input id="cm" class="cell" inputmode="numeric" value="${esc(c.mesas)}"></label>
      <label class="field">Fondo de caja sugerido ($)<input id="cf" class="cell" inputmode="decimal" value="${esc(c.fondo_caja)}"></label>
      <label class="field">Cierre automático por inactividad (minutos)<input id="ci" class="cell" inputmode="numeric" value="${esc(c.inactividad_min)}"></label>
      <label class="field">Intentos de PIN antes de bloquear<input id="cx" class="cell" inputmode="numeric" value="${esc(c.max_intentos)}"></label>
      <label class="field">Minutos de bloqueo<input id="cb" class="cell" inputmode="numeric" value="${esc(c.bloqueo_min)}"></label>
      <button class="btn pri" id="sv1">Guardar</button></div>
    <div class="card grid"><h2>Precios en plataformas</h2><p class="muted">% que se suma al precio del menú (se redondea al peso hacia arriba). 0 = mismo precio.</p>
      ${['rappi','didi','uber'].map(k => `<label class="field">${CANAL[k]} (%)<input id="pa_${k}" class="cell" inputmode="decimal" value="${esc(aj[k] ?? 0)}"></label>`).join('')}
      <label class="row"><input type="checkbox" id="pac" ${c.ajuste_plataforma_confirmado ? 'checked' : ''} style="width:22px;height:22px"> Porcentajes confirmados</label>
      <button class="btn pri" id="sv2">Guardar</button></div>
    <div class="card grid"><h2>Notas rápidas</h2><p class="muted">Una por renglón. Aparecen como botones al agregar un platillo.</p>
      <textarea id="cn" rows="7" style="font:16px var(--body);padding:10px;border-radius:10px;border:1.5px solid var(--line);background:var(--bg);color:var(--fg)">${esc((c.notas_rapidas || []).join('\n'))}</textarea>
      <button class="btn pri" id="sv3">Guardar</button></div></div>`;
  const g = (k, v) => call('admin_config_guardar', {p_clave: k, p_valor: v});
  const ok = async f => { try { await f(); toast('Guardado'); } catch(e){ toast(e.message, true); } };
  $('#sv1').onclick = () => ok(async () => { await g('mesas', Number($('#cm').value)); await g('fondo_caja', Number($('#cf').value)); await g('inactividad_min', Number($('#ci').value)); await g('max_intentos', Number($('#cx').value)); await g('bloqueo_min', Number($('#cb').value)); S.ses.config.mesas = Number($('#cm').value); S.ses.config.inactividad_min = Number($('#ci').value); });
  $('#sv2').onclick = () => ok(async () => { await g('ajuste_plataforma', {rappi: Number($('#pa_rappi').value) || 0, didi: Number($('#pa_didi').value) || 0, uber: Number($('#pa_uber').value) || 0}); await g('ajuste_plataforma_confirmado', $('#pac').checked); await cargaMenu(); });
  $('#sv3').onclick = () => ok(async () => { const n = $('#cn').value.split('\n').map(x => x.trim()).filter(Boolean).slice(0, 16); await g('notas_rapidas', n); S.ses.config.notas_rapidas = n; });
}


/* ---------- inventario ---------- */
const fq = (q, u) => { if (q == null) return '—'; const n = Number(q);
  if (u === 'g' && Math.abs(n) >= 1000) return (Math.round(n / 10) / 100).toLocaleString('es-MX') + ' kg';
  if (u === 'ml' && Math.abs(n) >= 1000) return (Math.round(n / 10) / 100).toLocaleString('es-MX') + ' L';
  return (Math.round(n * 100) / 100).toLocaleString('es-MX') + ' ' + u; };
const PILL = {'Agotado':'crit','Bajo mínimo':'crit','Pedir ya':'warn','Sin conteo':'mute','OK':'ok'};
const pill = e => `<span class="tag ${PILL[e] === 'crit' ? 'app' : PILL[e] === 'warn' ? 'pend' : PILL[e] === 'ok' ? 'mesa' : ''}">${esc(e)}</span>`;
const TIPOMOV = {inicial:'Conteo inicial', conteo:'Ajuste por conteo', compra:'Compra', produccion:'Producción', consumo_produccion:'Usado en producción', venta:'Venta', anulacion:'Venta anulada',
  merma:'Merma', consumo_personal:'Consumo personal', cortesia:'Cortesía', correccion:'Corrección'};
let invSub = 'existencias', invFiltro = 'todos', invCiego = true;
async function aInventario(){
  const A = S.admin; const d = await call('admin_inventario', {p_demo: A.demo}); A.inv = d;
  const ins = d.insumos; const cats = [...new Set(ins.map(i => i.categoria))];
  const alertas = ins.filter(i => ['Agotado','Bajo mínimo','Pedir ya'].includes(i.estado)).length;
  const vence = d.lotes.filter(l => l.dias <= 2);
  const subs = [['existencias','Existencias'],['capturar','Registrar movimiento'],['conteo','Conteo físico']];
  $('#abody').innerHTML = `${A.demo ? '<div class="banner">Incluye movimientos DEMO.</div>' : ''}
    ${d.lineas_por_medir ? `<div class="banner">El descuento automático usa solo ingredientes con cantidad: faltan <b>${d.lineas_por_medir} de ${d.lineas_total}</b> por medir. Captúralas en la pestaña <b>Recetas</b>; mientras tanto el conteo semanal corrige la diferencia.</div>` : ''}
    <div class="grid kpis">
      <div class="kpi"><div class="l">Valor del inventario</div><div class="v num">${money(ins.reduce((a, i) => a + (i.valor > 0 ? i.valor : 0), 0))}</div></div>
      <div class="kpi"><div class="l">Por pedir o agotados</div><div class="v num ${alertas ? 'neg' : ''}">${alertas}</div></div>
      <div class="kpi"><div class="l">Sin conteo</div><div class="v num">${ins.filter(i => i.estado === 'Sin conteo').length}</div></div>
      <div class="kpi"><div class="l">Lotes por vencer (≤ 2 días)</div><div class="v num ${vence.length ? 'neg' : ''}">${vence.length}</div></div></div>
    <div class="row" style="margin-bottom:12px">${subs.map(([k, l]) => `<button class="chip" data-isub="${k}" aria-pressed="${invSub === k}">${l}</button>`).join('')}<span class="spacer"></span><button class="btn sm" id="insNew">+ Insumo</button></div>
    <div id="ibody"></div>`;
  app().querySelectorAll('[data-isub]').forEach(b => b.onclick = () => { invSub = b.dataset.isub; aInventario(); });
  $('#insNew').onclick = () => formInsumo(null);
  ({existencias: invExistencias, capturar: invCapturar, conteo: invConteo})[invSub](d, cats);
}
function invExistencias(d, cats){
  let ins = d.insumos;
  if (invFiltro === 'alerta') ins = ins.filter(i => ['Agotado','Bajo mínimo','Pedir ya'].includes(i.estado));
  else if (invFiltro !== 'todos') ins = ins.filter(i => i.categoria === invFiltro);
  $('#ibody').innerHTML = `${d.lotes.length ? `<h3>Lotes con caducidad</h3>${tabla([['Insumo', l => esc(l.nombre)], ['Cantidad', l => fq(l.cantidad, l.unidad), 'n'], ['Caduca', l => fdate(l.caduca)], ['Días', l => `<b class="${l.dias < 0 ? 'neg' : l.dias <= 2 ? 'neg' : ''}">${l.dias < 0 ? 'Vencido' : l.dias}</b>`, 'n'],
      ['', l => `<button class="btn sm" data-lote="${esc(l.id)}" data-st="Agotado">Se usó</button> <button class="btn sm" data-lote="${esc(l.id)}" data-st="Merma">Merma</button>`]], d.lotes)}` : ''}
    <h3>Existencias</h3><div class="row" style="margin-bottom:10px">${[['todos','Todos'],['alerta','Por pedir'],...cats.map(c => [c, c])].map(([k, l]) => `<button class="chip" data-if="${esc(k)}" aria-pressed="${invFiltro === k}">${esc(l)}</button>`).join('')}</div>
    ${tabla([['Insumo', i => `<b>${esc(i.nombre)}</b><br><span class="muted small">${esc(i.codigo)}</span>`], ['Estado', i => pill(i.estado)], ['Existencia', i => `<b>${fq(i.existencia, i.unidad)}</b>`, 'n'],
      ['Mín. / objetivo', i => `${i.minimo != null ? fq(i.minimo, i.unidad) : '—'} / ${i.objetivo != null ? fq(i.objetivo, i.unidad) : '—'}`, 'n'], ['Consumo/día', i => i.consumo_dia ? fq(i.consumo_dia, i.unidad) : '—', 'n'],
      ['Alcanza', i => i.cobertura != null ? i.cobertura + ' días' : '—', 'n'], ['Pedir', i => i.sugerido ? fq(i.sugerido, i.unidad) : '—', 'n'], ['Último conteo', i => i.ultimo_conteo ? fdate(i.ultimo_conteo) : '—'],
      ['Costo', i => i.costo_unit != null ? money(i.costo_unit) + '/' + i.unidad : '—', 'n'], ['Valor', i => i.valor ? money(i.valor) : '—', 'n'],
      ['', i => `<button class="btn sm" data-kx="${esc(i.codigo)}">Historial</button> <button class="btn sm" data-ied="${esc(i.codigo)}">Editar</button>`]], ins, 'Ningún insumo con este filtro.')}
    <p class="note">Consumo/día = promedio de los últimos 7 días (ventas y producción). “Alcanza” = existencia ÷ consumo. “Pedir ya” cuando alcanza para 2 días o menos. Captura mínimo y objetivo en Editar para que el sistema sugiera cuánto pedir.</p>`;
  app().querySelectorAll('[data-if]').forEach(b => b.onclick = () => { invFiltro = b.dataset.if; invExistencias(d, cats); });
  app().querySelectorAll('[data-kx]').forEach(b => b.onclick = () => kardex(d.insumos.find(i => i.codigo === b.dataset.kx)));
  app().querySelectorAll('[data-ied]').forEach(b => b.onclick = () => formInsumo(d.insumos.find(i => i.codigo === b.dataset.ied)));
  app().querySelectorAll('[data-lote]').forEach(b => b.onclick = async () => { try { await call('admin_lote_estado', {p_lote: b.dataset.lote, p_estado: b.dataset.st}); toast('Listo'); aInventario(); } catch(e){ toast(e.message, true); } });
}
const opcionesInsumo = (ins, sel) => ins.map(i => `<option value="${esc(i.codigo)}" ${i.codigo === sel ? 'selected' : ''}>${esc(i.nombre)} (${esc(i.unidad)})</option>`).join('');
let movTipo = 'compra';
function invCapturar(d){
  const T = [['compra','Compra / recepción'],['produccion','Producción'],['merma','Merma'],['consumo_personal','Consumo del personal'],['cortesia','Cortesía'],['correccion','Corrección (+/−)']];
  const ins = movTipo === 'produccion' ? d.insumos.filter(i => i.codigo.startsWith('PRE-')) : d.insumos;
  $('#ibody').innerHTML = `<div class="card grid" style="max-width:640px">
    <div class="chips">${T.map(([k, l]) => `<button class="chip" data-mt="${k}" aria-pressed="${movTipo === k}">${l}</button>`).join('')}</div>
    <label class="field">${movTipo === 'produccion' ? 'Preparación' : 'Insumo'}<select id="mi">${opcionesInsumo(ins)}</select></label>
    <div id="mextra"></div>
    <label class="field">Nota ${['merma','correccion'].includes(movTipo) ? '(obligatoria)' : '(opcional)'}<input id="mn" maxlength="150"></label>
    <button class="btn pri big" id="msv">Guardar</button>
    <p class="note" id="mhelp"></p></div>`;
  app().querySelectorAll('[data-mt]').forEach(b => b.onclick = () => { movTipo = b.dataset.mt; invCapturar(d); });
  const extra = () => {
    const i = d.insumos.find(x => x.codigo === $('#mi').value); if (!i) return;
    const u = i.unidad;
    if (movTipo === 'compra') $('#mextra').innerHTML = `<div class="grid" style="grid-template-columns:1fr 1fr;gap:10px">
        <label class="field">Cantidad en ${u}<input id="mq" class="cell" style="width:100%" inputmode="decimal"></label>
        <label class="field">o en ${esc(i.presentacion || 'presentaciones')}${i.contenido ? ` (${fq(i.contenido, u)} c/u)` : ' (falta contenido)'}<input id="mp" class="cell" style="width:100%" inputmode="decimal" ${i.contenido ? '' : 'disabled'}></label>
        <label class="field">Costo total ($)<input id="mc" class="cell" style="width:100%" inputmode="decimal"></label>
        <label class="field">Proveedor<input id="mpv" class="cell w" style="width:100%" value="${esc(i.proveedor || '')}"></label>
        <label class="field">Caduca (opcional)<input id="mcad" type="date" class="cell w" style="width:100%"></label></div>`;
    else $('#mextra').innerHTML = `<label class="field">Cantidad en ${u}${movTipo === 'correccion' ? ' (negativo para restar)' : ''}<input id="mq" class="cell" style="width:100%" inputmode="decimal"></label>`;
    $('#mhelp').textContent = movTipo === 'produccion' ? 'Suma la preparación y descuenta sus ingredientes según el rendimiento capturado en Recetas.' : movTipo === 'compra' ? 'Suma al inventario y actualiza el costo (costo total ÷ cantidad).' : 'Resta del inventario.';
  };
  $('#mi').onchange = extra; extra();
  $('#msv').onclick = async () => {
    const v = id => $(id) ? $(id).value.trim() : '';
    try {
      if (movTipo === 'produccion'){
        const r = await call('admin_produccion', {p_insumo: v('#mi'), p_cantidad: Number(v('#mq')), p_nota: v('#mn') || null});
        toast(r.sin_rendimiento ? 'Producción registrada. Falta el rendimiento en Recetas: no se descontaron ingredientes.' : `Producción registrada · ${r.ingredientes_descontados} ingrediente(s) descontados${r.ingredientes_por_medir ? `, ${r.ingredientes_por_medir} por medir` : ''}`, r.sin_rendimiento);
      } else {
        const r = await call('admin_inv_registrar', {p: {tipo: movTipo, insumo: v('#mi'), cantidad: v('#mq'), presentaciones: v('#mp'), costo_total: v('#mc'), proveedor: v('#mpv'), caduca: v('#mcad'), nota: v('#mn')}});
        toast('Guardado · existencia: ' + fq(r.existencia, d.insumos.find(x => x.codigo === v('#mi')).unidad));
      }
      $('#mn').value = ''; if ($('#mq')) $('#mq').value = ''; if ($('#mp')) $('#mp').value = ''; if ($('#mc')) $('#mc').value = '';
    } catch(e){ toast(e.message, true); }
  };
}
function invConteo(d, cats){
  $('#ibody').innerHTML = `<div class="banner" style="background:var(--info-bg);color:var(--info)">Cuenta lo que hay físicamente y escríbelo en la unidad indicada. Deja vacío lo que no contaste. Al guardar, la existencia queda igual a lo contado y la diferencia se registra como ajuste.</div>
    <label class="row small" style="margin-bottom:10px"><input type="checkbox" id="ciego" ${invCiego ? 'checked' : ''} style="width:22px;height:22px"> Conteo a ciegas (no mostrar lo que el sistema espera)</label>
    ${cats.map(c => `<h3>${esc(c)}</h3>${tabla([['Insumo', i => esc(i.nombre)], ['Unidad', i => i.unidad], ...(invCiego ? [] : [['Esperado', i => fq(i.existencia, i.unidad), 'n']]),
       ['Contado', i => `<input class="cell" data-cnt="${esc(i.codigo)}" inputmode="decimal">`, 'n']], d.insumos.filter(i => i.categoria === c))}`).join('')}
    <div class="card row" style="position:sticky;bottom:8px;margin-top:12px"><input id="cnota" class="cell w" style="flex:1" placeholder="Nota (opcional): quién contó, observaciones"><button class="btn pri big" id="csave">Guardar conteo</button></div>`;
  $('#ciego').onchange = e => { invCiego = e.target.checked; invConteo(d, cats); };
  $('#csave').onclick = async () => {
    const items = [...app().querySelectorAll('[data-cnt]')].filter(i => i.value.trim() !== '').map(i => ({insumo: i.dataset.cnt, contado: Number(i.value.replace(',', '.'))}));
    if (!items.length) return toast('No capturaste ningún conteo.', true);
    if (items.some(i => !(i.contado >= 0))) return toast('Hay un número no válido.', true);
    try { const r = await call('admin_conteo', {p_items: items, p_nota: $('#cnota').value.trim() || null});
      abreModal(`<div class="sheet"><h2>Conteo guardado</h2><p class="muted">${r.resultado.length} insumo(s). Diferencias contra lo que esperaba el sistema:</p>
        ${tabla([['Insumo', x => esc(x.insumo)], ['Esperado', x => fq(x.esperado, x.unidad), 'n'], ['Contado', x => fq(x.contado, x.unidad), 'n'], ['Diferencia', x => `<b class="${x.diferencia < 0 ? 'neg' : x.diferencia > 0 ? 'pos' : ''}">${fq(x.diferencia, x.unidad)}</b>`, 'n']], r.resultado)}
        <div class="foot"><button class="btn pri big" data-x="ok">Listo</button></div></div>`);
      dlg().querySelector('[data-x="ok"]').onclick = () => { cierraModal(); invSub = 'existencias'; aInventario(); };
    } catch(e){ toast(e.message, true); }
  };
}
async function kardex(i){
  const k = await call('admin_kardex', {p_insumo: i.codigo, p_demo: S.admin.demo});
  abreModal(`<div class="sheet"><div class="row"><h2 style="margin:0">${esc(i.nombre)}</h2><span class="spacer"></span><button class="btn sm" data-x="no">Cerrar</button></div>
    <p class="muted" style="margin:0">Existencia: <b>${fq(i.existencia, i.unidad)}</b> · últimos ${k.length} movimientos</p>
    ${tabla([['Cuándo', x => ftime(x.cuando)], ['Movimiento', x => esc(TIPOMOV[x.tipo] || x.tipo)], ['Cantidad', x => `<span class="${x.cantidad < 0 ? 'neg' : 'pos'}">${x.cantidad > 0 ? '+' : ''}${fq(x.cantidad, i.unidad)}</span>`, 'n'],
      ['Saldo', x => fq(x.saldo, i.unidad), 'n'], ['Nota', x => esc(x.nota || '') + (x.quien ? ` <span class="muted">· ${esc(x.quien)}</span>` : ''), 'w']], k, 'Sin movimientos.')}</div>`);
  dlg().querySelector('[data-x="no"]').onclick = cierraModal;
}
function formInsumo(i){
  const f = (k, l, extra) => `<label class="field">${l}<input id="fi_${k}" value="${esc(i?.[k] ?? '')}" ${extra || ''}></label>`;
  abreModal(`<div class="sheet"><h2>${i ? 'Editar' : 'Nuevo'} insumo</h2>
    <div class="grid" style="grid-template-columns:1fr 1fr;gap:10px">
      ${f('codigo', 'Código (ABC-001)', i ? 'disabled' : '')}${f('nombre', 'Nombre')}
      ${f('categoria', 'Categoría')}<label class="field">Unidad base<select id="fi_unidad">${['g','ml','pz'].map(u => `<option ${i?.unidad === u ? 'selected' : ''}>${u}</option>`).join('')}</select></label>
      ${f('presentacion', 'Presentación de compra (caja, bolsa…)')}${f('contenido', 'Contenido por presentación (u. base)', 'inputmode="decimal"')}
      ${f('minimo', 'Stock mínimo (u. base)', 'inputmode="decimal"')}${f('objetivo', 'Stock objetivo (u. base)', 'inputmode="decimal"')}
      ${f('costo_unit', 'Costo por unidad base ($)', 'inputmode="decimal"')}${f('proveedor', 'Proveedor')}
      ${f('vida_util_dias', 'Vida útil (días)', 'inputmode="numeric"')}${f('ubicacion', 'Ubicación')}</div>
    ${f('notas', 'Notas')}
    <label class="row"><input type="checkbox" id="fi_activo" ${!i || i.activo !== false ? 'checked' : ''} style="width:22px;height:22px"> Activo</label>
    <div class="foot"><button class="btn big" data-x="no">Cancelar</button><button class="btn pri big" data-x="si">Guardar</button></div></div>`);
  dlg().querySelector('[data-x="no"]').onclick = cierraModal;
  dlg().querySelector('[data-x="si"]').onclick = async () => {
    const g = k => $('#fi_' + k).value.trim();
    const p = {codigo: i?.codigo || g('codigo'), nombre: g('nombre'), categoria: g('categoria'), unidad: g('unidad'), presentacion: g('presentacion'), contenido: g('contenido'), minimo: g('minimo'),
      objetivo: g('objetivo'), costo_unit: g('costo_unit'), proveedor: g('proveedor'), vida_util_dias: g('vida_util_dias'), ubicacion: g('ubicacion'), notas: g('notas'), activo: $('#fi_activo').checked};
    try { await call('admin_insumo_guardar', {p}); cierraModal(); toast('Guardado'); aInventario(); } catch(e){ toast(e.message, true); }
  };
}
let recFiltro = 'por_medir';
async function aRecetas(){
  const d = await call('admin_recetas'); const TIPOS = [...new Set(d.recetas.map(r => r.tipo))];
  let rs = d.recetas.filter(r => r.lineas.length || r.tipo === 'Preparación');
  if (recFiltro === 'por_medir') rs = rs.filter(r => r.lineas.some(l => l.cantidad == null) || (r.tipo === 'Preparación' && r.rendimiento == null));
  else if (recFiltro !== 'todas') rs = rs.filter(r => r.tipo === recFiltro);
  const faltan = d.recetas.reduce((a, r) => a + r.lineas.filter(l => l.cantidad == null).length, 0);
  $('#abody').innerHTML = `<p class="muted" style="margin-top:0">Cantidad por porción vendida (o por lote en preparaciones), en la unidad indicada. <b>${faltan}</b> ingrediente(s) por medir. Cada cambio queda en la bitácora y aplica a las ventas desde ese momento.</p>
    <div class="row" style="margin-bottom:12px">${[['por_medir','Por medir'],['todas','Todas'],...TIPOS.map(t => [t, t])].map(([k, l]) => `<button class="chip" data-rf="${esc(k)}" aria-pressed="${recFiltro === k}">${esc(l)}</button>`).join('')}</div>
    ${rs.length ? `<div class="two">${rs.map(r => `<div class="card" data-rec="${esc(r.codigo)}"><div class="row"><b>${esc(r.nombre)}</b><span class="spacer"></span><span class="muted small">${esc(r.codigo)} · ${esc(r.tipo)}</span></div>
      ${r.tipo === 'Preparación' ? `<label class="field" style="margin-top:8px">Rendimiento de un lote (${esc(r.unidad_rend || '')})<input class="cell" data-rend inputmode="decimal" value="${esc(r.rendimiento ?? '')}" placeholder="por medir"></label>` : ''}
      <table style="margin-top:8px"><tbody>${r.lineas.map(l => `<tr><td class="w">${esc(l.nombre)}${l.nota ? `<br><span class="muted small">${esc(l.nota)}</span>` : ''}</td>
        <td class="n"><input class="cell" data-lin="${esc(l.insumo)}" inputmode="decimal" value="${esc(l.cantidad ?? '')}" placeholder="por medir" style="${l.cantidad == null ? 'border-color:var(--warn)' : ''}"> ${esc(l.unidad)}</td></tr>`).join('')}</tbody></table>
      <div class="row" style="margin-top:8px"><select class="cell w" data-addi style="flex:1"><option value="">+ ingrediente…</option>${opcionesInsumo(d.insumos)}</select><button class="btn sm pri" data-rsv="${esc(r.codigo)}">Guardar</button></div></div>`).join('')}</div>` : '<div class="empty">Nada por medir en este filtro.</div>'}`;
  app().querySelectorAll('[data-rf]').forEach(b => b.onclick = () => { recFiltro = b.dataset.rf; aRecetas(); });
  app().querySelectorAll('[data-rsv]').forEach(b => b.onclick = async () => {
    const card = b.closest('[data-rec]'); const p = {receta: b.dataset.rsv, lineas: []};
    card.querySelectorAll('[data-lin]').forEach(i => p.lineas.push({insumo: i.dataset.lin, cantidad: i.value.trim() === '' ? null : Number(i.value.replace(',', '.'))}));
    const add = card.querySelector('[data-addi]').value; if (add && !p.lineas.some(l => l.insumo === add)) p.lineas.push({insumo: add, cantidad: null});
    const rd = card.querySelector('[data-rend]'); if (rd) p.rendimiento = rd.value.trim() === '' ? null : Number(rd.value.replace(',', '.'));
    if (p.lineas.some(l => l.cantidad != null && !(l.cantidad >= 0))) return toast('Hay una cantidad no válida.', true);
    try { const r = await call('admin_receta_guardar', {p}); toast(r.cambios ? `Receta guardada (${r.cambios} cambio(s))` : 'Sin cambios'); aRecetas(); } catch(e){ toast(e.message, true); }
  });
}

/* ================= eventos generales ================= */
document.addEventListener('click', async e => {
  const b = e.target.closest('[data-act]'); if (!b) return;
  const a = b.dataset.act;
  if (a === 'salir') return cerrarSesion();
  if (a === 'recargar') return location.reload();
  if (a === 'imprimir') return print();
  if (a === 'inicio'){ if (S.o?.nuevos?.length && !b.dataset.sure){ b.dataset.sure = 1; b.textContent = 'Hay productos sin guardar. ¿Salir?'; return; } S.o = null; S.vista = 'inicio'; render(); return cargaOrdenes(true); }
  if (a === 'nueva'){ tipoSel = 'mesa'; S.vista = 'tipo'; render(); return; }
  if (a === 'guardar') return guardar(true);
  if (a === 'cobrar') return cobrar();
  if (a === 'desc') return descuento();
  if (a === 'cancelOrden') return cancelarOrden();
  if (a === 'corte'){ S.vista = 'corte'; return render(); }
  if (a === 'admin'){ S.vista = 'admin'; return render(); }
  if (a === 'verErrores'){
    abreModal(`<div class="sheet"><h2>Operaciones no registradas</h2><p class="muted">Se hicieron sin internet y el servidor las rechazó. Captúralas de nuevo si hace falta.</p>
      ${S.errores.map(x => `<div class="payrow"><span>${ftime(x.ts)} · ${esc(x.fn === 'pos_cobrar' ? 'Cobro' : 'Orden')}</span><span>${esc(x.msg)}</span></div>`).join('')}
      <div class="foot"><button class="btn big" data-x="no">Cerrar</button><button class="btn pri big" data-x="clr">Ya lo revisé</button></div></div>`);
    dlg().querySelector('[data-x="no"]').onclick = cierraModal;
    dlg().querySelector('[data-x="clr"]').onclick = () => { S.errores = []; guardaCola(); cierraModal(); render(); };
  }
});
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && S.ses && !locked && S.vista === 'inicio') cargaOrdenes(true); });
setInterval(() => { if (S.ses && !locked && S.vista === 'inicio' && S.online) cargaOrdenes(true); }, 30000);

/* ================= inicio ================= */
if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});
if (CFG.PRUEBAS) window.__pos = S; // solo en pruebas automáticas
render();
})();
