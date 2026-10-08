/* =========================================================
   SISTEMA DE DESVÍOS — UPTU / División Transporte
   Visor público + editor para personas habilitadas
   ========================================================= */

/* ---------- 1. CONFIGURACIÓN — completar estas dos líneas ----------
   Se sacan de: Supabase → Settings → API
   La clave "anon public" es segura de publicar: los permisos
   están en la base (RLS), no en este archivo.                     */
const SUPABASE_URL  = 'https://vxwjxygjdirzxykefzaw.supabase.co';
const SUPABASE_ANON = 'sb_publishable_M7E5CM1w-VaSXQk9SegSEg_kASWuVEO';
/* ------------------------------------------------------------------ */

/* ---------- 2. ENVÍO DE CORREO (opcional) ----------
   Se completa después de instalar envio-correo-apps-script.gs:
   la URL que termina en /exec y la misma clave que pusiste ahí.
   Mientras estén vacíos, el botón Correo abre el cliente de correo
   como hasta ahora.                                              */
// MODO MANUAL: el botón Correo abre el correo con todo cargado.
// Cuando Informática habilite la publicación "Cualquier usuario" en Apps
// Script, alcanza con poner acá la URL de la implementación y vuelve a
// enviarse solo. La clave de abajo ya coincide con la del script.
const ENVIO_URL   = '';   // ej.: 'https://script.google.com/macros/s/AKfy.../exec'
const ENVIO_CLAVE = 'cachorromalvado';
/* ---------------------------------------------------------------- */

const REFRESCO_MS = 45000;

let sb = null, sesion = null, esEditor = false;
let desvios = [], seleccionado = null;
let filtro = '';                         // texto del buscador (visor)
let modo = 'visor';                       // visor | editor
let ed = null;                            // desvío en edición
let baseCargada = false;
let mapa, capaDesvios, capaEdicion, capaParadas, renderer;
let herramienta = null;                   // recorrido | suspender | provisoria
const OSRM = 'https://router.project-osrm.org/nearest/v1/driving/';

// Devuelve el nombre de la calle sobre la que cae un punto.
// No modifica el trazado: solo consulta cómo se llama esa calle.
async function calleDelPunto(p){
  try{
    const ctrl = new AbortController();
    const t = setTimeout(function(){ ctrl.abort(); }, 6000);
    const r = await fetch(OSRM + p[1] + ',' + p[0] + '?number=1', {signal: ctrl.signal});
    clearTimeout(t);
    if(!r.ok) return null;
    const j = await r.json();
    const wp = (j.waypoints || [])[0];
    return (wp && wp.name && wp.name.length > 2) ? wp.name : null;
  }catch(err){ return null; }
}

// Escribe el recorrido con las calles del trazado.
// No pisa lo que la persona ya haya editado a mano.
function proponerRecorrido(sentido){
  const g = gAct();
  if(!g) return;
  const s = sentido || g.dibujando;
  const t = g.traz[s];
  const calles = t.calles.filter(function(c){ return c && c.length > 2; });
  if(calles.length && !t.tocado) t.texto = calles.join(', ') + '.';
  if(s === g.dibujando){
    const campo = $('edRecorrido');
    if(campo && !t.tocado) campo.value = t.texto;
  }
}

// Rehace el recorrido consultando la calle de cada punto marcado.
async function escribirCalles(){
  if(!ed || !trazActual().v.length){ aviso('Marcá primero el recorrido provisorio', 'err'); return; }
  const btn = $('btnCalles');
  btn.disabled = true; btn.textContent = 'Consultando…';
  const calles = [];
  for(const p of trazActual().v){
    const n = await calleDelPunto(p);
    if(n && calles[calles.length - 1] !== n) calles.push(n);
  }
  if(calles.length){
    const t = trazActual();
    t.calles = calles;
    t.texto = calles.join(', ') + '.';
    t.tocado = true;
    const campo = $('edRecorrido');
    campo.value = t.texto;
    campo.dataset.tocado = '1';
    aviso('Recorrido escrito con ' + calles.length + ' calles. Revisalo antes de publicar.', 'ok');
  }else{
    aviso('No se pudieron obtener los nombres de las calles', 'err');
  }
  btn.disabled = false; btn.textContent = 'Rehacer calles';
}


function recorridoPlano(){
  return ed ? trazActual().v.slice() : [];
}

const $ = id => document.getElementById(id);
const KX = 91300, KY = 110950;
const fnum = n => Number(n).toLocaleString('es-UY');


// Escapa el texto que se inserta como HTML (popups y tooltips del mapa).
function esc(s){
  return String(s == null ? '' : s).replace(/[&<>"']/g, function(c){
    return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];
  });
}

function aviso(msg, tipo){
  const el = $('aviso');
  el.textContent = msg;
  el.className = 'aviso ' + (tipo || '') + (msg ? ' on' : '');
  if(msg && tipo !== 'err') setTimeout(()=>{ if(el.textContent === msg) el.className = 'aviso'; }, 4000);
}

function hace(iso){
  if(!iso) return '';
  const min = Math.round((Date.now() - new Date(iso).getTime())/60000);
  if(min < 1) return 'recién';
  if(min < 60) return 'hace ' + min + ' min';
  const h = Math.round(min/60);
  if(h < 24) return 'hace ' + h + ' h';
  return 'hace ' + Math.round(h/24) + ' días';
}


/* ---------- fechas en formato uruguayo (dd/mm/aaaa hh:mm) ---------- */
function fechaAtexto(iso){
  if(!iso) return '';
  const d = new Date(iso);
  if(isNaN(d)) return '';
  const dd = String(d.getDate()).padStart(2,'0');
  const mm = String(d.getMonth()+1).padStart(2,'0');
  const hh = String(d.getHours()).padStart(2,'0');
  const mi = String(d.getMinutes()).padStart(2,'0');
  return dd + '/' + mm + '/' + d.getFullYear() + ' ' + hh + ':' + mi;
}

// Acepta 5/9, 5/9/26, 05/09/2026, con o sin hora, y separadores / - .
function textoAfecha(txt){
  const s = String(txt || '').trim();
  if(!s) return null;
  const m = s.match(/^(\d{1,2})[\/\-. ](\d{1,2})(?:[\/\-. ](\d{2,4}))?(?:[\s,]+(\d{1,2})[:.](\d{2}))?$/);
  if(!m) return undefined;                 // escrito mal
  const dia = +m[1], mes = +m[2];
  let anio = m[3] ? +m[3] : new Date().getFullYear();
  if(anio < 100) anio += 2000;
  const hora = m[4] ? +m[4] : 0, min = m[5] ? +m[5] : 0;
  if(dia < 1 || dia > 31 || mes < 1 || mes > 12 || hora > 23 || min > 59) return undefined;
  const d = new Date(anio, mes-1, dia, hora, min);
  if(isNaN(d) || d.getDate() !== dia || d.getMonth() !== mes-1) return undefined;
  return d.toISOString();
}

function fechaCorta(iso){
  if(!iso) return '';
  const d = new Date(iso);
  return String(d.getDate()).padStart(2,'0') + '/' + String(d.getMonth()+1).padStart(2,'0') +
    ' ' + String(d.getHours()).padStart(2,'0') + ':' + String(d.getMinutes()).padStart(2,'0');
}


/* ================= MAPA DE FONDO ================= */
const PROVEEDORES = [
  {n:'MonteviMap · vías', wms:true,
   url:'https://montevideo.gub.uy/app/geoserver/mapstore-base/wms',
   opts:{layers:'mapstore-base:cb_v_sig_vias', format:'image/png', transparent:false,
         version:'1.1.1', attribution:'Intendencia de Montevideo'}},
  {n:'MonteviMap · vías (alternativa)', wms:true,
   url:'https://montevideo.gub.uy/app/geoserver/wms',
   opts:{layers:'mapstore-base:cb_v_sig_vias', format:'image/png', transparent:false,
         version:'1.1.1', attribution:'Intendencia de Montevideo'}},
  {n:'Esri', u:'https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}',
   a:'&copy; Esri', max:19},
  {n:'Esri satelital', u:'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
   a:'&copy; Esri', max:19},
  {n:'Carto (claro)', u:'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png',
   a:'&copy; OpenStreetMap, &copy; CARTO', max:20},
  {n:'OpenStreetMap', u:'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
   a:'&copy; OpenStreetMap', max:19},
  {n:'Sin fondo', u:'', a:'', max:19}
];
let capaFondo = null;

function fondoGuardado(){
  try{
    const g = localStorage.getItem('desvios_fondo_v2');
    const i = g === null ? 0 : parseInt(g, 10);
    return (i >= 0 && i < PROVEEDORES.length) ? i : 0;
  }catch(e){ return 0; }
}

function ponerFondo(i){
  if(capaFondo){ mapa.removeLayer(capaFondo); capaFondo = null; }
  try{ localStorage.setItem('desvios_fondo_v2', String(i)); }catch(e){}
  const p = PROVEEDORES[i] || PROVEEDORES[0];
  if(p.wms) capaFondo = L.tileLayer.wms(p.url, p.opts);
  else if(p.u) capaFondo = L.tileLayer(p.u, {maxZoom:p.max, attribution:p.a});
  else return;
  capaFondo.addTo(mapa);
  if(capaFondo.bringToBack) capaFondo.bringToBack();
}

// control propio sobre el mapa, para no ocupar lugar en el panel
function armarSelectorFondo(){
  const ctl = L.control({position:'topleft'});
  ctl.onAdd = function(){
    const div = L.DomUtil.create('div', 'ctlFondo');
    let html = '<select id="selFondo" title="Mapa de fondo">';
    PROVEEDORES.forEach(function(p, i){ html += '<option value="' + i + '">' + p.n + '</option>'; });
    html += '</select><label><input type="checkbox" id="verCalles" checked> calles</label>';
    div.innerHTML = html;
    L.DomEvent.disableClickPropagation(div);
    return div;
  };
  ctl.addTo(mapa);
  const sel = document.getElementById('selFondo');
  sel.value = String(fondoGuardado());
  sel.onchange = function(){ ponerFondo(parseInt(sel.value, 10)); };
  const chk = document.getElementById('verCalles');
  try{ if(localStorage.getItem('desvios_calles') === '0'){ chk.checked = false; callesOn = false; } }catch(e){}
  chk.onchange = function(){
    callesOn = chk.checked;
    try{ localStorage.setItem('desvios_calles', callesOn ? '1' : '0'); }catch(e){}
    dibujarNombresCalles();
  };
  mapa.on('moveend zoomend', pedirDibujoCalles);
  dibujarNombresCalles();
}

/* ================= NOMBRES DE CALLES (datos propios, sin red) ================= */
let capaCalles = null, callesOn = true, tempCalles = null;

function pedirDibujoCalles(){
  clearTimeout(tempCalles);
  tempCalles = setTimeout(dibujarNombresCalles, 90);
}

let callesPedidas = false;
// Los nombres de calles pesan ~700 KB: se descargan recién cuando se necesitan
// (al acercarse), para que el visor abra liviano en el celular.
function asegurarCalles(){
  if(typeof CALLES !== 'undefined' || callesPedidas) return;
  callesPedidas = true;
  const s = document.createElement('script');
  s.src = 'datos/calles.js';
  s.onload = function(){ dibujarNombresCalles(); const q = $('calle'); if(q && q.value.trim()) buscarPorCalle(q.value); };
  s.onerror = function(){
    aviso('No se encontró datos/calles.js: los nombres de calles no se van a mostrar.', 'err');
  };
  document.head.appendChild(s);
}

function dibujarNombresCalles(){
  if(!callesOn){ if(capaCalles){ capaCalles.remove(); capaCalles = null; } return; }
  const z = mapa.getZoom();
  if(z >= 14) asegurarCalles();
  if(typeof CALLES === 'undefined') return;
  if(!capaCalles){ capaCalles = L.layerGroup().addTo(mapa); }
  capaCalles.clearLayers();
  if(z < 14) return;
  const minLargo = z >= 17 ? 0 : (z >= 16 ? 400 : (z >= 15 ? 1200 : 3000));
  const verFlechas = z >= 16;
  const b = mapa.getBounds().pad(0.08);
  const cand = [];
  for(const c of CALLES){
    if(c[4] < minLargo) continue;
    if(!b.contains([c[1], c[2]])) continue;
    cand.push(c);
    if(cand.length > 1500) break;
  }
  cand.sort(function(a, b2){ return b2[4] - a[4]; });
  const puestas = [];
  const MAX = 110, SEP = 240;
  for(const c of cand){
    const p = mapa.latLngToContainerPoint([c[1], c[2]]);
    const nom = CALLES_N[c[0]];
    const ancho = Math.max(28, nom.length * 5.4) + (verFlechas && c[5] != null ? 14 : 0);
    const radio = ancho / 2 + 5;
    let choca = false;
    for(const q of puestas){
      const dx = q.x - p.x, dy = q.y - p.y;
      if(q.nom === c[0]){ if(dx*dx + dy*dy < SEP*SEP){ choca = true; break; } }
      else if(Math.abs(dy) < 13 && Math.abs(dx) < q.radio + radio){ choca = true; break; }
    }
    if(choca) continue;
    puestas.push({x:p.x, y:p.y, radio:radio, nom:c[0]});
    const flecha = (verFlechas && c[5] != null)
      ? '<i style="transform:rotate(' + c[5] + 'deg)">\u2192</i>' : '';
    capaCalles.addLayer(L.marker([c[1], c[2]], {interactive:false, icon: L.divIcon({
      className:'etqCalle',
      html:'<span style="transform:rotate(' + c[3] + 'deg)">' + nom + flecha + '</span>',
      iconSize:[0,0]
    })}));
    if(puestas.length >= MAX) break;
  }
}

