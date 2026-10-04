const express = require('express');
const router = express.Router();
const supabase = require('../../config/database');
const { generateResponse } = require('../ai/claude');
const { estadoAtencion, formatHora } = require('../../utils/horario');

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

// Número principal del equipo: recibe TODOS los avisos (pedidos,
// consultas, casos de garantía, fotos) y es el único autorizado a
// mandarle comandos al bot ("casos", cerrar un caso, etc.). Nunca se
// le da este número a un cliente — todo se resuelve en el mismo chat.
const AGENTE2_PHONE = '573143334860'; // con 57 al inicio, sin espacios

// Copia de todos los avisos de arriba, para que esté al tanto sin
// tener que responder — no es un número autorizado a mandar comandos.
const COPIA_PHONE = '573207679813'; // Duvan, con 57 al inicio, sin espacios

// Saludo de confianza: se manda UNA SOLA VEZ, en el primer mensaje de
// cada contacto nuevo, antes de que la IA entre a la conversación
const SALUDO_CONFIANZA_IMAGEN = 'https://uqqhbqgebwnbpgeztubs.supabase.co/storage/v1/object/public/servicell-images/3ac7bb5f-a052-4982-8ce4-0706b9ee42a0.JPG';
const SALUDO_CONFIANZA_TEXTO = `💙 ¡Hola! Bienvenido/a a *Servicell*.

Estás hablando con nuestro *WhatsApp oficial*.

Sabemos que antes de realizar una compra es importante sentirse seguro, por eso puedes verificar nuestros canales oficiales y confirmar que estás contactando directamente con nosotros 👇

🔎 *Verifica aquí nuestra página oficial y líneas oficiales:*
https://www.instagram.com/p/DdfchQ8kSUJ/?img_index=2&stkn=ZnRqb2ZpNTF1aTdw

Ahora sí 😊 cuéntame, ¿qué iPhone estás buscando?`;

const PALABRAS_CASOS = ['casos', 'pendientes', 'ventas', 'pedidos'];
const HISTORY_LIMIT = 12;

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

        // Las fotos sí las puede ver la IA. Si había texto esperando
        // (mensajes mandados justo antes), se lo mandamos junto con
        // la foto en vez de perderlo o mandarlo aparte.
        if (message.type === 'image') {
          const pendiente = sacarTextoPendiente(destino);
          const pie = [pendiente, message.image?.caption || ''].filter(Boolean).join('\n');
          console.log(`🖼️ Foto recibida de ${destino}`);
          handleMessage(destino, pie, message.image?.id).catch(err => {
            console.error('Error en handleMessage:', err);
          });
          return;
        }

        // Lo demás (audio, sticker, video, documento) no se puede procesar
        if (message.type !== 'text') {
          sacarTextoPendiente(destino); // no se puede combinar con esto, se pierde igual
          console.log(`🎙️ Mensaje tipo "${message.type}" de ${destino}`);
          responderNoTexto(destino, message.type).catch(err => {
            console.error('Error respondiendo a no-texto:', err);
          });
          return;
        }

        console.log(`📱 Mensaje de ${destino}: ${text}`);
        encolarTexto(destino, text);
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

// El horario de atención vive en src/utils/horario.js — lo comparten
// este archivo y la IA (ver claude.js), para no tener dos copias de
// la misma lógica.

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
    const [contactId, contactoNuevo] = await getOrCreateContact(destino);
    const conversation = await getOrCreateConversation(contactId);

    if (contactoNuevo) {
      console.log('💙 Contacto nuevo — mandando saludo de confianza');
      await enviarSaludoConfianza(destino, conversation, contactId);
      return;
    }

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

// ---------------------------------------------------------------
// AGRUPAR MENSAJES SEGUIDOS
// ---------------------------------------------------------------
// Cuando un cliente manda varias burbujas de WhatsApp seguidas y
// rápido (una idea partida en varios mensajes), cada una llegaba por
// su lado a la IA, que respondía a cada pedacito por separado sin
// ver el conjunto. Acá se agrupan: si llega más de un mensaje del
// mismo número en pocos segundos, se juntan en uno solo antes de
// llamar a la IA.
const ESPERA_AGRUPAR_MS = 4000;
const buffersPorDestino = new Map(); // destino -> { textos: string[], timer }

function encolarTexto(destino, texto) {
  let buffer = buffersPorDestino.get(destino);
  if (!buffer) {
    buffer = { textos: [] };
    buffersPorDestino.set(destino, buffer);
  }
  if (texto) buffer.textos.push(texto);

  clearTimeout(buffer.timer);
  buffer.timer = setTimeout(() => {
    buffersPorDestino.delete(destino);
    const textoCombinado = buffer.textos.join('\n');
    if (buffer.textos.length > 1) {
      console.log(`📦 Se agruparon ${buffer.textos.length} mensajes de ${destino} en uno solo`);
    }
    handleMessage(destino, textoCombinado).catch(err => {
      console.error('Error en handleMessage:', err);
    });
  }, ESPERA_AGRUPAR_MS);
}

