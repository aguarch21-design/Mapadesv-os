/**
 * ENVÍO DE COMUNICACIONES DE DESVÍO — UPTU / División Transporte
 *
 * Recibe el desvío desde el sistema de desvíos y manda el correo,
 * con el PDF adjunto, desde la casilla institucional.
 *
 * CÓMO INSTALARLO
 *  1. Ir a  script.google.com  con la cuenta institucional desde la que
 *     tienen que salir los correos.
 *  2. Nuevo proyecto → borrar lo que haya y pegar todo este archivo.
 *  3. Cambiar la lista CASILLAS de más abajo por las casillas reales
 *     y poner una CLAVE propia (cualquier texto largo e irrepetible).
 *  4. Implementar → Nueva implementación → tipo "Aplicación web".
 *       Ejecutar como:        Yo (tu cuenta)
 *       Quién tiene acceso:   Cualquier usuario
 *     Aceptar los permisos que pide (enviar correo en tu nombre).
 *  5. Copiar la URL que queda (termina en /exec) y pegarla en app.js
 *     del sistema de desvíos, junto con la misma CLAVE.
 *
 * NOTA DE SEGURIDAD
 *  El script solo envía a las casillas de la lista CASILLAS: aunque
 *  alguien descubra la URL, no puede usarlo para mandar correo a
 *  cualquier lado. Además lleva un tope diario de envíos.
 */

// ---------- CONFIGURACIÓN ----------
const CLAVE = 'PONER-UNA-CLAVE-LARGA-Y-PROPIA';

// Únicas casillas a las que este script puede enviar.
const CASILLAS = [
  'stc@imm.gub.uy'
  // , 'inspectores.uptu@imm.gub.uy'
  // , 'operaciones@empresa.com.uy'
];

const NOMBRE_REMITENTE = 'UPTU · División Transporte';
const TOPE_DIARIO = 60;   // envíos máximos por día, por las dudas
// -----------------------------------


function doPost(e) {
  try {
    const datos = JSON.parse(e.postData.contents);

    if (datos.clave !== CLAVE) {
      return responder({ ok: false, error: 'clave incorrecta' });
    }
    if (!contarEnvio()) {
      return responder({ ok: false, error: 'se alcanzó el tope diario de envíos' });
    }

    // solo se envía a las casillas autorizadas
    const para = (datos.para || [])
      .map(function (x) { return String(x).trim().toLowerCase(); })
      .filter(function (x) { return CASILLAS.indexOf(x) >= 0; });

    if (!para.length) {
      return responder({ ok: false, error: 'ninguna casilla autorizada en el pedido' });
    }

    const opciones = {
      name: NOMBRE_REMITENTE,
      body: datos.cuerpo || ''
    };

    if (datos.pdf) {
      const bytes = Utilities.base64Decode(datos.pdf);
      opciones.attachments = [
        Utilities.newBlob(bytes, 'application/pdf', datos.nombrePdf || 'desvio.pdf')
      ];
    }

    MailApp.sendEmail(para.join(','), datos.asunto || 'Desvío', datos.cuerpo || '', opciones);

    registrar(datos, para);
    return responder({ ok: true, enviados: para.length });

  } catch (err) {
    return responder({ ok: false, error: String(err) });
  }
}


// Permite comprobar desde el navegador que la implementación quedó viva.
function doGet() {
  return responder({ ok: true, servicio: 'envío de desvíos UPTU', casillas: CASILLAS.length });
}


function responder(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}


function contarEnvio() {
  const props = PropertiesService.getScriptProperties();
  const hoy = Utilities.formatDate(new Date(), 'America/Montevideo', 'yyyy-MM-dd');
  const clave = 'envios_' + hoy;
  const n = Number(props.getProperty(clave) || 0);
  if (n >= TOPE_DIARIO) return false;
  props.setProperty(clave, String(n + 1));
  return true;
}


// Deja constancia de cada envío en una hoja de cálculo, para poder revisar.
function registrar(datos, para) {
  try {
    const props = PropertiesService.getScriptProperties();
    let id = props.getProperty('hoja_registro');
    let hoja;
    if (id) {
      hoja = SpreadsheetApp.openById(id).getSheets()[0];
    } else {
      const libro = SpreadsheetApp.create('Envíos de desvíos — UPTU');
      props.setProperty('hoja_registro', libro.getId());
      hoja = libro.getSheets()[0];
      hoja.appendRow(['Fecha', 'Asunto', 'Casillas', 'Publicado por']);
    }
    hoja.appendRow([new Date(), datos.asunto || '', para.join(', '), datos.quien || '']);
  } catch (err) {
    // el registro es opcional: si falla, el correo igual se envió
  }
}