/* ================= MAPA ================= */
function iniciarMapa(){
  mapa = L.map('map', {preferCanvas:true, zoomControl:true}).setView([-34.87,-56.17], 12);
  ponerFondo(fondoGuardado());
  armarSelectorFondo();
  renderer = L.canvas({padding:.4});
  capaDesvios = L.layerGroup().addTo(mapa);
  capaEdicion = L.layerGroup().addTo(mapa);
  capaParadas = L.layerGroup();
  mapa.on('click', clicMapa);
}

/* ================= VISOR ================= */
async function cargarDesvios(){
  if(!sb) return;
  if(!sesion){
    desvios = [];
    $('lista').innerHTML = '<div class="vacio">Para ver los desvíos hay que ingresar con la cuenta de UPTU.<br><br>' +
      '<button class="chip primario" id="btnIngresar2">Ingresar</button></div>';
    const b = document.getElementById('btnIngresar2');
    if(b) b.onclick = abrirLogin;
    $('resumenTop').textContent = 'Acceso restringido';
    $('sello').textContent = '';
    capaDesvios.clearLayers();
    return;
  }
  try{
    let q = sb.from('desvios').select('*').order('actualizado_en', {ascending:false});
    if(!esEditor) q = q.eq('estado','activo');
    const { data, error } = await q;
    if(error) throw error;
    desvios = data || [];
    pintarLista();
    dibujarDesvios();
    $('sello').textContent = 'Actualizado ' + hace(new Date().toISOString());
  }catch(err){
    aviso('No se pudieron cargar los desvíos: ' + err.message, 'err');
  }
}

function activos(){ return desvios.filter(d => d.estado === 'activo'); }

/* ---------- BUSCADOR ----------
   Busca en lo que el personal pregunta por teléfono: línea, calle o cruce,
   código o nombre de parada (suspendida o provisoria), título, motivo,
   recorrido y observaciones. Varias palabras se combinan (todas deben
   aparecer): "151 menorca". Los números se comparan enteros, así "15" no
   trae el 151.                                                          */
const _pajar = new WeakMap();

function pajarDe(d){
  let p = _pajar.get(d);
  if(p) return p;
  const r = d.resumen || {};
  const partes = [];
  const ls = (d.lineas && d.lineas.length) ? d.lineas : [d.linea];
  ls.forEach(l => partes.push(l));
  [d.titulo, d.principal, d.entre, d.motivo, d.observaciones, d.recorrido_texto,
   textoRecorrido(d), d.estado].forEach(x => { if(x) partes.push(x); });
  const susp = (r.paradas_suspendidas || []).slice();
  (r.grupos || []).forEach(g => (g.paradas_suspendidas || []).forEach(x => susp.push(x)));
  susp.forEach(x => { if(x){ partes.push(x.cod, x.nombre); } });
  (d.paradas_suspendidas || []).forEach(c => partes.push(c));
  (d.paradas_provisorias || []).forEach(x => { if(x) partes.push(x.nombre, x.referencia); });
  p = sinAcentos(partes.filter(x => x != null && x !== '').join(' | '));
  _pajar.set(d, p);
  return p;
}

function coincide(d){
  const toks = sinAcentos(filtro).split(/\s+/).filter(Boolean);
  if(!toks.length) return true;
  const pajar = pajarDe(d);
  return toks.every(t => {
    if(/^\d+$/.test(t)) return new RegExp('(^|[^0-9])' + t + '([^0-9]|$)').test(pajar);
    return pajar.indexOf(t) >= 0;
  });
}

function baseLista(){ return esEditor ? desvios : activos(); }
function visibles(){ return baseLista().filter(coincide); }

function pintarAtajosLineas(){
  const cont = $('busqLineas');
  if(!cont) return;
  const set = new Set();
  activos().forEach(d => ((d.lineas && d.lineas.length) ? d.lineas : [d.linea]).forEach(l => { if(l) set.add(String(l)); }));
  const ls = Array.from(set).sort((a,b) => a.localeCompare(b, 'es', {numeric:true}));
  cont.innerHTML = '';
  ls.forEach(l => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'lchip' + (filtro.trim() === l ? ' on' : '');
    b.textContent = l;
    b.title = 'Ver los desvíos de la línea ' + l;
    b.onclick = () => ponerFiltro(filtro.trim() === l ? '' : l);
    cont.appendChild(b);
  });
}

function ponerFiltro(txt){
  filtro = txt || '';
  const inp = $('busq');
  if(inp.value !== filtro) inp.value = filtro;
  $('busqLimpiar').hidden = !filtro;
  aplicarFiltro(true);
}

function puntosDesvio(d){
  const pts = [];
  const rec = d.recorrido || [];
  const planos = (rec.length && Array.isArray(rec[0]) && Array.isArray(rec[0][0])) ? [].concat.apply([], rec) : rec;
  planos.forEach(p => pts.push(p));
  ((d.resumen && d.resumen.paradas_suspendidas) || []).forEach(p => pts.push([p.lat, p.lon]));
  (d.paradas_provisorias || []).forEach(p => pts.push([p.lat, p.lon]));
  return pts;
}

function aplicarFiltro(ajustarMapa){
  if(seleccionado && !visibles().some(d => d.id === seleccionado.id)) seleccionado = null;
  pintarLista();
  dibujarDesvios();
  if(ajustarMapa && filtro.trim() && modo !== 'editor'){
    const pts = [];
    visibles().forEach(d => puntosDesvio(d).forEach(p => pts.push(p)));
    if(pts.length) mapa.fitBounds(L.latLngBounds(pts), {padding:[40,40], maxZoom:17});
  }
}

function pintarLista(){
  const cont = $('lista');
  cont.innerHTML = '';
  pintarAtajosLineas();
  const base = baseLista();
  const lista = visibles();
  const nAct = activos().length;
  const textoAct = nAct + (nAct === 1 ? ' desvío activo' : ' desvíos activos');
  if(!base.length){
    cont.innerHTML = '<div class="vacio">No hay desvíos ' + (esEditor ? 'cargados' : 'activos en este momento') + '.</div>';
    $('resumenTop').textContent = esEditor ? 'Sin desvíos' : 'Sin desvíos activos';
    return;
  }
  if(!lista.length){
    cont.innerHTML = '<div class="vacio">Ningún desvío coincide con «<span id="vacioQ"></span>».<br>' +
      'Probá con el número de línea, el nombre de la calle o el código de la parada.<br>' +
      '<button class="chip primario" id="btnVerTodos">Ver todos</button></div>';
    $('vacioQ').textContent = filtro.trim();
    $('btnVerTodos').onclick = () => ponerFiltro('');
    $('resumenTop').textContent = '0 de ' + base.length + (base.length === 1 ? ' desvío' : ' desvíos');
    return;
  }
  $('resumenTop').textContent = filtro.trim()
    ? lista.length + ' de ' + base.length + (base.length === 1 ? ' desvío' : ' desvíos')
    : textoAct;
  for(const d of lista){
    const el = document.createElement('button');
    el.className = 'card' + (seleccionado && seleccionado.id === d.id ? ' sel' : '') + ' e-' + d.estado;
    const susp = (d.paradas_suspendidas || []).length;
    const prov = (d.paradas_provisorias || []).length;
    el.innerHTML =
      '<div class="ctop"><span class="lin"></span><span class="est"></span></div>' +
      '<div class="tit"></div>' +
      '<div class="meta"></div>' +
      '<div class="pie"></div>';
    const ls = (d.lineas && d.lineas.length) ? d.lineas : [d.linea];
    const chip = el.querySelector('.lin');
    chip.textContent = ls.length > 3
      ? ls.slice(0,3).join(' · ') + ' +' + (ls.length - 3)
      : ls.join(' · ');
    chip.title = (ls.length === 1 ? 'Línea afectada: ' : 'Líneas afectadas: ') + ls.join(', ');
    el.querySelector('.est').textContent = d.estado === 'activo' ? 'ACTIVO' : d.estado.toUpperCase();
    el.querySelector('.tit').textContent = d.titulo;
    el.querySelector('.meta').textContent =
      [d.motivo, susp ? susp + ' parada' + (susp===1?'':'s') + ' suspendida' + (susp===1?'':'s') : '',
       prov ? prov + ' provisoria' + (prov===1?'':'s') : ''].filter(Boolean).join(' · ');
    el.querySelector('.pie').textContent =
      (d.desde ? 'Desde ' + fechaCorta(d.desde) : '') +
      (d.hasta ? ' · hasta ' + fechaCorta(d.hasta) : '') +
      (d.actualizado_por ? '  |  ' + d.actualizado_por.split('@')[0] + ' · ' + hace(d.actualizado_en) : '');
    el.onclick = ()=> seleccionar(d);
    cont.appendChild(el);
  }
}

function seleccionar(d){
  seleccionado = d;
  pintarLista();
  dibujarDesvios();
  const pts = puntosDesvio(d);
  if(pts.length) mapa.fitBounds(L.latLngBounds(pts), {padding:[40,40]});
  if(window.innerWidth <= 820) $('map').scrollIntoView({behavior:'smooth', block:'nearest'});
}

function dibujarDesvios(){
  capaDesvios.clearLayers();
  if(modo === 'editor') return;   // editando: el mapa muestra solo la propuesta en curso
  const lista = visibles().filter(d => !seleccionado || d.id === seleccionado.id || d.estado === 'activo');
  for(const d of lista){
    const foco = seleccionado && seleccionado.id === d.id;
    const op = (!seleccionado || foco) ? 1 : .35;
    const origs = (d.resumen && d.resumen.recorridos_originales) ||
                  ((d.resumen && d.resumen.recorrido_original) ? [d.resumen.recorrido_original] : []);
    for(const orig of origs)
      if(orig.length > 1)
        capaDesvios.addLayer(L.polyline(orig, {color:'#4a5568', weight:4, opacity:.85*op, interactive:false}));
    // el recorrido puede ser una lista de puntos (un sentido) o una lista de
    // recorridos (uno por sentido, cuando las calles no coinciden)
    const rec = d.recorrido || [];
    const partesR = (rec.length && Array.isArray(rec[0]) && Array.isArray(rec[0][0])) ? rec : (rec.length ? [rec] : []);
    for(let k = 0; k < partesR.length; k++){
      if(partesR[k].length < 2) continue;
      capaDesvios.addLayer(L.polyline(partesR[k], {color: k === 0 ? '#c47f00' : '#1E6FA8',
        weight:5, opacity:op, dashArray:'10 7', interactive:false}));
    }
    for(const p of (d.resumen && d.resumen.paradas_suspendidas) || []){
      const m = L.circleMarker([p.lat, p.lon], {radius:6, color:'#B3403C', weight:2,
        fillColor:'#E8B4B2', fillOpacity:op, renderer});
      m.bindPopup('<b>Parada suspendida</b><br>' + esc(p.cod || '') + ' · ' + esc(p.nombre || ''));
      capaDesvios.addLayer(m);
    }
    for(const p of d.paradas_provisorias || []){
      const m = L.circleMarker([p.lat, p.lon], {radius:7, color:'#1E7A3C', weight:2,
        fillColor:'#7ED9A0', fillOpacity:op, renderer});
      m.bindPopup('<b>Parada provisoria</b><br>' + esc(p.nombre || 'sin descripción'));
      capaDesvios.addLayer(m);
    }
  }
}


/* ================= COMUNICACIÓN: TEXTO, PDF Y CORREO ================= */
let DESTINATARIOS = [];
async function cargarDestinatarios(){
  if(!sb || !esEditor) return;
  try{
    const { data } = await sb.from('destinatarios').select('email,nombre,activo');
    DESTINATARIOS = (data || []).filter(function(d){ return d.activo !== false; });
  }catch(err){ DESTINATARIOS = []; }
}

function fechaLarga(iso){
  if(!iso) return '';
  const d = new Date(iso);
  const dias = ['domingo','lunes','martes','miércoles','jueves','viernes','sábado'];
  return dias[d.getDay()] + ' ' + String(d.getDate()).padStart(2,'0') + '/' +
    String(d.getMonth()+1).padStart(2,'0') + '/' + d.getFullYear() + ' ' +
    String(d.getHours()).padStart(2,'0') + ':' + String(d.getMinutes()).padStart(2,'0');
}