// Si había texto esperando a agruparse cuando llega una foto (u otro
// tipo de mensaje), lo saca del buffer para no perderlo ni mandarlo
// aparte.
function sacarTextoPendiente(destino) {
  const buffer = buffersPorDestino.get(destino);
  if (!buffer) return '';
  clearTimeout(buffer.timer);
  buffersPorDestino.delete(destino);
  return buffer.textos.join('\n');
}

async function handleMessage(destino, text, imagenId = null) {
  if (destino === AGENTE2_PHONE) {
    await handleAgente(text);
    return;
  }

  let contactId = null;
  let contactoNuevo = false;
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

      // Copia SIEMPRE al equipo, sin depender de que la IA decida
      // avisar — así ve cualquier foto que mande un cliente, no solo
      // las que la IA clasifica como comprobante o preaprobado.
      copiaFotoSiempreAlEquipo(destino, imagenId, text).catch(err => {
        console.error('⚠️ No pude mandar la copia automática de la foto:', err.message);
      });
    } catch (err) {
      console.error('⚠️ No pude descargar la foto:', err.message);
      await sendMessage(destino, 'Disculpa, no pude abrir esa foto 🙈 ¿Me la puedes reenviar o contarme por escrito qué necesitas?');
      return;
    }
  }

  try {
    [contactId, contactoNuevo] = await getOrCreateContact(destino);
    conversation = await getOrCreateConversation(contactId);

    if (contactoNuevo) {
      console.log('💙 Contacto nuevo — mandando saludo de confianza');
      await saveMessage(conversation.id, contactId, 'contact', textoParaGuardar);
      await enviarSaludoConfianza(destino, conversation, contactId);
      return;
    }

    if (conversation.handled_by === 'human') {
      console.log('🤐 Conversación en manos de la asesora, el bot no responde');
      await saveMessage(conversation.id, contactId, 'contact', textoParaGuardar);
      const esAgente2 = String(conversation.summary || '').startsWith('Agente 2:');
      const esRevisionBloqueada = String(conversation.summary || '').startsWith('Respuesta bloqueada:');
      const mensaje = esAgente2
        ? mensajeYaEstaConAgente2()
        : esRevisionBloqueada
          ? mensajeYaEstaEnRevision()
          : mensajeYaEstaConVentas();
      await sendMessage(destino, mensaje);
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
        // Si ya conocemos el celular o el nombre del cliente, se lo decimos a la IA
    let contenidoParaIA = contenidoUsuario;
    const guardado = await datosDelContacto(contactId);
    if (guardado.celular || guardado.nombre) {
      const partes = [];
      if (guardado.nombre) partes.push(`su nombre es ${guardado.nombre}`);
      if (guardado.celular) {
        const cel = String(guardado.celular).replace(/^57(?=\d{10}$)/, '');
        partes.push(`su celular es ${cel} (es el número desde el que escribe)`);
      }
      const nota = `\n\n[NOTA INTERNA: ${partes.join(' y ')}. Ya lo tienes, no se lo vuelvas a pedir.]`;
      contenidoParaIA = Array.isArray(contenidoUsuario)
        ? contenidoUsuario.map(b => b.type === 'text' ? { ...b, text: b.text + nota } : b)
        : contenidoUsuario + nota;
      console.log(`📞 Datos conocidos del cliente: ${partes.join(', ')}`);
    }

    const { texto: respuestaCruda, agotados: modelosAgotados } = await generateResponse(contenidoParaIA, CLIENT_ID, history);

        // Consultas para el agente 2 (descuentos, SIM, etc.)
    const marcaAgente2 = /\[AGENTE2:([^\]]*)\]/.exec(respuestaCruda);
    const respuestaSinAgente2 = respuestaCruda.replace(/\[AGENTE2:[^\]]*\]/g, '').trim();
    let esPlanRetoma = false;
    if (marcaAgente2) {
      await avisarAgente2(marcaAgente2[1], destino, contactId, conversation);
      esPlanRetoma = /^plan retoma/i.test(String(marcaAgente2[1]).split('|')[0].trim());
    } else {
      esPlanRetoma = await redAgente2PlanRetoma(respuestaCruda, destino, contactId, conversation);
    }

    const { datos, fotos, textoLimpio: textoGenerado, motivoAsesora } = extraerMarcas(respuestaSinAgente2);
    // El plan retoma a veces sale marcado como [ASESORA:Plan retoma|...]
    // en vez de [AGENTE2:...] (depende de la version del prompt) — el
    // mensaje fijo con horario correcto aplica en los dos casos.
    if (!esPlanRetoma && motivoAsesora) {
      esPlanRetoma = /^plan retoma/i.test(String(motivoAsesora).split('|')[0].trim());
    }
    // Red de seguridad final: no depende de que la IA escriba el
    // asunto exacto "Plan retoma" en la marca. Si el cliente mencionó
    // plan retoma en la conversación y la IA mandó CUALQUIER marca
    // interna en esta respuesta, se trata como plan retoma igual.
    if (!esPlanRetoma && (marcaAgente2 || motivoAsesora)) {
      const historialClienteTexto = history.map(m => m.content).filter(Boolean).join(' ');
      esPlanRetoma = mencionaPlanRetoma(`${historialClienteTexto} ${text}`);
    }
    // El mensaje de plan retoma queda fijo y con horario correcto, sin
    // depender de que la IA lo redacte bien cada vez
    const textoLimpio = esPlanRetoma ? mensajePlanRetomaConfirmando() : textoGenerado;

    // La pausa se aplica siempre aquí, sin importar por cuál camino se
    // detectó el plan retoma — así no depende de que avisarAgente2 o
    // avisarAsesora hayan reconocido el asunto exacto por su cuenta.
    if (esPlanRetoma && conversation?.id) {
      await supabase
        .from('conversations')
        .update({
          handled_by: 'human',
          status: 'waiting_agente2',
          updated_at: new Date().toISOString(),
          summary: 'Plan retoma'
        })
        .eq('id', conversation.id);
      console.log('🤐 Conversación pausada — plan retoma');
    }

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
      const historialTexto = history.map(m => m.content).filter(Boolean).join(' ');
      const riesgo = respuestaTieneRiesgo(textoLimpio, historialTexto, modelosAgotados);

      if (riesgo) {
        console.error(`🚨 Respuesta bloqueada (${riesgo}): ${textoLimpio}`);
        const mensajeSeguro = 'Dame un momento, ya te confirmo eso.';
        await sendMessage(destino, mensajeSeguro);
        const textoBloqueo = `La IA iba a responder esto, lo bloqueé antes de que le llegara al cliente:\n\n"${textoLimpio}"\n\nEntra al panel y respóndele tú.`;
        await sendMessage(AGENTE2_PHONE, `⚠️ RESPUESTA BLOQUEADA (${riesgo})\n\n${textoBloqueo}`);
        await copiaParaDuvan(`⚠️ RESPUESTA BLOQUEADA (${riesgo})`, textoBloqueo);
        if (conversation?.id) {
          await supabase
            .from('conversations')
            .update({
              handled_by: 'human',
              status: 'waiting_agent',
              updated_at: new Date().toISOString(),
              summary: `Respuesta bloqueada: ${riesgo}`
            })
            .eq('id', conversation.id);
        }
        if (conversation) {
          saveMessage(conversation.id, contactId, 'agent', mensajeSeguro)
            .catch(err => console.error('⚠️ No se guardó la respuesta:', err.message));
        }
      } else {
        console.log(`✍️ Respuesta: ${textoLimpio}`);
        await sendMessage(destino, textoLimpio);

        await redAsesora(textoLimpio, destino, contactId, conversation);

        if (conversation) {
          saveMessage(conversation.id, contactId, 'agent', textoLimpio)
            .catch(err => console.error('⚠️ No se guardó la respuesta:', err.message));
        }
      }
    } else if (fotos.length === 0) {
      // No quedó texto para mandar (por ejemplo, un [DATOS] inválido
      // sin dirección, en un mensaje que no traía nada más). Sin este
      // respaldo, el cliente se queda sin ninguna respuesta.
      console.warn('⚠️ La IA no dejó texto para responder — se manda un mensaje de respaldo');
      const mensajeRespaldo = 'Dame un momento, ya te confirmo eso.';
      await sendMessage(destino, mensajeRespaldo);
      if (conversation) {
        saveMessage(conversation.id, contactId, 'agent', mensajeRespaldo)
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
      await sendMessage(AGENTE2_PHONE, 'Listo, no cerré nada 👌');
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
      await sendMessage(AGENTE2_PHONE, mensajeCasos(casos));
    } catch (err) {
      console.error('⚠️ Error consultando casos:', err.message);
      await sendMessage(AGENTE2_PHONE, 'No pude consultar los casos en este momento. Intenta de nuevo en un minuto.');
    }
    return;
  }

  console.log('👔 Mensaje de la asesora sin comando, se ignora');
}

