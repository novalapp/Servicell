const express = require('express');
const router = express.Router();
const supabase = require('../../config/database');
const { generateResponse } = require('../ai/claude');

const META_ACCESS_TOKEN = process.env.META_ACCESS_TOKEN;
const META_PHONE_NUMBER_ID = process.env.META_PHONE_NUMBER_ID;
const META_VERIFY_TOKEN = process.env.META_VERIFY_TOKEN;

// Clave secreta que debe mandar el panel para poder intervenir
const PANEL_KEY = process.env.PANEL_KEY;

// ---------------------------------------------------------------
// CONFIGURACIÓN — esto es lo único que hay que cambiar
// ---------------------------------------------------------------

const CLIENT_ID = 'c37d2508-c9d1-422d-9fef-23901bc51145';
const CHANNEL_ID = '18e8df74-2ed5-415b-ac84-2b043eebac7b';

// Asesora que recibe los casos de pago
const AGENT_PHONE = '573227831687';   // con 57 al inicio, sin espacios
const AGENT_NAME = 'Adriana';
const AGENT_DISPLAY = '322 783 1687'; // como se le muestra al cliente

// Horarios de atención, en minutos desde medianoche (hora de Colombia)
// 9:30am = 570 · 10am = 600 · 4pm = 960 · 7pm = 1140
const HORARIO_SEMANA  = { apertura: 570, cierre: 1140 }; // lunes a sábado
const HORARIO_DOMINGO = { apertura: 600, cierre: 960 };  // domingos y festivos

const MARGEN_CIERRE_MIN = 30;

// Festivos colombianos, formato 'YYYY-MM-DD'
const FESTIVOS = [];

const PALABRAS_CASOS = ['casos', 'pendientes', 'ventas', 'pedidos'];
const HISTORY_LIMIT = 6;

let cierrePendiente = null;

console.log('✅ Webhook receiver cargado');

// ---------------------------------------------------------------
// WEBHOOK
// ---------------------------------------------------------------

router.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === META_VERIFY_TOKEN) {
    console.log('✅ Webhook verificado');
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

router.post('/webhook', async (req, res) => {
  console.log('📨 Webhook POST recibido');
  res.status(200).send('EVENT_RECEIVED');

  try {
    const body = req.body;

    if (body.object === 'whatsapp_business_account') {
      const entry = body.entry[0];
      const changes = entry.changes[0];
      const value = changes.value;

      if (value.messages && value.messages.length > 0) {
        const message = value.messages[0];
        const contacto = (value.contacts && value.contacts[0]) || {};

        // Meta ya no siempre manda el número de teléfono.
        // Puede venir el BSUID (formato "CO.1392...") en su lugar.
        const destino = identificarRemitente(message, contacto);

        if (!destino) {
          console.error('❌ No pude identificar al remitente:', JSON.stringify(message));
          return;
        }

        const text = message.text?.body || '';

        // Las fotos sí las puede ver la IA
        if (message.type === 'image') {
          const pie = message.image?.caption || '';
          console.log(`🖼️ Foto recibida de ${destino}`);
          handleMessage(destino, pie, message.image?.id).catch(err => {
            console.error('Error en handleMessage:', err);
          });
          return;
        }

        // Lo demás (audio, sticker, video, documento) no se puede procesar
        if (message.type !== 'text') {
          console.log(`🎙️ Mensaje tipo "${message.type}" de ${destino}`);
          responderNoTexto(destino, message.type).catch(err => {
            console.error('Error respondiendo a no-texto:', err);
          });
          return;
        }

        console.log(`📱 Mensaje de ${destino}: ${text}`);

        handleMessage(destino, text).catch(err => {
          console.error('Error en handleMessage:', err);
        });
      }
    }
  } catch (error) {
    console.error('❌ Error en POST webhook:', error);
  }
});

// Devuelve el teléfono si viene, y si no, el identificador BSUID
function identificarRemitente(message, contacto) {
  const candidatos = [
    message.from,
    contacto.wa_id,
    message.from_user_id,
    message.user_id,
    contacto.user_id
  ];

  // Preferimos siempre un teléfono real
  const telefono = candidatos.find(c => c && esTelefono(c));
  if (telefono) return telefono;

  return candidatos.find(c => c) || null;
}

// Un teléfono es solo dígitos. Un BSUID trae letras y punto.
function esTelefono(valor) {
  return /^\d{7,15}$/.test(String(valor || ''));
}

// ---------------------------------------------------------------
// HORARIO
// ---------------------------------------------------------------

function ahoraColombia() {
  const partes = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Bogota',
    hour: 'numeric',
    minute: 'numeric',
    hour12: false
  }).formatToParts(new Date());

  const valor = tipo => partes.find(p => p.type === tipo)?.value;

  return {
    hora: parseInt(valor('hour'), 10) % 24,
    minuto: parseInt(valor('minute'), 10)
  };
}

function infoDia(offsetDias) {
  const fecha = new Date(Date.now() + offsetDias * 86400000);

  const partes = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Bogota',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    weekday: 'short'
  }).formatToParts(fecha);

  const valor = tipo => partes.find(p => p.type === tipo)?.value;
  const dias = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

  return {
    fecha: `${valor('year')}-${valor('month')}-${valor('day')}`,
    dia: dias[valor('weekday')]
  };
}