function textoDesvio(d){
  const fmt = function(iso){
    if(!iso) return '';
    const f = new Date(iso);
    return String(f.getDate()).padStart(2,'0') + '/' + String(f.getMonth()+1).padStart(2,'0') +
      '/' + f.getFullYear() + ' ' + String(f.getHours()).padStart(2,'0') + ':' +
      String(f.getMinutes()).padStart(2,'0');
  };
  let fecha = d.desde ? fmt(d.desde) : 'a confirmar';
  if(d.hasta) fecha += ' a ' + fmt(d.hasta);
  else if(d.desde) fecha += ' — hasta nuevo aviso';
  const L = [];
  L.push('DESVÍO');
  L.push('');
  L.push('Principal: ' + (d.principal || ''));
  L.push('Entre: ' + (d.entre || ''));
  L.push('Fecha: ' + fecha);
  L.push('Motivo: ' + (d.motivo || ''));
  for(const b of bloquesComunicado(d)){
    if(b.rotulo) L.push('— ' + b.rotulo + ' —');
    L.push('Línea: ' + b.linea);
    L.push('Recorrido: ' + b.recorrido);
    L.push('Paradas Suspendidas: ' + b.suspendidas);
    L.push('Parada Provisoria: ' + b.provisorias);
  }
  L.push('Observaciones: ' + (d.observaciones || ''));
  L.push('');
  L.push('Saludos cordiales,');
  L.push('U. P. T. U.');
  return L.join('\n');
}


// "151, 195 (ambos sentidos)" o "151 (sentido a Portones)"
function textoLineasCon(ls, rec){
  const porLinea = {};
  for(const r of rec){
    if(!porLinea[r.linea]) porLinea[r.linea] = [];
    porLinea[r.linea].push(r);
  }
  let ambos = false, destinos = [];
  for(const k in porLinea){
    const s = {};
    for(const r of porLinea[k]) s[r.sentido] = r.destino;
    const claves = Object.keys(s);
    if(claves.length > 1) ambos = true;
    else destinos.push(s[claves[0]]);
  }
  if(!rec.length) return ls.join(', ');
  if(ambos) return ls.join(', ') + ' (ambos sentidos)';
  const unicos = destinos.filter(function(x,i,a2){ return x && a2.indexOf(x) === i; });
  if(unicos.length === 1) return ls.join(', ') + ' (sentido a ' + unicos[0] + ')';
  return ls.join(', ') + ' (un solo sentido)';
}

function textoLineas(d, ls){
  return textoLineasCon(ls, (d.resumen && d.resumen.recorridos) || []);
}

// El recorrido puede venir con un trazado por sentido
function textoRecorridoCon(t){
  if(!t) return '';
  if(t.A && t.B && t.A.texto && t.B.texto &&
     t.A.v && t.B.v && t.A.v.length > 1 && t.B.v.length > 1)
    return 'Ida: ' + t.A.texto + '   Vuelta: ' + t.B.texto;
  const cual = (t.A && t.A.v && t.A.v.length > 1) ? t.A : t.B;
  return (cual && cual.texto) || '';
}

function textoRecorrido(d){
  const t = (d.resumen && d.resumen.traz) || null;
  if(t) return textoRecorridoCon(t);
  return d.recorrido_texto || '';
}

// Arma, por grupo, los cuatro campos del comunicado (Línea, Recorrido,
// Paradas Suspendidas, Parada Provisoria). Con un solo grupo —el caso más
// común, y todo lo guardado antes de que existieran los grupos— da un único
// bloque, igual que siempre. Con varios, uno por grupo: cada línea muestra
// su propio recorrido y sus propias paradas.
function bloquesComunicado(d){
  const rg = (d.resumen && d.resumen.grupos) || null;
  if(rg && rg.length > 1){
    return rg.map(function(g, i){
      const ls = (g.lineas && g.lineas.length) ? g.lineas : [];
      const susp = g.paradas_suspendidas || [];
      const prov = g.provisorias || [];
      return {
        rotulo: 'Grupo ' + (i+1) + (ls.length ? ': ' + ls.join(', ') : ''),
        rotuloCorto: 'Grupo ' + (i+1),
        linea: textoLineasCon(ls, g.recorridos || []),
        recorrido: textoRecorridoCon(g.traz),
        suspendidas: susp.length
          ? susp.map(function(p){ return p.cod + ' ' + (p.nombre || ''); }).join(' / ')
          : 'No se suspenden paradas.',
        provisorias: prov.length
          ? prov.map(function(p){ return p.nombre || 'sin referencia'; }).join(' / ')
          : 'No se habilitan paradas provisorias.'
      };
    });
  }
  const ls = (d.lineas && d.lineas.length) ? d.lineas : [d.linea];
  const susp = (d.resumen && d.resumen.paradas_suspendidas) || [];
  const prov = d.paradas_provisorias || [];
  return [{
    rotulo: null,
    linea: textoLineas(d, ls),
    recorrido: textoRecorrido(d),
    suspendidas: susp.length
      ? susp.map(function(p){ return p.cod + ' ' + (p.nombre || ''); }).join(' / ')
      : 'No se suspenden paradas.',
    provisorias: prov.length
      ? prov.map(function(p){ return p.nombre || 'sin referencia'; }).join(' / ')
      : 'No se habilitan paradas provisorias.'
  }];
}