async function pedirConfirmacionCierre(numero) {
  try {
    const casos = await getCasosPendientes();

    if (numero < 1 || numero > casos.length) {
      await sendMessage(AGENTE2_PHONE, `No existe el caso ${numero}. Escribe "casos" para ver la lista.`);
      return;
    }

    const caso = casos[numero - 1];
    const nombre = caso.contacts?.display_name || 'Sin nombre';

    cierrePendiente = { id: caso.id, nombre };

    await sendMessage(
      AGENTE2_PHONE,
      `¿Cierro el caso de ${nombre}?\n${caso.summary || ''}\n\nResponde "si" para confirmar.`
    );
  } catch (err) {
    console.error('⚠️ Error preparando cierre:', err.message);
    await sendMessage(AGENTE2_PHONE, 'No pude consultar los casos en este momento.');
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

    await sendMessage(AGENTE2_PHONE, `✅ Caso de ${caso.nombre} cerrado.\n${texto}`);
    console.log(`✅ Caso cerrado: ${caso.nombre}`);
  } catch (err) {
    console.error('⚠️ Error cerrando el caso:', err.message);
    await sendMessage(AGENTE2_PHONE, 'No pude cerrar el caso. Intenta de nuevo en un minuto.');
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
      destinatario: AGENTE2_PHONE,
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
// Agente 2: consultas que decide otra persona (descuentos, SIM, etc.)
// motivo llega como "Motivo|Detalle" — ya no pide nombre ni celular al cliente
async function avisarAgente2(motivo, destino, contactId, conversation) {
  try {
    const [asunto, detalle] = String(motivo)
      .split('|')
      .map(s => (s || '').trim());

    const guardado = await datosDelContacto(contactId);
    const celular = esTelefono(destino) ? destino : guardado.celular;
    const wa = paraWaMe(celular);

    const lineas = [`🟣 CONSULTA — ${asunto || 'Sin clasificar'}`];
    if (detalle) lineas.push(`📝 ${detalle}`);
    if (celular) {
      lineas.push(`📱 ${celular}`);
      if (wa) lineas.push(`💬 wa.me/${wa}`);
    } else {
      lineas.push(`🔎 Sin celular. Buscar en el panel con: ${destino || 'sin identificador'}`);
    }
    if (conversation?.id) lineas.push(`🆔 Chat: ${conversation.id}`);

    const debePausar = /^plan retoma/i.test(asunto || '');
    lineas.push(debePausar
      ? '\nEl chat ya quedó en pausa esperando tu respuesta.'
      : '\nEntra al panel, silencia el chat si hace falta y respóndele.');

    const texto = lineas.join('\n');
    await sendMessage(AGENTE2_PHONE, texto);
    console.log(`🟣 Aviso a agente 2: ${asunto}`);
    await registrarAviso('agente2', texto, conversation?.id, true, null);
    await copiaParaDuvan('Consulta', texto);

    const resumen = `Agente 2: ${asunto || 'sin clasificar'}${detalle ? ` — ${detalle}` : ''}`;

    if (debePausar && conversation?.id) {
      await supabase
        .from('conversations')
        .update({
          handled_by: 'human',
          status: 'waiting_agente2',
          updated_at: new Date().toISOString(),
          summary: resumen
        })
        .eq('id', conversation.id);
      console.log('🤐 Conversación pausada — esperando plan retoma');
    } else {
      await marcarEsperandoAsesora(conversation, resumen, 'waiting_agente2');
    }
  } catch (err) {
    console.error('⚠️ No pude avisar al agente 2:', err.message);
  }
}

// Copia a Duvan de un aviso que ya le llegó al número principal —
// para que esté al tanto, sin que tenga que responder desde aquí
async function copiaParaDuvan(etiqueta, texto) {
  try {
    await sendMessage(COPIA_PHONE, `🔴 COPIA (${etiqueta}) — esto ya se avisó, no hace falta que respondas aquí:\n\n${texto}`);
  } catch (err) {
    console.error('⚠️ No pude mandar la copia a Duvan:', err.message);
  }
}

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

    // El plan retoma sí pausa el chat del todo: hay que evaluar el
    // equipo en persona, así que seguir conversando con el bot
    // mientras tanto no sirve de nada.
    const debePausar = /^plan retoma/i.test(asunto || '');
    lineas.push(debePausar
      ? '\nEl chat ya quedó en pausa esperando tu respuesta.'
      : '\nEntra al panel, silencia el chat si hace falta y respóndele.');

    const textoAviso = lineas.join('\n');
    await sendMessage(AGENTE2_PHONE, textoAviso);
    console.log(`🔔 Aviso de consulta enviado: ${asunto}`);
    await registrarAviso('consulta', textoAviso, conversation?.id, true, null);
    await copiaParaDuvan('Consulta', textoAviso);

    const resumen = `Consulta: ${asunto || 'sin clasificar'}${nombre ? ` — ${nombre}` : ''}`;

    if (debePausar && conversation?.id) {
      await supabase
        .from('conversations')
        .update({
          handled_by: 'human',
          status: 'waiting_agent',
          updated_at: new Date().toISOString(),
          summary: resumen
        })
        .eq('id', conversation.id);
      console.log('🤐 Conversación pausada — esperando plan retoma');
    } else {
      await marcarEsperandoAsesora(conversation, resumen);
    }
  } catch (err) {
    console.error('⚠️ No pude avisar a la asesora:', err.message);
  }
}

