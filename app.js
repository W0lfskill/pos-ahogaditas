/* Ahogaditas Tapatío · Punto de venta para meseros
 * Toda la seguridad vive en el servidor (funciones de Supabase). Esta página
 * solo muestra lo que el servidor le devuelve a la persona que entró.
 * En el dispositivo solo se guarda: la clave del dispositivo, el menú
 * (precios de venta) y las órdenes pendientes de sincronizar. Nada de
 * costos, reportes, nómina ni ventas de otros. */
(() => {
'use strict';
const CFG = window.POS_CONFIG || {};
const VERSION = '1.5.1';

/* ================= utilidades ================= */
const $ = s => document.querySelector(s);
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const fmt = new Intl.NumberFormat('es-MX', {style:'currency', currency:'MXN', minimumFractionDigits:0, maximumFractionDigits:2});
const fmt2 = new Intl.NumberFormat('es-MX', {style:'currency', currency:'MXN', minimumFractionDigits:2, maximumFractionDigits:2});
const money = v => { const n = Number(v) || 0; return Number.isInteger(Math.round(n * 100) / 100) ? fmt.format(n) : fmt2.format(n); };
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
  anular_venta_cobrada:'Anuló venta cobrada', borrar_demo:'Borró datos demo',
  uso_2fa:'Usó código de verificación', codigo_2fa_fallido:'Código de verificación incorrecto', activar_2fa:'Activó verificación en dos pasos', quitar_2fa:'Quitó verificación en dos pasos'};
const folioTxt = o => o.folio ? '#' + o.folio : '';
const folioHTML = (o, cls = '') => `<span class="folio ${cls}"><small>Folio</small>${o.folio ? '#' + esc(o.folio) : '<i>por asignar</i>'}</span>`;
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
  cer: nuevoCer(),      // "Cobradas hoy" de la pantalla principal
};
function nuevoCer(){ return {abierta: false, q: '', fecha: null, d: null, ts: 0, cargando: false, err: null}; }
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
      try { const r = await rpc(it.fn, {p_token: S.ses.token, ...it.params}); S.cola = S.cola.filter(x => x.id !== it.id); guardaCola();
        if (it.fn === 'pos_guardar_orden' && r?.orden?.folio && !S.ordenes[r.orden.id]?.folio){ S.ordenes[r.orden.id] = {...r.orden}; toast(`Ya hay internet: ${etiquetaOrden(r.orden)} es la orden #${r.orden.folio}. Anótalo en la comanda.`); } }
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
  S.admin.rep = S.admin.bit = S.admin.per = S.admin.prods = S.admin.cfg = S.admin.inv = S.admin.od = null;
  if (S.vista === 'admin' || S.vista === 'corte' || S.vista === 'mapa') S.vista = 'inicio';
  padPin($('#lpad'), $('#ldots'), async pin => {
    if (S.online){
      const r = await rpc('pos_login', {p_clave: S.clave, p_staff: S.ses.staff.id, p_pin: pin}).catch(e => e);
      if (r instanceof ApiError && r.code === 'RED'){ return desbloqueoLocal(pin); }
      if (r instanceof ApiError){ $('#lmsg').textContent = r.message; return false; }
      const listo = r2 => { const viejo = S.ses.token; S.ses.token = r2.token; rpc('pos_logout', {p_token: viejo}).catch(() => {}); quitaLock(); };
      if (!r.ok && r.requiere_codigo){
        pideCodigo(el, S.ses.staff.nombre, async cod => {
          const r2 = await rpc('pos_login', {p_clave: S.clave, p_staff: S.ses.staff.id, p_pin: pin, p_codigo: cod}).catch(e => e);
          if (r2 instanceof ApiError) return r2.message;
          if (!r2.ok) return r2.error;
          listo(r2); return true;
        }, () => { quitaLock(); cerrarSesion(); });
        return true;
      }
      if (!r.ok){ $('#lmsg').textContent = r.error; return false; }
      listo(r); return true;
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
  S.admin = {tab:'resumen', desde:null, hasta:null, demo:false}; S.cer = nuevoCer();
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
  const v = {inicio: vInicio, tipo: vTipo, orden: vOrden, corte: vCorte, admin: vAdmin, rutina: vRutina, mapa: vMapa}[S.vista] || vInicio;
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
    const entra = async r2 => {
      const salt = uuid();
      S.ses = {token: r2.token, staff: r2.staff, config: r2.config, salt, pinHash: await sha256(salt + pin)};
      S.vista = 'inicio'; tocar();
      await cargaMenu(); render(); sincroniza();
    };
    if (!r.ok && r.requiere_codigo){
      pideCodigo($('#lg'), sel.nombre, async cod => {
        const r2 = await rpc('pos_login', {p_clave: S.clave, p_staff: sel.id, p_pin: pin, p_codigo: cod}).catch(e => e);
        if (r2 instanceof ApiError) return r2.message;
        if (!r2.ok) return r2.error;
        await entra(r2); return true;
      }, () => vLogin());
      return true;
    }
    if (!r.ok){ $('#pmsg').textContent = r.error; return false; }
    await entra(r); return true;
  });
}
// Segundo paso: código de 6 dígitos del autenticador (Google Authenticator)
function pideCodigo(cont, nombre, onCode, onBack){
  cont.innerHTML = `<div class="pinbox" id="t2"><h1>${esc(nombre)}</h1><p class="muted">Verificación en dos pasos: escribe el código de 6 dígitos que ves en Google Authenticator</p>
    <div class="dots" id="tdots"></div><div class="pad" id="tpad"></div><div class="msg" id="tmsg"></div>
    <button class="btn ghost block" id="tback" style="margin-top:12px">← Volver</button></div>`;
  $('#tback').onclick = onBack;
  padPin($('#tpad'), $('#tdots'), async cod => {
    const r = await onCode(cod);
    if (r === true) return true;
    const m = $('#tmsg'); if (m) m.textContent = r || 'Código incorrecto.'; return false;
  }, 6);
}
function padPin(pad, dots, onOk, min = 4){
  let pin = '', busy = false; const MAX = 6;
  const draw = () => dots.innerHTML = Array.from({length: Math.max(min, pin.length)}, (_, i) => `<i class="${i < pin.length ? 'on' : ''}"></i>`).join('');
  pad.innerHTML = [1,2,3,4,5,6,7,8,9].map(n => `<button data-k="${n}">${n}</button>`).join('') + `<button class="fn" data-k="del">Borrar</button><button data-k="0">0</button><button class="fn" data-k="ok" style="color:var(--accent);font-weight:800">Entrar</button>`;
  const press = async k => {
    if (busy) return;
    if (k === 'del') pin = pin.slice(0, -1);
    else if (k === 'ok'){ if (pin.length < min) return; busy = true; const ok = await onOk(pin); busy = false; if (!ok){ pin = ''; } }
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
  const card = o => { const t = totales(o); return `<div class="ordwrap"><button class="card order" data-open="${esc(o.id)}">
      <div class="row"><span class="tag ${o.tipo === 'mesa' ? 't-mesa' : o.tipo === 'llevar' ? 't-llevar' : 't-app'}">${esc(CANAL[o.tipo])}</span>${o.pendiente ? '<span class="tag pend">Por enviar</span>' : ''}<span class="spacer"></span>${folioHTML(o)}</div>
      <b>${esc(etiquetaOrden(o))}</b><div class="row"><span class="t num">${money(t.total)}</span><span class="spacer"></span><span class="muted small">${minsAgo(o.abierta_en)} min${otras.length || r !== 'mesero' ? ' · ' + esc(o.mesero || '') : ''}</span></div></button>
      ${o.pendiente ? '' : `<button class="btn cx" data-cxo="${esc(o.id)}">Cancelar orden</button>`}</div>`; };
  const foco = document.activeElement?.id === 'cerq' ? document.activeElement.selectionStart : null;
  const errs = r !== 'mesero' && S.errores.length ? `<div class="banner crit">${S.errores.length} operación(es) hechas sin internet no se registraron. <button class="btn sm" data-act="verErrores">Ver</button></div>` : '';
  app().innerHTML = barra() + `<main>${errs}
    <div class="row" style="margin-bottom:14px"><button class="btn pri big" data-act="nueva" style="flex:1;min-width:220px">+ Nueva orden</button>
      ${r !== 'mesero' ? '<button class="btn big" data-act="rutina">Apertura y cierre</button><button class="btn big" data-act="corte">Corte de caja</button>' : ''}${r === 'admin' ? '<button class="btn big" data-act="mapa">Mapa del restaurante</button><button class="btn big" data-act="anular">Anular venta cobrada</button><button class="btn big" data-act="admin">Panel</button>' : ''}</div>
    <h3>${r === 'mesero' ? 'Mis órdenes abiertas' : 'Mis órdenes'}</h3>
    ${mias.length ? `<div class="grid cards">${mias.map(card).join('')}</div>` : '<div class="empty">No tienes órdenes abiertas.</div>'}
    ${r !== 'mesero' ? `<h3>Órdenes abiertas de los demás</h3>${otras.length ? `<div class="grid cards">${otras.map(card).join('')}</div>` : '<div class="empty">Ninguna.</div>'}` : ''}
    ${seccionCerradas()}
    ${S.menu?.ajuste_confirmado === false && Object.values(S.menu?.ajuste_plataforma || {}).every(v => !v) ? '<p class="note">Precios de Rappi / DiDi / Uber: por confirmar (hoy se cobra igual que en local).</p>' : ''}
  </main>`;
  app().querySelectorAll('[data-open]').forEach(b => b.onclick = () => abreOrden(b.dataset.open));
  app().querySelectorAll('[data-cxo]').forEach(b => b.onclick = () => cancelarOrden(b.dataset.cxo));
  montaCerradas();
  if (foco != null){ const q = $('#cerq'); if (q){ q.focus(); try { q.setSelectionRange(foco, foco); } catch(e){} } }
}

/* ---------- cobradas hoy (pantalla principal) ----------
 * El servidor decide qué se ve: el mesero solo SUS órdenes de hoy (sin total del día),
 * la encargada todas las de hoy y el admin cualquier fecha. */
const horaCorta = t => t ? new Date(t).toLocaleTimeString('es-MX', {hour: '2-digit', minute: '2-digit'}) : '';
const tituloCer = d => !d || d.fecha === d.hoy ? 'Cobradas hoy' : 'Cobradas del ' + fdate(d.fecha);
function seccionCerradas(){
  const C = S.cer, d = C.d;
  return `<details class="cerradas" id="cer" ${C.abierta ? 'open' : ''}><summary><span id="certit">${esc(tituloCer(d))}</span> <span class="num" id="cern">(${d ? d.cobradas : '…'})</span></summary>
    <div class="cerbar"><input id="cerq" class="cell cerq" type="search" inputmode="numeric" autocomplete="off" placeholder="Buscar folio o mesa" value="${esc(C.q)}" aria-label="Buscar por folio o número de mesa">
      ${rol() === 'admin' ? `<label class="row small cerf">Fecha <input type="date" id="cerf" class="cell w" max="${hoyISO()}" value="${esc(C.fecha || hoyISO())}"></label>` : ''}</div>
    <p class="muted small" id="cerres" style="margin:8px 14px"></p><div id="cerlist"></div></details>`;
}
function montaCerradas(){
  const det = $('#cer'); if (!det) return;
  det.ontoggle = () => { S.cer.abierta = det.open; if (det.open) cargaCerradas(); };
  const q = $('#cerq'); q.oninput = () => { S.cer.q = q.value; pintaCerradas(); };
  const f = $('#cerf'); if (f) f.onchange = () => { S.cer.fecha = f.value || hoyISO(); S.cer.d = null; pintaCerradas(); cargaCerradas(true); };
  pintaCerradas();
  if (!S.cer.d || Date.now() - S.cer.ts > 15000) cargaCerradas();
}
async function cargaCerradas(forzar){
  const C = S.cer; if (!S.ses || C.cargando) return;
  if (!forzar && C.d && Date.now() - C.ts < 5000) return;
  C.cargando = true; const pedida = C.fecha;
  try { const d = await call('pos_ordenes_cerradas', rol() === 'admin' && C.fecha ? {p_fecha: C.fecha} : {});
    if (S.cer === C && pedida === C.fecha){ C.d = d; C.ts = Date.now(); C.err = null; } }
  catch(e){ if (S.cer === C) C.err = e.code === 'RED' ? 'Sin internet: no se pudo actualizar la lista.' : e.message; }
  finally { C.cargando = false; }
  if (S.cer !== C) return;                       // cambió de usuario mientras cargaba
  if (pedida !== C.fecha) return cargaCerradas(true);  // cambió la fecha mientras cargaba
  if (S.vista === 'inicio') pintaCerradas();
}
// Número → folio o número de mesa. Texto → nombre del cliente o número de pedido. (Igual que el servidor.)
function coincideCer(o, q){
  if (/^\d+$/.test(q)) return String(o.folio) === String(Number(q)) || (o.tipo === 'mesa' && String(o.mesa) === String(Number(q)));
  return String(o.cliente || '').toLowerCase().includes(q.toLowerCase());
}
function tarjetaCerrada(o){
  const cx = o.estado === 'cancelada';
  const mets = (o.metodos || []).map(m => METODO[m] || m).join(' + ');
  return `<button class="card cerrada ${cx ? 'cx' : ''}" data-cer="${esc(o.id)}">
    <div class="row"><span class="tag ${cx ? 'est-cancelada' : 'est-cobrada'}">${cx ? 'Cancelada' : 'Cobrada'}</span><span class="spacer"></span>${folioHTML(o)}</div>
    <b class="cl">${esc(lugarOrden(o))}</b>
    <div class="row"><span class="t num">${cx ? `<s>${money(o.total)}</s>` : money(o.total)}</span><span class="spacer"></span><span class="muted small">${horaCorta(cx ? o.cancelada_en : o.cobrada_en)}</span></div>
    <span class="muted small">${esc(o.mesero || '')}${!cx && mets ? ' · ' + esc(mets) : ''}</span>
    ${cx ? `<span class="small cxm">Motivo: ${esc(o.cancel_motivo || '—')}</span>` : ''}</button>`;
}
function pintaCerradas(){
  const C = S.cer, d = C.d, el = $('#cerlist'); if (!el) return;
  $('#certit').textContent = tituloCer(d); $('#cern').textContent = d ? `(${d.cobradas})` : '(…)';
  const res = $('#cerres');
  if (!d){ res.textContent = ''; el.innerHTML = C.err ? `<div class="banner">${esc(C.err)}</div>` : '<p class="muted">Cargando…</p>'; return; }
  const q = C.q.trim().replace(/^#/, '');
  const filas = q ? d.ordenes.filter(o => coincideCer(o, q)) : d.ordenes;
  res.innerHTML = `${d.cobradas} cobrada${d.cobradas === 1 ? '' : 's'}${d.canceladas ? ` · ${d.canceladas} cancelada${d.canceladas === 1 ? '' : 's'} (no suman)` : ''}${d.total != null ? ` · Total cobrado <b class="num">${money(d.total)}</b>` : ''}${C.err ? ` · <span style="color:var(--warn)">${esc(C.err)}</span>` : ''}`;
  el.innerHTML = filas.length ? `<div class="grid cards">${filas.map(tarjetaCerrada).join('')}</div>`
    : `<div class="empty">${q ? `No encontré el folio o la mesa “${esc(q)}”${d.fecha === d.hoy ? ' hoy' : ' en esa fecha'}.` : d.fecha === d.hoy ? 'Todavía no hay órdenes cobradas hoy.' : 'No hay órdenes cobradas en esa fecha.'}</div>`;
  el.querySelectorAll('[data-cer]').forEach(b => b.onclick = () => detalleCerrada(b.dataset.cer));
}
// Detalle en solo lectura de una orden cobrada o cancelada
async function detalleCerrada(id){
  const fila = S.cer.d?.ordenes.find(x => x.id === id) || {};
  let o; try { o = (await call('pos_orden', {p_orden: id})).orden; } catch(e){ return toast(e.message, true); }
  o = {...o, cobrada_en: fila.cobrada_en, cancelada_en: fila.cancelada_en, cancel_motivo: fila.cancel_motivo, cancelada_por: fila.cancelada_por};
  const cx = o.estado === 'cancelada';
  const activos = o.items.filter(i => i.estado !== 'cancelado'), quitados = o.items.filter(i => i.estado === 'cancelado');
  const linea = i => `<div class="payrow"><span>${i.cantidad}× ${esc(i.nombre)}${i.variante ? `<br><span class="muted small">${esc(i.variante)}</span>` : ''}${i.nota ? `<br><span class="small" style="color:var(--warn)">Nota: ${esc(i.nota)}</span>` : ''}${i.estado === 'cancelado' ? `<br><span class="small" style="color:var(--crit)">Cancelado: ${esc(i.cancel_motivo || '')}</span>` : ''}</span><span class="num">${i.estado === 'cancelado' ? `<s>${money(i.importe)}</s>` : money(i.importe)}</span></div>`;
  const pago = p => `<div class="payrow"><span>${esc(METODO[p.metodo] || p.metodo)}${p.recibido ? ` · recibió ${money(p.recibido)}` : ''}${Number(p.cambio) > 0 ? ` · cambio ${money(p.cambio)}` : ''}${Number(p.propina) > 0 ? ` · propina ${money(p.propina)}` : ''}</span><span class="num">${money(p.monto)}</span></div>`;
  abreModal(`<div class="sheet cerdet"><div class="row"><h2 style="margin:0">Orden <span class="foliobig sm">#${esc(o.folio)}</span></h2><span class="spacer"></span><button class="btn sm" data-x="no">Cerrar</button></div>
    <p class="muted" style="margin:0">${esc(lugarOrden(o))} · ${esc(o.mesero || '')} · ${cx ? 'cancelada' : 'cobrada'} ${(cx ? o.cancelada_en : o.cobrada_en) ? ftime(cx ? o.cancelada_en : o.cobrada_en) : ''} <span class="tag est-${esc(o.estado)}">${esc(ESTADO[o.estado] || o.estado)}</span></p>
    ${cx ? `<div class="banner crit" style="margin:0">Orden cancelada${o.cancelada_por ? ' · autorizó ' + esc(o.cancelada_por) : ''}. Motivo: ${esc(o.cancel_motivo || '—')}. No suma a las ventas.</div>` : ''}
    <h3 style="margin:4px 0 0">Productos</h3>${activos.length ? `<div class="paylist">${activos.map(linea).join('')}</div>` : '<p class="muted" style="margin:0">Sin productos.</p>'}
    ${quitados.length ? `<h3 style="margin:4px 0 0">Productos cancelados</h3><div class="paylist">${quitados.map(linea).join('')}</div>` : ''}
    ${Number(o.descuento) > 0 ? `<div class="tot"><span class="muted">Subtotal</span><span class="num">${money(o.subtotal)}</span></div>
      <div class="tot"><span class="muted">Descuento${o.descuento_tipo === 'pct' ? ' ' + esc(o.descuento_valor) + ' %' : ''}${o.descuento_motivo ? ' · ' + esc(o.descuento_motivo) : ''}</span><span class="num">−${money(o.descuento)}</span></div>` : ''}
    <div class="tot"><span>Total</span><b class="num">${cx ? `<s>${money(o.total)}</s>` : money(o.total)}</b></div>
    <h3 style="margin:4px 0 0">Pagos</h3>${o.pagos?.length ? `<div class="paylist">${o.pagos.map(pago).join('')}</div>` : '<p class="muted" style="margin:0">Sin pagos.</p>'}
    ${Number(o.propina) > 0 ? `<div class="tot"><span class="muted">Propina</span><span class="num">${money(o.propina)}</span></div>` : ''}
    ${cx ? '' : `<div class="foot"><button class="btn big" data-x="tk">Reimprimir ticket</button>${rol() === 'admin' ? '<button class="btn big cx" data-x="anu">Anular venta cobrada</button>' : ''}</div>`}</div>`);
  const d = dlg();
  d.querySelector('[data-x="no"]').onclick = cierraModal;
  const tk = d.querySelector('[data-x="tk"]'); if (tk) tk.onclick = () => imprimeTicket({...o, reimpresion: true}, true);
  const an = d.querySelector('[data-x="anu"]'); if (an) an.onclick = () => anularVenta(o.fecha, o.folio, () => { S.admin.od = S.admin.rep = null; cargaCerradas(true); });
}
function abreOrden(id, desde){ const o = S.ordenes[id]; if (!o) return; S.o = {...o, items: [...(o.items || [])], nuevos: [], desde}; S.cat = CATS[0]; S.vista = 'orden'; render(); }

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
      <h2 style="margin:0">${esc(etiquetaOrden(o))}</h2>${o.nueva ? '<span class="muted">Orden nueva</span>' : folioHTML(o, 'big')}</div>
      <div class="cats">${cats.map(c => `<button class="cat" data-cat="${esc(c)}" aria-pressed="${c === S.cat}">${esc(c)}</button>`).join('')}</div>
      <div class="grid prods">${prods.filter(p => p.categoria === S.cat).map(p => { const q = enCarrito(p.id); const precio = rangoPrecio(p, o.tipo);
        return `<button class="prod" data-prod="${esc(p.id)}"><b>${esc(p.nombre)}</b><span class="p">${precio}</span>${p.grupos?.length ? '<span class="v">elegir</span>' : ''}${q ? `<span class="q">${q}</span>` : ''}</button>`; }).join('')}</div>
    </section>
    <aside class="ticket"><div class="hd row"><b>${o.folio ? `<span class="folio-inline">${folioTxt(o)}</span> ` : ''}${esc(etiquetaOrden(o))}</b><span class="spacer"></span><span class="muted small">${lineas.filter(l => l.estado !== 'cancelado').length} producto(s)</span></div>
      <div class="bd">${lineas.length ? lineas.map(l => `<div class="line ${l.nuevo ? 'new' : ''} ${l.estado === 'cancelado' ? 'cx' : ''}">
          <span class="qty">${l.cantidad}×</span><div><div class="nm">${esc(l.nombre)}</div>${l.variante ? `<div class="vr">${esc(l.variante)}</div>` : ''}${l.nota ? `<div class="nt">${esc(l.nota)}</div>` : ''}${l.estado === 'cancelado' ? `<div class="vr">Cancelado: ${esc(l.cancel_motivo || '')}</div>` : ''}${l.pendiente ? '<div class="vr">por enviar</div>' : ''}</div>
          <div class="act"><span class="num">${money(l.cantidad * l.precio_unit)}</span>
          ${l.nuevo ? `<button class="ib" data-menos="${esc(l.id)}" aria-label="Quitar uno">−</button>` : (l.estado !== 'cancelado' && !l.pendiente ? `<button class="ib" data-cancel="${esc(l.id)}" aria-label="Cancelar producto" title="Cancelar (requiere autorización)">✕</button>` : '')}</div></div>`).join('')
        : '<div class="empty" style="margin:12px 0">Toca un producto para agregarlo.</div>'}</div>
      <div class="ft">${t.desc ? `<div class="tot"><span class="muted">Subtotal</span><span class="num">${money(t.sub)}</span></div><div class="tot"><span class="muted">Descuento</span><span class="num">−${money(t.desc)}</span></div>` : ''}
        <div class="tot"><span>Total</span><b class="num">${money(t.total)}</b></div>
        <button class="btn pri big" data-act="guardar" ${o.nuevos.length ? '' : 'disabled'}>Guardar orden${o.nuevos.length ? ` (${o.nuevos.reduce((a, n) => a + n.cantidad, 0)} nuevo${o.nuevos.length > 1 ? 's' : ''})` : ''}</button>
        <div class="row"><button class="btn ok big" data-act="cobrar" style="flex:1" ${lineas.some(l => l.estado !== 'cancelado') ? '' : 'disabled'}>Cobrar</button>
          ${!o.nueva ? `<button class="btn big" data-act="desc" title="Descuento (requiere autorización)">%</button>` : ''}</div>
        <div class="row">${lineas.some(l => l.estado !== 'cancelado') ? `<button class="btn" data-act="cuenta" style="flex:1">Ver cuenta</button>` : ''}${!o.nueva && o.tipo === 'mesa' && !o.pendiente ? `<button class="btn" data-act="mover" style="flex:1">⇄ Cambiar o unir mesa</button>` : ''}</div>
        ${!o.nueva && !o.pendiente ? '<button class="btn big cx" data-act="cancelOrden">Cancelar orden</button>' : ''}</div>
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
  const params = {p_orden: payloadOrden()}; const nueva = !!o.nueva;
  if (pendientes() || !S.online){ encola('pos_guardar_orden', params); aplicaLocal(S.cola[S.cola.length - 1]); postGuardar(S.ordenes[o.id], volver, true); return true; }
  try { const r = await call('pos_guardar_orden', params); S.ordenes[o.id] = r.orden; if (o.tipo === 'mesa' && !S.mesasOcupadas.includes(o.mesa)) S.mesasOcupadas.push(o.mesa); postGuardar(r.orden, volver, false, nueva); return true; }
  catch(e){
    if (e.code === 'RED'){ encola('pos_guardar_orden', params); aplicaLocal(S.cola[S.cola.length - 1]); postGuardar(S.ordenes[o.id], volver, true); return true; }
    toast(e.message, true); if (e.code === 'MENU') cargaMenu(); return false;
  }
}
function postGuardar(ord, volver, offline, nueva){
  if (offline) toast('Guardada en la tablet. El folio se asigna cuando vuelva el internet.');
  else if (!(nueva && volver && ord.folio)) toast(ord.folio ? `Orden #${ord.folio} guardada` : 'Orden guardada');
  if (volver){ S.o = null; S.vista = 'inicio'; render(); if (nueva && !offline && ord.folio) avisoFolio(ord); }
  else { S.o = {...ord, items: [...ord.items], nuevos: []}; }
}
// Aviso grande con el folio de una orden nueva, para anotarlo en la comanda de papel
function avisoFolio(o){
  abreModal(`<div class="sheet folioaviso"><p class="muted" style="margin:0">${esc(etiquetaOrden(o))}</p>
    <h2 style="margin:0">Orden <span class="foliobig">#${esc(o.folio)}</span> guardada</h2>
    <p class="anota">Anota el número en la comanda.</p>
    <div class="foot"><button class="btn pri big" data-x="ok">Listo, ya lo anoté</button></div></div>`);
  dlg().querySelector('[data-x="ok"]').onclick = cierraModal;
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
  const pagos = []; let metodo = 'efectivo'; let monto = ''; let recibido = ''; let partes = 1; let propSel = 0; let propOtra = '';
  const conProp = S.ses.config?.propinas_activas !== false;
  const rest = () => r2(t.total - pagos.reduce((a, p) => a + p.monto, 0));
  const propDe = m => propSel === 'otra' ? r2(Number(String(propOtra).replace(/[^0-9.]/g, '')) || 0) : r2(m * propSel / 100);
  const draw = () => {
    const falta = rest(); const m = monto === '' ? falta : Number(monto); const prop = conProp ? propDe(m) : 0; const rec = recibido === '' ? null : Number(recibido);
    const cambio = metodo === 'efectivo' && rec != null ? r2(rec - m - prop) : 0;
    abreModal(`<div class="sheet"><div class="row"><h2 style="margin:0">Cobrar ${o.folio ? `<span class="folio-inline">${folioTxt(o)}</span> ` : ''}· ${esc(etiquetaOrden(o))}</h2><span class="spacer"></span><button class="btn sm" data-x="close">Cerrar</button></div>
      <div class="paybig num">${money(t.total)}</div>
      ${pagos.length ? `<div class="paylist">${pagos.map((p, i) => `<div class="payrow"><span>${METODO[p.metodo]}${p.propina ? ` · propina ${money(p.propina)}` : ''}${p.recibido ? ` · recibe ${money(p.recibido)}` : ''}</span><span class="num">${money(p.monto)} <button class="btn sm ghost" data-rm="${i}">quitar</button></span></div>`).join('')}
        <div class="payrow" style="background:var(--warn-bg);color:var(--warn)"><span>Falta</span><span class="num">${money(falta)}</span></div></div>` : ''}
      ${falta > 0 ? `<div class="opts">${['efectivo','tarjeta','transferencia'].map(k => `<button class="opt" data-m="${k}" aria-pressed="${metodo === k}">${METODO[k]}</button>`).join('')}</div>
        ${conProp ? `<div class="row"><span class="muted" style="font-weight:600">Propina</span>${[[0,'Sin propina'],[10,'10 %'],[15,'15 %'],['otra','Otra']].map(([v, l]) => `<button class="chip" data-prop="${v}" aria-pressed="${propSel === v}">${l}${v && v !== 'otra' ? ' · ' + money(r2(m * v / 100)) : ''}</button>`).join('')}
          ${propSel === 'otra' ? `<input class="cell" id="propO" inputmode="decimal" placeholder="$" value="${esc(propOtra)}" style="width:90px">` : ''}</div>` : ''}
        <div class="grid" style="grid-template-columns:1fr 1fr;gap:10px">
          <label class="field">Monto de este pago (sin propina)<input class="big num" id="pm" inputmode="decimal" value="${esc(monto === '' ? falta : monto)}"></label>
          ${metodo === 'efectivo' ? `<label class="field">Recibe${prop ? ' (cuenta + propina)' : ''}<input class="big num" id="pr" inputmode="decimal" placeholder="${esc(r2(m + prop))}" value="${esc(recibido)}"></label>` : `<div class="field">${prop ? `A cobrar en ${METODO[metodo].toLowerCase()}<b class="num" style="font:800 30px var(--display);color:var(--fg)">${money(r2(m + prop))}</b>` : ''}</div>`}</div>
        ${metodo === 'efectivo' ? `<div class="chips">${billetes(r2(m + prop)).map(v => `<button class="chip" data-rec="${v}">${v === r2(m + prop) ? 'Exacto' : money(v)}</button>`).join('')}</div>` : ''}
        ${cambio > 0 ? `<div class="cambio">Cambio<b class="num">${money(cambio)}</b></div>` : ''}
        ${cambio < 0 ? `<div class="banner crit">Lo recibido es menor que ${prop ? 'la cuenta más la propina' : 'el monto'}.</div>` : ''}
        <details><summary class="muted" style="padding:6px 0;cursor:pointer">Dividir cuenta</summary>
          <div class="row" style="margin-top:8px"><span>Entre</span><div class="stepper"><button data-p="-1">−</button><output class="num">${partes}</output><button data-p="1">+</button></div><span>personas: <b class="num">${money(r2(falta / partes))}</b> c/u</span>
          <button class="btn sm" data-x="usarParte">Cobrar una parte</button></div>
          <p class="note">También puedes cobrar con varias formas de pago: escribe el monto de este pago y toca “Agregar pago”.</p></details>` : ''}
      <div class="foot">${falta > 0 ? `<button class="btn big" data-x="addPago">Agregar pago</button><button class="btn ok big" data-x="fin">Cobrar ${money(r2(falta + (monto === '' ? prop : 0)))}</button>` : `<button class="btn ok big" data-x="fin">Confirmar cobro</button>`}</div></div>`);
    const d = dlg();
    d.querySelector('[data-x="close"]').onclick = cierraModal;
    d.querySelectorAll('[data-m]').forEach(b => b.onclick = () => { metodo = b.dataset.m; recibido = ''; draw(); });
    d.querySelectorAll('[data-rm]').forEach(b => b.onclick = () => { pagos.splice(Number(b.dataset.rm), 1); monto = ''; draw(); });
    d.querySelectorAll('[data-rec]').forEach(b => b.onclick = () => { monto = $('#pm').value; recibido = b.dataset.rec; draw(); });
    d.querySelectorAll('[data-p]').forEach(b => b.onclick = () => { partes = Math.max(1, Math.min(20, partes + Number(b.dataset.p))); draw(); });
    d.querySelectorAll('[data-prop]').forEach(b => b.onclick = () => { monto = $('#pm') ? $('#pm').value : monto; const v = b.dataset.prop; propSel = v === 'otra' ? 'otra' : Number(v); recibido = ''; draw(); });
    const po = $('#propO'); if (po){ po.oninput = () => { propOtra = po.value; }; po.onchange = draw; }
    const pm = $('#pm'), pr = $('#pr');
    if (pm) pm.oninput = () => { monto = pm.value; };
    if (pr) pr.oninput = () => { recibido = pr.value; };
    if (pm) pm.onchange = draw; if (pr) pr.onchange = draw;
    const tomaPago = () => {
      const mm = r2(Number(String($('#pm').value).replace(/[^0-9.]/g, '')));
      const pp = conProp ? propDe(mm) : 0;
      const rr = metodo === 'efectivo' && $('#pr') && $('#pr').value !== '' ? r2(Number(String($('#pr').value).replace(/[^0-9.]/g, ''))) : null;
      if (!(mm > 0) || mm > rest() + 0.001){ toast('Monto no válido.', true); return false; }
      if (rr != null && rr < mm + pp){ toast('Lo recibido no alcanza.', true); return false; }
      pagos.push({metodo, monto: mm, propina: pp, recibido: rr ?? (metodo === 'efectivo' ? r2(mm + pp) : null)}); monto = ''; recibido = ''; propSel = 0; propOtra = ''; return true;
    };
    const ap = d.querySelector('[data-x="addPago"]'); if (ap) ap.onclick = () => { if (tomaPago()) draw(); };
    const up = d.querySelector('[data-x="usarParte"]'); if (up) up.onclick = () => { monto = String(r2(rest() / partes)); partes = Math.max(1, partes - 1); draw(); };
    d.querySelector('[data-x="fin"]').onclick = () => {
      if (rest() > 0 && !tomaPago()) return;
      if (Math.abs(rest()) > 0.009){ toast('Los pagos no suman el total.', true); return draw(); }
      enviaCobro(o, pagos.map(p => ({metodo: p.metodo, monto: p.monto, propina: p.propina || 0, recibido: p.metodo === 'efectivo' ? p.recibido : null})));
    };
  };
  draw();
}
function billetes(m){ // exacto + billetes con los que suele pagar el cliente
  const c = [m, Math.ceil(m / 50) * 50, Math.ceil(m / 100) * 100, Math.ceil(m / 200) * 200, Math.ceil(m / 500) * 500, 1000];
  return [...new Set(c)].filter(v => v >= m).sort((a, b) => a - b).slice(0, 5);
}
async function enviaCobro(o, pagos){
  const cambio = r2(pagos.reduce((a, p) => a + (p.metodo === 'efectivo' && p.recibido ? p.recibido - p.monto - (p.propina || 0) : 0), 0));
  const propina = r2(pagos.reduce((a, p) => a + (p.propina || 0), 0));
  const params = {p_orden: o.id, p_pagos: pagos};
  const fin = (offline, ord) => {
    delete S.ordenes[o.id]; if (o.tipo === 'mesa') S.mesasOcupadas = S.mesasOcupadas.filter(m => m !== o.mesa); S.cer.ts = 0;
    const tk = ord || {...o, items: [...(o.items || [])], pagos, propina, total: totales(o).total, subtotal: totales(o).sub, descuento: totales(o).desc, estado: 'cobrada'};
    abreModal(`<div class="sheet" style="text-align:center"><h2>Cobrado ✓</h2><p class="muted">${(ord || o).folio ? `Orden #${esc((ord || o).folio)} · ` : ''}${esc(etiquetaOrden(o))}${offline ? ' · se registrará al volver el internet' : ''}</p>
      ${cambio > 0 ? `<div class="cambio">Cambio a entregar<b class="num">${money(cambio)}</b></div>` : ''}${propina > 0 ? `<p class="muted">Propina registrada: <b>${money(propina)}</b></p>` : ''}
      <div class="foot"><button class="btn big" data-x="tk">Imprimir ticket</button><button class="btn pri big" data-x="ok">Listo</button></div></div>`);
    dlg().querySelector('[data-x="tk"]').onclick = () => imprimeTicket(tk, true);
    dlg().querySelector('[data-x="ok"]').onclick = () => { cierraModal(); S.o = null; S.vista = 'inicio'; render(); };
  };
  if (pendientes() || !S.online){ encola('pos_cobrar', params); return fin(true); }
  try { const r = await call('pos_cobrar', params); fin(false, r.orden); }
  catch(e){ if (e.code === 'RED'){ encola('pos_cobrar', params); return fin(true); } toast(e.message, true); }
}

/* ---------- pre-cuenta y ticket ---------- */
function ticketTexto(o, pagado){
  const cfg = S.ses.config || {}; const t = o.subtotal != null ? {sub: o.subtotal, desc: o.descuento, total: o.total} : totales(o);
  const L = []; const W = 32; const pad = (a, b) => { a = String(a); b = String(b); return a.length + b.length + 1 > W ? a + '\n' + ' '.repeat(Math.max(0, W - b.length)) + b : a + ' '.repeat(W - a.length - b.length) + b; };
  String(cfg.ticket_encabezado || 'Ahogaditas Tapatío').split('\n').forEach(x => L.push(x));
  L.push('-'.repeat(W)); L.push(pagado ? (o.reimpresion ? 'TICKET (REIMPRESIÓN)' : 'TICKET') : 'CUENTA (no es comprobante de pago)');
  if (o.folio){ const f = `FOLIO #${o.folio}`; L.push(' '.repeat(Math.max(0, Math.floor((W - f.length - 8) / 2))) + `*** ${f} ***`); }
  L.push(etiquetaOrden(o));
  L.push(new Date(o.cobrada_en || Date.now()).toLocaleString('es-MX', {dateStyle: 'short', timeStyle: 'short'}) + (o.mesero ? ' · ' + o.mesero : '')); L.push('-'.repeat(W));
  (o.items || []).filter(i => i.estado !== 'cancelado').concat(o.nuevos || []).forEach(i => { L.push(pad(`${i.cantidad} ${i.nombre}`, money(i.cantidad * i.precio_unit))); if (i.variante) L.push('  ' + i.variante); });
  L.push('-'.repeat(W));
  if (t.desc) { L.push(pad('Subtotal', money(t.sub))); L.push(pad('Descuento', '-' + money(t.desc))); }
  L.push(pad('TOTAL', money(t.total)));
  if (pagado){ (o.pagos || []).forEach(p => L.push(pad(METODO[p.metodo] || p.metodo, money(p.monto)))); if (o.propina > 0) L.push(pad('Propina', money(o.propina)));
    const camb = (o.pagos || []).reduce((a, p) => a + (Number(p.cambio) || (p.metodo === 'efectivo' && p.recibido ? p.recibido - p.monto - (p.propina || 0) : 0)), 0); if (camb > 0) L.push(pad('Cambio', money(camb))); }
  else if (S.ses.config?.propinas_activas !== false) { L.push(pad('Propina sugerida 10 %', money(r2(t.total * .10)))); L.push(pad('Propina sugerida 15 %', money(r2(t.total * .15)))); }
  L.push('Precios con IVA incluido'); L.push('-'.repeat(W)); String(cfg.ticket_pie || '¡Gracias por su visita!').split('\n').forEach(x => L.push(x));
  return L.join('\n');
}
function imprimeTicket(o, pagado){
  const txt = ticketTexto(o, pagado); const el = $('#printArea'); el.textContent = txt;
  document.body.classList.add('imprimiendo'); setTimeout(() => { print(); setTimeout(() => document.body.classList.remove('imprimiendo'), 500); }, 50);
}
function preCuenta(){
  const o = S.o; const txt = ticketTexto(o, false);
  abreModal(`<div class="sheet"><div class="row"><h2 style="margin:0">Cuenta ${o.folio ? `<span class="folio-inline">${folioTxt(o)}</span> ` : ''}· ${esc(etiquetaOrden(o))}</h2><span class="spacer"></span><button class="btn sm" data-x="no">Cerrar</button></div>
    <pre class="ticketprev">${esc(txt)}</pre>
    ${o.nuevos?.length ? '<div class="banner">Hay productos sin guardar: se incluyen en la cuenta, pero guarda la orden antes de cobrar.</div>' : ''}
    <div class="foot"><button class="btn big" data-x="share">Compartir</button><button class="btn pri big" data-x="print">Imprimir</button></div></div>`);
  dlg().querySelector('[data-x="no"]').onclick = cierraModal;
  dlg().querySelector('[data-x="print"]').onclick = () => imprimeTicket(o, false);
  dlg().querySelector('[data-x="share"]').onclick = async () => {
    if (navigator.share){ try { await navigator.share({title: 'Cuenta ' + etiquetaOrden(o), text: txt}); return; } catch(e){ if (e.name === 'AbortError') return; } }
    location.href = 'https://wa.me/?text=' + encodeURIComponent(txt);
  };
}

/* ---------- mover o unir mesa ---------- */
function moverMesa(){
  const o = S.o; const n = Number(S.ses.config?.mesas) || 10;
  const mias = Object.values(S.ordenes).filter(x => x.id !== o.id && x.tipo === 'mesa' && !x.pendiente);
  abreModal(`<div class="sheet"><div class="row"><h2 style="margin:0">Cambiar ${esc(etiquetaOrden(o))}</h2><span class="spacer"></span><button class="btn sm" data-x="no">Cerrar</button></div>
    <h3 style="margin-top:0">Pasar a una mesa libre</h3>
    <div class="grid mesas">${Array.from({length: n}, (_, i) => i + 1).filter(m => m !== o.mesa && !S.mesasOcupadas.includes(m)).map(m => `<button class="mesa" data-mv="${m}">${m}</button>`).join('') || '<div class="empty">No hay mesas libres.</div>'}</div>
    <h3>Unir con otra mesa</h3><p class="muted small" style="margin-top:0">Los productos de esta orden se pasan a la otra y se cobra todo junto.</p>
    <div class="grid cards">${mias.map(x => `<button class="card order" data-un="${esc(x.id)}"><b>${esc(etiquetaOrden(x))}</b><span class="num">${money(totales(x).total)}</span><span class="muted small">${esc(x.mesero || '')}</span></button>`).join('') || '<div class="empty">No hay otras mesas abiertas que puedas unir.</div>'}</div></div>`);
  dlg().querySelector('[data-x="no"]').onclick = cierraModal;
  dlg().querySelectorAll('[data-mv]').forEach(b => b.onclick = async () => {
    try { const r = await call('pos_mover_orden', {p_orden: o.id, p_mesa: Number(b.dataset.mv)}); S.mesasOcupadas = S.mesasOcupadas.filter(m => m !== o.mesa).concat(r.orden.mesa);
      S.ordenes[o.id] = r.orden; S.o = {...r.orden, items: [...r.orden.items], nuevos: o.nuevos}; cierraModal(); toast(`Ahora es la mesa ${r.orden.mesa}`); vOrden(); pintaSync(); }
    catch(e){ toast(e.message, true); }
  });
  dlg().querySelectorAll('[data-un]').forEach(b => b.onclick = async () => {
    if (o.nuevos?.length){ toast('Guarda primero los productos nuevos.', true); return; }
    try { const r = await call('pos_unir_ordenes', {p_origen: o.id, p_destino: b.dataset.un}); delete S.ordenes[o.id]; S.mesasOcupadas = S.mesasOcupadas.filter(m => m !== o.mesa);
      S.ordenes[r.orden.id] = r.orden; S.o = {...r.orden, items: [...r.orden.items], nuevos: []}; cierraModal(); toast(`Unida con ${etiquetaOrden(r.orden)}`); vOrden(); pintaSync(); }
    catch(e){ toast(e.message, true); }
  });
}

/* ---------- autorizaciones ---------- */
// Descuentos: autoriza la encargada o el administrador (PIN).
// opts.cancela (cancelar producto / orden, anular venta): SOLO el administrador,
//   en persona (PIN + código si tiene autenticador) o por teléfono (solo el código
//   de su autenticador, que él dicta por llamada). El servidor lo vuelve a validar.
// opts.anular: anular venta cobrada (solo desde la sesión del admin; sin teléfono).
const SOLO_ADMIN = 'Solo el administrador puede cancelar. Llama a Guillermo.';
async function hojaAutoriza(titulo, detalle, motivos, extraHTML, onOk, onDraw, opts = {}){
  if (!S.online){ toast(opts.cancela ? 'Para cancelar se necesita internet.' : 'Para autorizar se necesita internet.', true); return; }
  if (opts.cancela){ try { S.personal = await rpc('pos_personal', {p_clave: S.clave}); } catch(e){ if (e.code === 'RED') return toast('Para cancelar se necesita internet.', true); } }
  const obliga = !!S.ses.config?.cancelar_requiere_2fa;
  const mismo = p => p.es_demo === esDemo();
  // opciones: {k, id, nombre, tel, dos_pasos}
  let aut;
  if (opts.cancela){
    const admins = S.personal.filter(p => p.rol === 'admin' && mismo(p));
    aut = admins.filter(p => !obliga || p.dos_pasos).map(p => ({k: p.id, id: p.id, nombre: p.nombre, tel: false, dos_pasos: p.dos_pasos}));
    if (!opts.anular) admins.filter(p => p.dos_pasos && p.id !== S.ses.staff.id)
      .forEach(p => aut.push({k: 'tel:' + p.id, id: p.id, nombre: p.nombre, tel: true, dos_pasos: true}));
    if (!aut.length) return toast(obliga ? 'El administrador no tiene la verificación en dos pasos activa: no se puede autorizar. ' + SOLO_ADMIN : SOLO_ADMIN, true);
  } else {
    aut = S.personal.filter(p => p.rol !== 'mesero' && mismo(p)).map(p => ({k: p.id, id: p.id, nombre: p.nombre, tel: false, dos_pasos: p.dos_pasos}));
    if (!aut.length) return toast('No hay quién pueda autorizar.', true);
  }
  let quien = aut.find(p => p.k === S.ses.staff.id)?.k || (aut.length === 1 ? aut[0].k : null); let motivo = ''; let pin = ''; let cod = ''; let pideCod = false;
  const sel = () => aut.find(p => p.k === quien);
  const porTel = () => !!sel()?.tel;
  const conCodigo = () => opts.cancela && (porTel() || pideCod || !!sel()?.dos_pasos);
  const draw = (msg) => {
    const t = sel();
    abreModal(`<div class="sheet"><h2 style="margin:0">${esc(titulo)}</h2><p class="muted" style="margin:0">${esc(detalle)}</p>${(typeof extraHTML === 'function' ? extraHTML() : extraHTML) || ''}
      <div class="grp"><div class="gt">Motivo <span class="muted small">obligatorio</span></div><div class="chips">${motivos.map(m => `<button class="chip" data-mot="${esc(m)}" aria-pressed="${motivo === m}">${esc(m)}</button>`).join('')}</div>
        <input id="motl" style="margin-top:8px;font:17px var(--body);padding:10px;border-radius:10px;border:1.5px solid var(--line);background:var(--bg);color:var(--fg);width:100%" maxlength="100" placeholder="Otro motivo…" value="${esc(motivos.includes(motivo) ? '' : motivo)}"></div>
      <div class="grp"><div class="gt">Autoriza${opts.cancela ? ' <span class="muted small">solo el administrador</span>' : ''}</div><div class="opts">${aut.map(p => `<button class="opt" data-aut="${esc(p.k)}" aria-pressed="${quien === p.k}">${esc(p.nombre)}${p.tel ? '<small>por teléfono</small>' : ''}</button>`).join('')}</div>
        ${t?.tel ? `<p class="banner" style="margin:10px 0 0;background:var(--info-bg);color:var(--info)">Llama a ${esc(t.nombre)}. Te va a dictar el código de 6 dígitos de su Google Authenticator. Escríbelo aquí. Quedará registrado que tú lo capturaste.</p>`
          : `<label class="field" style="margin-top:10px">PIN de quien autoriza<input id="apin" type="password" inputmode="numeric" maxlength="6" autocomplete="off" value="${esc(pin)}"></label>`}
        ${conCodigo() ? `<label class="field" style="margin-top:10px">${t?.tel ? `Código que te dicta ${esc(t.nombre)}` : 'Código de 6 dígitos de su autenticador'}<input id="acod" class="big num" inputmode="numeric" maxlength="6" autocomplete="one-time-code" placeholder="000000" value="${esc(cod)}"></label>` : ''}</div>
      ${opts.cancela ? '<p class="note" style="margin:0">Se cancela y queda registrada en la bitácora: quién autorizó, quién capturó, cuándo, motivo e importe. Sale de las ventas y del corte.</p>' : ''}
      <div class="msg">${esc(msg || '')}</div>
      <div class="foot"><button class="btn big" data-x="no">Volver</button><button class="btn pri big" data-x="si">Autorizar</button></div></div>`);
    const d = dlg();
    const keep = () => { pin = $('#apin')?.value || ''; cod = $('#acod')?.value.trim() || ''; if ($('#motl').value.trim()) motivo = $('#motl').value.trim(); };
    d.querySelectorAll('[data-mot]').forEach(b => b.onclick = () => { keep(); motivo = b.dataset.mot; $('#motl').value = ''; draw(); });
    d.querySelectorAll('[data-aut]').forEach(b => b.onclick = () => { keep(); quien = b.dataset.aut; cod = ''; pin = ''; pideCod = false; draw(); });
    d.querySelector('[data-x="no"]').onclick = cierraModal;
    if (onDraw) onDraw(d);
    d.querySelector('[data-x="si"]').onclick = async () => {
      keep(); const libre = $('#motl').value.trim(); const mot = libre || motivo;
      if (mot.length < 3) return draw('Elige o escribe el motivo.');
      if (!quien) return draw('Elige quién autoriza.');
      const tel = porTel();
      if (!tel && pin.length < 4) return draw('Escribe el PIN.');
      if (conCodigo() && !/^[0-9]{6}$/.test(cod)) return draw(tel ? 'Escribe los 6 dígitos que te dicta el administrador.' : 'Escribe el código de 6 dígitos del autenticador.');
      try { const r = await onOk(sel().id, tel ? null : pin, mot, d, conCodigo() ? cod : null, tel);
        if (r && r.ok === false){ pin = ''; cod = ''; motivo = mot; if (r.requiere_codigo) pideCod = true; return draw(r.error); } cierraModal(); }
      catch(e){ pin = ''; cod = ''; motivo = mot; draw(e.code === 'RED' && opts.cancela ? 'Para cancelar se necesita internet.' : e.message); }
    };
  };
  draw();
}
function cancelarItem(itemId){
  const i = S.o.items.find(x => x.id === itemId); let n = i.cantidad;
  const extra = () => i.cantidad > 1 ? `<div class="grp"><div class="gt">¿Cuántos cancelar? <span class="muted small">de ${i.cantidad}</span></div><div class="stepper"><button data-cq="-1">−</button><output class="num" id="cqv">${n}</output><button data-cq="1">+</button></div></div>` : '';
  hojaAutoriza('Cancelar producto', `${i.cantidad}× ${i.nombre}${i.variante ? ' (' + i.variante + ')' : ''} · ${money(i.cantidad * i.precio_unit)}`,
    ['Error de captura', 'Cliente cambió', 'Se acabó', 'Tardó mucho'], extra, async (quien, pin, mot, d, cod, tel) => {
      const r = await call('pos_cancelar_item', {p_item: itemId, p_autoriza: quien, p_pin: pin, p_motivo: mot, p_cantidad: n, p_codigo: cod, p_telefono: !!tel});
      if (r.ok){ S.ordenes[S.o.id] = r.orden; S.o = {...r.orden, items: [...r.orden.items], nuevos: S.o.nuevos}; toast(n < i.cantidad ? `${n} cancelado(s) y registrado(s)` : 'Producto cancelado y registrado'); vOrden(); pintaSync(); }
      return r;
    }, d => d.querySelectorAll('[data-cq]').forEach(b => b.onclick = () => { n = Math.max(1, Math.min(i.cantidad, n + Number(b.dataset.cq))); $('#cqv').textContent = n; }), {cancela: true});
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
function cancelarOrden(id){
  const o = id ? S.ordenes[id] : S.o; if (!o) return;
  if (o.pendiente) return toast('Esta orden todavía no se envía. Para cancelar se necesita internet.', true);
  const t = totales(o);
  hojaAutoriza('Cancelar orden', `${o.folio ? 'Orden #' + o.folio + ' · ' : ''}${etiquetaOrden(o)} · ${money(t.total)}`, ['Cliente se fue', 'Orden duplicada', 'Error de captura'], '', async (quien, pin, mot, d, cod, tel) => {
    const r = await call('pos_cancelar_orden', {p_orden: o.id, p_autoriza: quien, p_pin: pin, p_motivo: mot, p_codigo: cod, p_telefono: !!tel});
    if (r.ok){ delete S.ordenes[o.id]; if (o.tipo === 'mesa') S.mesasOcupadas = S.mesasOcupadas.filter(m => m !== o.mesa); S.cer.ts = 0;
      if (S.o?.id === o.id){ S.o = null; S.vista = 'inicio'; } toast('Orden cancelada y registrada'); render(); }
    return r;
  }, null, {cancela: true});
}
// Anular una venta YA cobrada (solo el administrador, desde su sesión)
function anularVenta(fecha, folio, despues){
  let fol = folio ? String(folio) : '';
  const extra = () => `<div class="grp"><div class="gt">Folio de la venta <span class="muted small">${fecha === hoyISO() ? 'de hoy' : fdate(fecha)}</span></div>
    <input id="afol" class="big num" inputmode="numeric" maxlength="6" placeholder="Folio" value="${esc(fol)}" style="font:22px var(--body);padding:10px;border-radius:10px;border:1.5px solid var(--line);background:var(--bg);color:var(--fg);width:100%"></div>`;
  hojaAutoriza('Anular venta cobrada', 'La venta ya se cobró. Solo el administrador puede anularla.', ['Error de cobro', 'Devolución al cliente', 'Venta duplicada'], extra,
    async (quien, pin, mot, d, cod) => {
      const n = Number(fol); if (!(n > 0)) return {ok: false, error: 'Escribe el folio.'};
      const r = await call('admin_anular_venta', {p_fecha: fecha, p_folio: n, p_motivo: mot, p_autoriza: quien, p_pin: pin, p_codigo: cod});
      if (r.ok){ toast(`Venta folio ${n} anulada y registrada`); if (despues) despues(); }
      return r;
    }, d => { const f = d.querySelector('#afol'); f.oninput = () => { fol = f.value.replace(/\D/g, ''); }; }, {cancela: true, anular: true});
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
    <div class="two"><div><h3>Por forma de pago</h3><div class="tbl"><table><tbody>${['efectivo','tarjeta','transferencia','plataforma'].map(k => `<tr><td>${METODO[k]}</td><td class="n">${money(pm[k] || 0)}</td></tr>`).join('')}</tbody></table></div>
      ${d.propinas ? `<h3>Propinas del turno · ${money(d.propinas)}</h3><div class="tbl"><table><tbody>${Object.entries(d.propinas_por_mesero || {}).map(([k, v]) => `<tr><td>${esc(k)}</td><td class="n">${money(v)}</td></tr>`).join('')}</tbody></table></div><p class="note">Las propinas no cuentan como venta. Las de tarjeta se pagan al mesero en efectivo desde la caja.</p>` : ''}</div>
    <div><h3>Efectivo</h3><div class="card grid">
      <label class="field">Fondo de caja al iniciar<input id="fondo" class="big num" inputmode="decimal" value="${esc(d.fondo_sugerido ?? 0)}"></label>
      <div class="tot"><span class="muted">+ Ventas en efectivo</span><span class="num">${money(d.efectivo)}</span></div>
      ${d.propinas_efectivo ? `<div class="tot"><span class="muted">+ Propinas en efectivo</span><span class="num">${money(d.propinas_efectivo)}</span></div>` : ''}
      <div class="tot"><span>= Efectivo esperado</span><b class="num" id="esp"></b></div>
      <label class="field">Efectivo contado en caja<input id="cont" class="big num" inputmode="decimal" placeholder="0"></label>
      <div class="tot"><span>Diferencia</span><b class="num" id="dif">—</b></div>
      <label class="field">Notas<input id="cnot" maxlength="200"></label>
      <button class="btn pri big" id="cerrar">Cerrar corte</button></div></div></div>
    ${foliosCorte(d)}`;
  const upd = () => { const f = Number($('#fondo').value) || 0, c = $('#cont').value; const esp = r2(f + d.efectivo + (d.propinas_efectivo || 0)); $('#esp').textContent = money(esp);
    if (c === ''){ $('#dif').textContent = '—'; $('#dif').className = 'num'; return; } const df = r2(Number(c) - esp); $('#dif').textContent = (df > 0 ? '+' : '') + money(df); $('#dif').className = 'num ' + (df < 0 ? 'neg' : df > 0 ? 'pos' : ''); };
  $('#fondo').oninput = upd; $('#cont').oninput = upd; upd();
  $('#cerrar').onclick = async () => {
    if ($('#cont').value === '') return toast('Captura el efectivo contado.', true);
    try { const r = await call('pos_corte_cerrar', {p_fondo: Number($('#fondo').value) || 0, p_contado: Number($('#cont').value), p_notas: $('#cnot').value.trim() || null});
      corteRes = r.corte; pintaCorteHecho(); }
    catch(e){ toast(e.message, true); }
  };
}
// Folios del turno: cada orden cobrada y cada cancelación, para cuadrar con las comandas de papel
function foliosCorte(d){
  const ol = d.ordenes_lista || [], cl = d.cancelaciones_lista || [];
  const lugar = x => x.tipo === 'mesa' ? `Mesa ${x.mesa}` : (CANAL[x.tipo] || x.tipo) + (x.cliente ? ' · ' + x.cliente : '');
  return `<div class="two" id="cfolios"><div><h3>Órdenes cobradas en este corte (${ol.length})</h3>${tabla([['Folio', x => `<b class="folio-inline">#${esc(x.folio)}</b>`], ['Mesa o tipo', x => esc(lugar(x))], ['Mesero', x => esc(x.mesero)],
      ['Pago', x => esc((x.metodos || []).map(m => METODO[m] || m).join(' + '))], ['Total', x => money(x.total), 'n']], ol, 'Todavía no hay órdenes cobradas.')}</div>
    <div><h3>Cancelaciones (${cl.length})</h3>${tabla([['Folio', x => x.folio != null ? `<b class="folio-inline">#${esc(x.folio)}</b>` : '—'], ['Qué', x => esc(x.accion === 'cancelar_producto' ? (x.producto || 'Producto') : x.accion === 'anular_venta_cobrada' ? 'Venta anulada' : 'Orden completa')],
      ['Importe', x => money(x.importe), 'n'], ['Autorizó', x => esc(x.autorizo || '') + (x.autorizacion === 'autorizado por teléfono' ? ' <span class="small muted">(por teléfono)</span>' : '')], ['Motivo', x => esc(x.motivo || ''), 'w']], cl, 'Sin cancelaciones.')}</div></div>`;
}
function pintaCorteHecho(){
  const c = corteRes; const pm = c.totales?.por_metodo || {};
  $('#cbody').innerHTML = `<div class="card" style="max-width:520px"><h2>Corte cerrado ✓</h2><p class="muted">${ftime(c.creado)} · ${esc(c.hecho_por)}</p>
    <div class="tbl"><table><tbody>${Object.entries(pm).map(([k, v]) => `<tr><td>${METODO[k] || k}</td><td class="n">${money(v)}</td></tr>`).join('')}
    <tr><td><b>Total</b></td><td class="n"><b>${money(c.totales?.total)}</b></td></tr>${c.totales?.propinas ? `<tr><td>Propinas (no son venta)</td><td class="n">${money(c.totales.propinas)}</td></tr>` : ''}<tr><td>Fondo</td><td class="n">${money(c.fondo)}</td></tr>
    <tr><td>Efectivo esperado</td><td class="n">${money(c.esperado)}</td></tr><tr><td>Efectivo contado</td><td class="n">${money(c.contado)}</td></tr>
    <tr><td><b>Diferencia</b></td><td class="n ${c.diferencia < 0 ? 'neg' : c.diferencia > 0 ? 'pos' : ''}"><b>${money(c.diferencia)}</b></td></tr></tbody></table></div>
    <div class="row noprint" style="margin-top:12px"><button class="btn" data-act="imprimir">Imprimir</button><button class="btn pri" id="cok">Listo</button></div></div>
    ${foliosCorte(c.totales || {})}`;
  $('#cok').onclick = () => { corteRes = null; S.vista = 'inicio'; render(); };
}

/* ---------- mapa del restaurante (solo admin) ---------- */
async function vMapa(){
  if (rol() !== 'admin'){ S.vista = 'inicio'; return render(); }
  app().innerHTML = barra() + `<main><div class="row" style="margin-bottom:10px"><button class="btn" data-act="inicio">← Volver</button><h1 style="margin:0">Mapa del restaurante</h1>
    <span class="spacer"></span><span class="muted small" id="mhora"></span><button class="btn sm" data-act="mapa">Actualizar</button></div><div id="mbody"><p class="muted">Cargando…</p></div></main>`;
  pintaSync(); await pintaMapa();
}
async function pintaMapa(){
  let d; try { d = await call('admin_mapa'); }
  catch(e){ const mb = $('#mbody'); if (mb && e.code !== 'RED') mb.innerHTML = `<div class="banner crit">${esc(e.message)}</div>`; return; }
  const mb = $('#mbody'); if (S.vista !== 'mapa' || !mb) return;
  d.ordenes.forEach(o => { S.ordenes[o.id] = o; });   // para poder abrirlas
  const porMesa = {}; d.ordenes.filter(o => o.tipo === 'mesa').forEach(o => { porMesa[o.mesa] = o; });
  const info = o => `<span class="mm">${esc(o.mesero || '')}</span><span class="mm">${minsAgo(o.abierta_en)} min</span><b class="num mt">${money(o.total)}</b>`;
  const mesa = m => { const o = porMesa[m];
    return o ? `<button class="mtile occ" data-mopen="${esc(o.id)}"><span class="mh"><span class="mn">Mesa ${m}</span>${folioHTML(o)}</span>${info(o)}</button>`
             : `<div class="mtile libre"><span class="mn">Mesa ${m}</span><span class="mm">Libre</span></div>`; };
  const grupo = (titulo, lista) => `<div class="mgroup"><h3 style="margin-top:0">${titulo} (${lista.length})</h3>${lista.length ? `<div class="grid mapa">${lista.map(o =>
      `<button class="mtile occ" data-mopen="${esc(o.id)}"><span class="mh"><span class="mn">${esc(etiquetaOrden(o))}</span>${folioHTML(o)}</span>${info(o)}</button>`).join('')}</div>` : '<div class="mtile libre"><span class="mm">Sin órdenes</span></div>'}</div>`;
  const n = Number(d.mesas) || 10; const ocup = Object.keys(porMesa).length;
  mb.innerHTML = `<div class="row" style="margin-bottom:10px"><span class="tag t-mesa">${ocup} de ${n} mesas ocupadas</span><span class="tag">${d.ordenes.length} orden(es) abiertas</span><span class="muted small">Se actualiza sola cada 30 segundos.</span></div>
    <div class="grid mapa">${Array.from({length: n}, (_, i) => mesa(i + 1)).join('')}</div>
    <div class="two" style="margin-top:16px">${grupo('Para llevar', d.ordenes.filter(o => o.tipo === 'llevar'))}${grupo('Plataformas', d.ordenes.filter(o => ['rappi','didi','uber'].includes(o.tipo)))}</div>`;
  const h = $('#mhora'); if (h) h.textContent = 'Actualizado ' + new Date().toLocaleTimeString('es-MX', {hour: '2-digit', minute: '2-digit', second: '2-digit'});
  mb.querySelectorAll('[data-mopen]').forEach(b => b.onclick = () => abreOrden(b.dataset.mopen, 'mapa'));
}

/* ---------- órdenes del día (Panel > Ventas, solo admin) ---------- */
const ESTADO = {abierta: 'Abierta', cobrada: 'Cobrada', cancelada: 'Cancelada', unida: 'Unida'};
const lugarOrden = x => x.tipo === 'mesa' ? `Mesa ${x.mesa}` : (CANAL[x.tipo] || x.tipo) + (x.cliente ? ' · ' + x.cliente : '');
async function ordenesDia(){
  const A = S.admin; const box = $('#odbox'); if (!box) return;
  if (!A.odFecha) A.odFecha = hoyISO();
  box.innerHTML = `<div class="card row" style="margin-bottom:10px"><label class="row small" style="gap:6px">Fecha <input type="date" id="odf" class="cell w" value="${esc(A.odFecha)}"></label>
      <input id="odq" class="cell" style="width:150px;text-align:left" inputmode="numeric" placeholder="Buscar folio #" value="${esc(A.odQ || '')}" aria-label="Buscar por folio">
      <span class="muted small" id="odn"></span></div><div id="odlist"><p class="muted">Cargando…</p></div>`;
  $('#odf').onchange = () => { A.odFecha = $('#odf').value || hoyISO(); A.od = null; ordenesDia(); };
  $('#odq').oninput = () => { A.odQ = $('#odq').value.replace(/\D/g, ''); pintaOrdenesDia(); };
  if (!A.od || A.odKey !== A.odFecha + A.demo){
    try { A.od = await call('admin_ordenes_dia', {p_fecha: A.odFecha, p_demo: A.demo}); A.odKey = A.odFecha + A.demo; }
    catch(e){ $('#odlist').innerHTML = `<div class="banner crit">${esc(e.message)}</div>`; return; }
  }
  pintaOrdenesDia();
}
function pintaOrdenesDia(){
  const A = S.admin; const el = $('#odlist'); if (!el || !A.od) return;
  const q = A.odQ || ''; const rows = q ? A.od.filter(x => String(x.folio) === q) : A.od;
  $('#odn').textContent = q ? (rows.length ? '' : `No hay orden #${q} en esa fecha.`) : `${A.od.length} orden(es)`;
  const hora = t => t ? new Date(t).toLocaleTimeString('es-MX', {hour: '2-digit', minute: '2-digit'}) : '';
  el.innerHTML = rows.length ? `<div class="tbl"><table><thead><tr><th>Folio</th><th>Hora</th><th>Mesa o tipo</th><th>Mesero</th><th class="n">Total</th><th>Estado</th><th></th></tr></thead><tbody>
    ${rows.map(x => `<tr class="odrow" data-od="${esc(x.id)}"><td><b class="folio-inline">#${esc(x.folio)}</b></td><td>${hora(x.abierta_en)}</td><td>${esc(lugarOrden(x))}</td><td>${esc(x.mesero)}</td>
      <td class="n">${money(x.total)}</td><td><span class="tag est-${esc(x.estado)}">${esc(ESTADO[x.estado] || x.estado)}${x.estado === 'unida' && x.unida_a_folio ? ' a #' + esc(x.unida_a_folio) : ''}</span></td>
      <td><button class="btn sm" data-od="${esc(x.id)}">Ver</button></td></tr>`).join('')}</tbody></table></div>`
    : `<div class="empty">${q ? `No hay orden #${esc(q)} en esa fecha.` : 'No hay órdenes en esa fecha.'}</div>`;
  el.querySelectorAll('tr[data-od]').forEach(b => b.onclick = () => detalleOrden(b.dataset.od));
}
async function detalleOrden(id){
  let o; try { o = await call('admin_orden_detalle', {p_orden: id}); } catch(e){ return toast(e.message, true); }
  const hora = t => t ? ftime(t) : '';
  const quien = c => `${esc(c.autorizo || '—')}${c.por_telefono ? ' <b>por teléfono</b>' : ''}${c.capturo ? ` · capturó ${esc(c.capturo)}` : ''}`;
  const activos = o.items.filter(i => i.estado !== 'cancelado');
  abreModal(`<div class="sheet"><div class="row"><h2 style="margin:0">Orden <span class="foliobig sm">#${esc(o.folio)}</span></h2><span class="spacer"></span><button class="btn sm" data-x="no">Cerrar</button></div>
    <p class="muted" style="margin:0">${esc(lugarOrden(o))} · ${esc(o.mesero || '')} · abierta ${hora(o.abierta_en)} · <span class="tag est-${esc(o.estado)}">${esc(ESTADO[o.estado] || o.estado)}${o.unida_a_folio ? ' a #' + esc(o.unida_a_folio) : ''}</span></p>
    <h3 style="margin:4px 0 0">Productos</h3>${activos.length ? `<div class="paylist">${activos.map(i => `<div class="payrow"><span>${i.cantidad}× ${esc(i.nombre)}${i.variante ? ` <span class="muted small">${esc(i.variante)}</span>` : ''}${i.nota ? ` <span class="small" style="color:var(--warn)">${esc(i.nota)}</span>` : ''}</span><span class="num">${money(i.importe)}</span></div>`).join('')}</div>` : '<div class="empty">Sin productos activos.</div>'}
    <h3 style="margin:4px 0 0">Cancelaciones</h3>${o.cancelaciones.length || o.estado === 'cancelada' ? `<div class="paylist">
      ${o.cancelaciones.map(c => `<div class="payrow" style="flex-direction:column;gap:2px"><span>${c.cantidad}× ${esc(c.producto)} · <span class="num">${money(c.importe)}</span></span><span class="small muted">Motivo: ${esc(c.motivo || '')} · Autorizó ${quien(c)} · ${hora(c.cuando)}</span></div>`).join('')}
      ${o.estado === 'cancelada' ? `<div class="payrow" style="flex-direction:column;gap:2px;background:var(--crit-bg);color:var(--crit)"><span>Orden completa cancelada</span><span class="small">Motivo: ${esc(o.cancel_motivo || '')} · Autorizó ${quien({autorizo: o.cancelada_por, por_telefono: o.cancel_telefono, capturo: o.cancel_capturo})} · ${hora(o.cancelada_en)}</span></div>` : ''}</div>` : '<p class="muted" style="margin:0">Ninguna.</p>'}
    <h3 style="margin:4px 0 0">Descuento</h3>${o.descuento_tipo ? `<div class="payrow"><span>${o.descuento_tipo === 'pct' ? esc(o.descuento_valor) + ' %' : money(o.descuento_valor)} · ${esc(o.descuento_motivo || '')} · autorizó ${esc(o.descuento_autorizo || '')}</span><span class="num">−${money(o.descuento)}</span></div>` : '<p class="muted" style="margin:0">Sin descuento.</p>'}
    <h3 style="margin:4px 0 0">Pagos</h3>${o.pagos_detalle.length ? `<div class="paylist">${o.pagos_detalle.map(p => `<div class="payrow"><span>${esc(METODO[p.metodo] || p.metodo)}${p.propina > 0 ? ` · propina ${money(p.propina)}` : ''} · ${hora(p.cuando)} · cobró ${esc(p.cobro || '')}</span><span class="num">${money(p.monto)}</span></div>`).join('')}</div>` : '<p class="muted" style="margin:0">Sin pagos.</p>'}
    <div class="tot"><span>Total</span><b class="num">${money(o.total)}</b></div>
    <div class="foot"><button class="btn big" data-x="tk">Imprimir ticket</button>${o.estado === 'cobrada' ? '<button class="btn big cx" data-x="anu">Anular esta venta</button>' : ''}</div></div>`);
  const d = dlg();
  d.querySelector('[data-x="no"]').onclick = cierraModal;
  d.querySelector('[data-x="tk"]').onclick = () => imprimeTicket(o, o.estado === 'cobrada');
  const an = d.querySelector('[data-x="anu"]'); if (an) an.onclick = () => anularVenta(o.fecha, o.folio, () => { S.admin.od = S.admin.rep = null; if (S.vista === 'admin' && S.admin.tab === 'resumen') aResumen(); });
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
  const tabs = [['resumen','Ventas'],['resultado','Resultado'],['productos','Por producto'],['costos','Costos y ganancia'],['gastos','Gastos'],['nomina','Nómina'],['marketing','Marketing'],['inventario','Inventario'],['recetas','Recetas'],['cortes','Cortes'],['bitacora','Bitácora'],['personal','Personal'],['menu','Menú y precios'],['ajustes','Ajustes']];
  app().innerHTML = barra() + `<main><div class="row" style="margin-bottom:6px"><button class="btn" data-act="inicio">← POS</button><h1 style="margin:0">Panel de ventas</h1></div>
    <nav class="tabs">${tabs.map(([k, l]) => `<button data-tab="${k}" aria-current="${A.tab === k}">${l}</button>`).join('')}</nav>
    ${['resumen','productos','cortes','bitacora','costos','resultado','gastos'].includes(A.tab) ? `<div class="row" style="margin-bottom:12px">
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
  if (!A.respChk){ A.respChk = true; call('admin_config').then(c => { A.ultResp = c.ultimo_respaldo || null; if (S.vista === 'admin') pintaRecordatorio(); }).catch(() => {}); } else pintaRecordatorio();
  try { await ({resumen: aResumen, resultado: aResultado, gastos: aGastos, nomina: aNomina, marketing: aMarketing, productos: aProductos, inventario: aInventario, recetas: aRecetas, costos: aCostos, cortes: aCortes, bitacora: aBitacora, personal: aPersonal, menu: aMenu, ajustes: aAjustes}[A.tab])(); }
  catch(e){ $('#abody').innerHTML = `<div class="banner crit">${esc(e.message)}</div>`; }
}
function pintaRecordatorio(){
  const A = S.admin;
  if (A.emp === undefined){ A.emp = null; call('admin_empleados').then(e => { A.emp = e; if (S.vista === 'admin') pintaRecordatorio(); }).catch(() => {}); }
  if (A.emp && !$('#nomrec')){
    const hoyD = DSEM[new Date().getDay()], manD = DSEM[(new Date().getDay() + 1) % 7];
    const msg = [[hoyD, 'Hoy'], [manD, 'Mañana']].map(([d, c]) => { const g = A.emp.filter(e => e.activo && e.dia_pago === d); return g.length ? `${c} se paga a ${g.map(e => e.nombre).join(', ')}: <b>${money(g.reduce((a, e) => a + Number(e.pago_semanal), 0))}</b>` : ''; }).filter(Boolean).join(' · ');
    if (msg){ const el = document.createElement('div'); el.className = 'banner'; el.id = 'nomrec'; el.style.background = 'var(--info-bg)'; el.style.color = 'var(--info)'; el.innerHTML = msg + ' <button class="btn sm" data-tab="nomina">Ver nómina</button>'; const nav = $('.tabs'); if (nav){ nav.after(el); el.querySelector('[data-tab]').onclick = () => { A.tab = 'nomina'; vAdmin(); }; } }
  } const dias = A.ultResp ? (Date.now() - new Date(A.ultResp).getTime()) / 864e5 : 999;
  if (dias < 7 || $('#resprec') || A.ultResp === undefined) return;
  const el = document.createElement('div'); el.className = 'banner'; el.id = 'resprec';
  el.innerHTML = `${A.ultResp ? `Tu último respaldo fue hace ${Math.floor(dias)} días.` : 'Todavía no has descargado ningún respaldo.'} <button class="btn sm" id="resbtn">Descargar respaldo ahora</button>`;
  const nav = $('.tabs'); if (nav) nav.after(el); $('#resbtn').onclick = async () => { await respaldo(); A.ultResp = new Date().toISOString(); el.remove(); };
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
    <h3>Órdenes del día</h3><div id="odbox"></div>
    <div class="two"><div><h3>Por día</h3>${r.por_dia.length ? barras(r.por_dia, d => fdate(d.fecha), d => d.ventas) : '<div class="empty">Sin ventas.</div>'}</div>
      <div><h3>Por mesero</h3>${tabla([['Mesero', x => esc(x.mesero)], ['Órdenes', x => x.ordenes, 'n'], ['Ticket', x => money(x.ticket), 'n'], ['Ventas', x => money(x.ventas), 'n']], r.por_mesero)}</div>
      <div><h3>Por forma de pago</h3>${tabla([['Forma', x => METODO[x.metodo] || x.metodo], ['Pagos', x => x.pagos, 'n'], ['Monto', x => money(x.monto), 'n']], r.por_metodo)}</div>
      <div><h3>Por canal</h3>${tabla([['Canal', x => CANAL[x.canal] || x.canal], ['Órdenes', x => x.ordenes, 'n'], ['Ventas', x => money(x.ventas), 'n']], r.por_canal)}</div>
      <div><h3>Propinas · ${money(r.propinas || 0)}</h3>${tabla([['Mesero', x => esc(x.mesero)], ['Propinas', x => money(x.propinas), 'n']], r.propinas_por_mesero || [], 'Sin propinas registradas.')}<p class="note">Las propinas no se suman a las ventas.</p></div></div>
    <h3>¿Cuándo vendes más?</h3>${cuandoVendes(r)}
    <h3>Anular una venta ya cobrada</h3><div class="card row"><input type="date" id="anf" class="cell w" value="${hoyISO()}"><input id="anfo" class="cell" inputmode="numeric" placeholder="Folio"><button class="btn cx" id="anb">Anular venta…</button>
      <span class="note" style="margin:0">Pide motivo, PIN y código. Se cancela y queda en la bitácora. Si ya entró a un corte, la diferencia se verá en ese corte.</span></div>`;
  $('#anb').onclick = () => anularVenta($('#anf').value || hoyISO(), $('#anfo').value, () => { S.admin.rep = S.admin.od = null; if (S.vista === 'admin' && S.admin.tab === 'resumen') aResumen(); });
  ordenesDia();
}
const DSEM = ['Dom','Lun','Mar','Mié','Jue','Vie','Sáb'];
function cuandoVendes(r){
  if (!r.por_hora?.length) return '<div class="empty">Sin ventas en este periodo.</div>';
  const horas = [...new Set(r.hora_dia.map(x => x.hora))].sort((a, b) => a - b); const dias = [1,2,3,4,5,6,0];
  const max = Math.max(...r.hora_dia.map(x => x.ventas), 1); const val = (d, h) => r.hora_dia.find(x => x.dia === d && x.hora === h)?.ventas || 0;
  const pd = dias.map(d => r.por_dia_semana.find(x => x.dia === d) || {dia: d, ventas: 0, dias: 0});
  return `<div class="two"><div><h3 style="margin-top:0">Promedio por día de la semana</h3>${barras(pd, x => DSEM[x.dia], x => x.dias ? r2(x.ventas / x.dias) : 0)}</div>
    <div><h3 style="margin-top:0">Ventas por hora</h3>${barras(r.por_hora, x => `${x.hora}:00 – ${x.hora + 1}:00`, x => x.ventas)}</div></div>
    <h3>Mapa de calor: día × hora</h3><div class="tbl"><table><thead><tr><th></th>${horas.map(h => `<th class="n">${h}h</th>`).join('')}</tr></thead><tbody>
    ${dias.map(d => `<tr><td><b>${DSEM[d]}</b></td>${horas.map(h => { const v = val(d, h); return `<td class="n" style="background:${v ? `color-mix(in srgb, var(--accent) ${Math.round(10 + 70 * v / max)}%, transparent)` : 'transparent'};color:${v / max > .55 ? '#fff' : 'inherit'}">${v ? money(v) : ''}</td>`; }).join('')}</tr>`).join('')}</tbody></table></div>
    <p class="note">Úsalo para decidir horarios del personal y cuándo publicar anuncios: justo antes de tus horas más fuertes.</p>`;
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
      <button class="btn pri" id="sv3">Guardar</button></div>
    <div class="card grid"><h2>Cobro y ticket</h2>
      <label class="row"><input type="checkbox" id="cprop" ${c.propinas_activas !== false ? 'checked' : ''} style="width:22px;height:22px"> Registrar propinas al cobrar</label>
      <label class="row"><input type="checkbox" id="civa" ${c.iva_incluido !== false ? 'checked' : ''} style="width:22px;height:22px"> Los precios incluyen IVA (para calcular la ganancia)</label>
      <label class="field">Encabezado del ticket<textarea id="cte" rows="3" style="font:16px var(--body);padding:10px;border-radius:10px;border:1.5px solid var(--line);background:var(--bg);color:var(--fg)">${esc(c.ticket_encabezado || '')}</textarea></label>
      <label class="field">Pie del ticket<textarea id="ctp" rows="2" style="font:16px var(--body);padding:10px;border-radius:10px;border:1.5px solid var(--line);background:var(--bg);color:var(--fg)">${esc(c.ticket_pie || '')}</textarea></label>
      <button class="btn pri" id="sv4">Guardar</button></div>
    <div class="card grid"><h2>Comisiones</h2><p class="muted" style="margin:0">Lo que te cobra cada app y la terminal, en %. Se restan en el Resultado.</p>
      ${['rappi','didi','uber'].map(k => `<label class="field">${CANAL[k]} (%)<input id="co_${k}" class="cell" inputmode="decimal" value="${esc((c.comision_apps || {})[k] ?? 0)}"></label>`).join('')}
      <label class="field">Terminal de tarjeta (%)<input id="co_t" class="cell" inputmode="decimal" value="${esc(c.comision_tarjeta ?? 0)}"></label>
      <label class="row"><input type="checkbox" id="co_ok" ${c.comision_apps_confirmada ? 'checked' : ''} style="width:22px;height:22px"> Comisiones confirmadas</label>
      <label class="row"><input type="checkbox" id="co_iva" ${c.iva_en_resultado ? 'checked' : ''} style="width:22px;height:22px"> Restar el IVA en el Resultado</label>
      <button class="btn pri" id="sv5">Guardar</button></div>
    <div class="card grid"><h2>Apertura y cierre</h2><p class="muted" style="margin:0">Un punto por renglón. Bris los marca en la tablet.</p>
      <label class="field">Apertura<textarea id="ra" rows="6" style="font:16px var(--body);padding:10px;border-radius:10px;border:1.5px solid var(--line);background:var(--bg);color:var(--fg)">${esc(((c.rutina_items || {}).apertura || []).join('\n'))}</textarea></label>
      <label class="field">Cierre<textarea id="rc" rows="6" style="font:16px var(--body);padding:10px;border-radius:10px;border:1.5px solid var(--line);background:var(--bg);color:var(--fg)">${esc(((c.rutina_items || {}).cierre || []).join('\n'))}</textarea></label>
      <button class="btn pri" id="sv6">Guardar</button></div>
    <div class="card grid"><h2>Respaldo</h2><p class="muted" style="margin:0">Descarga toda la información (ventas, cortes, inventario, recetas, personal sin PIN) en un archivo. Hazlo cada semana y guárdalo en tu computadora o en la nube.</p>
      <p style="margin:0">Último respaldo: <b>${c.ultimo_respaldo ? ftime(c.ultimo_respaldo) : 'nunca'}</b></p>
      <button class="btn pri" id="bresp">Descargar respaldo</button></div>
    <div class="card grid" id="c2fa" style="grid-column:1/-1"><h2>Verificación en dos pasos</h2><p class="muted">Cargando…</p></div></div>`;
  pinta2FA();
  const g = (k, v) => call('admin_config_guardar', {p_clave: k, p_valor: v});
  const ok = async f => { try { await f(); toast('Guardado'); } catch(e){ toast(e.message, true); } };
  $('#sv1').onclick = () => ok(async () => { await g('mesas', Number($('#cm').value)); await g('fondo_caja', Number($('#cf').value)); await g('inactividad_min', Number($('#ci').value)); await g('max_intentos', Number($('#cx').value)); await g('bloqueo_min', Number($('#cb').value)); S.ses.config.mesas = Number($('#cm').value); S.ses.config.inactividad_min = Number($('#ci').value); });
  $('#sv2').onclick = () => ok(async () => { await g('ajuste_plataforma', {rappi: Number($('#pa_rappi').value) || 0, didi: Number($('#pa_didi').value) || 0, uber: Number($('#pa_uber').value) || 0}); await g('ajuste_plataforma_confirmado', $('#pac').checked); await cargaMenu(); });
  $('#sv3').onclick = () => ok(async () => { const n = $('#cn').value.split('\n').map(x => x.trim()).filter(Boolean).slice(0, 16); await g('notas_rapidas', n); S.ses.config.notas_rapidas = n; });
  $('#sv4').onclick = () => ok(async () => { await g('propinas_activas', $('#cprop').checked); await g('iva_incluido', $('#civa').checked); await g('ticket_encabezado', $('#cte').value.trim()); await g('ticket_pie', $('#ctp').value.trim());
    Object.assign(S.ses.config, {propinas_activas: $('#cprop').checked, ticket_encabezado: $('#cte').value.trim(), ticket_pie: $('#ctp').value.trim()}); });
  $('#bresp').onclick = respaldo;
  $('#sv5').onclick = () => ok(async () => { await g('comision_apps', {rappi: Number($('#co_rappi').value) || 0, didi: Number($('#co_didi').value) || 0, uber: Number($('#co_uber').value) || 0});
    await g('comision_tarjeta', Number($('#co_t').value) || 0); await g('comision_apps_confirmada', $('#co_ok').checked); await g('iva_en_resultado', $('#co_iva').checked); });
  $('#sv6').onclick = () => ok(async () => { const sp = id => $(id).value.split('\n').map(x => x.trim()).filter(Boolean).slice(0, 15); await g('rutina_items', {apertura: sp('#ra'), cierre: sp('#rc')}); });
}
/* ---------- verificación en dos pasos (Google Authenticator) ---------- */
async function pinta2FA(){
  const box = $('#c2fa'); if (!box) return;
  let d; try { d = await call('admin_2fa_estado'); } catch(e){ box.innerHTML = `<h2>Verificación en dos pasos</h2><div class="banner crit">${esc(e.message)}</div>`; return; }
  const req = d.requiere === true;
  box.innerHTML = `<h2>Verificación en dos pasos</h2>
    <p class="muted" style="margin:0">Con Google Authenticator en el celular. Para entrar al panel (tú) y para autorizar cancelaciones se pide, además del PIN, el código de 6 dígitos que cambia cada 30 segundos.</p>
    ${d.personas.map(p => `<div class="payrow" style="align-items:center"><span><b>${esc(p.nombre)}</b> <span class="muted small">${p.rol === 'admin' ? 'administrador' : 'encargada'}</span><br>
        ${p.activo ? `<span class="small" style="color:var(--ok)">✔ Activa desde ${ftime(p.activado)}</span>` : '<span class="small muted">No activa</span>'}</span>
      ${p.activo ? `<button class="btn cx" data-2q="${esc(p.id)}" data-yo="${p.yo ? 1 : ''}">Quitar</button>` : `<button class="btn pri" data-2a="${esc(p.id)}">Activar</button>`}</div>`).join('')}
    <div id="c2paso"></div>
    <label class="row"><input type="checkbox" id="c2req" ${req ? 'checked' : ''} style="width:22px;height:22px"> Las cancelaciones requieren código (nadie autoriza sin autenticador)</label>
    <p class="note" style="margin:0">Apagado: el código se pide solo a quien ya lo tiene activo. Si alguien pierde el celular: “Quitar” aquí, o en Supabase &gt; SQL Editor: <code>select pos.quitar_2fa('Nombre');</code></p>`;
  $('#c2req').onchange = async e => {
    try { await call('admin_config_guardar', {p_clave: 'cancelar_requiere_2fa', p_valor: e.target.checked}); S.ses.config.cancelar_requiere_2fa = e.target.checked; toast('Guardado'); }
    catch(err){ e.target.checked = !e.target.checked; toast(err.message, true); }
  };
  box.querySelectorAll('[data-2a]').forEach(b => b.onclick = () => activar2FA(b.getAttribute('data-2a')));
  box.querySelectorAll('[data-2q]').forEach(b => b.onclick = () => quitar2FA(d.personas.find(p => p.id === b.getAttribute('data-2q'))));
}
async function activar2FA(id){
  let r; try { r = await call('admin_2fa_iniciar', {p_staff: id}); } catch(e){ return toast(e.message, true); }
  // El secreto solo vive en esta pantalla mientras se escanea; no se guarda en la tablet.
  const emisor = r.emisor || 'Ahogaditas Tapatio';
  const uri = `otpauth://totp/${encodeURIComponent(emisor)}:${encodeURIComponent(r.nombre)}?secret=${r.secreto}&issuer=${encodeURIComponent(emisor)}&algorithm=SHA1&digits=6&period=30`;
  let svg = ''; try { const q = qrcode(0, 'M'); q.addData(uri); q.make(); svg = q.createSvgTag({cellSize: 5, margin: 2, scalable: true}); } catch(e){}
  const paso = $('#c2paso');
  paso.innerHTML = `<div class="card grid" style="border:2px solid var(--accent)"><h3 style="margin:0">Activar para ${esc(r.nombre)}</h3>
    <ol style="margin:0;padding-left:20px;line-height:1.5"><li>En el celular de ${esc(r.nombre)} abre <b>Google Authenticator</b> y toca <b>+</b> → <b>Escanear un código QR</b>.</li>
      <li>Escanea este código. Si no se puede, elige “Ingresar una clave de configuración” y escribe la clave de abajo.</li>
      <li>Escribe aquí el código de 6 dígitos que aparece en el celular.</li></ol>
    <div class="qr"><div class="img">${svg}</div><div><div class="muted small">Clave (cuenta: ${esc(r.nombre)})</div><div class="clave2fa">${esc(r.secreto.match(/.{1,4}/g).join(' '))}</div></div></div>
    <label class="field">Código de 6 dígitos<input id="c2cod" class="big num" inputmode="numeric" maxlength="6" autocomplete="one-time-code" placeholder="000000"></label>
    <div class="row"><button class="btn big" id="c2no">Cancelar</button><button class="btn pri big" id="c2ok" style="flex:1">Confirmar y activar</button></div></div>`;
  $('#c2no').onclick = () => { paso.innerHTML = ''; };
  $('#c2ok').onclick = async () => {
    const c = $('#c2cod').value.trim(); if (!/^[0-9]{6}$/.test(c)) return toast('Escribe los 6 dígitos.', true);
    try { await call('admin_2fa_confirmar', {p_staff: id, p_codigo: c}); toast(`Verificación activada para ${r.nombre}`); pinta2FA(); }
    catch(e){ toast(e.message, true); }
  };
  paso.scrollIntoView({block: 'nearest'});
}
function quitar2FA(p){
  abreModal(`<div class="sheet"><h2 style="margin:0">Quitar verificación de ${esc(p.nombre)}</h2>
    <p class="muted">Úsalo si cambió o perdió el celular. Después vuelve a activarla con el celular nuevo.</p>
    ${p.yo ? '<label class="field">Tu código actual de 6 dígitos<input id="q2cod" class="big num" inputmode="numeric" maxlength="6" autocomplete="one-time-code"></label>' : ''}
    <div class="msg" id="q2msg"></div><div class="foot"><button class="btn big" data-x="no">Volver</button><button class="btn big cx" data-x="si">Quitar</button></div></div>`);
  const d = dlg(); d.querySelector('[data-x="no"]').onclick = cierraModal;
  d.querySelector('[data-x="si"]').onclick = async () => {
    try { const r = await call('admin_2fa_quitar', {p_staff: p.id, p_codigo: p.yo ? $('#q2cod').value.trim() : null});
      if (r.ok === false){ $('#q2msg').textContent = r.error; return; }
      cierraModal(); toast('Verificación quitada'); pinta2FA(); }
    catch(e){ $('#q2msg').textContent = e.message; }
  };
}
async function respaldo(){
  try { const r = await call('admin_respaldo'); const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([JSON.stringify(r)], {type: 'application/json'}));
    a.download = `respaldo_ahogaditas_${hoyISO()}.json`; document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
    toast(`Respaldo descargado: ${r.ordenes.length} órdenes, ${r.movimientos.length} movimientos`); if (S.admin.tab === 'ajustes') aAjustes(); }
  catch(e){ toast(e.message, true); }
}


/* ---------- resultado (P&L) y escenarios ---------- */
const pctTxt = x => x == null ? '—' : (Math.round(x * 1000) / 10).toLocaleString('es-MX') + ' %';
let escTmp = {nombre: 'Mi escenario', precio: 0, ordenes: 0, variables: 0, pub_semana: 0};
async function aResultado(){
  const A = S.admin; const r = await call('admin_resultado', {p_desde: A.desde, p_hasta: A.hasta, p_demo: A.demo}); A.res = r;
  const varEst = r.modelo?.variables_estimado; const estMes = varEst ? varEst.conceptos.reduce((a, c) => a + Number(c.monto), 0) * 4.33 / (varEst.periodo_semanas || 4) : 0;
  const estPeriodo = r2(estMes * r.dias / 30.4);
  const fila = (label, v, opts = {}) => `<tr class="${opts.cls || ''}"><td>${opts.indent ? '&nbsp;&nbsp;&nbsp;' : ''}${label}${opts.tag ? ' ' + opts.tag : ''}</td><td class="n">${opts.neg && v ? '−' : ''}${money(v)}</td><td class="n muted">${r.ventas && !opts.noPct ? pctTxt(v / r.ventas) : ''}</td></tr>`;
  const avisos = [];
  if (!r.comisiones_confirmadas) avisos.push('las <b>comisiones de Rappi, DiDi y Uber</b> están en 0 % (captúralas en Ajustes)');
  if (!r.insumos) avisos.push(`no hay <b>gastos de insumos</b> registrados en este periodo (tu estimado anterior sería ${money(estPeriodo)})`);
  if (r.nomina_estimada) avisos.push('la <b>nómina</b> es estimada con el pago semanal (registra los pagos en Nómina)');
  const pe = r.punto_equilibrio;
  $('#abody').innerHTML = `${A.demo ? '<div class="banner">Incluye ventas DEMO.</div>' : ''}
    ${avisos.length ? `<div class="banner">Para que el resultado sea exacto: ${avisos.join('; ')}.</div>` : ''}
    <div class="grid kpis">
      <div class="kpi"><div class="l">Ventas</div><div class="v num">${money(r.ventas)}</div><div class="small muted">${r.ordenes} órdenes · ${r.dias} días</div></div>
      <div class="kpi"><div class="l">Utilidad</div><div class="v num ${r.utilidad < 0 ? 'neg' : 'pos'}">${money(r.utilidad)}</div></div>
      <div class="kpi"><div class="l">Margen</div><div class="v num">${pctTxt(r.margen)}</div></div>
      <div class="kpi"><div class="l">Punto de equilibrio</div><div class="v num">${pe ? money(pe) : '—'}</div><div class="small muted">${pe ? (r.ventas >= pe ? 'superado ✓' : `faltan ${money(pe - r.ventas)}`) : 'ventas para no perder ni ganar'}</div></div></div>
    <div class="two"><div><h3>Estado de resultados</h3><div class="tbl"><table><tbody>
      ${fila('<b>Ventas</b>', r.ventas, {noPct: true})}
      ${r.iva ? fila('IVA incluido en precios', r.iva, {neg: true, indent: true}) : ''}
      ${fila('Comisiones de apps', r.comision_apps, {neg: true, indent: true, tag: r.comisiones_confirmadas ? '' : '<span class="tag pend">por confirmar</span>'})}
      ${r.comision_tarjeta ? fila('Comisión de terminal', r.comision_tarjeta, {neg: true, indent: true}) : ''}
      ${fila('Insumos y gastos variables', r.insumos, {neg: true, indent: true, tag: r.insumos ? '' : '<span class="tag pend">sin registrar</span>'})}
      ${fila('Nómina', r.nomina, {neg: true, indent: true, tag: r.nomina_estimada ? '<span class="tag pend">estimada</span>' : ''})}
      ${fila('Gastos fijos', r.fijos, {neg: true, indent: true})}
      ${fila('Publicidad', r.publicidad, {neg: true, indent: true})}
      <tr><td><b>Utilidad</b></td><td class="n"><b class="${r.utilidad < 0 ? 'neg' : 'pos'}">${money(r.utilidad)}</b></td><td class="n"><b>${pctTxt(r.margen)}</b></td></tr>
      </tbody></table></div>
      <p class="note">Referencias: costo teórico de ingredientes según recetas medidas: <b>${money(r.costo_teorico)}</b>. Propinas registradas (no son ingreso del negocio): <b>${money(r.propinas)}</b>. Gastos fijos y nómina se prorratean por día; la publicidad, por los días de cada campaña.</p></div>
      <div><h3>Ventas por semana</h3>${r.por_semana.length ? barras(r.por_semana, x => 'Sem. ' + fdate(x.semana), x => x.ventas) : '<div class="empty">Sin ventas en el periodo.</div>'}
        <h3>Gastos fijos del periodo</h3>${tabla([['Concepto', x => esc(x.concepto)], ['Monto', x => money(x.monto), 'n']], r.fijos_detalle, 'Captura tus gastos fijos en la pestaña Gastos.')}</div></div>
    <h3>Escenarios: ¿qué pasa si…?</h3><div id="escen"></div>`;
  pintaEscenarios(r, estMes);
}
function baseMensual(r, estMes){
  const m = r.modelo?.ventas_modelo || {}; const sem = Number(m.semanas_mes) || 4.33;
  const real = r.ventas > 0 && r.dias >= 7;
  const ventas = real ? r.ventas * 30.4 / r.dias : (Number(m.comandas_dia) * (Number(m.dias_semana) || 5) + Number(m.comandas_finde)) * Number(m.ticket) * sem;
  const variables = real && r.insumos ? r.insumos * 30.4 / r.dias : estMes;
  const comPct = r.ventas ? (r.comision_apps + r.comision_tarjeta + r.iva) / r.ventas : 0;
  const nomina = real && !r.nomina_estimada ? r.nomina * 30.4 / r.dias : (r.nomina * 30.4 / r.dias);
  const fijos = r.fijos * 30.4 / r.dias;
  return {fuente: real ? 'ventas reales del periodo' : 'tu modelo anterior (comandas × ticket)', ventas, variables, comPct, nomina, fijos, sem};
}
function calcEsc(b, e){
  const ventas = b.ventas * (1 + (Number(e.precio) || 0) / 100) * (1 + (Number(e.ordenes) || 0) / 100);
  const variables = b.variables * (1 + (Number(e.ordenes) || 0) / 100) * (1 + (Number(e.variables) || 0) / 100);
  const com = ventas * b.comPct; const pub = (Number(e.pub_semana) || 0) * b.sem;
  const util = ventas - variables - com - b.nomina - b.fijos - pub;
  return {ventas, variables, com, pub, util, margen: ventas ? util / ventas : null};
}
function pintaEscenarios(r, estMes){
  const b = baseMensual(r, estMes); const lista = [...(r.modelo?.escenarios || [])];
  const cols = [{nombre: 'Hoy (base)', precio: 0, ordenes: 0, variables: 0, pub_semana: 0}, ...lista, escTmp];
  const calc = cols.map(e => calcEsc(b, e));
  const mc = b.ventas ? 1 - (b.variables / b.ventas) - b.comPct : 0;
  $('#escen').innerHTML = `<p class="muted" style="margin-top:0">Cifras por mes. Base: ${esc(b.fuente)}. Ajusta tu escenario en la última columna.</p>
    <div class="tbl"><table><thead><tr><th></th>${cols.map((e, i) => `<th class="n">${i === cols.length - 1 ? `<input class="cell w" id="en" value="${esc(e.nombre)}" style="width:150px">` : esc(e.nombre)}</th>`).join('')}</tr></thead><tbody>
      ${[['precio','Subir precios (%)'],['ordenes','Más órdenes (%)'],['variables','Más costo de insumos (%)'],['pub_semana','Publicidad por semana ($)']].map(([k, l]) => `<tr><td>${l}</td>${cols.map((e, i) => `<td class="n">${i === cols.length - 1 ? `<input class="cell" data-esc="${k}" inputmode="decimal" value="${esc(e[k])}">` : (k === 'pub_semana' ? money(e[k]) : (e[k] || 0) + ' %')}</td>`).join('')}</tr>`).join('')}
      <tr><td><b>Ventas del mes</b></td>${calc.map(c => `<td class="n"><b>${money(Math.round(c.ventas))}</b></td>`).join('')}</tr>
      <tr><td>Insumos y variables</td>${calc.map(c => `<td class="n">−${money(Math.round(c.variables))}</td>`).join('')}</tr>
      <tr><td>Comisiones</td>${calc.map(c => `<td class="n">−${money(Math.round(c.com))}</td>`).join('')}</tr>
      <tr><td>Nómina y fijos</td>${calc.map(() => `<td class="n">−${money(Math.round(b.nomina + b.fijos))}</td>`).join('')}</tr>
      <tr><td>Publicidad</td>${calc.map(c => `<td class="n">−${money(Math.round(c.pub))}</td>`).join('')}</tr>
      <tr><td><b>Utilidad del mes</b></td>${calc.map(c => `<td class="n"><b class="${c.util < 0 ? 'neg' : 'pos'}">${money(Math.round(c.util))}</b></td>`).join('')}</tr>
      <tr><td>Margen</td>${calc.map(c => `<td class="n">${pctTxt(c.margen)}</td>`).join('')}</tr>
      <tr><td>Contra hoy</td>${calc.map((c, i) => `<td class="n">${i ? `<b class="${c.util - calc[0].util < 0 ? 'neg' : 'pos'}">${c.util - calc[0].util >= 0 ? '+' : ''}${money(Math.round(c.util - calc[0].util))}</b>` : '—'}</td>`).join('')}</tr>
    </tbody></table></div>
    <div class="row" style="margin-top:10px"><button class="btn pri" id="escSave">Guardar mi escenario</button>${lista.length ? `<select id="escDel" class="cell w"><option value="">Quitar un escenario…</option>${lista.map((e, i) => `<option value="${i}">${esc(e.nombre)}</option>`).join('')}</select>` : ''}</div>
    <p class="note">Con tu margen de contribución actual (${pctTxt(mc)}), <b>$1,500 de publicidad por semana (${money(Math.round(1500 * b.sem))} al mes) se pagan solos si generan ${mc > 0 ? money(Math.round(1500 * b.sem / mc)) : '—'} de ventas extra al mes</b>. Revisa el resultado real de cada campaña en la pestaña Marketing.</p>`;
  $('#escen').querySelectorAll('[data-esc]').forEach(i => i.onchange = () => { escTmp[i.dataset.esc] = Number(i.value) || 0; escTmp.nombre = $('#en').value; pintaEscenarios(r, estMes); });
  $('#en').onchange = () => { escTmp.nombre = $('#en').value; };
  $('#escSave').onclick = async () => { escTmp.nombre = $('#en').value.trim() || 'Mi escenario'; const nl = [...lista, {...escTmp}].slice(-6);
    try { await call('admin_config_guardar', {p_clave: 'escenarios', p_valor: nl}); toast('Escenario guardado'); r.modelo.escenarios = nl; escTmp = {nombre: 'Mi escenario', precio: 0, ordenes: 0, variables: 0, pub_semana: 0}; pintaEscenarios(r, estMes); } catch(e){ toast(e.message, true); } };
  const del = $('#escDel'); if (del) del.onchange = async () => { if (del.value === '') return; const nl = lista.filter((_, i) => i !== Number(del.value));
    try { await call('admin_config_guardar', {p_clave: 'escenarios', p_valor: nl}); r.modelo.escenarios = nl; pintaEscenarios(r, estMes); } catch(e){ toast(e.message, true); } };
}

/* ---------- gastos ---------- */
const CATG = {insumos: 'Insumos', gas: 'Gas', desechables: 'Desechables', mantenimiento: 'Mantenimiento', otro: 'Otro'};
async function aGastos(){
  const A = S.admin; const d = await call('admin_gastos', {p_desde: A.desde, p_hasta: A.hasta, p_demo: A.demo});
  const porCat = {}; d.gastos.forEach(g => porCat[g.categoria] = (porCat[g.categoria] || 0) + Number(g.monto));
  const fijosMes = d.fijos.filter(f => f.activo).reduce((a, f) => a + Number(f.monto_mensual), 0);
  $('#abody').innerHTML = `<div class="two"><div><h3 style="margin-top:0">Registrar un gasto</h3><div class="card grid">
      <div class="grid" style="grid-template-columns:1fr 1fr;gap:10px">
        <label class="field">Fecha<input type="date" id="gf" class="cell w" style="width:100%" value="${hoyISO()}"></label>
        <label class="field">Categoría<select id="gc" class="cell w" style="width:100%">${Object.entries(CATG).map(([k, l]) => `<option value="${k}">${l}</option>`).join('')}</select></label>
        <label class="field">Concepto<input id="gn" class="cell w" style="width:100%" placeholder="Carnitas, verdura de la semana…"></label>
        <label class="field">Monto ($)<input id="gm" class="cell" style="width:100%" inputmode="decimal"></label>
        <label class="field">Proveedor<input id="gp" class="cell w" style="width:100%"></label>
        <label class="field">Nota<input id="gx" class="cell w" style="width:100%"></label></div>
      <button class="btn pri" id="gsave">Guardar gasto</button>
      <p class="note" style="margin:0">Las compras que registras en Inventario con su costo ya se agregan aquí solas: no las captures dos veces.</p></div></div>
    <div><h3 style="margin-top:0">Gastos fijos mensuales · ${money(fijosMes)}</h3>${tabla([['Concepto', f => `<input class="cell w" data-fc="${esc(f.id)}" value="${esc(f.concepto)}" style="width:170px">`], ['Mensual', f => `<input class="cell" data-fm="${esc(f.id)}" inputmode="decimal" value="${esc(f.monto_mensual)}">`, 'n'],
        ['Activo', f => `<input type="checkbox" data-fa="${esc(f.id)}" ${f.activo ? 'checked' : ''} style="width:22px;height:22px">`], ['', f => `<button class="btn sm" data-fs="${esc(f.id)}">Guardar</button>`]], d.fijos)}
      <div class="card row" style="margin-top:8px"><input id="fnc" class="cell w" placeholder="Nuevo concepto (gas, internet, contador…)" style="flex:1"><input id="fnm" class="cell" inputmode="decimal" placeholder="$ al mes"><button class="btn" id="fadd">Agregar</button></div></div></div>
    <h3>Gastos del periodo · ${money(d.gastos.reduce((a, g) => a + Number(g.monto), 0))}</h3>
    <div class="row" style="margin-bottom:8px">${Object.entries(porCat).map(([k, v]) => `<span class="tag">${CATG[k] || k}: ${money(v)}</span>`).join('')}</div>
    ${tabla([['Fecha', g => fdate(g.fecha)], ['Categoría', g => CATG[g.categoria] || g.categoria], ['Concepto', g => esc(g.concepto) + (g.origen === 'inventario' ? ' <span class="tag t-mesa">inventario</span>' : '')], ['Proveedor', g => esc(g.proveedor || '')], ['Monto', g => money(g.monto), 'n'],
      ['', g => g.origen === 'manual' ? `<button class="btn sm" data-gd="${esc(g.id)}">Borrar</button>` : '']], d.gastos, 'Sin gastos registrados en este periodo.')}`;
  $('#gsave').onclick = async () => { try { await call('admin_gasto_guardar', {p: {fecha: $('#gf').value, categoria: $('#gc').value, concepto: $('#gn').value, monto: $('#gm').value, proveedor: $('#gp').value, nota: $('#gx').value}}); toast('Gasto guardado'); aGastos(); } catch(e){ toast(e.message, true); } };
  app().querySelectorAll('[data-gd]').forEach(b => b.onclick = async () => { if (!b.dataset.sure){ b.dataset.sure = 1; b.textContent = '¿Seguro?'; return; } try { await call('admin_gasto_borrar', {p_id: b.dataset.gd}); toast('Gasto borrado'); aGastos(); } catch(e){ toast(e.message, true); } });
  app().querySelectorAll('[data-fs]').forEach(b => b.onclick = async () => { const id = b.dataset.fs;
    try { await call('admin_gasto_fijo_guardar', {p: {id, concepto: app().querySelector(`[data-fc="${id}"]`).value, monto_mensual: app().querySelector(`[data-fm="${id}"]`).value, activo: app().querySelector(`[data-fa="${id}"]`).checked}}); toast('Guardado'); aGastos(); } catch(e){ toast(e.message, true); } });
  $('#fadd').onclick = async () => { try { await call('admin_gasto_fijo_guardar', {p: {concepto: $('#fnc').value, monto_mensual: $('#fnm').value}}); toast('Agregado'); aGastos(); } catch(e){ toast(e.message, true); } };
}

/* ---------- nómina ---------- */
let nomFecha = null;
function proximoDia(d){ const h = new Date(hoyISO() + 'T12:00:00'); const t = DSEM.indexOf(d); let k = (t - h.getDay() + 7) % 7; return addDays(hoyISO(), k); }
async function aNomina(){
  const emp = await call('admin_empleados'); S.admin.emp = emp;
  const dias = [...new Set(emp.filter(e => e.activo).map(e => e.dia_pago))];
  if (!nomFecha) nomFecha = dias.map(proximoDia).sort()[0] || hoyISO();
  const n = await call('admin_nomina', {p_fecha: nomFecha});
  const pagada = n.lineas.length && n.lineas.every(l => l.pagado);
  $('#abody').innerHTML = `<div class="row" style="margin-bottom:12px">${dias.map(d => { const f = proximoDia(d); return `<button class="chip" data-nf="${f}" aria-pressed="${f === nomFecha}">${fdate(f)}</button>`; }).join('')}
      <input type="date" id="nfd" class="cell w" value="${nomFecha}"><span class="muted small">Día de pago</span></div>
    <h3 style="margin-top:0">Nómina del ${fdate(nomFecha)} ${pagada ? '<span class="tag t-mesa">pagada</span>' : ''}</h3>
    ${n.lineas.length ? `<div class="tbl"><table><thead><tr><th>Persona</th><th class="n">Pago semanal</th><th class="n">Días</th><th class="n">Extras $</th><th class="n">Bonos $</th><th class="n">Adelantos $</th><th class="n">Total</th></tr></thead><tbody>
      ${n.lineas.map((l, i) => `<tr><td><b>${esc(l.nombre)}</b><br><span class="muted small">${esc(l.puesto || '')}</span></td><td class="n">${money(l.base)}</td>
        ${['dias','extras','bonos','adelantos'].map(k => `<td class="n"><input class="cell" data-nl="${i}" data-k="${k}" inputmode="decimal" value="${esc(l[k])}" style="width:80px" ${l.pagado ? 'disabled' : ''}></td>`).join('')}
        <td class="n"><b id="nt${i}">${money(l.total)}</b></td></tr>`).join('')}
      <tr><td colspan="6"><b>Total a pagar</b></td><td class="n"><b id="ntt"></b></td></tr></tbody></table></div>
      ${pagada ? '<p class="note">Esta nómina ya se marcó como pagada.</p>' : `<div class="row" style="margin-top:10px"><button class="btn" id="nsv">Guardar borrador</button><button class="btn pri" id="npg">Marcar como pagada</button></div>`}
      <p class="note">Total = pago semanal × días ÷ 7 + extras + bonos − adelantos. 7 días = semana completa. No incluye IMSS ni ISR: pásale el total a tu contador.</p>`
      : '<div class="empty">Nadie cobra ese día.</div>'}
    <div class="two" style="margin-top:16px"><div><h3>Personal y pago semanal</h3>${tabla([['Nombre', e => `<b>${esc(e.nombre)}</b>${e.activo ? '' : ' <span class="tag">baja</span>'}<br><span class="muted small">${esc(e.puesto || '')}</span>`], ['Paga', e => e.dia_pago], ['Pago semanal', e => money(e.pago_semanal), 'n'], ['', e => `<button class="btn sm" data-ee="${esc(e.id)}">Editar</button>`]], emp)}
      <div class="row" style="margin-top:8px"><button class="btn" id="enew">+ Persona</button><span class="muted small">Nómina mensual: <b>${money(Math.round(emp.filter(e => e.activo).reduce((a, e) => a + Number(e.pago_semanal), 0) * 4.33))}</b></span></div></div>
    <div><h3>Pagos anteriores</h3>${tabla([['Fecha', h => fdate(h.fecha_pago)], ['Personas', h => h.personas, 'n'], ['Total', h => money(h.total), 'n'], ['Estado', h => h.pagado ? 'Pagada' : '<span class="tag pend">borrador</span>'], ['', h => `<button class="btn sm" data-nh="${h.fecha_pago}">Ver</button>`]], n.historial, 'Todavía no hay nóminas registradas.')}</div></div>`;
  const lineas = n.lineas.map(l => ({...l}));
  const recalc = () => { let t = 0; lineas.forEach((l, i) => { const tot = r2(Number(l.base) * Number(l.dias) / 7 + Number(l.extras || 0) + Number(l.bonos || 0) - Number(l.adelantos || 0)); l.total = tot; t += tot; const el = $('#nt' + i); if (el) el.textContent = money(tot); }); const tt = $('#ntt'); if (tt) tt.textContent = money(t); };
  app().querySelectorAll('[data-nl]').forEach(i => i.oninput = () => { lineas[Number(i.dataset.nl)][i.dataset.k] = i.value === '' ? 0 : Number(i.value); recalc(); });
  recalc();
  app().querySelectorAll('[data-nf]').forEach(b => b.onclick = () => { nomFecha = b.dataset.nf; aNomina(); });
  app().querySelectorAll('[data-nh]').forEach(b => b.onclick = () => { nomFecha = b.dataset.nh; aNomina(); });
  $('#nfd').onchange = () => { nomFecha = $('#nfd').value; aNomina(); };
  const guarda = async pagar => { try { const r = await call('admin_nomina_guardar', {p_fecha: nomFecha, p_lineas: lineas, p_pagar: pagar}); toast(pagar ? `Nómina pagada: ${money(r.total)}` : 'Borrador guardado'); aNomina(); } catch(e){ toast(e.message, true); } };
  const ns = $('#nsv'); if (ns) ns.onclick = () => guarda(false);
  const np = $('#npg'); if (np) np.onclick = () => { if (!np.dataset.sure){ np.dataset.sure = 1; np.textContent = '¿Confirmas el pago? Toca otra vez'; return; } guarda(true); };
  $('#enew').onclick = () => formEmpleado(null);
  app().querySelectorAll('[data-ee]').forEach(b => b.onclick = () => formEmpleado(emp.find(e => e.id === b.dataset.ee)));
}
function formEmpleado(e){
  abreModal(`<div class="sheet"><h2>${e ? 'Editar' : 'Nueva'} persona</h2>
    <div class="grid" style="grid-template-columns:1fr 1fr;gap:10px">
      <label class="field">Nombre<input id="em_n" value="${esc(e?.nombre || '')}"></label><label class="field">Puesto<input id="em_p" value="${esc(e?.puesto || '')}"></label>
      <label class="field">Pago semanal ($)<input id="em_s" inputmode="decimal" value="${esc(e?.pago_semanal ?? '')}"></label>
      <label class="field">Día de pago<select id="em_d">${['Lun','Mar','Mié','Jue','Vie','Sáb','Dom'].map(d => `<option ${(e?.dia_pago || 'Dom') === d ? 'selected' : ''}>${d}</option>`).join('')}</select></label>
      <label class="field">Fecha de ingreso<input type="date" id="em_i" value="${esc(e?.ingreso || '')}"></label><label class="field">Teléfono<input id="em_t" value="${esc(e?.telefono || '')}"></label></div>
    <label class="field">Notas<input id="em_x" value="${esc(e?.notas || '')}"></label>
    ${e ? `<label class="row"><input type="checkbox" id="em_a" ${e.activo ? 'checked' : ''} style="width:22px;height:22px"> Activo</label>` : ''}
    <p class="note" style="margin:0">Esto es solo para la nómina. Para que alguien use la tablet, dalo de alta con PIN en la pestaña Personal.</p>
    <div class="foot"><button class="btn big" data-x="no">Cancelar</button><button class="btn pri big" data-x="si">Guardar</button></div></div>`);
  dlg().querySelector('[data-x="no"]').onclick = cierraModal;
  dlg().querySelector('[data-x="si"]').onclick = async () => {
    try { await call('admin_empleado_guardar', {p: {id: e?.id || null, nombre: $('#em_n').value, puesto: $('#em_p').value, pago_semanal: $('#em_s').value, dia_pago: $('#em_d').value, ingreso: $('#em_i').value, telefono: $('#em_t').value, notas: $('#em_x').value, activo: $('#em_a') ? $('#em_a').checked : true}});
      cierraModal(); toast('Guardado'); S.admin.emp = undefined; aNomina(); } catch(err){ toast(err.message, true); }
  };
}

/* ---------- marketing ---------- */
async function aMarketing(){
  const d = await call('admin_campanas', {p_demo: S.admin.demo});
  $('#abody').innerHTML = `<p class="muted" style="margin-top:0">Registra cada campaña (redes sociales, letreros, volanteo) con su costo y fechas. El sistema compara las ventas diarias durante la campaña contra las 4 semanas anteriores y calcula si se pagó sola, con tu margen de contribución de ${pctTxt(d.margen_contribucion)}${d.margen_estimado ? ' (estimado hasta tener 2 semanas de ventas y gastos registrados)' : ''}.</p>
    <div class="card grid" style="margin-bottom:16px"><h2 style="margin:0">Nueva campaña</h2>
      <div class="grid" style="grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:10px">
        <label class="field">Nombre<input id="cn2" class="cell w" style="width:100%" placeholder="Facebook noviembre"></label>
        <label class="field">Canal<input id="cc2" class="cell w" style="width:100%" list="canales" placeholder="Facebook, Instagram, letrero…"><datalist id="canales"><option value="Facebook"><option value="Instagram"><option value="TikTok"><option value="Letreros"><option value="Volanteo"><option value="Promoción en apps"></datalist></label>
        <label class="field">Inicio<input type="date" id="ci2" class="cell w" style="width:100%" value="${hoyISO()}"></label>
        <label class="field">Fin<input type="date" id="cf2" class="cell w" style="width:100%" value="${addDays(hoyISO(), 6)}"></label>
        <label class="field">Inversión total ($)<input id="cm2" class="cell" style="width:100%" inputmode="decimal" placeholder="1500"></label></div>
      <button class="btn pri" id="csv2">Guardar campaña</button></div>
    ${d.campanas.length ? `<div class="two">${d.campanas.map(c => { const ok = c.retorno != null && c.retorno >= 0;
      return `<div class="card grid"><div class="row"><b style="font-size:18px">${esc(c.nombre)}</b><span class="spacer"></span>${c.en_curso ? '<span class="tag pend">en curso</span>' : ''}<span class="tag">${esc(c.canal || '')}</span></div>
        <div class="muted small">${fdate(c.inicio)} – ${fdate(c.fin)} · ${c.dias} días · inversión <b>${money(c.monto)}</b></div>
        <div class="tbl"><table><tbody>
          <tr><td>Venta diaria antes (4 semanas)</td><td class="n">${money(c.antes.diario)}</td></tr>
          <tr><td>Venta diaria durante</td><td class="n"><b>${money(c.durante.diario)}</b></td></tr>
          <tr><td>Ticket promedio antes → durante</td><td class="n">${c.antes.ticket ? money(c.antes.ticket) : '—'} → ${c.durante.ticket ? money(c.durante.ticket) : '—'}</td></tr>
          <tr><td>Ventas extra</td><td class="n"><b class="${c.extra < 0 ? 'neg' : 'pos'}">${money(c.extra)}</b></td></tr>
          <tr><td>Retorno (ganancia extra − inversión)</td><td class="n"><b class="${ok ? 'pos' : 'neg'}">${c.retorno == null ? '—' : pctTxt(c.retorno)}</b></td></tr></tbody></table></div>
        <p class="note" style="margin:0">${c.en_curso ? 'La campaña sigue: el resultado cambia cada día.' : c.retorno == null ? '' : ok ? 'Se pagó sola y dejó ganancia.' : 'No se pagó sola: prueba otro canal, otro mensaje o otro horario.'} ${c.antes.ventas === 0 ? 'Sin ventas registradas antes de la campaña: la comparación todavía no es confiable.' : ''}</p>
        <button class="btn sm" data-ce="${esc(c.id)}" style="justify-self:start">Editar</button></div>`; }).join('')}</div>` : '<div class="empty">Sin campañas registradas.</div>'}
    <p class="note">Retorno = (ventas extra × margen de contribución − inversión) ÷ inversión. Las ventas pueden subir o bajar por otras razones (quincena, clima, fechas especiales): compara varias campañas antes de decidir.</p>`;
  const guardar = async id => { try { await call('admin_campana_guardar', {p: {id: id || null, nombre: $('#cn2').value, canal: $('#cc2').value, inicio: $('#ci2').value, fin: $('#cf2').value, monto: $('#cm2').value}}); toast('Campaña guardada'); aMarketing(); } catch(e){ toast(e.message, true); } };
  let edit = null; $('#csv2').onclick = () => guardar(edit);
  app().querySelectorAll('[data-ce]').forEach(b => b.onclick = () => { const c = d.campanas.find(x => x.id === b.dataset.ce); edit = c.id;
    $('#cn2').value = c.nombre; $('#cc2').value = c.canal || ''; $('#ci2').value = c.inicio; $('#cf2').value = c.fin; $('#cm2').value = c.monto; $('#csv2').textContent = 'Guardar cambios'; window.scrollTo({top: 0, behavior: 'smooth'}); });
}

/* ---------- rutinas de apertura y cierre ---------- */
async function vRutina(){
  app().innerHTML = barra() + `<main><div class="row" style="margin-bottom:10px"><button class="btn" data-act="inicio">← Volver</button><h1 style="margin:0">Apertura y cierre</h1></div><div id="rbody"><p class="muted">Cargando…</p></div></main>`; pintaSync();
  let d; try { d = await call('pos_rutina'); } catch(e){ $('#rbody').innerHTML = `<div class="banner crit">${esc(e.message)}</div>`; return; }
  const pinta = () => {
    $('#rbody').innerHTML = `<p class="muted" style="margin-top:0">${fdate(d.fecha)}. Toca cada punto al terminarlo: queda registrado quién y a qué hora.</p><div class="two">
      ${['apertura','cierre'].map(t => { const items = d.items?.[t] || []; const hechos = items.filter((_, i) => d[t][i]?.hecho).length;
        return `<div class="card"><div class="row"><h2 style="margin:0">${t === 'apertura' ? 'Apertura' : 'Cierre'}</h2><span class="spacer"></span><span class="tag ${hechos === items.length ? 't-mesa' : 'pend'}">${hechos} de ${items.length}</span></div>
        ${items.map((txt, i) => { const m = d[t][i]; return `<button class="chk ${m?.hecho ? 'on' : ''}" data-rt="${t}" data-ri="${i}"><span class="box">${m?.hecho ? '✓' : ''}</span><span><b>${esc(txt)}</b>${m?.hecho ? `<br><span class="muted small">${esc(m.quien)} · ${new Date(m.cuando).toLocaleTimeString('es-MX', {hour: '2-digit', minute: '2-digit'})}</span>` : ''}</span></button>`; }).join('')}</div>`; }).join('')}</div>`;
    $('#rbody').querySelectorAll('[data-rt]').forEach(b => b.onclick = async () => { const t = b.dataset.rt, i = Number(b.dataset.ri);
      try { d = await call('pos_rutina_marcar', {p_tipo: t, p_idx: i, p_hecho: !d[t][i]?.hecho}); pinta(); } catch(e){ toast(e.message, true); } });
  };
  pinta();
}

/* ---------- costos y ganancia ---------- */
let costoVista = 'vendido';
async function aCostos(){
  const A = S.admin; const d = await call('admin_costeo', {p_desde: A.desde, p_hasta: A.hasta, p_demo: A.demo});
  const v = d.vendido; const tot = v.reduce((a, x) => ({ventas: a.ventas + x.ventas, costo: a.costo + x.costo}), {ventas: 0, costo: 0});
  const inc = d.menu.filter(x => x.faltan > 0).length;
  const pct = x => x == null ? '—' : (Math.round(x * 1000) / 10) + ' %';
  const mg = (x, row) => row && row.faltan ? '<span class="muted">incompleto</span>' : x == null ? '—' : `<b class="${x < 0.5 ? 'neg' : x >= 0.65 ? 'pos' : ''}">${pct(x)}</b>`;
  const datos = x => x.faltan ? `<span class="tag pend">faltan ${x.faltan} dato(s)</span>` : '<span class="tag t-mesa">completo</span>';
  $('#abody').innerHTML = `${inc ? `<div class="banner">El costo de <b>${inc} de ${d.menu.length}</b> platillos está incompleto: falta medir ingredientes en <b>Recetas</b> o capturar el costo de insumos (con cada <b>Compra</b> se guarda solo). Mientras tanto, el costo que ves es solo de lo que ya tiene dato.</div>` : ''}
    <div class="grid kpis">
      <div class="kpi"><div class="l">Ventas sin IVA</div><div class="v num">${money(tot.ventas)}</div></div>
      <div class="kpi"><div class="l">Costo de ingredientes</div><div class="v num">${money(tot.costo)}</div></div>
      <div class="kpi"><div class="l">Ganancia bruta</div><div class="v num">${money(tot.ventas - tot.costo)}</div></div>
      <div class="kpi"><div class="l">Costo de alimentos</div><div class="v num">${tot.ventas && !v.some(x => x.faltan) ? pct(tot.costo / tot.ventas) : '—'}</div>${v.some(x => x.faltan) ? '<div class="small muted">incompleto: faltan datos</div>' : ''}</div></div>
    <div class="row" style="margin-bottom:10px"><button class="chip" data-cv="vendido" aria-pressed="${costoVista === 'vendido'}">Lo vendido en el periodo</button><button class="chip" data-cv="menu" aria-pressed="${costoVista === 'menu'}">Costo por platillo del menú</button></div>
    ${costoVista === 'vendido'
      ? tabla([['Producto', x => esc(x.producto)], ['Unidades', x => x.unidades, 'n'], ['Ventas sin IVA', x => money(x.ventas), 'n'], ['Costo', x => money(x.costo), 'n'], ['Ganancia', x => money(x.ganancia), 'n'], ['Margen', x => mg(x.margen, x), 'n'], ['Datos', datos]], v, 'Sin ventas en este periodo.')
      : tabla([['Platillo', x => `<b>${esc(x.producto)}</b>${x.variante ? `<br><span class="muted small">${esc(x.variante)}</span>` : ''}`], ['Código', x => `<code>${esc(x.codigo)}</code>`], ['Precio', x => money(x.precio), 'n'], ['Costo', x => money(x.costo), 'n'], ['Ganancia por pieza', x => money(r2(x.precio / d.iva - x.costo)), 'n'], ['Margen', x => mg(x.margen, x), 'n'], ['Datos', datos]], d.menu)}
    <p class="note">Margen = (precio sin IVA − costo de ingredientes) ÷ precio sin IVA. Referencia en restaurantes: costo de alimentos entre 28 y 35 % (margen de 65–72 %). En verde: margen de 65 % o más; en rojo: menos de 50 %. No incluye renta, sueldos ni comisiones de las apps. El costo usa el último precio de compra de cada insumo.</p>`;
  app().querySelectorAll('[data-cv]').forEach(b => b.onclick = () => { costoVista = b.dataset.cv; aCostos(); });
}

/* ---------- inventario ---------- */
const fq = (q, u) => { if (q == null) return '—'; const n = Number(q);
  if (u === 'g' && Math.abs(n) >= 1000) return (Math.round(n / 10) / 100).toLocaleString('es-MX') + ' kg';
  if (u === 'ml' && Math.abs(n) >= 1000) return (Math.round(n / 10) / 100).toLocaleString('es-MX') + ' L';
  return (Math.round(n * 100) / 100).toLocaleString('es-MX') + ' ' + u; };
const PILL = {'Agotado':'crit','Bajo mínimo':'crit','Pedir ya':'warn','Sin conteo':'mute','OK':'ok'};
const pill = e => `<span class="tag ${PILL[e] === 'crit' ? 't-app' : PILL[e] === 'warn' ? 'pend' : PILL[e] === 'ok' ? 't-mesa' : ''}">${esc(e)}</span>`;
const TIPOMOV = {inicial:'Conteo inicial', conteo:'Ajuste por conteo', compra:'Compra', produccion:'Producción', consumo_produccion:'Usado en producción', venta:'Venta', anulacion:'Venta anulada',
  merma:'Merma', consumo_personal:'Consumo personal', cortesia:'Cortesía', correccion:'Corrección'};
let invSub = 'existencias', invFiltro = 'todos', invCiego = true;
async function aInventario(){
  const A = S.admin; const d = await call('admin_inventario', {p_demo: A.demo}); A.inv = d;
  const ins = d.insumos; const cats = [...new Set(ins.map(i => i.categoria))];
  const alertas = ins.filter(i => ['Agotado','Bajo mínimo','Pedir ya'].includes(i.estado)).length;
  const vence = d.lotes.filter(l => l.dias <= 2);
  const subs = [['existencias','Existencias'],['compras','Qué comprar'],['capturar','Registrar movimiento'],['conteo','Conteo físico'],['proveedores','Proveedores']];
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
  ({existencias: invExistencias, capturar: invCapturar, conteo: invConteo, compras: invCompras, proveedores: invProveedores})[invSub](d, cats);
}
async function invCompras(){
  const r = await call('admin_compras', {p_demo: S.admin.demo});
  const msg = p => `Buen día${p.contacto ? ' ' + p.contacto : ''}, le hago el pedido de Ahogaditas Tapatío:\n` + p.items.map(i => `- ${i.presentaciones ? `${i.presentaciones} ${i.presentacion || 'pza'}` : fq(i.cantidad, i.unidad)} de ${i.nombre}`).join('\n') + '\n¿Me confirma para cuándo llega? Gracias.';
  $('#ibody').innerHTML = `<p class="muted" style="margin-top:0">Hoy es ${esc(r.hoy)}. Sugerido = stock objetivo − existencia; si no hay objetivo, consumo diario × (días de entrega + 3) + mínimo − existencia.${r.sin_dato ? ` <b>${r.sin_dato} insumo(s)</b> no tienen mínimo, objetivo ni consumo: captúralos en Existencias → Editar para que aparezcan aquí.` : ''}</p>
    ${r.proveedores.length ? `<div class="two">${r.proveedores.map((p, ix) => `<div class="card grid"><div class="row"><b style="font-size:18px">${esc(p.proveedor)}</b><span class="spacer"></span>${p.hoy_toca ? '<span class="tag pend">Hoy toca pedir</span>' : p.dias_pedido ? `<span class="tag">Pide: ${esc(p.dias_pedido)}</span>` : ''}</div>
      ${tabla([['Insumo', i => esc(i.nombre)], ['Hay', i => fq(i.existencia, i.unidad), 'n'], ['Pedir', i => `<b>${i.presentaciones ? `${i.presentaciones} ${esc(i.presentacion || '')}` : fq(i.cantidad, i.unidad)}</b>`, 'n'], ['Aprox.', i => i.costo ? money(i.costo) : '—', 'n']], p.items)}
      <pre class="ticketprev" id="pm${ix}">${esc(msg(p))}</pre>
      <div class="row"><button class="btn sm" data-cp="${ix}">Copiar mensaje</button>${p.telefono ? `<a class="btn sm pri" target="_blank" rel="noopener" href="https://wa.me/${esc(p.telefono.replace(/^\+/, '').replace(/^(?!52)/, '52'))}?text=${encodeURIComponent(msg(p))}">Enviar por WhatsApp</a>` : '<span class="muted small">Captura su teléfono en Proveedores para enviarlo por WhatsApp.</span>'}
        <span class="spacer"></span><b>${p.monto ? money(p.monto) + ' aprox.' : ''}</b></div></div>`).join('')}</div>` : '<div class="empty">Nada por comprar según existencias y mínimos.</div>'}`;
  app().querySelectorAll('[data-cp]').forEach(b => b.onclick = async () => { try { await navigator.clipboard.writeText($('#pm' + b.dataset.cp).textContent); toast('Mensaje copiado'); } catch(e){ toast('Selecciona el texto y cópialo', true); } });
}
const DIASP = ['Lun','Mar','Mié','Jue','Vie','Sáb','Dom'];
async function invProveedores(){
  const ps = await call('admin_proveedores');
  $('#ibody').innerHTML = `<div class="row" style="margin-bottom:10px"><button class="btn pri" id="pvNew">+ Proveedor</button></div>
    ${tabla([['Proveedor', p => `<b>${esc(p.nombre)}</b>${p.activo ? '' : ' <span class="tag">inactivo</span>'}`], ['Contacto', p => esc(p.contacto || '')], ['Teléfono', p => esc(p.telefono || '')], ['Días de pedido', p => esc((p.dias_pedido || []).join(', '))],
      ['Entrega', p => p.dias_entrega != null ? p.dias_entrega + ' día(s)' : '—', 'n'], ['Insumos', p => p.insumos, 'n'], ['', p => `<button class="btn sm" data-pv="${esc(p.id)}">Editar</button>`]], ps, 'Agrega a tus proveedores: pan birote, carnitas, refrescos, verduras, tortillas…')}
    <p class="note">Para asignar un proveedor a un insumo: Existencias → Editar → Proveedor (mismo nombre).</p>`;
  $('#pvNew').onclick = () => formProveedor(null);
  app().querySelectorAll('[data-pv]').forEach(b => b.onclick = () => formProveedor(ps.find(p => p.id === b.dataset.pv)));
}
function formProveedor(p){
  abreModal(`<div class="sheet"><h2>${p ? 'Editar' : 'Nuevo'} proveedor</h2>
    <label class="field">Nombre<input id="pv_n" value="${esc(p?.nombre || '')}"></label>
    <div class="grid" style="grid-template-columns:1fr 1fr;gap:10px"><label class="field">Contacto<input id="pv_c" value="${esc(p?.contacto || '')}"></label><label class="field">Teléfono / WhatsApp (10 dígitos)<input id="pv_t" inputmode="tel" value="${esc(p?.telefono || '')}"></label>
      <label class="field">Días que tarda en entregar<input id="pv_e" inputmode="numeric" value="${esc(p?.dias_entrega ?? '')}"></label><label class="field">Forma de pago<input id="pv_p" value="${esc(p?.pago || '')}"></label></div>
    <div class="field">Días en que se le pide<div class="chips">${DIASP.map(d => `<button class="chip" data-dp="${d}" aria-pressed="${(p?.dias_pedido || []).includes(d)}">${d}</button>`).join('')}</div></div>
    <label class="field">Notas<input id="pv_x" value="${esc(p?.notas || '')}"></label>
    ${p ? `<label class="row"><input type="checkbox" id="pv_a" ${p.activo ? 'checked' : ''} style="width:22px;height:22px"> Activo</label>` : ''}
    <div class="foot"><button class="btn big" data-x="no">Cancelar</button><button class="btn pri big" data-x="si">Guardar</button></div></div>`);
  dlg().querySelectorAll('[data-dp]').forEach(b => b.onclick = () => b.setAttribute('aria-pressed', b.getAttribute('aria-pressed') !== 'true'));
  dlg().querySelector('[data-x="no"]').onclick = cierraModal;
  dlg().querySelector('[data-x="si"]').onclick = async () => {
    const body = {id: p?.id || null, nombre: $('#pv_n').value, contacto: $('#pv_c').value, telefono: $('#pv_t').value, dias_entrega: $('#pv_e').value, pago: $('#pv_p').value, notas: $('#pv_x').value,
      activo: $('#pv_a') ? $('#pv_a').checked : true, dias_pedido: [...dlg().querySelectorAll('[data-dp][aria-pressed="true"]')].map(b => b.dataset.dp)};
    try { await call('admin_proveedor_guardar', {p: body}); cierraModal(); toast('Guardado'); invProveedores(); } catch(e){ toast(e.message, true); }
  };
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
      ${f('costo_unit', 'Costo por unidad base ($)', 'inputmode="decimal"')}${f('proveedor', 'Proveedor', 'list="provlist"')}<datalist id="provlist"></datalist>
      ${f('vida_util_dias', 'Vida útil (días)', 'inputmode="numeric"')}${f('ubicacion', 'Ubicación')}</div>
    ${f('notas', 'Notas')}
    <label class="row"><input type="checkbox" id="fi_activo" ${!i || i.activo !== false ? 'checked' : ''} style="width:22px;height:22px"> Activo</label>
    <div class="foot"><button class="btn big" data-x="no">Cancelar</button><button class="btn pri big" data-x="si">Guardar</button></div></div>`);
  dlg().querySelector('[data-x="no"]').onclick = cierraModal;
  call('admin_proveedores').then(ps => { const dl = $('#provlist'); if (dl) dl.innerHTML = ps.map(p => `<option value="${esc(p.nombre)}">`).join(''); }).catch(() => {});
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
  if (a === 'inicio'){ if (S.o?.nuevos?.length && !b.dataset.sure){ b.dataset.sure = 1; b.textContent = 'Hay productos sin guardar. ¿Salir?'; return; }
    const v = S.vista === 'orden' && S.o?.desde === 'mapa' ? 'mapa' : 'inicio'; S.o = null; S.vista = v; render(); return v === 'inicio' ? cargaOrdenes(true) : undefined; }
  if (a === 'mapa'){ if (S.vista === 'mapa') return pintaMapa(); S.vista = 'mapa'; return render(); }
  if (a === 'nueva'){ tipoSel = 'mesa'; S.vista = 'tipo'; render(); return; }
  if (a === 'guardar') return guardar(true);
  if (a === 'cobrar') return cobrar();
  if (a === 'desc') return descuento();
  if (a === 'cancelOrden') return cancelarOrden();
  if (a === 'anular') return anularVenta(hoyISO());
  if (a === 'cuenta') return preCuenta();
  if (a === 'mover') return moverMesa();
  if (a === 'corte'){ S.vista = 'corte'; return render(); }
  if (a === 'admin'){ S.vista = 'admin'; return render(); }
  if (a === 'rutina'){ S.vista = 'rutina'; return render(); }
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
setInterval(() => { if (S.ses && !locked && S.vista === 'mapa' && S.online) pintaMapa(); }, 30000);

/* ================= inicio ================= */
if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});
if (CFG.PRUEBAS) window.__pos = S; // solo en pruebas automáticas
render();
})();