function horarioDe(offsetDias) {
  const { fecha, dia } = infoDia(offsetDias);
  const comoDomingo = (dia === 0) || FESTIVOS.includes(fecha);
  return comoDomingo ? HORARIO_DOMINGO : HORARIO_SEMANA;
}

function formatHora(minutos) {
  const h24 = Math.floor(minutos / 60);
  const m = minutos % 60;
  const sufijo = h24 >= 12 ? 'pm' : 'am';
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  return m === 0 ? `${h12}${sufijo}` : `${h12}:${String(m).padStart(2, '0')}${sufijo}`;
}

function estadoAtencion() {
  const { hora, minuto } = ahoraColombia();
  const ahora = hora * 60 + minuto;
  const hoy = horarioDe(0);

  if (ahora < hoy.apertura) return { estado: 'temprano', apertura: hoy.apertura };
  if (ahora >= hoy.cierre - MARGEN_CIERRE_MIN) {
    return { estado: 'cerrado', apertura: horarioDe(1).apertura };
  }
  return { estado: 'abierto', apertura: hoy.apertura };
}

function haceCuanto(fechaISO) {
  if (!fechaISO) return '';
  const dias = Math.floor((Date.now() - new Date(fechaISO).getTime()) / 86400000);
  if (dias <= 0) return 'hoy';
  if (dias === 1) return 'ayer';
  return `hace ${dias} días`;
}

// ---------------------------------------------------------------
// FLUJO PRINCIPAL
// ---------------------------------------------------------------

// Responde cuando llega algo que no es texto (audio, foto, sticker...)
async function responderNoTexto(destino, tipo) {
  try {
    const contactId = await getOrCreateContact(destino);
    const conversation = await getOrCreateConversation(contactId);

    if (conversation.handled_by === 'human') {
      console.log('🤐 Conversación con la asesora, no se responde');
      return;
    }
  } catch (err) {
    console.error('⚠️ No pude verificar la conversación:', err.message);
  }

  const esAudio = (tipo === 'audio' || tipo === 'voice');

  const texto = esAudio
    ? 'Disculpa, en este momento no puedo escucharte 🙏 ¿Me lo puedes escribir, por favor? Gracias 😊'
    : 'Disculpa, no puedo abrir ese archivo por acá 🙈 ¿Me cuentas por escrito qué necesitas?';

  await sendMessage(destino, texto);
}

// Descarga una foto de WhatsApp y la deja lista para la IA
async function descargarImagen(mediaId) {
  const cabeceras = { Authorization: `Bearer ${META_ACCESS_TOKEN}` };

  // 1. Pedirle a Meta la URL temporal del archivo
  const infoRes = await fetch(`https://graph.facebook.com/v19.0/${mediaId}`, { headers: cabeceras });
  const info = await infoRes.json();

  if (!info.url) throw new Error(`Meta no dio URL: ${JSON.stringify(info)}`);

  const permitidos = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
  if (!permitidos.includes(info.mime_type)) {
    throw new Error(`formato no soportado: ${info.mime_type}`);
  }

  // 2. Descargar el archivo
  const binRes = await fetch(info.url, { headers: cabeceras });
  const buffer = Buffer.from(await binRes.arrayBuffer());

  if (buffer.length > 4500000) throw new Error('la foto pesa demasiado');

  return { base64: buffer.toString('base64'), mime: info.mime_type };
}

async function handleMessage(destino, text, imagenId = null) {
  if (destino === AGENT_PHONE) {
    await handleAgente(text);
    return;
  }

  let contactId = null;
  let conversation = null;
  let history = [];

  // Si viene foto, la descargamos y se la pasamos a la IA
  let contenidoUsuario = text;
  let textoParaGuardar = text;

  if (imagenId) {
    try {
      const img = await descargarImagen(imagenId);
      contenidoUsuario = [
        { type: 'image', source: { type: 'base64', media_type: img.mime, data: img.base64 } },
        { type: 'text', text: text || '¿Qué me puedes decir de esta foto?' }
      ];
      textoParaGuardar = text ? `[foto] ${text}` : '[el cliente envió una foto]';
      console.log('📷 Foto descargada y lista para la IA');
    } catch (err) {
      console.error('⚠️ No pude descargar la foto:', err.message);
      await sendMessage(destino, 'Disculpa, no pude abrir esa foto 🙈 ¿Me la puedes reenviar o contarme por escrito qué necesitas?');
      return;
    }
  }

  console.log('⏳ Esperando 2 segundos...');
  await new Promise(resolve => setTimeout(resolve, 2000));

  try {
    contactId = await getOrCreateContact(destino);
    conversation = await getOrCreateConversation(contactId);

    if (conversation.handled_by === 'human') {
      console.log('🤐 Conversación en manos de la asesora, el bot no responde');
      await saveMessage(conversation.id, contactId, 'contact', textoParaGuardar);
      await sendMessage(destino, mensajeYaEstaConVentas());
      return;
    }

    history = await getHistory(conversation.id);
    console.log(`📚 Historial recuperado: ${history.length} mensajes`);

    await saveMessage(conversation.id, contactId, 'contact', textoParaGuardar);
  } catch (dbError) {
    console.error('⚠️ Error de base de datos (el chat continúa):', dbError.message);
    history = [];
  }

  try {
    console.log('🤖 Llamando Claude...');
    const respuestaCruda = await generateResponse(contenidoUsuario, CLIENT_ID, history);

    const { datos, fotos, textoLimpio, motivoAsesora } = extraerMarcas(respuestaCruda);

      // Avisar a la asesora si la IA lo pidió
    if (motivoAsesora) {
      if (imagenId) {
        await reenviarAsesora(imagenId, motivoAsesora, destino);
        avisoYaEnviado(destino);
      } else if (puedeAvisar(destino)) {
        await avisarAsesora(motivoAsesora, destino, contactId, conversation);
        avisoYaEnviado(destino);
      } else {
        console.log('🔕 Aviso repetido del mismo cliente, se omite');
      }
    }

    if (datos) {
      console.log('🛒 Pedido completo detectado, iniciando traspaso');
      await cerrarVenta(destino, contactId, conversation, datos);
      return;
    }

    if (fotos.length > 0) {
      await enviarFotos(destino, fotos);
    }

    if (textoLimpio) {
      console.log(`✍️ Respuesta: ${textoLimpio}`);
      await sendMessage(destino, textoLimpio);

      await redAsesora(textoLimpio, destino, contactId, conversation);

      if (conversation) {
        saveMessage(conversation.id, contactId, 'agent', textoLimpio)
          .catch(err => console.error('⚠️ No se guardó la respuesta:', err.message));
      }
    }
  } catch (error) {
    console.error('❌ Error en handleMessage:', error);
  }
}

