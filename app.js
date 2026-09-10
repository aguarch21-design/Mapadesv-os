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
const ENVIO_URL   = 'https://script.google.com/macros/s/AKfycbxhNcfVyUk4rBK9TGBhHdhnasBZRqgdM4OvrD9vTptdpnsyY0koFwlet7AjJqJG9vXL/exec';
const ENVIO_CLAVE = 'cachorromalvado';
/* ---------------------------------------------------------------- */

const REFRESCO_MS = 45000;

let sb = null, sesion = null, esEditor = false;
let desvios = [], seleccionado = null;
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
function proponerRecorrido(){
  const campo = $('edRecorrido');
  if(!campo || !ed) return;
  if(campo.dataset.tocado === '1') return;
  const calles = ed.calles.filter(function(c){ return c && c.length > 2; });
  if(!calles.length) return;
  campo.value = calles.join(', ') + '.';
  ed.recorridoTexto = campo.value;
}

// Rehace el recorrido consultando la calle de cada punto marcado.
async function escribirCalles(){
  if(!ed || !ed.vertices.length){ aviso('Marcá primero el recorrido provisorio', 'err'); return; }
  const btn = $('btnCalles');
  btn.disabled = true; btn.textContent = 'Consultando…';
  const calles = [];
  for(const p of ed.vertices){
    const n = await calleDelPunto(p);
    if(n && calles[calles.length - 1] !== n) calles.push(n);
  }
  if(calles.length){
    ed.calles = calles;
    const campo = $('edRecorrido');
    campo.value = calles.join(', ') + '.';
    campo.dataset.tocado = '1';
    ed.recorridoTexto = campo.value;
    aviso('Recorrido escrito con ' + calles.length + ' calles. Revisalo antes de publicar.', 'ok');
  }else{
    aviso('No se pudieron obtener los nombres de las calles', 'err');
  }
  btn.disabled = false; btn.textContent = 'Rehacer calles';
}