// Deja el caso en la lista de "casos" SIN silenciar al bot
// (handled_by sigue en 'ai', el cliente puede seguir conversando)
async function marcarEsperandoAsesora(conversation, resumen, status = 'waiting_agent') {
  if (!conversation) return;
  try {
    await supabase
      .from('conversations')
      .update({
        status,
        summary: resumen,
        updated_at: new Date().toISOString()
      })
      .eq('id', conversation.id);
    console.log('📋 Conversación marcada como pendiente');
  } catch (err) {
    console.error('⚠️ No pude marcar la conversación:', err.message);
  }
}

function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// La IA confía en su propio conocimiento del mundo real para modelos
// famosos (ej. "iPhone 18 Pro") y a veces confirma que lo tienen aunque
// el inventario diga AGOTADO — probado directamente contra el modelo,
// ni poniendo la regla más arriba en el prompt lo evitó siempre. Esta
// red de seguridad no depende del texto del prompt: recibe la lista de
// modelos sin ningún stock (ver getProductsInfo en claude.js) y bloquea
// si la respuesta los menciona sin negar la disponibilidad.
function confirmaModeloAgotado(textoMinuscula, modelosAgotados) {
  if (!Array.isArray(modelosAgotados) || modelosAgotados.length === 0) return null;

  for (const nombre of modelosAgotados) {
    if (!nombre) continue;
    // Lookahead para que "iPhone 18 Pro" no haga match dentro de
    // "iPhone 18 Pro Max" cuando ese SÍ tiene stock — son modelos
    // distintos aunque uno sea substring del otro.
    const regexNombre = new RegExp(`\\b${escapeRegex(nombre.toLowerCase())}\\b(?!\\s+(pro|max|plus|mini))`);
    if (!regexNombre.test(textoMinuscula)) continue;

    const niegaDisponibilidad = /agotad[oa]|no lo tenemos|no la tenemos|no manejamos|no disponible|no hay unidades|se nos agot[oó]/.test(textoMinuscula);
    if (niegaDisponibilidad) continue;

    const afirmaDisponibleOPrecio =
      /\b(s[ií]|tenemos|hay|disponible|lo tenemos|lo manejamos|nos lleg[oó])\b/.test(textoMinuscula) ||
      /\$\s?\d/.test(textoMinuscula);
    if (afirmaDisponibleOPrecio) return `modelo agotado (${nombre}) confirmado como disponible`;
  }

  return null;
}