// ---------------------------------------------------------------
// IMÁGENES
// ---------------------------------------------------------------

function normalizar(texto) {
  if (!texto) return '';
  return texto
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/titanio/g, 'titan')
    .replace(/[^a-z0-9]/g, '');
}

function parecido(buscado, candidato) {
  const a = normalizar(buscado);
  const b = normalizar(candidato);

  if (!a || !b) return 0;
  if (a === b) return 3;
  if (a.includes(b) || b.includes(a)) return 2;

  const palabrasA = buscado.toLowerCase().split(/\s+/).map(normalizar).filter(Boolean);
  const palabrasB = candidato.toLowerCase().split(/\s+/).map(normalizar).filter(Boolean);

  return palabrasA.some(p => p.length > 2 && palabrasB.includes(p)) ? 1 : 0;
}

async function enviarFotos(destino, fotos) {
  for (const foto of fotos) {
    try {
      const url = (foto.tipo === 'lista')
        ? await getListaPrecios()
        : await getFotoModelo(foto.modelo, foto.color);

      if (!url) continue;
      await sendImage(destino, url);
    } catch (err) {
      console.error('⚠️ Error enviando foto:', err.message);
    }
  }
}

async function getFotoModelo(modelo, color) {
  if (!modelo) return null;

  const { data, error } = await supabase
    .from('model_images')
    .select('model, color, image_url')
    .eq('client_id', CLIENT_ID)
    .eq('active', true);

  if (error) {
    console.error('⚠️ Error buscando foto:', error.message);
    return null;
  }

  if (!data || data.length === 0) {
    console.log('📷 No hay fotos cargadas en model_images');
    return null;
  }

  let delModelo = data.filter(f => parecido(modelo, f.model) === 3);

  if (delModelo.length === 0) {
    delModelo = data.filter(f => parecido(modelo, f.model) === 2);
    if (delModelo.length > 0) {
      console.log(`📷 Modelo "${modelo}" resuelto como "${delModelo[0].model}"`);
    }
  }

  if (delModelo.length === 0) {
    console.log(`📷 Sin fotos del modelo "${modelo}"`);
    return null;
  }

  if (!color) return delModelo[0].image_url;

  let mejor = null;
  let mejorPuntaje = 0;

  for (const fila of delModelo) {
    const puntaje = parecido(color, fila.color);
    if (puntaje > mejorPuntaje) {
      mejorPuntaje = puntaje;
      mejor = fila;
    }
  }

  if (!mejor) {
    const disponibles = delModelo.map(f => f.color).join(', ');
    console.log(`📷 Sin foto para "${modelo}" color "${color}". Disponibles: ${disponibles}`);
    return null;
  }

  if (mejorPuntaje < 3) {
    console.log(`📷 Color "${color}" resuelto como "${mejor.color}"`);
  }

  return mejor.image_url;
}

async function getListaPrecios() {
  const { data, error } = await supabase
    .from('price_list_images')
    .select('image_url')
    .eq('client_id', CLIENT_ID)
    .eq('active', true)
    .order('created_at', { ascending: false })
    .limit(1);

  if (error) {
    console.error('⚠️ Error buscando lista de precios:', error.message);
    return null;
  }

  if (!data || data.length === 0) {
    console.log('📷 No hay lista de precios activa');
    return null;
  }

  return data[0].image_url;
}

// ---------------------------------------------------------------
// CUANDO ESCRIBE LA ASESORA
// ---------------------------------------------------------------