// Convierte un texto libre (p.ej. un nombre de calle) en algo apto para
// nombre de archivo: sin tildes, sin espacios ni símbolos.
function slugArchivo(s){
  return String(s || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

function nombrePDF(d){
  const calle = slugArchivo(d.principal);
  if(calle) return 'desvio-' + calle + '.pdf';
  const ls = (d.lineas && d.lineas.length) ? d.lineas : [d.linea];
  return 'desvio-lineas-' + ls.join('-') + '.pdf';
}

function generarPDF(d, devolver){
  if(!window.jspdf){ aviso('No se pudo cargar el generador de PDF', 'err'); return; }
  const doc = new window.jspdf.jsPDF({unit:'mm', format:'a4'});
  const M = 16, W = 210 - M*2, DER = 210 - M;
  const MESES = ['enero','febrero','marzo','abril','mayo','junio','julio',
                 'agosto','setiembre','octubre','noviembre','diciembre'];
  const gris = function(){ doc.setTextColor(90,90,90); };
  const negro = function(){ doc.setTextColor(0,0,0); };

  function encabezado(){
    doc.setDrawColor(0,0,0); doc.setLineWidth(0.4);
    // logo institucional
    if(typeof D_LOGO_IM !== 'undefined'){
      const alto = 11, ancho = alto * (typeof D_LOGO_PROP !== 'undefined' ? D_LOGO_PROP : 3.58);
      doc.addImage(D_LOGO_IM, 'PNG', M, 10, ancho, alto);
    }else{
      negro(); doc.setFont('helvetica','bold'); doc.setFontSize(10);
      doc.text('Intendencia de Montevideo', M, 18);
    }
    doc.setFont('helvetica','normal'); doc.setFontSize(8.5); gris();
    doc.text('www.montevideo.gub.uy', DER, 18, {align:'right'});
    negro();
    doc.line(M, 27, DER, 27);
    doc.setFont('helvetica','bold'); doc.setFontSize(9.5);
    doc.text('Departamento de Movilidad', M, 33);
    doc.text('DIVISIÓN TRANSPORTE', M, 37.6);
    doc.setFont('helvetica','normal'); doc.setFontSize(9);
    doc.text('Unidad De Programación del Transporte Urbano.', M, 42.2);
    doc.line(M, 45.5, DER, 45.5);
  }

  function pie(){
    doc.setLineWidth(0.4); doc.setDrawColor(0,0,0);
    doc.line(M, 276, DER, 276);
    doc.setFont('helvetica','normal'); doc.setFontSize(8); negro();
    doc.text('Edificio Anexo Soriano 1426. Piso 5 CP. 11200. Montevideo, Uruguay', M, 281);
    doc.text('Tel: (598 2 ) 1950 8702/8712   stc@imm.gub.uy', M, 285);
  }

  encabezado();

  const hoy = new Date(d.actualizado_en || Date.now());
  doc.setFont('helvetica','normal'); doc.setFontSize(10.5);
  doc.text('Montevideo, ' + hoy.getDate() + ' de ' + MESES[hoy.getMonth()] +
           ' de ' + hoy.getFullYear() + '.-', DER, 53, {align:'right'});

  // título
  doc.setLineWidth(0.4);
  doc.rect(M, 57, W, 8);
  doc.setFont('helvetica','bold'); doc.setFontSize(11);
  doc.text('DESVÍO', 105, 62.4, {align:'center'});
  const finTitulo = 65;

  // ---- tabla de items ----
  const fmt = function(iso){
    if(!iso) return '';
    const f = new Date(iso);
    return String(f.getDate()).padStart(2,'0') + '/' + String(f.getMonth()+1).padStart(2,'0') +
      '/' + f.getFullYear() + ' ' + String(f.getHours()).padStart(2,'0') + ':' +
      String(f.getMinutes()).padStart(2,'0');
  };
  let fecha = d.desde ? fmt(d.desde) : 'a confirmar';
  if(d.hasta) fecha += ' a ' + fmt(d.hasta);
  else if(d.desde) fecha += ' — hasta nuevo aviso';

  const items = [
    ['Principal', d.principal || ''],
    ['Entre', d.entre || ''],
    ['Fecha', fecha],
    ['Motivo', d.motivo || '']
  ];
  const bloques = bloquesComunicado(d);
  for(const b of bloques){
    const suf = b.rotuloCorto ? ' (' + b.rotuloCorto + ')' : '';
    items.push(['Línea' + suf, b.linea]);
    items.push(['Recorrido' + suf, b.recorrido]);
    items.push(['Paradas Suspendidas' + suf, b.suspendidas]);
    items.push(['Parada Provisoria' + suf, b.provisorias]);
  }
  items.push(['Observaciones', d.observaciones || '']);

  const X0 = M + 4, ANCHO = W - 8, COL = 52, PADX = 2.2, INTER = 4.6;
  let y = finTitulo + 4;
  const marcoY = y;
  doc.setLineWidth(0.3);
  doc.setFontSize(9.5);

  for(const it of items){
    doc.setFont('helvetica','normal');
    const lineas = doc.splitTextToSize(String(it[1]), ANCHO - COL - PADX*2);
    const alto = Math.max(9, lineas.length * INTER + 4);
    if(y + alto > 250){ pie(); doc.addPage(); encabezado(); y = 52; }
    doc.rect(X0, y, COL, alto);
    doc.rect(X0 + COL, y, ANCHO - COL, alto);
    doc.text(it[0], X0 + PADX, y + 5.8);
    let ty = y + 5.8;
    for(const t of lineas){ doc.text(t, X0 + COL + PADX, ty); ty += INTER; }
    y += alto;
  }

  // caja libre debajo de la tabla, como en el formulario
  const altoLibre = 26;
  doc.rect(X0, y, ANCHO, altoLibre);
  y += altoLibre;

  // marco exterior de todo el bloque
  doc.setLineWidth(0.4);
  doc.rect(M, marcoY - 3, W, (y - marcoY) + 6);
  y += 10;

  doc.setFont('helvetica','normal'); doc.setFontSize(10.5);
  doc.text('Saludos cordiales,', M + 4, y);
  y += 18;
  doc.setFont('helvetica','bold'); doc.setFontSize(22);
  doc.text('U. P. T. U.', 105, y, {align:'center'});

  pie();
  if(devolver) return doc.output('datauristring').split(',')[1];
  doc.save(nombrePDF(d));
  return true;
}

function enviarPorCorreo(d){
  if(!DESTINATARIOS.length){
    aviso('No hay casillas cargadas. Agregalas en la tabla destinatarios de Supabase.', 'err');
    return;
  }
  elegirCasillas(d);
}

function abrirCliente(d, para){
  const ls = (d.lineas && d.lineas.length) ? d.lineas : [d.linea];
  const asunto = 'Desvío ' + (ls.length === 1 ? 'línea ' : 'líneas ') + ls.join(', ') + ' — ' + (d.titulo || '');
  const cuerpo = textoDesvio(d);
  const url = 'mailto:' + encodeURIComponent(para.join(',')) +
    '?subject=' + encodeURIComponent(asunto) + '&body=' + encodeURIComponent(cuerpo);
  if(url.length > 1900){
    if(navigator.clipboard) navigator.clipboard.writeText(cuerpo);
    aviso('El texto es largo: quedó copiado al portapapeles para pegarlo en el correo.', 'ok');
    window.open('mailto:' + encodeURIComponent(para.join(',')) + '?subject=' + encodeURIComponent(asunto), '_blank');
    return;
  }
  window.location.href = url;
}

// Lista de casillas con tilde, para elegir a quiénes se comunica este desvío.
function elegirCasillas(d){
  const cont = $('envioLista');
  cont.innerHTML = '';
  for(const dest of DESTINATARIOS){
    const id = 'dest_' + dest.email.replace(/[^a-z0-9]/gi, '');
    const fila = document.createElement('label');
    fila.className = 'tgl';
    fila.innerHTML = '<input type="checkbox" checked><span></span>';
    fila.querySelector('input').value = dest.email;
    fila.querySelector('input').id = id;
    fila.querySelector('span').textContent = (dest.nombre ? dest.nombre + ' — ' : '') + dest.email;
    cont.appendChild(fila);
  }
  $('envioTitulo').textContent = 'Enviar comunicación';
  $('envioNota').textContent = (ENVIO_URL && ENVIO_CLAVE)
    ? 'Se envía el texto del desvío con el PDF adjunto. Elegí a qué casillas:'
    : 'Se abrirá tu correo con el texto y las casillas ya cargadas, para que lo revises y lo envíes. El PDF se adjunta a mano (botón PDF). Elegí a qué casillas:';
  $('envio').classList.add('on');
  $('envio').dataset.desvio = d.id || '';
  window.__envioDesvio = d;
}

async function confirmarEnvio(){
  const d = window.__envioDesvio;
  if(!d) return;
  const para = Array.prototype.slice.call($('envioLista').querySelectorAll('input:checked'))
    .map(function(i){ return i.value; });
  if(!para.length){ aviso('Elegí al menos una casilla', 'err'); return; }
  $('envio').classList.remove('on');

  // Sin envío automático configurado: se abre el correo con todo cargado.
  if(!ENVIO_URL || !ENVIO_CLAVE){
    abrirCliente(d, para);
    aviso('Se abrió el correo con el texto y las casillas. Acordate de adjuntar el PDF con el botón de al lado.', 'ok');
    return;
  }

  const ls = (d.lineas && d.lineas.length) ? d.lineas : [d.linea];
  const asunto = 'Desvío ' + (ls.length === 1 ? 'línea ' : 'líneas ') + ls.join(', ') + ' — ' + (d.titulo || '');
  const cuerpo = textoDesvio(d);

  const btn = $('btnCorreo');
  btn.disabled = true; btn.textContent = 'Enviando…';
  const pdf = generarPDF(d, true);
  const cuerpoPedido = JSON.stringify({clave: ENVIO_CLAVE, para: para, asunto: asunto,
    cuerpo: cuerpo, pdf: pdf, nombrePdf: nombrePDF(d), quien: (sesion && sesion.user.email) || ''});

  try{
    const r = await fetch(ENVIO_URL, {
      method: 'POST',
      headers: {'Content-Type': 'text/plain;charset=utf-8'},
      body: cuerpoPedido
    });
    const j = await r.json();
    if(j.ok) aviso('Comunicación enviada a ' + j.enviados + (j.enviados === 1 ? ' casilla' : ' casillas'), 'ok');
    else aviso('No se pudo enviar: ' + (j.error || 'error desconocido'), 'err');
  }catch(err){
    // Google no permite al navegador leer su respuesta: se reenvía sin esperarla.
    try{
      await fetch(ENVIO_URL, {
        method: 'POST', mode: 'no-cors',
        headers: {'Content-Type': 'text/plain;charset=utf-8'},
        body: cuerpoPedido
      });
      aviso('Comunicación enviada a ' + para.length + (para.length === 1 ? ' casilla' : ' casillas') +
        '. Si querés verificar el envío, está registrado en la planilla del Drive.', 'ok');
    }catch(err2){
      aviso('No se pudo enviar: ' + err2.message, 'err');
    }
  }
  btn.disabled = false; btn.textContent = 'Correo';
}

function copiarTexto(d){
  const t = textoDesvio(d);
  if(navigator.clipboard && navigator.clipboard.writeText){
    navigator.clipboard.writeText(t);
    aviso('Texto del desvío copiado', 'ok');
  }else{
    const ta = document.createElement('textarea');
    ta.value = t; document.body.appendChild(ta); ta.select();
    document.execCommand('copy'); ta.remove();
    aviso('Texto del desvío copiado', 'ok');
  }
}

/* ================= SESIÓN ================= */
async function entrar(){
  const email = $('email').value.trim();
  const pass  = $('pass').value;
  if(!email || !pass){ aviso('Completá correo y contraseña', 'err'); return; }
  $('btnEntrar').disabled = true;
  try{
    const { data, error } = await sb.auth.signInWithPassword({email, password: pass});
    if(error) throw error;
    sesion = data.session;
    await verificarEditor();
    cerrarLogin();
    aviso(esEditor ? 'Sesión iniciada' : 'Sesión iniciada (solo consulta)', 'ok');
    document.body.classList.add('conSesion');
    if(!esEditor) $('quien').textContent = sesion.user.email.split('@')[0];
    await cargarDesvios();
  }catch(err){
    aviso('No se pudo ingresar: ' + err.message, 'err');
  }
  $('btnEntrar').disabled = false;
}

async function verificarEditor(){
  esEditor = false;
  if(!sesion) return;
  try{
    const { data } = await sb.from('editores').select('email,nombre,rol')
      .ilike('email', sesion.user.email).maybeSingle();
    esEditor = !!data;
    if(esEditor){
      $('quien').textContent = (data.nombre || sesion.user.email.split('@')[0]);
      document.body.classList.add('editor');
      cargarDestinatarios();
    }
  }catch(err){ esEditor = false; }
}

async function salir(){
  await sb.auth.signOut();
  sesion = null; esEditor = false; ed = null;
  document.body.classList.remove('editor');
  document.body.classList.remove('conSesion');
  $('quien').textContent = '';
  cerrarEditor();
  await cargarDesvios();
  aviso('Sesión cerrada');
}

function abrirLogin(){ $('login').classList.add('on'); }
function cerrarLogin(){ $('login').classList.remove('on'); $('pass').value = ''; }

/* ================= DATOS BASE (solo editores) ================= */
function cargarBase(){
  return new Promise((resolve, reject)=>{
    if(baseCargada) return resolve();
    if(window.D_PARADAS && window.D_VARS && window.D_SHAPES){ baseCargada = true; return resolve(); }
    aviso('Cargando líneas y paradas…');
    let faltan = 3;
    const listo = ()=>{ if(--faltan === 0){ baseCargada = true; aviso(''); resolve(); } };
    for(const f of ['paradas.js','lineas.js','shapes.js']){
      const s = document.createElement('script');
      s.src = 'datos/' + f;
      s.onload = listo;
      s.onerror = ()=> reject(new Error('no se pudo cargar datos/' + f));
      document.head.appendChild(s);
    }
  });
}

function coordParada(cod){
  if(!window.__COORD){
    window.__COORD = new Map();
    window.__NOM = new Map();
    for(const p of (window.D_PARADAS || [])){ window.__COORD.set(p[0], [p[2], p[3]]); window.__NOM.set(p[0], p[1]); }
  }
  return window.__COORD.get(cod);
}
function nombreParada(cod){ coordParada(cod); return (window.__NOM && window.__NOM.get(cod)) || ''; }

function decodePolyline(str){
  let idx=0, lat=0, lon=0; const pts=[];
  while(idx < str.length){
    for(const w of [0,1]){
      let shift=0, result=0, b;
      do{ b = str.charCodeAt(idx++) - 63; result |= (b & 0x1f) << shift; shift += 5; }while(b >= 0x20);
      const d = (result & 1) ? ~(result >> 1) : (result >> 1);
      w === 0 ? lat += d : lon += d;
    }
    pts.push([lat/1e5, lon/1e5]);
  }
  return pts;
}


/* ================= BUSCAR LÍNEAS POR CALLE ================= */
let PARADAS_POR_LINEA = null;
function indiceLineas(){
  if(!PARADAS_POR_LINEA){
    PARADAS_POR_LINEA = new Map();          // código de parada -> Set de líneas
    for(const v of (window.D_VARS || [])){
      for(const c of v[9]){
        let s = PARADAS_POR_LINEA.get(c);
        if(!s){ s = new Set(); PARADAS_POR_LINEA.set(c, s); }
        s.add(v[0]);
      }
    }
  }
  return PARADAS_POR_LINEA;
}

const sinAcentos = s => String(s||'').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'');

// Un desvío puede tener un recorrido distinto por sentido: con calles de
// sentido único, la ida y la vuelta van por calles diferentes.
function trazVacio(){ return {A:{v:[], calles:[], texto:''}, B:{v:[], calles:[], texto:''}}; }

function trazDesde(d){
  const t = trazVacio();
  const r = (d.resumen && d.resumen.traz) || null;
  if(r){
    for(const s of ['A','B']) if(r[s]){
      t[s].v = (r[s].v || []).slice();
      t[s].calles = (r[s].calles || []).slice();
      t[s].texto = r[s].texto || '';
    }
    return t;
  }
  // desvíos guardados antes de esta función: un solo trazado
  const s = (d.sentido === 'B') ? 'B' : 'A';
  t[s].v = ((d.resumen && d.resumen.vertices) || d.recorrido || []).slice();
  t[s].calles = ((d.resumen && d.resumen.calles) || []).slice();
  t[s].texto = d.recorrido_texto || '';
  return t;
}

// Un desvío puede necesitar más de un trazado: cuando distintas líneas
// del mismo desvío van por recorridos diferentes. Cada grupo tiene sus
// propias líneas, su propio trazado (por sentido) y sus propias paradas.
function crearGrupo(){
  return { vars: [], sentidoFiltro: 'ambos', dibujando: 'A',
    traz: trazVacio(), suspendidas: [], provisorias: [] };
}

function gAct(){ return (ed && ed.grupos) ? ed.grupos[ed.grupoActivo] : null; }

function etiquetaGrupo(g, i){
  const ls = g.vars.map(function(v){ return v[0]; })
    .filter(function(x,j,arr){ return arr.indexOf(x) === j; });
  return 'Grupo ' + (i+1) + (ls.length ? ' — ' + ls.join(', ') : ' (sin líneas todavía)');
}

function pintarGrupos(){
  const sel = $('grupoSel');
  if(!sel || !ed) return;
  sel.innerHTML = '';
  ed.grupos.forEach(function(g, i){
    const o = document.createElement('option');
    o.value = String(i);
    o.textContent = etiquetaGrupo(g, i);
    sel.appendChild(o);
  });
  const oNuevo = document.createElement('option');
  oNuevo.value = 'nuevo';
  oNuevo.textContent = '+ Nuevo grupo (otro recorrido)';
  sel.appendChild(oNuevo);
  sel.value = String(ed.grupoActivo);
  const cont = $('grupoSelCont');
  if(cont) cont.style.display = ed.grupos.length > 1 ? 'block' : 'none';
}

function cambiarGrupo(v){
  if(!ed) return;
  if(v === 'nuevo'){
    ed.grupos.push(crearGrupo());
    ed.grupoActivo = ed.grupos.length - 1;
  }else{
    ed.grupoActivo = parseInt(v, 10) || 0;
  }
  $('calle').value = ''; $('resCalle').innerHTML = '';
  pintarGrupos(); pintarElegidos(); pintarDibujando(); dibujarEdicion();
  if(herramienta === 'suspender') dibujarParadasLinea();
}

// Mueve una línea del grupo activo a otro (o a uno nuevo), sin tocar el
// trazado de ninguno de los dos: el trazado pertenece al grupo, no a la línea.
function moverLineaAGrupo(cod, destino){
  if(!ed) return;
  const g = gAct();
  const idx = g.vars.findIndex(function(v){ return v[6] === cod; });
  if(idx < 0) return;
  const v = g.vars.splice(idx, 1)[0];
  let gd;
  if(destino === 'nuevo'){
    gd = crearGrupo();
    ed.grupos.push(gd);
  }else{
    gd = ed.grupos[parseInt(destino, 10)];
  }
  gd.vars.push(v);
  ed.grupoActivo = ed.grupos.indexOf(gd);
  pintarGrupos(); pintarElegidos(); pintarDibujando(); dibujarEdicion();
  if(herramienta === 'suspender') dibujarParadasLinea();
}

// sentidos que tienen trazado propio, del grupo activo (u otro si se pasa)
function sentidosConTrazado(g){
  g = g || gAct();
  const out = [];
  if(g){ for(const s of ['A','B']) if(g.traz[s].v.length > 1) out.push(s); }
  return out;
}

function nombreSentido(s){ return s === 'B' ? 'vuelta' : 'ida'; }

// el sentido que se está dibujando ahora, del grupo activo
function trazActual(){
  const g = gAct();
  return g ? (g.traz[g.dibujando] || g.traz.A) : trazVacio().A;
}

// Devuelve la traza de una variante como una o varias polilíneas.
// En los recorridos sin trazado oficial los puntos son las paradas: si dos
// quedan a más de 800 m, el tramo recto entre ellas no representa nada real
// (hay casos de 10 km cruzando la ciudad), así que se corta ahí.
function trazaDe(v){
  const oficial = !!(v[8] && window.D_SHAPES && window.D_SHAPES[v[6]]);
  const pts = oficial ? decodePolyline(window.D_SHAPES[v[6]])
                      : v[9].map(coordParada).filter(Boolean);
  if(oficial) return {oficial:true, partes: pts.length > 1 ? [pts] : []};
  const partes = [];
  let actual = [];
  for(let i = 0; i < pts.length; i++){
    if(!actual.length){ actual.push(pts[i]); continue; }
    const a = actual[actual.length-1], b = pts[i];
    const dx = (b[1]-a[1])*KX, dy = (b[0]-a[0])*KY;
    if(dx*dx + dy*dy > 800*800){
      if(actual.length > 1) partes.push(actual);
      actual = [b];
    }else actual.push(b);
  }
  if(actual.length > 1) partes.push(actual);
  return {oficial:false, partes: partes};
}

// ---------- índice de recorridos: qué líneas circulan por cada punto ----------
let REJILLA = null, TRAZAS = null;
const CELDA = 0.0012;        // ~130 m
const RADIO = 45;            // metros: media calzada más el error del trazado

function indiceRecorridos(){
  if(REJILLA) return REJILLA;
  REJILLA = new Map();
  TRAZAS = [];
  for(let vi = 0; vi < (window.D_VARS || []).length; vi++){
    const v = D_VARS[vi];
    const t = trazaDe(v);
    const pts = [];
    for(const parte of t.partes){ for(const p of parte) pts.push(p); }
    TRAZAS.push(t.partes);
    const marcar = function(la, lo){
      const k = Math.round(la/CELDA) + '|' + Math.round(lo/CELDA);
      let s = REJILLA.get(k);
      if(!s){ s = new Set(); REJILLA.set(k, s); }
      s.add(vi);
    };
    for(const parte of t.partes) for(let i = 0; i < parte.length; i++){
      const p = parte[i], q = parte[i+1];
      marcar(p[0], p[1]);
      if(!q) continue;
      // se marcan también las celdas intermedias: en los recorridos sin trazado
      // oficial los puntos son las paradas y quedan lejos entre sí
      const dx = (q[1]-p[1])*KX, dy = (q[0]-p[0])*KY;
      const pasos = Math.min(40, Math.floor(Math.sqrt(dx*dx + dy*dy)/60));
      for(let k = 1; k <= pasos; k++)
        marcar(p[0] + (q[0]-p[0])*k/pasos, p[1] + (q[1]-p[1])*k/pasos);
    }
  }
  return REJILLA;
}

// distancia de un punto al tramo entre a y b, en metros al cuadrado
function distTramo(lat, lon, a, b){
  const px = (lon-a[1])*KX, py = (lat-a[0])*KY;
  const vx = (b[1]-a[1])*KX, vy = (b[0]-a[0])*KY;
  const L2 = vx*vx + vy*vy;
  let t = L2 ? (px*vx + py*vy)/L2 : 0;
  t = t < 0 ? 0 : (t > 1 ? 1 : t);
  const dx = px - vx*t, dy = py - vy*t;
  return dx*dx + dy*dy;
}

function pasaPor(vi, lat, lon, radio){
  const partes = TRAZAS[vi], r2 = radio*radio;
  if(!partes || !partes.length) return false;
  for(const pts of partes)
    for(let i = 0; i < pts.length-1; i++)
      if(distTramo(lat, lon, pts[i], pts[i+1]) <= r2) return true;
  return false;
}

// Variantes que realmente circulan por un punto
function variantesCerca(lat, lon, radio){
  const g = indiceRecorridos();
  const r = radio || RADIO;
  const kx = Math.round(lat/CELDA), ky = Math.round(lon/CELDA);
  const cand = new Set();
  for(let i = -1; i <= 1; i++) for(let j = -1; j <= 1; j++){
    const s = g.get((kx+i) + '|' + (ky+j));
    if(s) for(const vi of s) cand.add(vi);
  }
  const out = new Set();
  for(const vi of cand) if(pasaPor(vi, lat, lon, r)) out.add(vi);
  return out;
}

const sinAcentos2 = sinAcentos;

// ---------- búsqueda por cruce o por calle ----------
let CRUCE_ELEGIDO = null;

function buscarPorCalle(txt){
  const cont = $('resCalle');
  cont.innerHTML = '';
  const crudo = sinAcentos(txt).trim();
  if(crudo.length < 3){ resaltarParadasCalle([]); CRUCE_ELEGIDO = null; return; }
  if(typeof CRUCES === 'undefined'){
    asegurarCalles();
    cont.innerHTML = '<div class="nada">Cargando el callejero…</div>';
    return;
  }
  const partes = crudo.split(/\s+y\s+|\s+esq\.?\s+|\s*[\/,&]\s*/).map(function(s){ return s.trim(); })
    .filter(function(s){ return s.length >= 3; });
  if(!partes.length){ resaltarParadasCalle([]); return; }

  // nombres de calle que coinciden con cada término
  const coincide = partes.map(function(t){
    const s = new Set();
    for(let i = 0; i < CALLES_N.length; i++) if(sinAcentos(CALLES_N[i]).indexOf(t) >= 0) s.add(i);
    return s;
  });
  if(coincide.some(function(s){ return !s.size; })){
    cont.innerHTML = '<div class="nada">No hay ninguna calle con ese nombre</div>';
    resaltarParadasCalle([]);
    return;
  }

  let puntos = [];      // dónde buscar líneas
  let etiqueta = '';
  let otros = 0;

  if(partes.length > 1){
    // cruces donde estén todas las calles nombradas
    const cand = [];
    for(const c of CRUCES){
      const ids = c.slice(2);
      let ok = true;
      for(const s of coincide){
        let hay = false;
        for(const id of ids) if(s.has(id)){ hay = true; break; }
        if(!hay){ ok = false; break; }
      }
      if(ok) cand.push(c);
    }
    if(!cand.length){
      cont.innerHTML = '<div class="nada">Esas calles no se cruzan. Probá con una sola calle.</div>';
      resaltarParadasCalle([]);
      return;
    }
    // agrupar los nodos del mismo cruce y quedarse con el de más líneas
    const grupos = [];
    for(const c of cand){
      let puesto = false;
      for(const g of grupos){
        const dx = (c[1]-g.lon)*KX, dy = (c[0]-g.lat)*KY;
        if(dx*dx + dy*dy <= 250*250){ g.n++; puesto = true; break; }
      }
      if(!puesto) grupos.push({lat:c[0], lon:c[1], n:1});
    }
    for(const g of grupos){
      const vs = variantesCerca(g.lat, g.lon);
      const ls = new Set();
      for(const vi of vs) ls.add(D_VARS[vi][0]);
      g.lineas = ls.size;
      g.enMontevideo = paradaMasCerca(g.lat, g.lon, 900);
    }
    grupos.sort(function(x, y){
      return ((y.enMontevideo?1:0) - (x.enMontevideo?1:0)) || (y.lineas - x.lineas);
    });
    const elegido = grupos[0];
    CRUCE_ELEGIDO = elegido;
    puntos = [[elegido.lat, elegido.lon]];
    otros = grupos.length - 1;
    etiqueta = 'cruce';
  }else{
    // calle entera: todos los puntos de su traza
    const ids = coincide[0];
    for(const c of CALLES) if(ids.has(c[0])) puntos.push([c[1], c[2]]);
    CRUCE_ELEGIDO = null;
    etiqueta = 'calle';
    // si la calle tiene tramos en zonas muy separadas, se queda el grupo mayor
    puntos = grupoPrincipal(puntos);
  }

  // líneas que circulan por esos puntos
  const conteo = new Map();
  for(const pt of puntos){
    for(const vi of variantesCerca(pt[0], pt[1])){
      const v = D_VARS[vi];
      let e = conteo.get(v[0]);
      if(!e){ e = {n:0, vars:new Set()}; conteo.set(v[0], e); }
      e.n++; e.vars.add(vi);
    }
  }
  // En una calle entera, las líneas que solo la cruzan tocan un punto suelto.
  // Se piden al menos dos puntos de la traza para considerar que circulan por ella.
  if(!CRUCE_ELEGIDO && puntos.length >= 4){
    const filtrado = new Map();
    conteo.forEach(function(e, l){ if(e.n >= 2) filtrado.set(l, e); });
    if(filtrado.size){ conteo.clear(); filtrado.forEach(function(e, l){ conteo.set(l, e); }); }
  }
  if(!conteo.size){
    cont.innerHTML = '<div class="nada">No circula ninguna línea por ahí</div>';
    resaltarParadasCalle([]);
    return;
  }

  const orden = Array.from(conteo.entries()).sort(function(a2, b2){
    if(b2[1].n !== a2[1].n) return b2[1].n - a2[1].n;
    const na = parseInt(a2[0],10), nb = parseInt(b2[0],10);
    if(Number.isFinite(na) && Number.isFinite(nb)) return na - nb;
    return a2[0] < b2[0] ? -1 : 1;
  });

  if(orden.length > 1){
    const acc = document.createElement('div');
    acc.className = 'accCalle';
    const bTodas = document.createElement('button');
    bTodas.className = 'mini';
    bTodas.textContent = 'Todas se desvían (' + orden.length + ')';
    bTodas.onclick = function(){
      for(const par of orden) if(!lineaElegida(par[0])) alternarLinea(par[0], par[1].vars);
      buscarPorCalle($('calle').value);
    };
    acc.appendChild(bTodas);
    if(orden.some(function(par){ return lineaElegida(par[0]); })){
      const bNada = document.createElement('button');
      bNada.className = 'mini';
      bNada.textContent = 'Quitar todas';
      bNada.onclick = function(){
        for(const par of orden) if(lineaElegida(par[0])) alternarLinea(par[0], par[1].vars);
        buscarPorCalle($('calle').value);
      };
      acc.appendChild(bNada);
    }
    cont.appendChild(acc);
  }

  const cab = document.createElement('div');
  cab.className = 'nada';
  cab.textContent = orden.length + (orden.length === 1 ? ' línea circula' : ' líneas circulan') +
    ' por ' + (etiqueta === 'cruce' ? 'ese cruce' : 'esa calle') +
    (otros ? ' · hay ' + otros + ' cruce' + (otros===1?'':'s') + ' más con esos nombres' : '') +
    ' · tocá las que se desvían';
  cont.appendChild(cab);

  for(const par of orden.slice(0, 80)){
    const linea = par[0], info = par[1];
    const b = document.createElement('button');
    b.className = 'lchip' + (lineaElegida(linea) ? ' on' : '');
    b.innerHTML = '<b></b>';
    b.querySelector('b').textContent = linea;
    b.title = 'Línea ' + linea + ' — tocar para sumarla al desvío';
    b.onclick = (function(l, vars){ return function(){
      alternarLinea(l, vars);
      buscarPorCalle($('calle').value);
    }; })(linea, info.vars);
    cont.appendChild(b);
  }

  marcarPuntos(puntos);
}

// agrupa puntos encadenando los que están a menos de 5 km y devuelve el grupo mayor
// Agrupa los puntos de traza por cercanía, para separar calles homónimas
// lejanas entre sí (o, dentro de la misma Montevideo, dos calles distintas
// que comparten una palabra en el nombre — p. ej. "Dr. Joaquín de Salterain"
// y "Eduardo Salterain y Herrera").
function agruparPorCercania(pts){
  if(pts.length < 3) return [pts];
  const n = pts.length, g = new Array(n).fill(-1);
  let c = 0;
  for(let i = 0; i < n; i++){
    if(g[i] >= 0) continue;
    const gi = c++;
    g[i] = gi;
    const cola = [i];
    while(cola.length){
      const k = cola.pop();
      for(let j = 0; j < n; j++){
        if(g[j] >= 0) continue;
        const dx = (pts[k][1]-pts[j][1])*KX, dy = (pts[k][0]-pts[j][0])*KY;
        if(dx*dx + dy*dy <= 5000*5000){ g[j] = gi; cola.push(j); }
      }
    }
  }
  const grupos = [];
  for(let i = 0; i < c; i++) grupos.push([]);
  for(let i = 0; i < n; i++) grupos[g[i]].push(pts[i]);
  grupos.sort(function(a, b){ return b.length - a.length; });
  return grupos;
}

// Cuántas líneas circulan "de verdad" por un conjunto de puntos: exige que
// aparezcan cerca de al menos dos de ellos cuando hay puntos suficientes
// como para que eso distinga circular de solo cruzar (mismo criterio que
// se usa para la calle entera más abajo).
function contarLineasDe(pts){
  const conteo = new Map();
  for(const p of pts) for(const vi of variantesCerca(p[0], p[1])){
    const l = D_VARS[vi][0];
    conteo.set(l, (conteo.get(l) || 0) + 1);
  }
  const minimo = pts.length >= 4 ? 2 : 1;
  let n2 = 0;
  conteo.forEach(function(cant){ if(cant >= minimo) n2++; });
  return n2;
}

// Se queda con el grupo por el que de verdad circulan líneas, no con el que
// tiene más tramos: una calle puede tener muchos tramos digitalizados y
// ninguna línea, y ese no es el resultado que le sirve a quien busca.
function grupoPrincipal(pts){
  const grupos = agruparPorCercania(pts);
  if(grupos.length === 1) return grupos[0];
  let mejor = grupos[0], mejorN = contarLineasDe(grupos[0]);
  for(let i = 1; i < grupos.length; i++){
    const n2 = contarLineasDe(grupos[i]);
    if(n2 > mejorN){ mejor = grupos[i]; mejorN = n2; }
  }
  return mejor;
}

function paradaMasCerca(lat, lon, radio){
  for(const p of (window.D_PARADAS || [])){
    if(!p[5]) continue;                       // solo las de la capital
    const dx = (p[3]-lon)*KX, dy = (p[2]-lat)*KY;
    if(dx*dx + dy*dy <= radio*radio) return true;
  }
  return false;
}

function lineaElegida(linea){
  const g = gAct();
  return !!(g && g.vars.some(function(v){ return v[0] === linea; }));
}

// Al tocar una línea se suman sus recorridos que realmente pasan por esas paradas,
// dentro del grupo activo.
function alternarLinea(linea, vars){
  const g = gAct();
  if(!g) return;
  if(lineaElegida(linea)){
    g.vars = g.vars.filter(function(v){ return v[0] !== linea; });
    pintarElegidos(); dibujarEdicion();
    return;
  }
  let cand = [];
  if(vars && vars.size){
    for(const vi of vars) if(D_VARS[vi][0] === linea) cand.push(D_VARS[vi]);
  }
  if(!cand.length) cand = (window.D_VARS || []).filter(function(v){ return v[0] === linea && v[5] === 1; });
  // se prefiere el recorrido máximo de cada sentido
  const porSentido = {};
  for(const v of cand){
    const s = v[4] || 'A';
    if(!porSentido[s] || (v[5] && !porSentido[s][5])) porSentido[s] = v;
  }
  let nuevos = Object.keys(porSentido).map(function(k){ return porSentido[k]; });
  if(g.sentidoFiltro === 'A' || g.sentidoFiltro === 'B')
    nuevos = nuevos.filter(function(v){ return (v[4] || 'A') === g.sentidoFiltro; });
  if(!nuevos.length){ aviso('La línea ' + linea + ' no tiene recorridos por ahí', 'err'); return; }
  for(const v of nuevos) g.vars.push(v);
  pintarElegidos(); dibujarEdicion();
  if(herramienta === 'suspender') dibujarParadasLinea();
}

function quitarVariante(cod){
  const g = gAct();
  if(!g) return;
  g.vars = g.vars.filter(function(v){ return v[6] !== cod; });
  pintarElegidos(); dibujarEdicion();
  if(herramienta === 'suspender') dibujarParadasLinea();
  buscarPorCalle($('calle').value);
}

// Barra para elegir qué sentido se está trazando, dentro del grupo activo
function pintarDibujando(){
  const cont = $('dibujandoSel');
  const g = gAct();
  if(!cont || !g) return;
  const dos = (g.sentidoFiltro === 'ambos');
  cont.style.display = dos ? 'flex' : 'none';
  cont.innerHTML = '';
  if(dos){
    for(const s of ['A','B']){
      const b = document.createElement('button');
      b.className = 'chip';
      const n = g.traz[s].v.length;
      b.textContent = (s === 'A' ? 'Ida' : 'Vuelta') + (n ? ' (' + n + ')' : '');
      b.setAttribute('aria-pressed', String(g.dibujando === s));
      b.onclick = (function(x){ return function(){ cambiarDibujando(x); }; })(s);
      cont.appendChild(b);
    }
  }else if(g.sentidoFiltro === 'A' || g.sentidoFiltro === 'B'){
    g.dibujando = g.sentidoFiltro;
  }
  const t = trazActual();
  const campo = $('edRecorrido');
  if(campo){
    campo.value = t.texto || '';
    campo.dataset.tocado = t.tocado ? '1' : '0';
    campo.placeholder = 'Calles del recorrido de ' + nombreSentido(g.dibujando);
  }
  const ay = $('edAyudaSentido');
  if(ay) ay.textContent = dos
    ? 'Estás trazando el recorrido de ' + nombreSentido(g.dibujando) +
      '. Cambiá de sentido para trazar el otro: con calles de sentido único no coinciden.'
    : '';
}

function cambiarDibujando(s){
  const g = gAct();
  if(!g) return;
  // se guarda lo escrito en el sentido que se deja
  const campo = $('edRecorrido');
  if(campo){
    trazActual().texto = campo.value.trim();
    trazActual().tocado = campo.dataset.tocado === '1';
  }
  g.dibujando = s;
  pintarDibujando();
  dibujarEdicion();
}

function cambiarSentido(s){
  const g = gAct();
  if(!g) return;
  g.sentidoFiltro = s;
  if(s === 'A' || s === 'B'){
    g.vars = g.vars.filter(function(v){ return (v[4] || 'A') === s; });
    g.dibujando = s;
  }
  pintarElegidos(); pintarDibujando(); dibujarEdicion();
  if(herramienta === 'suspender') dibujarParadasLinea();
  if($('calle').value.trim()) buscarPorCalle($('calle').value);
}

function pintarSentido(){
  const cont = $('sentidoSel');
  const g = gAct();
  if(!cont || !g) return;
  cont.innerHTML = '';
  const ops = [['ambos','Ambos sentidos'], ['A','Solo ida'], ['B','Solo vuelta']];
  for(const o of ops){
    const b = document.createElement('button');
    b.className = 'chip';
    b.textContent = o[1];
    b.setAttribute('aria-pressed', String(g.sentidoFiltro === o[0]));
    b.onclick = (function(s){ return function(){ cambiarSentido(s); }; })(o[0]);
    cont.appendChild(b);
  }
}

function pintarElegidos(){
  const cont = $('elegidos');
  const g = gAct();
  if(!cont) return;
  pintarSentido();
  cont.innerHTML = '';
  if(!g || !g.vars.length){
    cont.innerHTML = '<div class="nada">Todavía no elegiste ningún recorrido.</div>';
    $('edNotaVar').textContent = '';
    return;
  }
  const lineasDistintas = g.vars.map(function(v){ return v[0]; })
    .filter(function(x,i,arr){ return arr.indexOf(x) === i; }).length;
  const res = document.createElement('div');
  res.className = 'nada';
  res.textContent = lineasDistintas + (lineasDistintas === 1 ? ' línea' : ' líneas') + ' · ' +
    g.vars.length + (g.vars.length === 1 ? ' recorrido' : ' recorridos') +
    ' · mismo trazado y mismas paradas para éstas';
  cont.appendChild(res);
  // agrupadas por sentido, con el destino de cada línea en su propio renglón
  const porLado = {A: [], B: []};
  for(const v of g.vars) (porLado[v[4] === 'B' ? 'B' : 'A']).push(v);
  const rotulo = {A: 'Ida', B: 'Vuelta'};
  const hayAmbos = porLado.A.length && porLado.B.length;
  const hayOtrosGrupos = ed.grupos.length > 1;
  for(const s of ['A', 'B']){
    if(!porLado[s].length) continue;
    if(hayAmbos){
      const tit = document.createElement('div');
      tit.className = 'tituloSentido';
      tit.textContent = rotulo[s];
      cont.appendChild(tit);
    }
    for(const v of porLado[s]){
      const el = document.createElement('div');
      el.className = 'eleg';
      el.innerHTML = '<b></b><span></span>' +
        (hayOtrosGrupos ? '<select title="Mover a otro grupo"></select>' : '') +
        '<button title="Quitar">\u00d7</button>';
      el.querySelector('b').textContent = v[0];
      el.querySelector('span').textContent = v[3] + (v[5] ? '' : ' · corto');
      if(hayOtrosGrupos){
        const mv = el.querySelector('select');
        mv.innerHTML = '<option value="">Mover a…</option>';
        ed.grupos.forEach(function(og, i){
          if(i === ed.grupoActivo) return;
          const o = document.createElement('option');
          o.value = String(i);
          o.textContent = etiquetaGrupo(og, i);
          mv.appendChild(o);
        });
        const oN = document.createElement('option');
        oN.value = 'nuevo'; oN.textContent = '+ Nuevo grupo';
        mv.appendChild(oN);
        mv.onchange = (function(cod){ return function(){
          if(mv.value) moverLineaAGrupo(cod, mv.value);
        }; })(v[6]);
      }
      el.querySelector('button').onclick = (function(c){ return function(){ quitarVariante(c); }; })(v[6]);
      cont.appendChild(el);
    }
  }
  const aprox = g.vars.filter(function(v){ return !v[8]; }).length;
  $('edNotaVar').textContent = aprox
    ? aprox + ' de los recorridos elegidos no tienen trazado oficial del SIG: se dibujan punteados, uniendo sus paradas en línea recta, así que atraviesan manzanas. Son solo referencia y no afectan al desvío que trazás.'
    : '';
}

let capaCalle = null;

function marcarPuntos(pts){
  if(capaCalle){ capaCalle.remove(); capaCalle = null; }
  if(!pts || !pts.length) return;
  capaCalle = L.layerGroup();
  if(CRUCE_ELEGIDO){
    // un cruce: se marca el punto exacto
    capaCalle.addLayer(L.circleMarker([CRUCE_ELEGIDO.lat, CRUCE_ELEGIDO.lon],
      {radius:11, color:'#7B2D8E', weight:3, fillColor:'#E3CCEC', fillOpacity:.55, renderer}));
    capaCalle.addTo(mapa);
    mapa.setView([CRUCE_ELEGIDO.lat, CRUCE_ELEGIDO.lon], Math.max(mapa.getZoom(), 16));
    return;
  }
  for(const p of pts){
    capaCalle.addLayer(L.circleMarker(p, {radius:4, color:'#7B2D8E', weight:2,
      fillColor:'#E3CCEC', fillOpacity:.9, renderer, interactive:false}));
  }
  capaCalle.addTo(mapa);
  mapa.fitBounds(L.latLngBounds(pts), {padding:[40,40]});
}

// se mantiene el nombre anterior por compatibilidad
function resaltarParadasCalle(pts){ marcarPuntos(pts); }

/* ================= EDITOR ================= */
async function nuevoDesvio(){
  try{ await cargarBase(); }
  catch(err){ aviso(err.message, 'err'); return; }
  ed = {id:null, linea:'', variantes:[], sentido:null, titulo:'', motivo:'', observaciones:'',
        principal:'', entre:'',
        estado:'borrador', desde:null, hasta:null, recorrido:[],
        grupos:[crearGrupo()], grupoActivo:0};
  abrirEditor();
}

// Reconstruye los grupos de un desvío ya guardado. Los guardados con esta
// función (resumen.grupos) traen la separación completa; los guardados
// antes se leen como un único grupo con todo lo que tenían.
function gruposDesde(d){
  const rg = (d.resumen && d.resumen.grupos) || null;
  if(rg && rg.length){
    return rg.map(function(g){
      const vars = (g.variantes || []).map(function(cv){
        return (window.D_VARS || []).find(function(x){ return x[6] === cv; });
      }).filter(Boolean);
      const traz = trazVacio();
      for(const s of ['A','B']) if(g.traz && g.traz[s]){
        traz[s].v = (g.traz[s].v || []).slice();
        traz[s].calles = (g.traz[s].calles || []).slice();
        traz[s].texto = g.traz[s].texto || '';
      }
      return {
        vars: vars,
        sentidoFiltro: g.sentidoFiltro || 'ambos',
        dibujando: (traz.B.v.length && !traz.A.v.length) ? 'B' : 'A',
        traz: traz,
        suspendidas: (g.paradas_suspendidas || []).map(function(p){ return p.cod; }),
        provisorias: (g.provisorias || []).map(function(p){ return Object.assign({}, p); })
      };
    });
  }
  // formato anterior a los grupos: todo el desvío era un único grupo
  const elegidas = (d.variantes || []).map(function(cv){
    return (window.D_VARS || []).find(function(x){ return x[6] === cv; });
  }).filter(Boolean);
  const g0 = crearGrupo();
  g0.vars = elegidas;
  g0.sentidoFiltro = (d.sentido === 'A' ? 'A' : (d.sentido === 'B' ? 'B' : 'ambos'));
  g0.dibujando = (d.sentido === 'B' ? 'B' : 'A');
  g0.traz = trazDesde(d);
  g0.suspendidas = (d.paradas_suspendidas || []).slice();
  g0.provisorias = (d.paradas_provisorias || []).map(function(p){ return Object.assign({}, p); });
  return [g0];
}

async function editarDesvio(d){
  try{ await cargarBase(); }
  catch(err){ aviso(err.message, 'err'); return; }
  ed = {id:d.id, linea:d.linea, variantes:d.variantes || [], sentido:d.sentido,
        titulo:d.titulo, motivo:d.motivo || '', observaciones:d.observaciones || '',
        principal:d.principal || '', entre:d.entre || '',
        estado:d.estado, desde:d.desde, hasta:d.hasta,
        recorrido:(d.recorrido || []).slice(),
        grupos: gruposDesde(d), grupoActivo: 0};
  abrirEditor();
}

function abrirEditor(){
  modo = 'editor';
  document.body.classList.add('editando');
  $('panelEditor').classList.add('on');
  const as = document.querySelector('aside');
  if(as) as.scrollTop = 0;
  $('edLinea').value = ed.linea || '';
  $('edTitulo').value = ed.titulo || '';
  $('edMotivo').value = ed.motivo || '';
  pintarDibujando();
  $('edPrincipal').value = ed.principal || '';
  $('edEntre').value = ed.entre || '';
  $('edObs').value = ed.observaciones || '';
  $('edDesde').value = fechaAtexto(ed.desde);
  $('edHasta').value = fechaAtexto(ed.hasta);
  $('edVariante').innerHTML = '';
  $('calle').value = ''; $('resCalle').innerHTML = '';
  pintarGrupos();
  pintarElegidos();
  herramienta = null;
  pintarHerramientas();
  dibujarEdicion();
}

function cerrarEditor(){
  modo = 'visor';
  document.body.classList.remove('editando');
  ed = null;
  herramienta = null;
  $('panelEditor').classList.remove('on');
  if(capaCalle){ capaCalle.remove(); capaCalle = null; }
  $('calle').value = ''; $('resCalle').innerHTML = '';
  capaEdicion.clearLayers();
  capaParadas.remove();
  dibujarDesvios();
}

function buscarVariantes(txt){
  if(!ed) return;
  const q = String(txt).trim();
  const sel = $('edVariante');
  sel.innerHTML = '';
  if(!q || !window.D_VARS) return;
  const hits = window.D_VARS.filter(v => v[0] === q).slice(0, 40);
  if(!hits.length){
    sel.innerHTML = '<option value="">— sin variantes para esa línea —</option>';
    return;
  }
  sel.innerHTML = '<option value="">— elegir recorrido —</option>';
  for(const v of hits){
    const o = document.createElement('option');
    o.value = v[6];
    o.textContent = (v[4] === 'A' ? 'ida' : 'vuelta') + (v[5] ? '' : ' · corto') + ' · ' + v[3];
    if(ed.variante && ed.variante[6] === v[6]) o.selected = true;
    sel.appendChild(o);
  }
}

function elegirVariante(cod){
  if(!ed || !cod) return;
  const v = (window.D_VARS || []).find(x => x[6] === parseInt(cod,10));
  if(!v) return;
  const g = gAct();
  if(g && !g.vars.some(function(x){ return x[6] === v[6]; })) g.vars.push(v);
  $('edVariante').value = '';
  pintarElegidos();
  dibujarEdicion();
  if(herramienta === 'suspender') dibujarParadasLinea();
  const pts = v[9].map(coordParada).filter(Boolean);
  if(pts.length) mapa.fitBounds(L.latLngBounds(pts), {padding:[40,40]});
}

function pintarHerramientas(){
  for(const h of ['recorrido','suspender','provisoria']){
    const b = $('h_' + h);
    if(b) b.setAttribute('aria-pressed', String(herramienta === h));
  }
  const ayuda = {
    recorrido: 'Tocá el mapa para ir trazando el recorrido provisorio.',
    suspender: 'Tocá las paradas de la línea que quedan sin servicio.',
    provisoria: 'Tocá el mapa donde se ubica una parada provisoria.'
  };
  $('edAyuda').textContent = herramienta ? ayuda[herramienta] : 'Elegí una herramienta para empezar.';
  if(herramienta === 'suspender'){ capaParadas.addTo(mapa); dibujarParadasLinea(); }
  else capaParadas.remove();
  $('map').style.cursor = herramienta ? 'crosshair' : '';
}

function usarHerramienta(h){
  herramienta = (herramienta === h) ? null : h;
  pintarHerramientas();
}

// Las paradas de las líneas del grupo activo: es el único grupo que se
// puede editar en cada momento.
function paradasDeLaSeleccion(){
  const out = [];
  const vistas = new Map();   // código de parada -> Set de sentidos
  const g = gAct();
  if(!g) return out;
  for(const v of g.vars){
    const s = v[4] || 'A';
    for(const c of v[9]){
      let ss = vistas.get(c);
      if(!ss){ ss = new Set(); vistas.set(c, ss); out.push(c); }
      ss.add(s);
    }
  }
  out.sentidos = vistas;
  return out;
}

function dibujarParadasLinea(){
  capaParadas.clearLayers();
  const g = gAct();
  if(!g || !g.vars.length) return;
  const paradas = paradasDeLaSeleccion();
  const dosSentidos = sentidosConTrazado().length > 1 ||
    (new Set(g.vars.map(function(v){ return v[4] || 'A'; })).size > 1);
  for(const c of paradas){
    const xy = coordParada(c);
    if(!xy) continue;
    const susp = g.suspendidas.indexOf(c) >= 0;
    const ss = paradas.sentidos.get(c);
    const soloB = dosSentidos && ss && ss.size === 1 && ss.has('B');
    const m = L.circleMarker(xy, susp
      ? {radius:7, color:'#B3403C', weight:2, fillColor:'#E8B4B2', fillOpacity:1, renderer}
      : {radius:5, color: soloB ? '#1E6FA8' : '#003580', weight:1.5,
         fillColor: soloB ? '#DCEAF5' : '#fff', fillOpacity:1, renderer});
    const etqSent = dosSentidos ? (ss.size > 1 ? ' · ambos sentidos' :
      (ss.has('B') ? ' · vuelta' : ' · ida')) : '';
    m.bindTooltip(esc(c + ' · ' + nombreParada(c) + etqSent + (susp ? ' (suspendida)' : '')), {direction:'top'});
    capaParadas.addLayer(m);
  }
}

function clicMapa(e){
  if(modo !== 'editor' || !ed || !herramienta) return;
  if(herramienta === 'recorrido'){
    const p = [+e.latlng.lat.toFixed(6), +e.latlng.lng.toFixed(6)];
    const t = trazActual();
    t.v.push(p);
    ed.recorrido = recorridoPlano();
    dibujarEdicion();
    const idx = t.v.length - 1, sentido = gAct().dibujando, gEste = gAct();
    calleDelPunto(p).then(function(nombre){
      if(!ed || !gEste || gEste.traz[sentido].v.length <= idx) return;
      const cc = gEste.traz[sentido].calles;
      if(nombre && cc[cc.length - 1] !== nombre) cc.push(nombre);
      proponerRecorrido(sentido);
    });
  }else if(herramienta === 'provisoria'){
    const g = gAct(); if(!g) return;
    const punto = [+e.latlng.lat.toFixed(6), +e.latlng.lng.toFixed(6)];
    const sugerida = esquinaCercana(punto);
    const nombre = window.prompt(
      'Referencia de la parada provisoria (esquina o altura).\nSe propone la esquina más cercana; se puede cambiar:',
      sugerida);
    if(nombre === null) return;
    g.provisorias.push({lat:punto[0], lon:punto[1], nombre:(nombre.trim() || sugerida || 'sin referencia')});
    dibujarEdicion();
  }else if(herramienta === 'suspender'){
    const g = gAct();
    if(!g || !g.vars.length){ aviso('Elegí primero al menos un recorrido', 'err'); return; }
    const pt = mapa.latLngToContainerPoint(e.latlng);
    let best = null, bestD = 22;
    for(const c of paradasDeLaSeleccion()){
      const xy = coordParada(c); if(!xy) continue;
      const q = mapa.latLngToContainerPoint(xy);
      const dd = Math.hypot(q.x - pt.x, q.y - pt.y);
      if(dd < bestD){ bestD = dd; best = c; }
    }
    if(best === null) return;
    const i = g.suspendidas.indexOf(best);
    i >= 0 ? g.suspendidas.splice(i,1) : g.suspendidas.push(best);
    dibujarParadasLinea();
    dibujarEdicion();
  }
}


// Devuelve la esquina más cercana a un punto, para proponerla como referencia.
function esquinaCercana(p){
  let mejor = null, mejorD = 250*250;
  for(const q of (window.D_PARADAS || [])){
    const dx = (q[3]-p[1])*KX, dy = (q[2]-p[0])*KY;
    const d = dx*dx + dy*dy;
    if(d < mejorD){ mejorD = d; mejor = q; }
  }
  return mejor ? mejor[1] : '';
}

function dibujarEdicion(){
  capaEdicion.clearLayers();
  if(!ed) return;
  const g = gAct();
  const otros = ed.grupos.filter(function(x){ return x !== g; });

  // recorridos de referencia (las líneas habituales) de todos los grupos
  const todasVars = ed.grupos.reduce(function(acc, gr){ return acc.concat(gr.vars); }, []);
  const muchos = todasVars.length > 5;
  for(const v of todasVars){
    const t = trazaDe(v);
    const estilo = t.oficial
      ? {color:'#4a5568', weight: muchos ? 2.5 : 4, opacity: muchos ? .5 : .85, interactive:false}
      : {color:'#8a92a6', weight: muchos ? 1.5 : 2, opacity: muchos ? .35 : .55,
         dashArray:'3 6', interactive:false};
    for(const parte of t.partes) capaEdicion.addLayer(L.polyline(parte, estilo));
  }

  // el trazado de los otros grupos queda visible pero tenue, de fondo
  for(const og of otros){
    for(const s of ['A','B']){
      const t = og.traz[s];
      if(t.v.length < 2) continue;
      capaEdicion.addLayer(L.polyline(t.v, {color: s === 'A' ? '#c47f00' : '#1E6FA8',
        weight:3, opacity:.35, dashArray:'10 7', interactive:false}));
    }
    for(const p of og.provisorias)
      capaEdicion.addLayer(L.circleMarker([p.lat, p.lon], {radius:6, color:'#1E7A3C', weight:1.5,
        fillColor:'#7ED9A0', fillOpacity:.4, renderer, interactive:false}));
  }

  // el trazado del grupo activo, destacado
  if(g){
    for(const s of ['A','B']){
      const t = g.traz[s];
      if(t.v.length < 2 && !(t.v.length && s === g.dibujando)) continue;
      const activo = (s === g.dibujando);
      if(t.v.length > 1) capaEdicion.addLayer(L.polyline(t.v, {
        color: s === 'A' ? '#c47f00' : '#1E6FA8',
        weight: activo ? 5 : 4, opacity: activo ? 1 : .6,
        dashArray:'10 7', interactive:false}));
      for(const p of t.v)
        capaEdicion.addLayer(L.circleMarker(p, {radius: activo ? 4 : 3,
          color: s === 'A' ? '#6b4a00' : '#124e77', weight:2,
          fillColor:'#fff', fillOpacity: activo ? 1 : .6, renderer, interactive:false}));
    }
    for(const p of g.provisorias){
      const m = L.circleMarker([p.lat, p.lon], {radius:7, color:'#1E7A3C', weight:2, fillColor:'#7ED9A0', fillOpacity:1, renderer});
      m.bindTooltip(esc('Provisoria: ' + (p.nombre || 'sin referencia') + ' — tocar para corregir'), {direction:'top'});
      m.on('click', function(){
        const actual = p.nombre || esquinaCercana([p.lat, p.lon]);
        const nuevo = window.prompt(
          'Referencia de esta parada provisoria.\nBorrá el texto y aceptá para eliminar la parada:', actual);
        if(nuevo === null) return;
        if(!nuevo.trim()) g.provisorias.splice(g.provisorias.indexOf(p), 1);
        else p.nombre = nuevo.trim();
        dibujarEdicion();
      });
      capaEdicion.addLayer(m);
    }
  }

  const tA = g ? g.traz.A.v.length : 0, tB = g ? g.traz.B.v.length : 0;
  const totalSusp = ed.grupos.reduce(function(n2, gr){ return n2 + gr.suspendidas.length; }, 0);
  const totalProv = ed.grupos.reduce(function(n2, gr){ return n2 + gr.provisorias.length; }, 0);
  $('edResumen').innerHTML =
    '<span>ida: ' + tA + ' punto' + (tA===1?'':'s') + (tB ? ' · vuelta: ' + tB + ' punto' + (tB===1?'':'s') : '') + '</span>' +
    '<span>' + (g ? g.suspendidas.length : 0) + ' suspendidas' + (ed.grupos.length>1 ? ' (' + totalSusp + ' en total)' : '') + '</span>' +
    '<span>' + (g ? g.provisorias.length : 0) + ' provisorias' + (ed.grupos.length>1 ? ' (' + totalProv + ' en total)' : '') + '</span>';
}

function deshacerTrazo(){
  const g = gAct();
  if(!g) return;
  const t = trazActual();
  if(!t.v.length) return;
  t.v.pop();
  if(t.calles.length) t.calles.pop();
  ed.recorrido = recorridoPlano();
  proponerRecorrido(g.dibujando);
  dibujarEdicion();
}
function borrarTrazo(){
  if(!ed) return;
  const t = trazActual();
  t.v = []; t.calles = []; t.texto = '';
  ed.recorrido = [];
  $('edRecorrido').value = '';
  $('edRecorrido').dataset.tocado = '0';
  dibujarEdicion();
}

// Resumen de un solo grupo (recorrido, paradas, líneas), para el desglose
// del PDF/texto y para la reconstrucción al reeditar.
function resumenGrupo(g){
  const susp = g.suspendidas.map(function(c){
    const xy = coordParada(c);
    return xy ? {cod:c, nombre:nombreParada(c), lat:xy[0], lon:xy[1]} : {cod:c, nombre:nombreParada(c)};
  }).filter(function(p){ return p.lat != null; });
  const origs = [];
  for(const v of g.vars){
    const t = trazaDe(v);
    for(const parte of t.partes)
      if(parte.length > 1) origs.push(parte.map(function(p){ return [+p[0].toFixed(5), +p[1].toFixed(5)]; }));
  }
  const lineas = g.vars.map(function(v){ return v[0]; }).filter(function(x,i,a){ return a.indexOf(x)===i; });
  return {
    lineas: lineas,
    variantes: g.vars.map(function(v){ return v[6]; }),
    sentidoFiltro: g.sentidoFiltro,
    traz: {A: {v: g.traz.A.v, calles: g.traz.A.calles, texto: g.traz.A.texto},
           B: {v: g.traz.B.v, calles: g.traz.B.calles, texto: g.traz.B.texto}},
    recorridos: g.vars.map(function(v){
      return {linea:v[0], sentido:v[4], destino:v[3],
              empresa: window.D_EMPRESAS ? (window.D_EMPRESAS[v[1]] || '') : ''};
    }),
    recorridos_originales: origs,
    paradas_suspendidas: susp,
    provisorias: g.provisorias
  };
}

// Arma el resumen del desvío entero, uniendo todos los grupos. El detalle
// por grupo queda en resumen.grupos, para el desglose línea por línea del
// PDF y del texto; lo demás son uniones, para que el visor público (que no
// distingue grupos) siga mostrando todo igual que antes.
function armarResumen(){
  const rGrupos = ed.grupos.map(resumenGrupo);
  const susp = [], vistas = new Set();
  for(const rg of rGrupos) for(const p of rg.paradas_suspendidas)
    if(!vistas.has(p.cod)){ vistas.add(p.cod); susp.push(p); }
  const origs = [];
  for(const rg of rGrupos) for(const o of rg.recorridos_originales) origs.push(o);
  const recorridos = [];
  for(const rg of rGrupos) for(const r of rg.recorridos) recorridos.push(r);
  const lineas = [];
  for(const rg of rGrupos) for(const l of rg.lineas) if(lineas.indexOf(l) < 0) lineas.push(l);
  let vertices = [];
  for(const rg of rGrupos){ if(rg.traz.A.v.length){ vertices = rg.traz.A.v; break; }
    if(rg.traz.B.v.length){ vertices = rg.traz.B.v; break; } }
  return {
    grupos: rGrupos,
    traz: ed.grupos.length === 1 ? rGrupos[0].traz : undefined,   // compatibilidad con lo anterior
    vertices: vertices,
    lineas: lineas,
    recorridos: recorridos,
    recorridos_originales: origs,
    recorrido_original: origs.length ? origs[0] : [],
    paradas_suspendidas: susp
  };
}

async function guardar(nuevoEstado){
  if(!ed) return;
  const lineasSel = [];
  for(const g of ed.grupos) for(const v of g.vars)
    if(lineasSel.indexOf(v[0]) < 0) lineasSel.push(v[0]);
  ed.linea = lineasSel.length ? lineasSel.join(', ') : $('edLinea').value.trim();
  ed.variantes = [];
  for(const g of ed.grupos) for(const v of g.vars) ed.variantes.push(v[6]);
  const gUnico = ed.grupos.length === 1 ? ed.grupos[0] : null;
  ed.sentido = null;
  if(gUnico){
    const sents = gUnico.vars.map(function(v){ return v[4] || 'A'; })
      .filter(function(x,i,arr){ return arr.indexOf(x) === i; });
    ed.sentido = (gUnico.sentidoFiltro === 'A' || gUnico.sentidoFiltro === 'B') ? gUnico.sentidoFiltro
               : (sents.length === 1 ? sents[0] : null);
  }
  ed.titulo = $('edTitulo').value.trim();
  ed.motivo = $('edMotivo').value.trim();
  const gAhora = gAct();
  if(gAhora){
    const campoRec = $('edRecorrido');
    trazActual().texto = campoRec.value.trim();
    trazActual().tocado = campoRec.dataset.tocado === '1';
  }
  // texto del recorrido: por grupo cuando hay más de uno, simple si hay solo uno
  if(ed.grupos.length > 1){
    ed.recorridoTexto = ed.grupos.map(function(g, i){
      const ls = g.vars.map(function(v){ return v[0]; }).filter(function(x,j,a){ return a.indexOf(x)===j; });
      const conTraz = sentidosConTrazado(g);
      const txt = conTraz.length > 1
        ? ('Ida: ' + (g.traz.A.texto || 's/d') + '  ·  Vuelta: ' + (g.traz.B.texto || 's/d'))
        : (g.traz[conTraz[0] || g.dibujando].texto || 's/d');
      return (ls.length ? ls.join(', ') : 'Grupo ' + (i+1)) + ': ' + txt;
    }).join('   |   ');
  }else if(gUnico){
    const conTraz = sentidosConTrazado(gUnico);
    ed.recorridoTexto = conTraz.length > 1
      ? ('Ida: ' + (gUnico.traz.A.texto || 's/d') + '  ·  Vuelta: ' + (gUnico.traz.B.texto || 's/d'))
      : (gUnico.traz[conTraz[0] || gUnico.dibujando].texto || '');
  }else ed.recorridoTexto = '';
  ed.principal = $('edPrincipal').value.trim();
  ed.entre = $('edEntre').value.trim();
  ed.observaciones = $('edObs').value.trim();
  const fd = textoAfecha($('edDesde').value);
  const fh = textoAfecha($('edHasta').value);
  if(fd === undefined){ aviso('Revisá la fecha "Desde": va como 05/09/2026 14:30', 'err'); return; }
  if(fh === undefined){ aviso('Revisá la fecha "Hasta": va como 05/09/2026 14:30', 'err'); return; }
  ed.desde = fd; ed.hasta = fh;
  if(!ed.linea){ aviso('Elegí al menos una línea afectada', 'err'); return; }
  if(!ed.titulo){ aviso('Falta el título del desvío', 'err'); return; }
  const partes = [];
  let totalSuspendidas = 0;
  for(const g of ed.grupos){
    for(const s of sentidosConTrazado(g)) partes.push(g.traz[s].v);
    totalSuspendidas += g.suspendidas.length;
  }
  ed.recorrido = partes.length > 1 ? partes : (partes[0] || []);
  const hayTrazado = partes.length > 0;
  if(nuevoEstado === 'activo' && !hayTrazado && !totalSuspendidas){
    aviso('Para publicar, trazá el recorrido provisorio o marcá al menos una parada suspendida', 'err');
    return;
  }
  const resumen = armarResumen();
  const provisoriasTodas = [];
  for(const g of ed.grupos) for(const p of g.provisorias) provisoriasTodas.push(p);
  const fila = {
    linea: ed.linea, lineas: lineasSel, variantes: ed.variantes, sentido: ed.sentido,
    titulo: ed.titulo, motivo: ed.motivo, observaciones: ed.observaciones,
    principal: ed.principal, entre: ed.entre, recorrido_texto: ed.recorridoTexto,
    estado: nuevoEstado || ed.estado,
    desde: ed.desde, hasta: ed.hasta,
    recorrido: ed.recorrido,
    paradas_suspendidas: resumen.paradas_suspendidas.map(function(p){ return p.cod; }),
    paradas_provisorias: provisoriasTodas,
    resumen: resumen
  };
  try{
    let res;
    if(ed.id) res = await sb.from('desvios').update(fila).eq('id', ed.id).select().single();
    else res = await sb.from('desvios').insert(fila).select().single();
    if(res.error) throw res.error;
    ed.id = res.data.id; ed.estado = res.data.estado;
    aviso(nuevoEstado === 'activo' ? 'Desvío publicado: ya lo ven todos' :
          nuevoEstado === 'finalizado' ? 'Desvío finalizado' : 'Borrador guardado', 'ok');
    await cargarDesvios();
    if(nuevoEstado === 'activo' || nuevoEstado === 'finalizado') cerrarEditor();
  }catch(err){
    aviso('No se pudo guardar: ' + err.message, 'err');
  }
}

async function eliminar(){
  if(!ed || !ed.id) { cerrarEditor(); return; }
  if(!confirm('¿Eliminar este desvío definitivamente?')) return;
  const { error } = await sb.from('desvios').delete().eq('id', ed.id);
  if(error){ aviso('No se pudo eliminar: ' + error.message, 'err'); return; }
  aviso('Desvío eliminado', 'ok');
  cerrarEditor();
  await cargarDesvios();
}

/* ================= ARRANQUE ================= */
async function iniciar(){
  iniciarMapa();

  if(SUPABASE_URL.indexOf('TU-PROYECTO') >= 0){
    $('config').classList.add('on');
    return;
  }
  sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON);
  const { data } = await sb.auth.getSession();
  sesion = data.session;
  if(sesion){
    document.body.classList.add('conSesion');
    await verificarEditor();
    if(!esEditor) $('quien').textContent = sesion.user.email.split('@')[0];
  }else{
    abrirLogin();
  }
  await cargarDesvios();
  setInterval(cargarDesvios, REFRESCO_MS);
  document.addEventListener('visibilitychange', ()=>{ if(!document.hidden) cargarDesvios(); });

  $('btnIngresar').onclick = abrirLogin;
  $('btnCerrarLogin').onclick = cerrarLogin;
  $('btnEntrar').onclick = entrar;
  $('pass').addEventListener('keydown', e => { if(e.key === 'Enter') entrar(); });
  $('btnSalir').onclick = salir;
  $('btnActualizar').onclick = cargarDesvios;
  $('busq').addEventListener('input', e => { filtro = e.target.value; $('busqLimpiar').hidden = !filtro; aplicarFiltro(false); });
  $('busq').addEventListener('change', () => aplicarFiltro(true));
  $('busq').addEventListener('keydown', e => { if(e.key === 'Enter'){ e.preventDefault(); aplicarFiltro(true); e.target.blur(); } });
  $('busqLimpiar').onclick = () => { ponerFiltro(''); $('busq').focus(); };
  $('btnNuevo').onclick = nuevoDesvio;
  $('btnCerrarEditor').onclick = cerrarEditor;
  $('calle').addEventListener('input', e => { asegurarCalles(); buscarPorCalle(e.target.value); });
  $('grupoSel').addEventListener('change', e => cambiarGrupo(e.target.value));
  $('btnNuevoGrupo').addEventListener('click', () => cambiarGrupo('nuevo'));
  $('edLinea').addEventListener('input', e => buscarVariantes(e.target.value));
  $('edVariante').addEventListener('change', e => elegirVariante(e.target.value));
  $('h_recorrido').onclick = ()=> usarHerramienta('recorrido');
  $('h_suspender').onclick = ()=> usarHerramienta('suspender');
  $('h_provisoria').onclick = ()=> usarHerramienta('provisoria');
  $('edRecorrido').addEventListener('input', function(e){ e.target.dataset.tocado = '1'; });
  $('btnCalles').onclick = escribirCalles;
  $('btnDeshacer').onclick = deshacerTrazo;
  $('btnBorrarTrazo').onclick = borrarTrazo;
  $('btnBorrador').onclick = ()=> guardar('borrador');
  $('btnPublicar').onclick = ()=> guardar('activo');
  $('btnFinalizar').onclick = ()=> guardar('finalizado');
  $('btnEliminar').onclick = eliminar;
  $('lista').addEventListener('dblclick', ()=>{ if(esEditor && seleccionado) editarDesvio(seleccionado); });
  $('btnEditarSel').onclick = ()=>{ if(seleccionado) editarDesvio(seleccionado); };
  $('btnPDF').onclick = ()=>{
    if(!seleccionado){ aviso('Elegí primero un desvío de la lista', 'err'); return; }
    generarPDF(seleccionado);
  };
  $('btnCorreo').onclick = ()=>{
    if(!seleccionado){ aviso('Elegí primero un desvío de la lista', 'err'); return; }
    enviarPorCorreo(seleccionado);
  };
  $('envioConfirmar').onclick = confirmarEnvio;
  $('envioCancelar').onclick = ()=> $('envio').classList.remove('on');
  $('envioTodas').onclick = ()=>{
    const cajas = $('envioLista').querySelectorAll('input');
    const todas = Array.prototype.every.call(cajas, function(i){ return i.checked; });
    Array.prototype.forEach.call(cajas, function(i){ i.checked = !todas; });
  };
  $('btnCopiar').onclick = ()=>{
    if(!seleccionado){ aviso('Elegí primero un desvío de la lista', 'err'); return; }
    copiarTexto(seleccionado);
  };
}

document.addEventListener('DOMContentLoaded', iniciar);