// Desde el iPhone 14 en adelante (cualquier variante: Pro, Pro Max o
// normal) es eSIM — del 13 Pro Max para atrás es SIM física. Es por
// GENERACIÓN, no por si es Pro, así que basta con el número. Probado
// directo contra el modelo: aunque el prompt lo dice bien, Haiku sigue
// asumiendo SIM física para modelos recientes (probablemente porque
// fuera de EE. UU. muchos sí la traen) — mismo patrón que el stock.
function generacionesMencionadas(texto) {
  const matches = [...String(texto || '').toLowerCase().matchAll(/iphone\s*(\d{2})\b/g)];
  return [...new Set(matches.map(m => parseInt(m[1], 10)).filter(n => n >= 11 && n <= 20))];
}

function confirmaSimIncorrecta(textoMinuscula, historialTexto) {
  const contexto = `${historialTexto || ''} ${textoMinuscula}`;
  const generaciones = generacionesMencionadas(contexto);
  if (generaciones.length === 0) return null;

  const idxFisica = textoMinuscula.search(/\bsim f[ií]sica\b/);
  const niegaFisica = idxFisica !== -1 && /\bno\b/.test(textoMinuscula.slice(Math.max(0, idxFisica - 25), idxFisica));
  const afirmaFisica = idxFisica !== -1 && !niegaFisica;
  const afirmaEsim = /\be ?sim\b|sim virtual/.test(textoMinuscula);

  if (!afirmaFisica && !afirmaEsim) return null;

  for (const gen of generaciones) {
    const debeSerEsim = gen >= 14;
    if (debeSerEsim && afirmaFisica) {
      return `tipo de SIM incorrecto (iPhone ${gen} es eSIM, la respuesta afirma SIM física)`;
    }
    if (!debeSerEsim && afirmaEsim && !afirmaFisica) {
      return `tipo de SIM incorrecto (iPhone ${gen} es SIM física, la respuesta afirma eSIM)`;
    }
  }

  return null;
}