async function handleAgente(text) {
  const limpio = text.trim().toLowerCase();

  if (cierrePendiente) {
    if (limpio === 'si' || limpio === 'sí') {
      await confirmarCierre();
      return;
    }
    if (limpio === 'no') {
      cierrePendiente = null;
      await sendMessage(AGENT_PHONE, 'Listo, no cerré nada 👌');
      return;
    }
    cierrePendiente = null;
  }

  const pideCerrar = limpio.match(/^cerrar\s+(\d+)$/);
  if (pideCerrar) {
    await pedirConfirmacionCierre(parseInt(pideCerrar[1], 10));
    return;
  }

  const pideCasos = PALABRAS_CASOS.some(p => limpio === p || limpio.startsWith(p + ' '));
  if (pideCasos) {
    console.log('📋 La asesora pidió los casos pendientes');
    try {
      const casos = await getCasosPendientes();
      await sendMessage(AGENT_PHONE, mensajeCasos(casos));
    } catch (err) {
      console.error('⚠️ Error consultando casos:', err.message);
      await sendMessage(AGENT_PHONE, 'No pude consultar los casos en este momento. Intenta de nuevo en un minuto.');
    }
    return;
  }

  console.log('👔 Mensaje de la asesora sin comando, se ignora');
}

async function pedirConfirmacionCierre(numero) {
  try {
    const casos = await getCasosPendientes();

    if (numero < 1 || numero > casos.length) {
      await sendMessage(AGENT_PHONE, `No existe el caso ${numero}. Escribe "casos" para ver la lista.`);
      return;
    }

    const caso = casos[numero - 1];
    const nombre = caso.contacts?.display_name || 'Sin nombre';

    cierrePendiente = { id: caso.id, nombre };

    await sendMessage(
      AGENT_PHONE,
      `¿Cierro el caso de ${nombre}?\n${caso.summary || ''}\n\nResponde "si" para confirmar.`
    );
  } catch (err) {
    console.error('⚠️ Error preparando cierre:', err.message);
    await sendMessage(AGENT_PHONE, 'No pude consultar los casos en este momento.');
  }
}

async function confirmarCierre() {
  const caso = cierrePendiente;
  cierrePendiente = null;

  if (!caso) return;

  try {
    const { error } = await supabase
      .from('conversations')
      .update({
        status: 'closed',
        closed_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      })
      .eq('id', caso.id);

    if (error) throw new Error(error.message);

    const restantes = await getCasosPendientes();
    const texto = restantes.length === 0
      ? 'No quedan casos pendientes 👌'
      : `Quedan ${restantes.length} pendiente${restantes.length === 1 ? '' : 's'}.`;

    await sendMessage(AGENT_PHONE, `✅ Caso de ${caso.nombre} cerrado.\n${texto}`);
    console.log(`✅ Caso cerrado: ${caso.nombre}`);
  } catch (err) {
    console.error('⚠️ Error cerrando el caso:', err.message);
    await sendMessage(AGENT_PHONE, 'No pude cerrar el caso. Intenta de nuevo en un minuto.');
  }
}

async function getCasosPendientes() {
  const { data, error } = await supabase
    .from('conversations')
    .select('id, summary, updated_at, contacts(display_name, external_id, metadata)')
    .eq('client_id', CLIENT_ID)
    .eq('status', 'waiting_agent')
    .order('updated_at', { ascending: true })
    .limit(20);

  if (error) throw new Error(error.message);
  return data || [];
}

// Deja el número listo para un enlace wa.me (solo dígitos, con 57)
function paraWaMe(numero) {
  const limpio = String(numero || '').replace(/\D/g, '');
  if (!limpio) return null;
  if (limpio.length === 10) return '57' + limpio;
  return limpio;
}

function mensajeCasos(casos) {
  if (!casos || casos.length === 0) {
    return '📋 No hay casos pendientes en este momento 👌';
  }

  const lineas = casos.map((c, i) => {
    const contacto = c.contacts || {};
    const meta = contacto.metadata || {};

    // El celular que escribió el cliente es el único confiable para wa.me
    const celular = meta.celular || (esTelefono(contacto.external_id) ? contacto.external_id : null);
    const wa = paraWaMe(celular);

    const cedula = meta.cedula ? ` · CC ${meta.cedula}` : '';
    const ubicacion = [meta.direccion, meta.ciudad].filter(Boolean).join(', ');
    const lineaUbicacion = ubicacion ? `\n   📍 ${ubicacion}` : '';
    const lineaChat = wa ? `\n   💬 wa.me/${wa}` : '';

    return `${i + 1}. ${contacto.display_name || 'Sin nombre'}${cedula}  (${haceCuanto(c.updated_at)})
   🛒 ${c.summary || 'Sin detalle'}${lineaUbicacion}
   📱 ${celular || 'sin celular'}${lineaChat}`;
  });

  const plural = casos.length === 1 ? 'caso' : 'casos';

  return `📋 ${casos.length} ${plural} esperando:

${lineas.join('\n\n')}

Para cerrar uno escribe: cerrar 1`;
}

// ---------------------------------------------------------------
// AVISOS A LA ASESORA (consultas, no ventas)
// ---------------------------------------------------------------
// Deja constancia en Supabase de cada aviso que se le manda a la asesora
async function registrarAviso(tipo, contenido, conversationId, enviado, error) {
  try {
    await supabase.from('avisos_asesora').insert([{
      client_id: CLIENT_ID,
      conversation_id: conversationId || null,
      tipo: tipo,
      destinatario: AGENT_PHONE,
      contenido: contenido,
      enviado: enviado,
      error: error || null
    }]);
    console.log(`📒 Aviso registrado (${tipo})`);
  } catch (err) {
    console.error('⚠️ No pude registrar el aviso:', err.message);
  }
}
// Para no avisar diez veces del mismo cliente. Ventana de 6 horas.
const VENTANA_AVISO_MS = 6 * 60 * 60 * 1000;
const avisosRecientes = new Map();