function recorridoPlano(){
  return (ed && ed.vertices) ? ed.vertices.slice() : [];
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

function fechaCorta(iso){
  if(!iso) return '';
  const d = new Date(iso);
  return String(d.getDate()).padStart(2,'0') + '/' + String(d.getMonth()+1).padStart(2,'0') +
    ' ' + String(d.getHours()).padStart(2,'0') + ':' + String(d.getMinutes()).padStart(2,'0');
}

/* ================= MAPA ================= */
function iniciarMapa(){
  mapa = L.map('map', {preferCanvas:true, zoomControl:true}).setView([-34.87,-56.17], 12);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
    {maxZoom:19, attribution:'&copy; OpenStreetMap'}).addTo(mapa);
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

function pintarLista(){
  const cont = $('lista');
  cont.innerHTML = '';
  const lista = esEditor ? desvios : activos();
  if(!lista.length){
    cont.innerHTML = '<div class="vacio">No hay desvíos ' + (esEditor ? 'cargados' : 'activos en este momento') + '.</div>';
    $('resumenTop').textContent = esEditor ? 'Sin desvíos' : 'Sin desvíos activos';
    return;
  }
  $('resumenTop').textContent = activos().length + (activos().length === 1 ? ' desvío activo' : ' desvíos activos');
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
  const pts = [];
  (d.recorrido || []).forEach(p => pts.push(p));
  ((d.resumen && d.resumen.paradas_suspendidas) || []).forEach(p => pts.push([p.lat, p.lon]));
  (d.paradas_provisorias || []).forEach(p => pts.push([p.lat, p.lon]));
  if(pts.length) mapa.fitBounds(L.latLngBounds(pts), {padding:[40,40]});
  if(window.innerWidth <= 820) $('map').scrollIntoView({behavior:'smooth', block:'nearest'});
}

function dibujarDesvios(){
  capaDesvios.clearLayers();
  if(modo === 'editor') return;   // editando: el mapa muestra solo la propuesta en curso
  const lista = (esEditor ? desvios : activos()).filter(d => !seleccionado || d.id === seleccionado.id || d.estado === 'activo');
  for(const d of lista){
    const foco = seleccionado && seleccionado.id === d.id;
    const op = (!seleccionado || foco) ? 1 : .35;
    const origs = (d.resumen && d.resumen.recorridos_originales) ||
                  ((d.resumen && d.resumen.recorrido_original) ? [d.resumen.recorrido_original] : []);
    for(const orig of origs)
      if(orig.length > 1)
        capaDesvios.addLayer(L.polyline(orig, {color:'#4a5568', weight:4, opacity:.85*op, interactive:false}));
    if((d.recorrido || []).length > 1)
      capaDesvios.addLayer(L.polyline(d.recorrido, {color:'#c47f00', weight:5, opacity:op,
        dashArray:'10 7', interactive:false}));
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
  const ls = (d.lineas && d.lineas.length) ? d.lineas : [d.linea];
  const susp = (d.resumen && d.resumen.paradas_suspendidas) || [];
  const prov = d.paradas_provisorias || [];
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
  const sent = {};
  for(const r of ((d.resumen && d.resumen.recorridos) || [])){
    if(!sent[r.linea]) sent[r.linea] = new Set();
    sent[r.linea].add(r.sentido);
  }
  let amb = false;
  for(const k in sent) if(sent[k].size > 1) amb = true;
  L.push('Línea: ' + ls.join(', ') + (amb ? ' (ambos sentidos)' : ''));
  L.push('Recorrido: ' + (d.recorrido_texto || ''));
  L.push('Paradas Suspendidas: ' + (susp.length
    ? susp.map(function(p){ return p.cod + ' ' + (p.nombre || ''); }).join(' / ')
    : 'No se suspenden paradas.'));
  L.push('Parada Provisoria: ' + (prov.length
    ? prov.map(function(p){ return p.nombre || 'sin referencia'; }).join(' / ')
    : 'No se habilitan paradas provisorias.'));
  L.push('Observaciones: ' + (d.observaciones || ''));
  L.push('');
  L.push('Saludos cordiales,');
  L.push('U. P. T. U.');
  return L.join('\n');
}

function nombrePDF(d){
  const ls = (d.lineas && d.lineas.length) ? d.lineas : [d.linea];
  const f = new Date(d.actualizado_en || Date.now()).toISOString().slice(0,10);
  return 'desvio-lineas-' + ls.join('-') + '-' + f + '.pdf';
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

  // ---- tabla de items ----
  const ls = (d.lineas && d.lineas.length) ? d.lineas : [d.linea];
  const susp = (d.resumen && d.resumen.paradas_suspendidas) || [];
  const prov = d.paradas_provisorias || [];
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

  const sentidos = {};
  for(const r of ((d.resumen && d.resumen.recorridos) || [])){
    if(!sentidos[r.linea]) sentidos[r.linea] = new Set();
    sentidos[r.linea].add(r.sentido);
  }
  let ambos = false;
  for(const k in sentidos) if(sentidos[k].size > 1) ambos = true;
  const lineaTxt = ls.join(', ') + (ambos ? ' (ambos sentidos)' : '');

  const items = [
    ['Principal', d.principal || ''],
    ['Entre', d.entre || ''],
    ['Fecha', fecha],
    ['Motivo', d.motivo || ''],
    ['Línea', lineaTxt],
    ['Recorrido', d.recorrido_texto || ''],
    ['Paradas Suspendidas', susp.length
      ? susp.map(function(p){ return p.cod + ' ' + (p.nombre || ''); }).join(' / ')
      : 'No se suspenden paradas.'],
    ['Parada Provisoria', prov.length
      ? prov.map(function(p){ return p.nombre || 'sin referencia'; }).join(' / ')
      : 'No se habilitan paradas provisorias.'],
    ['Observaciones', d.observaciones || '']
  ];

  const X0 = M + 4, ANCHO = W - 8, COL = 52, PADX = 2.2, INTER = 4.6;
  let y = 69;
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
  // Sin envío configurado: se abre el cliente de correo, como antes.
  if(!ENVIO_URL || !ENVIO_CLAVE){
    const todas = DESTINATARIOS.map(function(x){ return x.email; });
    abrirCliente(d, todas);
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

function buscarPorCalle(txt){
  const cont = $('resCalle');
  cont.innerHTML = '';
  const crudo = sinAcentos(txt).trim();
  if(crudo.length < 3) { resaltarParadasCalle([]); return; }
  // "italia y comercio", "italia esq comercio", "italia / comercio" → dos calles
  const partes = crudo.split(/\s+y\s+|\s+esq\.?\s+|\s*[\/,&]\s*/).map(s=>s.trim()).filter(s=>s.length>=3);
  if(!partes.length){ resaltarParadasCalle([]); return; }
  if($('edPrincipal') && !$('edPrincipal').value.trim()) $('edPrincipal').value = txt.split(/\s+y\s+|\s+esq\.?\s+|\s*[\/,&]\s*/)[0].trim();
  if($('edEntre') && !$('edEntre').value.trim() && partes.length > 1)
    $('edEntre').value = txt.replace(/^[^]*?(?:\s+y\s+|\s+esq\.?\s+|\s*[\/,&]\s*)/, '').trim();
  const idx = indiceLineas();
  const conteo = new Map();
  const paradasCalle = [];
  for(const p of (window.D_PARADAS || [])){
    if(p[6]) continue;
    const d = sinAcentos(p[1]);
    let coincide = true;
    for(const t of partes){ if(d.indexOf(t) < 0){ coincide = false; break; } }
    if(!coincide) continue;
    paradasCalle.push(p);
    const ls = idx.get(p[0]);
    if(!ls) continue;
    for(const l of ls){
      let e = conteo.get(l);
      if(!e){ e = {n:0, paradas:[]}; conteo.set(l, e); }
      e.n++; e.paradas.push(p[0]);
    }
  }
  let notaCruce = '';
  // Si el cruce exacto no figura, buscar las paradas de la primera calle
  // que estén cerca de la segunda (los nombres de esquina no siempre coinciden).
  if(!conteo.size && partes.length > 1){
    const enA = (window.D_PARADAS || []).filter(function(p){ return !p[6] && sinAcentos(p[1]).indexOf(partes[0]) >= 0; });
    const enB = (window.D_PARADAS || []).filter(function(p){ return !p[6] && sinAcentos(p[1]).indexOf(partes[1]) >= 0; });
    if(enA.length && enB.length){
      const cerca = enA.filter(function(p){
        for(const q of enB){
          const dx = (p[3]-q[3])*KX, dy = (p[2]-q[2])*KY;
          if(dx*dx + dy*dy <= 500*500) return true;
        }
        return false;
      });
      for(const p of cerca){
        paradasCalle.push(p);
        const ls = idx.get(p[0]);
        if(!ls) continue;
        for(const l of ls){
          let e = conteo.get(l);
          if(!e){ e = {n:0, paradas:[]}; conteo.set(l, e); }
          e.n++; e.paradas.push(p[0]);
        }
      }
      if(conteo.size) notaCruce = 'No hay una parada con ese nombre exacto: se muestran las paradas cercanas al cruce (500 m). ';
    }
  }
  if(!conteo.size){
    cont.innerHTML = '<div class="nada">' +
      (partes.length > 1 ? 'Sin paradas en ese cruce ni cerca. Probá con una sola calle.' : 'Sin líneas para esa calle') +
      '</div>';
    resaltarParadasCalle([]);
    return;
  }
  const orden = Array.from(conteo.entries()).sort(function(a,b){
    if(b[1].n !== a[1].n) return b[1].n - a[1].n;
    const na = parseInt(a[0],10), nb = parseInt(b[0],10);
    if(Number.isFinite(na) && Number.isFinite(nb)) return na - nb;
    return a[0] < b[0] ? -1 : 1;
  });
  const cab = document.createElement('div');
  cab.className = 'nada';
  if(orden.length > 1){
    const acc = document.createElement('div');
    acc.className = 'accCalle';
    const bTodas = document.createElement('button');
    bTodas.className = 'mini';
    bTodas.textContent = 'Todas se desvían (' + orden.length + ')';
    bTodas.onclick = function(){
      for(const par of orden) if(!lineaElegida(par[0])) alternarLinea(par[0], par[1].paradas);
      buscarPorCalle($('calle').value);
    };
    acc.appendChild(bTodas);
    const elegidasAca = orden.filter(function(par){ return lineaElegida(par[0]); }).length;
    if(elegidasAca){
      const bNada = document.createElement('button');
      bNada.className = 'mini';
      bNada.textContent = 'Quitar todas';
      bNada.onclick = function(){
        for(const par of orden) if(lineaElegida(par[0])) alternarLinea(par[0], par[1].paradas);
        buscarPorCalle($('calle').value);
      };
      acc.appendChild(bNada);
    }
    cont.appendChild(acc);
  }
  cab.textContent = notaCruce + orden.length + (orden.length === 1 ? ' línea' : ' líneas') + ' · ' +
    paradasCalle.length + (paradasCalle.length === 1 ? ' parada' : ' paradas') +
    (partes.length > 1 ? ' en ese cruce' : ' en esa calle') + ' · tocá las que se desvían';
  cont.appendChild(cab);
  for(const par of orden.slice(0, 60)){
    const linea = par[0], info = par[1];
    const b = document.createElement('button');
    b.className = 'lchip' + (lineaElegida(linea) ? ' on' : '');
    b.innerHTML = '<b></b><span></span>';
    b.querySelector('b').textContent = linea;
    b.querySelector('span').textContent = info.n;
    b.title = info.n + ' parada' + (info.n===1?'':'s') + ' de la línea ' + linea + ' ahí';
    b.onclick = (function(l, paradas){ return function(){
      alternarLinea(l, paradas);
      buscarPorCalle($('calle').value);
    }; })(linea, info.paradas);
    cont.appendChild(b);
  }
  resaltarParadasCalle(paradasCalle);
}

function lineaElegida(linea){
  return !!(ed && ed.vars.some(function(v){ return v[0] === linea; }));
}

// Al tocar una línea se suman sus recorridos que realmente pasan por esas paradas
function alternarLinea(linea, paradas){
  if(!ed) return;
  if(lineaElegida(linea)){
    ed.vars = ed.vars.filter(function(v){ return v[0] !== linea; });
    pintarElegidos(); dibujarEdicion();
    return;
  }
  const set = new Set(paradas || []);
  let cand = (window.D_VARS || []).filter(function(v){
    if(v[0] !== linea) return false;
    if(!set.size) return v[5] === 1;
    for(const c of v[9]) if(set.has(c)) return true;
    return false;
  });
  const maximas = cand.filter(function(v){ return v[5] === 1; });
  if(maximas.length) cand = maximas;
  const porSentido = {};
  for(const v of cand) if(!porSentido[v[4]]) porSentido[v[4]] = v;
  const nuevos = Object.keys(porSentido).map(function(k){ return porSentido[k]; });
  if(!nuevos.length){ aviso('La línea ' + linea + ' no tiene recorridos por ahí', 'err'); return; }
  for(const v of nuevos) ed.vars.push(v);
  pintarElegidos(); dibujarEdicion();
}

function quitarVariante(cod){
  if(!ed) return;
  ed.vars = ed.vars.filter(function(v){ return v[6] !== cod; });
  pintarElegidos(); dibujarEdicion();
  buscarPorCalle($('calle').value);
}

function pintarElegidos(){
  const cont = $('elegidos');
  if(!cont) return;
  cont.innerHTML = '';
  if(!ed || !ed.vars.length){
    cont.innerHTML = '<div class="nada">Todavía no elegiste ningún recorrido.</div>';
    $('edNotaVar').textContent = '';
    return;
  }
  const lineasDistintas = ed.vars.map(function(v){ return v[0]; })
    .filter(function(x,i,arr){ return arr.indexOf(x) === i; }).length;
  const res = document.createElement('div');
  res.className = 'nada';
  res.textContent = lineasDistintas + (lineasDistintas === 1 ? ' línea' : ' líneas') + ' · ' +
    ed.vars.length + (ed.vars.length === 1 ? ' recorrido' : ' recorridos') +
    ' · mismo trazado y mismas paradas para todas';
  cont.appendChild(res);
  for(const v of ed.vars){
    const el = document.createElement('div');
    el.className = 'eleg';
    el.innerHTML = '<b></b><span></span><button title="Quitar">\u00d7</button>';
    el.querySelector('b').textContent = v[0];
    el.querySelector('span').textContent = 'línea ' + v[0] + ' · ' + (v[4] === 'A' ? 'ida' : 'vuelta') +
      (v[5] ? '' : ' · corto') + ' · ' + v[3];
    el.querySelector('button').onclick = (function(c){ return function(){ quitarVariante(c); }; })(v[6]);
    cont.appendChild(el);
  }
  const aprox = ed.vars.filter(function(v){ return !v[8]; }).length;
  $('edNotaVar').textContent = aprox
    ? aprox + ' de los recorridos elegidos no tienen trazado oficial: su línea gris une las paradas y corta esquinas. Es solo referencia.'
    : '';
}

let capaCalle = null;
function resaltarParadasCalle(paradas){
  if(capaCalle){ capaCalle.remove(); capaCalle = null; }
  if(!paradas || !paradas.length) return;
  capaCalle = L.layerGroup();
  for(const p of paradas){
    const m = L.circleMarker([p[2], p[3]], {radius:5, color:'#7B2D8E', weight:2,
      fillColor:'#E3CCEC', fillOpacity:.9, renderer});
    m.bindTooltip(esc(p[0] + ' · ' + p[1]), {direction:'top'});
    capaCalle.addLayer(m);
  }
  capaCalle.addTo(mapa);
  mapa.fitBounds(L.latLngBounds(paradas.map(function(p){ return [p[2], p[3]]; })), {padding:[40,40]});
}

/* ================= EDITOR ================= */
async function nuevoDesvio(){
  try{ await cargarBase(); }
  catch(err){ aviso(err.message, 'err'); return; }
  ed = {id:null, linea:'', variantes:[], sentido:null, titulo:'', motivo:'', observaciones:'',
        principal:'', entre:'', recorridoTexto:'', calles:[],
        estado:'borrador', desde:null, hasta:null, recorrido:[], vertices:[],
        suspendidas:[], provisorias:[], vars:[]};
  abrirEditor();
}

async function editarDesvio(d){
  try{ await cargarBase(); }
  catch(err){ aviso(err.message, 'err'); return; }
  const elegidas = (d.variantes || []).map(function(cv){
    return (window.D_VARS || []).find(function(x){ return x[6] === cv; });
  }).filter(Boolean);
  ed = {id:d.id, linea:d.linea, variantes:d.variantes || [], sentido:d.sentido,
        titulo:d.titulo, motivo:d.motivo || '', observaciones:d.observaciones || '',
        principal:d.principal || '', entre:d.entre || '',
        recorridoTexto:d.recorrido_texto || '', calles:((d.resumen && d.resumen.calles) || []).slice(),
        estado:d.estado, desde:d.desde, hasta:d.hasta,
        recorrido:(d.recorrido || []).slice(),
        vertices:((d.resumen && d.resumen.vertices) || (d.recorrido || [])).slice(),
        suspendidas:(d.paradas_suspendidas || []).slice(),
        provisorias:(d.paradas_provisorias || []).map(p => Object.assign({}, p)),
        vars:elegidas};
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
  $('edRecorrido').value = ed.recorridoTexto || '';
  $('edRecorrido').dataset.tocado = ed.recorridoTexto ? '1' : '0';
  $('edPrincipal').value = ed.principal || '';
  $('edEntre').value = ed.entre || '';
  $('edObs').value = ed.observaciones || '';
  $('edDesde').value = ed.desde ? new Date(ed.desde).toISOString().slice(0,16) : '';
  $('edHasta').value = ed.hasta ? new Date(ed.hasta).toISOString().slice(0,16) : '';
  $('edVariante').innerHTML = '';
  $('calle').value = ''; $('resCalle').innerHTML = '';
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
  if(!ed.vars.some(function(x){ return x[6] === v[6]; })) ed.vars.push(v);
  $('edVariante').value = '';
  pintarElegidos();
  dibujarEdicion();
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

function paradasDeLaSeleccion(){
  const out = [];
  const vistas = new Set();
  if(!ed) return out;
  for(const v of ed.vars) for(const c of v[9]) if(!vistas.has(c)){ vistas.add(c); out.push(c); }
  return out;
}

function dibujarParadasLinea(){
  capaParadas.clearLayers();
  if(!ed || !ed.vars.length) return;
  for(const c of paradasDeLaSeleccion()){
    const xy = coordParada(c);
    if(!xy) continue;
    const susp = ed.suspendidas.indexOf(c) >= 0;
    const m = L.circleMarker(xy, susp
      ? {radius:7, color:'#B3403C', weight:2, fillColor:'#E8B4B2', fillOpacity:1, renderer}
      : {radius:5, color:'#003580', weight:1.5, fillColor:'#fff', fillOpacity:1, renderer});
    m.bindTooltip(esc(c + ' · ' + nombreParada(c) + (susp ? ' (suspendida)' : '')), {direction:'top'});
    capaParadas.addLayer(m);
  }
}

function clicMapa(e){
  if(modo !== 'editor' || !ed || !herramienta) return;
  if(herramienta === 'recorrido'){
    const p = [+e.latlng.lat.toFixed(6), +e.latlng.lng.toFixed(6)];
    ed.vertices.push(p);
    ed.recorrido = recorridoPlano();
    dibujarEdicion();
    const idx = ed.vertices.length - 1;
    calleDelPunto(p).then(function(nombre){
      if(!ed || ed.vertices.length <= idx) return;
      if(nombre && ed.calles[ed.calles.length - 1] !== nombre) ed.calles.push(nombre);
      proponerRecorrido();
    });
  }else if(herramienta === 'provisoria'){
    const punto = [+e.latlng.lat.toFixed(6), +e.latlng.lng.toFixed(6)];
    const sugerida = esquinaCercana(punto);
    const nombre = window.prompt(
      'Referencia de la parada provisoria (esquina o altura).\nSe propone la esquina más cercana; se puede cambiar:',
      sugerida);
    if(nombre === null) return;
    ed.provisorias.push({lat:punto[0], lon:punto[1], nombre:(nombre.trim() || sugerida || 'sin referencia')});
    dibujarEdicion();
  }else if(herramienta === 'suspender'){
    if(!ed.vars.length){ aviso('Elegí primero al menos un recorrido', 'err'); return; }
    const pt = mapa.latLngToContainerPoint(e.latlng);
    let best = null, bestD = 16;
    for(const c of paradasDeLaSeleccion()){
      const xy = coordParada(c); if(!xy) continue;
      const q = mapa.latLngToContainerPoint(xy);
      const dd = Math.hypot(q.x - pt.x, q.y - pt.y);
      if(dd < bestD){ bestD = dd; best = c; }
    }
    if(best === null) return;
    const i = ed.suspendidas.indexOf(best);
    i >= 0 ? ed.suspendidas.splice(i,1) : ed.suspendidas.push(best);
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
  const muchos = ed.vars.length > 5;
  for(const v of ed.vars){
    const pts = v[8] && window.D_SHAPES && window.D_SHAPES[v[6]]
      ? decodePolyline(window.D_SHAPES[v[6]])
      : v[9].map(coordParada).filter(Boolean);
    if(pts.length > 1) capaEdicion.addLayer(L.polyline(pts,
      {color:'#4a5568', weight: muchos ? 2.5 : 4, opacity: muchos ? .5 : .85, interactive:false}));
  }
  if(ed.recorrido.length > 1)
    capaEdicion.addLayer(L.polyline(ed.recorrido, {color:'#c47f00', weight:5, dashArray:'10 7', interactive:false}));
  for(const p of ed.vertices)
    capaEdicion.addLayer(L.circleMarker(p, {radius:4, color:'#6b4a00', weight:2, fillColor:'#fff', fillOpacity:1, renderer, interactive:false}));
  for(const p of ed.provisorias){
    const m = L.circleMarker([p.lat, p.lon], {radius:7, color:'#1E7A3C', weight:2, fillColor:'#7ED9A0', fillOpacity:1, renderer});
    m.bindTooltip(esc('Provisoria: ' + (p.nombre || 'sin referencia') + ' — tocar para corregir'), {direction:'top'});
    m.on('click', function(){
      const actual = p.nombre || esquinaCercana([p.lat, p.lon]);
      const nuevo = window.prompt(
        'Referencia de esta parada provisoria.\nBorrá el texto y aceptá para eliminar la parada:', actual);
      if(nuevo === null) return;
      if(!nuevo.trim()) ed.provisorias.splice(ed.provisorias.indexOf(p), 1);
      else p.nombre = nuevo.trim();
      dibujarEdicion();
    });
    capaEdicion.addLayer(m);
  }
  $('edResumen').innerHTML =
    '<span>' + ed.vertices.length + ' puntos de trazado</span>' +
    '<span>' + ed.suspendidas.length + ' suspendidas</span>' +
    '<span>' + ed.provisorias.length + ' provisorias</span>';
}

function deshacerTrazo(){
  if(!ed || !ed.vertices.length) return;
  ed.vertices.pop();
  if(ed.calles.length) ed.calles.pop();
  ed.recorrido = recorridoPlano();
  proponerRecorrido();
  dibujarEdicion();
}
function borrarTrazo(){
  if(!ed) return;
  ed.vertices = []; ed.recorrido = []; ed.calles = [];
  if($('edRecorrido').dataset.tocado !== '1'){ $('edRecorrido').value = ''; ed.recorridoTexto = ''; }
  dibujarEdicion();
}

function armarResumen(){
  const susp = ed.suspendidas.map(c => {
    const xy = coordParada(c);
    return xy ? {cod:c, nombre:nombreParada(c), lat:xy[0], lon:xy[1]} : {cod:c, nombre:nombreParada(c)};
  }).filter(p => p.lat != null);
  const origs = [];
  for(const v of ed.vars){
    const pts = v[8] && window.D_SHAPES && window.D_SHAPES[v[6]]
      ? decodePolyline(window.D_SHAPES[v[6]]).map(p => [+p[0].toFixed(5), +p[1].toFixed(5)])
      : v[9].map(coordParada).filter(Boolean);
    if(pts.length > 1) origs.push(pts);
  }
  return {
    calles: ed.calles,
    vertices: ed.vertices,
    lineas: ed.vars.map(function(v){ return v[0]; }).filter(function(x,i,a){ return a.indexOf(x)===i; }),
    recorridos: ed.vars.map(function(v){
      return {linea:v[0], sentido:v[4], destino:v[3],
              empresa: window.D_EMPRESAS ? (window.D_EMPRESAS[v[1]] || '') : ''};
    }),
    recorridos_originales: origs,
    recorrido_original: origs.length ? origs[0] : [],
    paradas_suspendidas: susp
  };
}

async function guardar(nuevoEstado){
  if(!ed) return;
  const lineasSel = ed.vars.map(function(v){ return v[0]; }).filter(function(x,i,a){ return a.indexOf(x)===i; });
  ed.linea = lineasSel.length ? lineasSel.join(', ') : $('edLinea').value.trim();
  ed.variantes = ed.vars.map(function(v){ return v[6]; });
  ed.sentido = ed.vars.length === 1 ? ed.vars[0][4] : null;
  ed.titulo = $('edTitulo').value.trim();
  ed.motivo = $('edMotivo').value.trim();
  ed.recorridoTexto = $('edRecorrido').value.trim();
  ed.principal = $('edPrincipal').value.trim();
  ed.entre = $('edEntre').value.trim();
  ed.observaciones = $('edObs').value.trim();
  ed.desde = $('edDesde').value ? new Date($('edDesde').value).toISOString() : null;
  ed.hasta = $('edHasta').value ? new Date($('edHasta').value).toISOString() : null;
  if(!ed.linea){ aviso('Elegí al menos una línea afectada', 'err'); return; }
  if(!ed.titulo){ aviso('Falta el título del desvío', 'err'); return; }
  ed.recorrido = recorridoPlano();
  if(nuevoEstado === 'activo' && ed.recorrido.length < 2 && !ed.suspendidas.length){
    aviso('Para publicar, trazá el recorrido provisorio o marcá al menos una parada suspendida', 'err');
    return;
  }
  const fila = {
    linea: ed.linea, lineas: lineasSel, variantes: ed.variantes, sentido: ed.sentido,
    titulo: ed.titulo, motivo: ed.motivo, observaciones: ed.observaciones,
    principal: ed.principal, entre: ed.entre, recorrido_texto: ed.recorridoTexto,
    estado: nuevoEstado || ed.estado,
    desde: ed.desde, hasta: ed.hasta,
    recorrido: ed.recorrido,
    paradas_suspendidas: ed.suspendidas,
    paradas_provisorias: ed.provisorias,
    resumen: armarResumen()
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
  $('btnNuevo').onclick = nuevoDesvio;
  $('btnCerrarEditor').onclick = cerrarEditor;
  $('calle').addEventListener('input', e => buscarPorCalle(e.target.value));
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