// GUARDIÁN DE RESPUESTAS: revisa el texto que la IA va a mandarle al
// cliente y bloquea las promesas de alto riesgo (plata) que la tienda
// nunca hace, sin depender de que el prompt se cumpla al pie de la letra.
// Devuelve el motivo del bloqueo, o null si la respuesta es segura.
function respuestaTieneRiesgo(texto, historialTexto, modelosAgotados) {
  const t = String(texto || '').toLowerCase();

  const riesgoSim = confirmaSimIncorrecta(t, historialTexto);
  if (riesgoSim) return riesgoSim;

  const riesgoAgotado = confirmaModeloAgotado(t, modelosAgotados);
  if (riesgoAgotado) return riesgoAgotado;

  // Ninguna frase que diga que el cargador/cubo/adaptador viene incluido
  // es válida — eso nunca es cierto, ni en iPhone ni en iPad.
  const frasesAccesorioIncluido = [
    'cargador completo incluido',
    'cargador incluido',
    'trae cargador',
    'viene con cargador',
    'incluye cargador',
    'incluye adaptador',
    'incluye el cubo',
    'incluye cubo',
    'viene con cubo',
    'viene con el cubo',
    'viene con adaptador',
    'con todo lo de fábrica'
  ];
  const prometeAccesorioIncluido = frasesAccesorioIncluido.some(frase => {
    const idx = t.indexOf(frase);
    if (idx === -1) return false;
    const antes = t.slice(Math.max(0, idx - 20), idx);
    return !/\bno\b/.test(antes);
  });
  if (prometeAccesorioIncluido) return 'accesorio ofrecido como incluido';

  // Contra entrega solo aplica a equipos de exhibición. Los NUEVOS
  // (línea iPhone 17, iPad, computadores) nunca la tienen — si el
  // modelo aparece en la conversación (mensaje actual + historial
  // reciente), bloquea la promesa.
  const afirmaContraEntrega =
    /manejamos contra entrega|contra entrega (funciona|es bien f[aá]cil|sin problema|perfecto)/.test(t) &&
    !/no manejamos contra entrega|no hacemos contra entrega/.test(t);
  if (afirmaContraEntrega) {
    const contexto = `${historialTexto || ''} ${t}`.toLowerCase();
    const esEquipoNuevo = /iphone\s*17\b|17\s*pro\s*max|\b17\s*pro\b|ipad|macbook|mac\s*book|computador|port[aá]til|laptop/.test(contexto);
    if (esEquipoNuevo) return 'contra entrega ofrecida para un equipo nuevo (iPhone 17, iPad o computador)';
  }

  if (confirmaColorSinVerificar(t)) {
    return 'color confirmado como disponible sin la salvedad de verificar';
  }

  return null;
}

// Las unidades cambian de color más rápido de lo que el inventario se
// actualiza (ver prompt, REGLA #3). Si la IA da un color por hecho
// SIN la salvedad de que hay que verificarlo, se bloquea — así no se
// le promete al cliente algo que puede no estar cuando llegue.
const COLORES_CONOCIDOS = [
  // Español
  'negro', 'blanco', 'plata', 'plateado', 'dorado', 'oro', 'azul', 'morado',
  'lila', 'verde', 'rojo', 'rosado', 'rosa', 'amarillo', 'naranja', 'gris',
  'titan', 'titán', 'espacial', 'natural', 'medianoche', 'grafito',
  'purpura', 'púrpura', 'cobre', 'bronce',
  // Inglés — el prompt (sección COLORES) le enseña a la IA a usar la
  // palabra del cliente tal cual, que puede venir en inglés
  'silver', 'black', 'white', 'gold', 'blue', 'purple', 'green',
  'midnight', 'graphite'
];

function confirmaColorSinVerificar(textoMinuscula) {
  // Si el mensaje trae un precio, es una respuesta de precio/inventario
  // (ej. "el más económico es el iPhone 11 en negro por $700.000") y
  // menciona el color solo como dato del equipo, no como confirmación
  // de color para cerrar la venta (PASO 6). El guion real de PASO 6
  // nunca incluye un precio.
  if (/\$\s?\d/.test(textoMinuscula)) return false;

  // \b en ambos lados: sin el de cierre, "plata" hace match dentro de
  // "plataforma", "natural" dentro de "naturalmente", etc.
  const tieneColor = COLORES_CONOCIDOS.some(c => new RegExp(`\\b${c}\\b`).test(textoMinuscula));
  if (!tieneColor) return false;

  const afirmaDisponible = /\b(s[ií]|tenemos|hay|disponible|lo tenemos|nos lleg[oó])\b/.test(textoMinuscula);
  if (!afirmaDisponible) return false;

  const tieneSalvedad = /rota(n)?|rotando|verificar|confirmar|disponibilidad exacta|seg[uú]n el registro|se nos agot[oó]/.test(textoMinuscula);
  if (tieneSalvedad) return false;

  return true;
}