function puedeAvisar(destino) {
  const ultimo = avisosRecientes.get(destino);
  return !ultimo || (Date.now() - ultimo) > VENTANA_AVISO_MS;
}

function avisoYaEnviado(destino) {
  avisosRecientes.set(destino, Date.now());
  if (avisosRecientes.size > 500) {
    for (const [k, t] of avisosRecientes) {
      if (Date.now() - t > VENTANA_AVISO_MS) avisosRecientes.delete(k);
    }
  }
}

// Saca el nombre y el celular que ya tengamos guardados del cliente
async function datosDelContacto(contactId) {
  if (!contactId) return {};
  try {
    const { data, error } = await supabase
      .from('contacts')
      .select('display_name, external_id, metadata')
      .eq('id', contactId)
      .limit(1);

    if (error || !data || data.length === 0) return {};

    const c = data[0];
    const meta = c.metadata || {};

    // Al crear el contacto, display_name queda igual al identificador.
    // Eso no es un nombre real.
    const nombre = (c.display_name && c.display_name !== c.external_id)
      ? c.display_name
      : null;

    return {
      nombre,
      celular: meta.celular || (esTelefono(c.external_id) ? c.external_id : null)
    };
  } catch (err) {
    console.error('⚠️ No pude leer los datos del contacto:', err.message);
    return {};
  }
}

// Avisa a la asesora de una consulta (sin foto de por medio)
// motivo llega como "Asunto|Nombre|Pedido|Celular" o solo "Asunto"
async function avisarAsesora(motivo, destino, contactId, conversation) {
  try {
    const [asunto, nombreMarca, pedido, celularMarca] = String(motivo)
      .split('|')
      .map(s => (s || '').trim());

    const guardado = await datosDelContacto(contactId);
    const nombre = nombreMarca || guardado.nombre;
    const celular = celularMarca || guardado.celular;
    const wa = paraWaMe(celular);

    const lineas = ['🔔 CONSULTA — este cliente te va a escribir'];
    lineas.push(`📌 ${asunto || 'Sin clasificar'}`);
    if (nombre) lineas.push(`👤 ${nombre}`);
    if (pedido) lineas.push(`🛒 ${pedido}`);
    lineas.push(`📱 ${celular || 'sin celular'}`);
    if (wa) {
      lineas.push(`💬 wa.me/${wa}`);
    } else {
      lineas.push('⚠️ El cliente no dejó celular. Espera a que él escriba.');
    }

    const textoAviso = lineas.join('\n');
    await sendMessage(AGENT_PHONE, textoAviso);
    console.log(`🔔 Aviso de consulta enviado a ${AGENT_NAME}: ${asunto}`);
    await registrarAviso('consulta', textoAviso, conversation?.id, true, null);

    const resumen = `Consulta: ${asunto || 'sin clasificar'}${nombre ? ` — ${nombre}` : ''}`;
    await marcarEsperandoAsesora(conversation, resumen);
  } catch (err) {
    console.error('⚠️ No pude avisar a la asesora:', err.message);
  }
}

// Deja el caso en la lista de "casos" SIN silenciar al bot
// (handled_by sigue en 'ai', el cliente puede seguir conversando)
async function marcarEsperandoAsesora(conversation, resumen) {
  if (!conversation) return;
  try {
    await supabase
      .from('conversations')
      .update({
        status: 'waiting_agent',
        summary: resumen,
        updated_at: new Date().toISOString()
      })
      .eq('id', conversation.id);
    console.log('📋 Conversación marcada como pendiente');
  } catch (err) {
    console.error('⚠️ No pude marcar la conversación:', err.message);
  }
}

// ¿La respuesta menciona el número de la asesora, en cualquier formato?
function mencionaAsesora(texto) {
  const soloDigitos = String(texto || '').replace(/\D/g, '');
  return soloDigitos.includes(AGENT_PHONE.slice(2));
}

// RED DE SEGURIDAD: si la IA mandó al cliente donde la asesora pero
// olvidó la marca, el aviso sale igual.
async function redAsesora(texto, destino, contactId, conversation) {
  if (!mencionaAsesora(texto)) return;

  if (!puedeAvisar(destino)) {
    console.log('🔕 Ya se avisó de este cliente hace poco, no se repite');
    return;
  }

  console.log('🕸️ Se mencionó a la asesora sin marca — aviso automático');
  await avisarAsesora('Consulta sin clasificar', destino, contactId, conversation);
  avisoYaEnviado(destino);
}

async function cerrarVenta(destino, contactId, conversation, datos) {
  const atencion = estadoAtencion();
  console.log(`🕐 Estado de atención: ${atencion.estado}`);

  const mensajeCliente = mensajeTraspaso(datos, atencion);
  await sendMessage(destino, mensajeCliente);

  const textoPedido = mensajeAgente(destino, datos);
  try {
    await sendMessage(AGENT_PHONE, textoPedido);
    console.log(`🔔 Aviso enviado a ${AGENT_NAME}`);
    await registrarAviso('pedido', textoPedido, conversation?.id, true, null);
  } catch (err) {
    console.error('⚠️ NO SE PUDO AVISAR A LA ASESORA:', err.message);
    await registrarAviso('pedido', textoPedido, conversation?.id, false, err.message);
  }

  if (!conversation || !contactId) return;

  try {
    await guardarDatosEnvio(contactId, datos);

    await supabase
      .from('conversations')
      .update({
        handled_by: 'human',
        status: 'waiting_agent',
        updated_at: new Date().toISOString(),
        summary: `${datos.pedido || 'Pedido'}${datos.total ? ` — ${datos.total}` : ''} — pago por ${datos.medio_pago || 'definir'}`
      })
      .eq('id', conversation.id);

    await saveMessage(conversation.id, contactId, 'agent', mensajeCliente);
    console.log('✅ Conversación traspasada a la asesora');
  } catch (err) {
    console.error('⚠️ Error guardando el traspaso:', err.message);
  }
}

function extraerMarcas(respuesta) {
  let texto = respuesta;
  const fotos = [];

  // Marca para reenviarle la foto a la asesora
  const paraAsesora = /\[ASESORA:([^\]]*)\]/.exec(respuesta);
  const motivoAsesora = paraAsesora ? (paraAsesora[1].trim() || 'Revisar') : null;
  texto = texto.replace(/\[ASESORA:[^\]]*\]/g, '').trim();

  const patronFoto = /\[FOTO:([^\]]+)\]/g;
  let m;
  while ((m = patronFoto.exec(respuesta)) !== null) {
    const contenido = m[1].trim();

    if (contenido.toLowerCase() === 'lista') {
      fotos.push({ tipo: 'lista' });
    } else {
      const [modelo, color] = contenido.split('|').map(s => (s || '').trim());
      if (modelo) fotos.push({ tipo: 'modelo', modelo, color: color || null });
    }
  }
  texto = texto.replace(patronFoto, '').trim();

  if (fotos.length > 0) {
    console.log(`🖼️ Marcas de foto encontradas: ${JSON.stringify(fotos)}`);
  }

  const patronDatos = /\[DATOS\]([\s\S]*?)\[\/DATOS\]/;
  const encontrado = texto.match(patronDatos);
  const textoLimpio = texto.replace(patronDatos, '').trim();

  if (!encontrado) return { datos: null, fotos, textoLimpio, motivoAsesora };

  try {
    const datos = JSON.parse(encontrado[1].trim());
    if (!datos.nombre || !datos.direccion) {
      console.log('⚠️ Bloque DATOS incompleto, se ignora');
      return { datos: null, fotos, textoLimpio, motivoAsesora };
    }
    return { datos, fotos, textoLimpio, motivoAsesora };
  } catch (err) {
    console.error('⚠️ Bloque DATOS mal formado:', err.message);
    return { datos: null, fotos, textoLimpio, motivoAsesora };
  }
}

async function guardarDatosEnvio(contactId, datos) {
  const partes = (datos.nombre || '').trim().split(' ');
  const first_name = partes[0] || null;
  const last_name = partes.slice(1).join(' ') || null;

  const { error } = await supabase
    .from('contacts')
    .update({
      display_name: datos.nombre || null,
      first_name,
      last_name,
      metadata: {
        cedula: datos.cedula || null,
        celular: datos.celular || null,
        direccion: datos.direccion || null,
        ciudad: datos.ciudad || null,
        medio_pago: datos.medio_pago || null
      }
    })
    .eq('id', contactId);

  if (error) throw new Error(`guardar datos de envío: ${error.message}`);
  console.log('📦 Datos de envío guardados');
}

// ---------------------------------------------------------------
// TEXTOS
// ---------------------------------------------------------------

function mensajeTraspaso(datos, atencion) {
  const resumen = `📱 ${datos.pedido || 'Tu pedido'}${datos.total ? ` — ${datos.total}` : ''}
📍 ${datos.direccion || ''}${datos.ciudad ? `, ${datos.ciudad}` : ''}
💳 ${datos.medio_pago || 'Por definir'}`;

  let cuando;
  let cierre;

  if (atencion.estado === 'abierto') {
    cuando = `En unos minutos te escribe *${AGENT_NAME}*, de nuestra área de ventas, desde el *${AGENT_DISPLAY}*. No te asustes cuando te llegue de otro número, es parte del proceso 😊`;
    cierre = '¡Gracias por tu compra! Quedas atento que ya te escribe 🙌';
  } else {
    const dia = (atencion.estado === 'temprano') ? 'hoy' : 'mañana';
    const hora = formatHora(atencion.apertura);
    cuando = `Como estamos fuera del horario de atención, nuestra asesora te escribirá *${dia} a partir de las ${hora}*. Se llama *${AGENT_NAME}* y te escribe desde el *${AGENT_DISPLAY}*. No te asustes cuando te llegue de otro número, es parte del proceso 😊`;
    cierre = '¡Gracias por tu compra! Quedas atento a su mensaje 🙌';
  }

  return `¡Perfecto! Tu pedido ya quedó registrado:

${resumen}

${cuando}

Ella ya tiene todos tus datos, así que te da la información de pago y te confirma el envío.

${cierre}`;
}