// ¿En algún punto de esto se mencionó plan retoma? Se usa como red de
// seguridad final: si el cliente lo mencionó y la IA mandó cualquier
// marca interna, se trata como plan retoma aunque la IA no haya
// escrito el asunto exacto "Plan retoma".
function mencionaPlanRetoma(texto) {
  return /plan retoma|\bretoma\b|parte de pago|recibir mi equipo usado|me reciben el m[ií]o/i.test(String(texto || ''));
}

// ¿La respuesta menciona el número de la asesora, en cualquier formato?
function mencionaAsesora(texto) {
  const soloDigitos = String(texto || '').replace(/\D/g, '');
  if (soloDigitos.includes(AGENTE2_PHONE.slice(2))) return true;

  // Frases de flujos que deberían traer marca [ASESORA:...] pero a
  // veces la IA las dice sin ponerla
  const t = String(texto || '').toLowerCase();
  const frasesSinMarca = ['te tenemos anotado'];
  return frasesSinMarca.some(frase => t.includes(frase));
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

// ¿La respuesta confirma un plan retoma sin traer la marca [AGENTE2:...]?
// Frase de la IA al confirmarlo (ver prompt, PLAN RETOMA / PARTE DE PAGO,
// PASO 3): "...confirmar en cuánto te podemos recibir el equipo..."
function mencionaPlanRetomaSinMarca(texto) {
  return /en cu[aá]nto te (podemos recibir|recibimos)/i.test(String(texto || ''));
}

// RED DE SEGURIDAD: si la IA confirmó un plan retoma pero olvidó la
// marca [AGENTE2:Plan retoma|...], el aviso sale igual — sin esto, el
// cliente queda esperando una respuesta que nadie va a mandar.
async function redAgente2PlanRetoma(texto, destino, contactId, conversation) {
  if (!mencionaPlanRetomaSinMarca(texto)) return false;

  if (!puedeAvisar(destino)) {
    console.log('🔕 Ya se avisó de este cliente hace poco, no se repite');
    return true;
  }

  console.log('🕸️ Se confirmó un plan retoma sin marca — aviso automático');
  await avisarAgente2(
    'Plan retoma|Marca perdida — revisar el chat completo para los datos del equipo',
    destino,
    contactId,
    conversation
  );
  avisoYaEnviado(destino);
  return true;
}

async function cerrarVenta(destino, contactId, conversation, datos) {
  const atencion = estadoAtencion();
  console.log(`🕐 Estado de atención: ${atencion.estado}`);

  const mensajeCliente = mensajeTraspaso(datos, atencion);
  await sendMessage(destino, mensajeCliente);

  const textoPedido = mensajeAgente(destino, datos);
  try {
    await sendMessage(AGENTE2_PHONE, textoPedido);
    console.log('🔔 Aviso de pedido enviado');
    await registrarAviso('pedido', textoPedido, conversation?.id, true, null);
    await copiaParaDuvan('Pedido', textoPedido);
  } catch (err) {
    console.error('⚠️ NO SE PUDO AVISAR A LA ASESORA:', err.message);
    await registrarAviso('pedido', textoPedido, conversation?.id, false, err.message);
  }

  if (!conversation || !contactId) return;

  try {
    await guardarDatosEnvio(contactId, datos);

    // No se pone handled_by: 'human' aquí a propósito: el cliente
    // puede seguir preguntando después de cerrar el pedido (otro
    // accesorio, un cambio, una duda), y el bot debe poder seguir
    // atendiéndolo. La venta ya quedó avisada a la asesora arriba;
    // si un caso puntual necesita silenciar el chat, se hace a mano
    // desde el panel.
    await supabase
      .from('conversations')
      .update({
        status: 'waiting_agent',
        updated_at: new Date().toISOString(),
        summary: `${datos.pedido || 'Pedido'}${datos.total ? ` — ${datos.total}` : ''} — pago por ${datos.medio_pago || 'definir'}`
      })
      .eq('id', conversation.id);

    await saveMessage(conversation.id, contactId, 'agent', mensajeCliente);
    console.log('✅ Pedido registrado, asesora avisada — el bot sigue disponible');
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
    cuando = 'En unos minutos seguimos por acá mismo con el pago y el envío 😊';
    cierre = '¡Gracias por tu compra! Quedas atento por este chat 🙌';
  } else {
    const dia = (atencion.estado === 'temprano') ? 'hoy' : 'mañana';
    const hora = formatHora(atencion.apertura);
    cuando = `Como estamos fuera del horario de atención, seguimos *${dia} a partir de las ${hora}*, por este mismo chat 😊`;
    cierre = '¡Gracias por tu compra! Quedas atento por este chat 🙌';
  }

  return `¡Perfecto! Tu pedido ya quedó registrado:

${resumen}

${cuando}

Ya tenemos todos tus datos, así que por acá mismo te damos la información de pago y te confirmamos el envío.

${cierre}`;
}

// Mensaje fijo para cuando se escala un caso de plan retoma — con
// horario correcto, sin depender de que la IA lo redacte bien
function mensajePlanRetomaConfirmando() {
  const atencion = estadoAtencion();

  if (atencion.estado === 'abierto') {
    return 'Listo, danos un momento para evaluarlo. Te confirmamos por este mismo chat en cuanto lo tengamos.';
  }

  const dia = (atencion.estado === 'temprano') ? 'hoy' : 'mañana';
  const hora = formatHora(atencion.apertura);
  return `Listo, ya quedó registrado. Como estamos fuera del horario de atención, te confirmamos *${dia} a partir de las ${hora}* por este mismo chat.`;
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
    return 'Ya estás con nuestra área de ventas 😊 Seguimos por este mismo chat con el pago y el envío.';
  }

  const dia = (atencion.estado === 'temprano') ? 'hoy' : 'mañana';
  const hora = formatHora(atencion.apertura);

  return `Tu pedido ya quedó registrado 😊 Seguimos por este mismo chat ${dia} a partir de las ${hora}.`;
}

function mensajeYaEstaConAgente2() {
  return 'Seguimos consultando tu caso 🧡 Apenas tengamos la respuesta te escribimos por este mismo chat.';
}

// Para cuando una respuesta se bloqueó (revisión pendiente) y el cliente
// vuelve a escribir antes de que alguien la revise. A diferencia de
// mensajeYaEstaConVentas, aquí NO hay pedido ni pago de por medio —
// no se puede reutilizar ese mensaje o el cliente cree que ya compró.
function mensajeYaEstaEnRevision() {
  return 'Ya tenemos tu mensaje anotado 😊 en un momento te ayudamos por este mismo chat.';
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
  if (existing && existing.length > 0) return [existing[0].id, false];

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
  return [created[0].id, true];
}

async function getOrCreateConversation(contactId) {
  const { data: existing, error: findError } = await supabase
    .from('conversations')
    .select('id, handled_by, summary')
    .eq('client_id', CLIENT_ID)
    .eq('contact_id', contactId)
    .in('status', ['open', 'waiting_customer', 'waiting_agent', 'waiting_agente2'])
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

// Manda SIEMPRE una copia de cualquier foto que mande un cliente al
// número principal y a Duvan, sin depender de que la IA la clasifique
// como comprobante, preaprobado o cualquier otro caso puntual.
async function copiaFotoSiempreAlEquipo(destino, mediaId, textoCliente) {
  const wa = esTelefono(destino) ? paraWaMe(destino) : null;
  const lineas = ['📷 Foto de un cliente (copia automática)'];
  if (textoCliente) lineas.push(`📝 "${textoCliente}"`);
  if (wa) lineas.push(`💬 wa.me/${wa}`);
  else lineas.push(`🔎 Identificador: ${destino}`);

  await sendMessage(AGENTE2_PHONE, lineas.join('\n'));
  await enviarAMeta(AGENTE2_PHONE, { type: 'image', image: { id: mediaId } }, 'imagen');
  await copiaParaDuvan('Foto', lineas.join('\n'));
  await enviarAMeta(COPIA_PHONE, { type: 'image', image: { id: mediaId } }, 'imagen');
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
    await sendMessage(AGENTE2_PHONE, textoFoto);
    await enviarAMeta(AGENTE2_PHONE, { type: 'image', image: { id: mediaId } }, 'imagen');
    console.log(`📤 Foto reenviada: ${asunto}`);

    const tipo = /preaprob/i.test(asunto) ? 'preaprobado' : 'comprobante';
    await registrarAviso(tipo, textoFoto, null, true, null);
    await copiaParaDuvan('Foto', textoFoto);
    await enviarAMeta(COPIA_PHONE, { type: 'image', image: { id: mediaId } }, 'imagen');
  } catch (err) {
    console.error('⚠️ No pude reenviar la foto a la asesora:', err.message);
  }
}

async function sendImage(destino, imageUrl) {
  return enviarAMeta(destino, { type: 'image', image: { link: imageUrl } }, 'imagen');
}

// Manda el saludo de confianza (imagen + texto en un solo mensaje) y
// lo guarda en el historial para que la IA sepa que ya se mandó
async function enviarSaludoConfianza(destino, conversation, contactId) {
  await enviarAMeta(
    destino,
    { type: 'image', image: { link: SALUDO_CONFIANZA_IMAGEN, caption: SALUDO_CONFIANZA_TEXTO } },
    'saludo de confianza'
  );
  if (conversation?.id) {
    saveMessage(conversation.id, contactId, 'agent', SALUDO_CONFIANZA_TEXTO)
      .catch(err => console.error('⚠️ No se guardó el saludo de confianza:', err.message));
  }
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