function mensajeAgente(destino, datos) {
  // El celular que el cliente escribió es el único confiable para wa.me
  const celular = datos.celular || (esTelefono(destino) ? destino : null);
  const wa = paraWaMe(celular);
  const lineaChat = wa
    ? `\n\n💬 Abrir chat: wa.me/${wa}`
    : '\n\n⚠️ Sin número de contacto, responde por el chat del bot';

  return `🔔 NUEVO PEDIDO — pasar a pago

👤 ${datos.nombre || 'Sin nombre'}${datos.cedula ? ` · CC ${datos.cedula}` : ''}
📱 ${celular || 'sin celular'}
🛒 ${datos.pedido || 'Sin detalle'}${datos.total ? ` — ${datos.total}` : ''}
📍 ${datos.direccion || ''}${datos.ciudad ? `, ${datos.ciudad}` : ''}
💳 ${datos.medio_pago || 'Por definir'}${lineaChat}`;
}

function mensajeYaEstaConVentas() {
  const atencion = estadoAtencion();

  if (atencion.estado === 'abierto') {
    return `Ya estás con nuestra área de ventas 😊 ${AGENT_NAME} te ayuda por ese chat con el pago y el envío.

Si aún no te ha escrito, puedes buscarla en el ${AGENT_DISPLAY}.`;
  }

  const dia = (atencion.estado === 'temprano') ? 'hoy' : 'mañana';
  const hora = formatHora(atencion.apertura);

  return `Tu pedido ya quedó registrado 😊 ${AGENT_NAME}, de nuestra área de ventas, te escribe ${dia} a partir de las ${hora} desde el ${AGENT_DISPLAY}.`;
}

// ---------------------------------------------------------------
// BASE DE DATOS
// ---------------------------------------------------------------

async function getOrCreateContact(identificador) {
  const { data: existing, error: findError } = await supabase
    .from('contacts')
    .select('id')
    .eq('client_id', CLIENT_ID)
    .eq('external_id', identificador)
    .limit(1);

  if (findError) throw new Error(`buscar contacto: ${findError.message}`);
  if (existing && existing.length > 0) return existing[0].id;

  const { data: created, error: createError } = await supabase
    .from('contacts')
    .insert([{
      client_id: CLIENT_ID,
      channel_id: CHANNEL_ID,
      external_id: identificador,
      display_name: identificador
    }])
    .select('id');

  if (createError) throw new Error(`crear contacto: ${createError.message}`);

  console.log(`👤 Contacto nuevo creado: ${identificador}`);
  return created[0].id;
}

async function getOrCreateConversation(contactId) {
  const { data: existing, error: findError } = await supabase
    .from('conversations')
    .select('id, handled_by')
    .eq('client_id', CLIENT_ID)
    .eq('contact_id', contactId)
    .in('status', ['open', 'waiting_customer', 'waiting_agent'])
    .order('created_at', { ascending: false })
    .limit(1);

  if (findError) throw new Error(`buscar conversación: ${findError.message}`);
  if (existing && existing.length > 0) return existing[0];

  const { data: created, error: createError } = await supabase
    .from('conversations')
    .insert([{
      client_id: CLIENT_ID,
      channel_id: CHANNEL_ID,
      contact_id: contactId,
      status: 'open',
      handled_by: 'ai',
      source: 'inbound'
    }])
    .select('id, handled_by');

  if (createError) throw new Error(`crear conversación: ${createError.message}`);

  console.log('💬 Conversación nueva creada');
  return created[0];
}

async function saveMessage(conversationId, contactId, senderType, content) {
  const { error } = await supabase
    .from('messages')
    .insert([{
      conversation_id: conversationId,
      contact_id: contactId,
      sender_type: senderType,
      message_type: 'text',
      content: content
    }]);

  if (error) throw new Error(`guardar mensaje (${senderType}): ${error.message}`);
  console.log(`💾 Mensaje guardado (${senderType})`);
}

async function getHistory(conversationId) {
  const { data, error } = await supabase
    .from('messages')
    .select('sender_type, content')
    .eq('conversation_id', conversationId)
    .order('created_at', { ascending: false })
    .limit(HISTORY_LIMIT);

  if (error) throw new Error(`leer historial: ${error.message}`);
  if (!data || data.length === 0) return [];

  const ordenados = data
    .slice()
    .reverse()
    .filter(m => m.content)
    .map(m => ({
      role: m.sender_type === 'contact' ? 'user' : 'assistant',
      content: m.content
    }));

  const limpio = [];
  for (const m of ordenados) {
    if (limpio.length === 0 && m.role !== 'user') continue;

    const ultimo = limpio[limpio.length - 1];
    if (ultimo && ultimo.role === m.role) {
      ultimo.content += '\n' + m.content;
    } else {
      limpio.push({ role: m.role, content: m.content });
    }
  }

  while (limpio.length > 0 && limpio[limpio.length - 1].role === 'user') {
    limpio.pop();
  }

  return limpio;
}

// ---------------------------------------------------------------
// ENVÍO A WHATSAPP
// ---------------------------------------------------------------

async function sendMessage(destino, body) {
  return enviarAMeta(destino, { type: 'text', text: { body: body } }, 'texto');
}

// Le reenvía a la asesora una foto con el contexto del cliente
// motivo llega como "Asunto|Nombre|Pedido|Celular"
async function reenviarAsesora(mediaId, motivo, destino) {
  try {
    const [asunto, nombre, pedido, celular] = String(motivo)
      .split('|')
      .map(s => (s || '').trim());

    const wa = paraWaMe(celular || (esTelefono(destino) ? destino : null));

    const lineas = [`📎 ${asunto || 'Revisar'}`];
    if (nombre) lineas.push(`👤 ${nombre}`);
    if (pedido) lineas.push(`🛒 ${pedido}`);
    lineas.push(`📱 ${celular || 'sin celular'}`);
    if (wa) lineas.push(`💬 wa.me/${wa}`);
    lineas.push('\nRevisa la foto que sigue 👇');

    const textoFoto = lineas.join('\n');
    await sendMessage(AGENT_PHONE, textoFoto);
    await enviarAMeta(AGENT_PHONE, { type: 'image', image: { id: mediaId } }, 'imagen');
    console.log(`📤 Foto reenviada a ${AGENT_NAME}: ${asunto}`);

    const tipo = /preaprob/i.test(asunto) ? 'preaprobado' : 'comprobante';
    await registrarAviso(tipo, textoFoto, null, true, null);
  } catch (err) {
    console.error('⚠️ No pude reenviar la foto a la asesora:', err.message);
  }
}

async function sendImage(destino, imageUrl) {
  return enviarAMeta(destino, { type: 'image', image: { link: imageUrl } }, 'imagen');
}

async function enviarAMeta(destino, contenido, tipo) {
  try {
    if (!destino) {
      console.error(`❌ No hay destinatario para enviar ${tipo}`);
      return;
    }

    const url = `https://graph.facebook.com/v19.0/${META_PHONE_NUMBER_ID}/messages`;

    // Un teléfono va en "to". Un identificador BSUID va en "recipient".
    const destinatario = esTelefono(destino)
      ? { to: destino }
      : { recipient: destino };

    const cuerpo = {
      messaging_product: 'whatsapp',
      ...destinatario,
      ...contenido
    };

    console.log(`📲 Enviando ${tipo} a ${destino}`);

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${META_ACCESS_TOKEN}`
      },
      body: JSON.stringify(cuerpo)
    });

    const data = await res.json();

    if (data.messages) {
      console.log(`✅ ${tipo} enviado a ${destino}`);
    } else {
      console.error(`❌ Error Meta al enviar ${tipo} a ${destino}:`, JSON.stringify(data));
    }
  } catch (error) {
    console.error(`❌ Error enviando ${tipo}:`, error);
  }
}

// ---------------------------------------------------------------
// API PARA EL PANEL — intervenir una conversación
// ---------------------------------------------------------------

function panelAutorizado(req) {
  const clave = req.get('x-panel-key');
  return PANEL_KEY && clave === PANEL_KEY;
}

// POST /api/panel/enviar   { conversationId, texto }
router.post('/api/panel/enviar', async (req, res) => {
  if (!panelAutorizado(req)) return res.status(401).json({ error: 'No autorizado' });

  const { conversationId, texto } = req.body || {};

  if (!conversationId || !texto || !String(texto).trim()) {
    return res.status(400).json({ error: 'Faltan conversationId o texto' });
  }

  try {
    const { data, error } = await supabase
      .from('conversations')
      .select('id, contact_id, contacts(external_id)')
      .eq('client_id', CLIENT_ID)
      .eq('id', conversationId)
      .limit(1);

    if (error) throw new Error(error.message);
    if (!data || data.length === 0) {
      return res.status(404).json({ error: 'Conversación no encontrada' });
    }

    const conv = data[0];
    const destino = conv.contacts?.external_id;

    if (!destino) return res.status(400).json({ error: 'El contacto no tiene identificador' });

    await sendMessage(destino, texto);
    await saveMessage(conv.id, conv.contact_id, 'human', texto);

    await supabase
      .from('conversations')
      .update({ updated_at: new Date().toISOString() })
      .eq('id', conv.id);

    console.log(`🧑‍💻 Mensaje manual enviado desde el panel a ${destino}`);
    return res.json({ ok: true });
  } catch (err) {
    console.error('❌ Error en /api/panel/enviar:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

// POST /api/panel/modo   { conversationId, modo: 'human' | 'ai' }
router.post('/api/panel/modo', async (req, res) => {
  if (!panelAutorizado(req)) return res.status(401).json({ error: 'No autorizado' });

  const { conversationId, modo } = req.body || {};

  if (!conversationId || !['ai', 'human'].includes(modo)) {
    return res.status(400).json({ error: "modo debe ser 'ai' o 'human'" });
  }

  try {
    const { error } = await supabase
      .from('conversations')
      .update({ handled_by: modo, updated_at: new Date().toISOString() })
      .eq('client_id', CLIENT_ID)
      .eq('id', conversationId);

    if (error) throw new Error(error.message);

    console.log(`🎛️ Conversación ${conversationId} pasó a modo ${modo}`);
    return res.json({ ok: true, modo });
  } catch (err) {
    console.error('❌ Error en /api/panel/modo:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

module.exports = router;
