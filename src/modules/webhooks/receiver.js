const express = require('express');
const router = express.Router();
const supabase = require('../../config/database');
const { generateResponse } = require('../ai/claude');

const META_ACCESS_TOKEN = process.env.META_ACCESS_TOKEN;
const META_PHONE_NUMBER_ID = process.env.META_PHONE_NUMBER_ID;
const META_VERIFY_TOKEN = process.env.META_VERIFY_TOKEN;

// ---------------------------------------------------------------
// CONFIGURACIÓN — esto es lo único que hay que cambiar
// ---------------------------------------------------------------

// ID de Servicell en la tabla clients
const CLIENT_ID = 'c37d2508-c9d1-422d-9fef-23901bc51145';

// ID del canal "Servicell WhatsApp" en la tabla channels
const CHANNEL_ID = '18e8df74-2ed5-415b-ac84-2b043eebac7b';

// Asesora que recibe los casos de pago
const AGENT_PHONE = '573227831687';   // con 57 al inicio, sin espacios
const AGENT_NAME = 'Adriana';
const AGENT_DISPLAY = '322 783 1687'; // como se le muestra al cliente

// Horarios de atención, en minutos desde medianoche (hora de Colombia)
// 9:30am = 570 · 10am = 600 · 4pm = 960 · 7pm = 1140
const HORARIO_SEMANA  = { apertura: 570, cierre: 1140 }; // lunes a sábado
const HORARIO_DOMINGO = { apertura: 600, cierre: 960 };  // domingos y festivos

// Deja de decir "ya te escriben" este número de minutos antes del cierre
const MARGEN_CIERRE_MIN = 30;

// Festivos colombianos, formato 'YYYY-MM-DD'.
// Agrégalos aquí para que el bot los trate como domingo.
const FESTIVOS = [];

// Palabras con las que la asesora pide los casos pendientes
const PALABRAS_CASOS = ['casos', 'pendientes', 'ventas', 'pedidos'];

// Cuántos mensajes anteriores se le pasan a Claude como contexto
const HISTORY_LIMIT = 10;

// Guarda qué caso está esperando confirmación de cierre
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
        const from = message.from;
        const text = message.text?.body || '';

        console.log(`📱 Mensaje de ${from}: ${text}`);

        handleMessage(from, text).catch(err => {
          console.error('Error en handleMessage:', err);
        });
      }
    }
  } catch (error) {
    console.error('❌ Error en POST webhook:', error);
  }
});

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

// offsetDias = 0 hoy, 1 mañana
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

// 570 -> "9:30am" · 600 -> "10am" · 960 -> "4pm"
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

  if (ahora < hoy.apertura) {
    return { estado: 'temprano', apertura: hoy.apertura };
  }

  if (ahora >= hoy.cierre - MARGEN_CIERRE_MIN) {
    return { estado: 'cerrado', apertura: horarioDe(1).apertura };
  }

  return { estado: 'abierto', apertura: hoy.apertura };
}

function haceCuanto(fechaISO) {
  if (!fechaISO) return '';

  const entonces = new Date(fechaISO);
  const dias = Math.floor((Date.now() - entonces.getTime()) / 86400000);

  if (dias <= 0) return 'hoy';
  if (dias === 1) return 'ayer';
  return `hace ${dias} días`;
}

// ---------------------------------------------------------------
// FLUJO PRINCIPAL
// ---------------------------------------------------------------

async function handleMessage(from, text) {
  if (from === AGENT_PHONE) {
    await handleAgente(text);
    return;
  }

  let contactId = null;
  let conversation = null;
  let history = [];

  console.log('⏳ Esperando 2 segundos...');
  await new Promise(resolve => setTimeout(resolve, 2000));

  try {
    contactId = await getOrCreateContact(from);
    conversation = await getOrCreateConversation(contactId);

    if (conversation.handled_by === 'human') {
      console.log('🤐 Conversación en manos de la asesora, el bot no responde');
      await saveMessage(conversation.id, contactId, 'contact', text);
      await sendMessage(from, mensajeYaEstaConVentas());
      return;
    }

    history = await getHistory(conversation.id);
    console.log(`📚 Historial recuperado: ${history.length} mensajes`);

    await saveMessage(conversation.id, contactId, 'contact', text);
  } catch (dbError) {
    console.error('⚠️ Error de base de datos (el chat continúa):', dbError.message);
    history = [];
  }

  try {
    console.log('🤖 Llamando Claude...');
    const respuestaCruda = await generateResponse(text, CLIENT_ID, history);

    const { datos, fotos, textoLimpio } = extraerMarcas(respuestaCruda);

    if (datos) {
      console.log('🛒 Pedido completo detectado, iniciando traspaso');
      await cerrarVenta(from, contactId, conversation, datos);
      return;
    }

    if (fotos.length > 0) {
      await enviarFotos(from, fotos);
    }

    if (textoLimpio) {
      console.log(`✍️ Respuesta: ${textoLimpio}`);
      await sendMessage(from, textoLimpio);

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

// Quita tildes, pasa a minúsculas y unifica variantes conocidas.
// Así "Titán Natural", "Titanio Natural" y "titan natural" son iguales.
function normalizar(texto) {
  if (!texto) return '';

  return texto
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')   // quita tildes
    .toLowerCase()
    .replace(/titanio/g, 'titan')       // Titanio = Titán
    .replace(/[^a-z0-9]/g, '');         // quita espacios y signos
}

// Puntaje de parecido entre lo que pidió la IA y lo que hay en la tabla.
// 3 = idéntico · 2 = uno contiene al otro · 1 = comparten una palabra
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

async function enviarFotos(to, fotos) {
  for (const foto of fotos) {
    try {
      const url = (foto.tipo === 'lista')
        ? await getListaPrecios()
        : await getFotoModelo(foto.modelo, foto.color);

      if (!url) continue;

      await sendImage(to, url);
    } catch (err) {
      console.error('⚠️ Error enviando foto:', err.message);
    }
  }
}

async function getFotoModelo(modelo, color) {
  if (!modelo) return null;

  // Trae todas las fotos del cliente y compara en memoria.
  // Son pocas filas, y así toleramos variantes de escritura.
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

  // 1. Filtrar por modelo, prefiriendo la coincidencia exacta.
  // Así "iPhone 14 Pro" no se confunde con "iPhone 14 Pro Max".
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

  // 2. Si no pidieron color, mandar la primera del modelo
  if (!color) return delModelo[0].image_url;

  // 3. Escoger el color más parecido
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
    console.log(`📷 Color "${color}" resuelto como "${mejor.color}" (parecido ${mejorPuntaje})`);
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

function mensajeCasos(casos) {
  if (!casos || casos.length === 0) {
    return '📋 No hay casos pendientes en este momento 👌';
  }

  const lineas = casos.map((c, i) => {
    const contacto = c.contacts || {};
    const meta = contacto.metadata || {};

    const telefono = meta.celular || contacto.external_id || '';
    const whatsapp = (contacto.external_id || '').replace(/\D/g, '');
    const cedula = meta.cedula ? ` · CC ${meta.cedula}` : '';

    const ubicacion = [meta.direccion, meta.ciudad].filter(Boolean).join(', ');
    const lineaUbicacion = ubicacion ? `\n   📍 ${ubicacion}` : '';

    return `${i + 1}. ${contacto.display_name || 'Sin nombre'}${cedula}  (${haceCuanto(c.updated_at)})
   🛒 ${c.summary || 'Sin detalle'}${lineaUbicacion}
   📱 ${telefono}
   💬 wa.me/${whatsapp}`;
  });

  const plural = casos.length === 1 ? 'caso' : 'casos';

  return `📋 ${casos.length} ${plural} esperando:

${lineas.join('\n\n')}

Para cerrar uno escribe: cerrar 1`;
}

// ---------------------------------------------------------------
// CIERRE DE VENTA Y TRASPASO
// ---------------------------------------------------------------

async function cerrarVenta(from, contactId, conversation, datos) {
  const atencion = estadoAtencion();
  console.log(`🕐 Estado de atención: ${atencion.estado}`);

  const mensajeCliente = mensajeTraspaso(datos, atencion);
  await sendMessage(from, mensajeCliente);

  try {
    await sendMessage(AGENT_PHONE, mensajeAgente(from, datos));
    console.log(`🔔 Aviso enviado a ${AGENT_NAME}`);
  } catch (err) {
    console.error('⚠️ NO SE PUDO AVISAR A LA ASESORA:', err.message);
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

  if (!encontrado) return { datos: null, fotos, textoLimpio };

  try {
    const datos = JSON.parse(encontrado[1].trim());
    if (!datos.nombre || !datos.direccion) {
      console.log('⚠️ Bloque DATOS incompleto, se ignora');
      return { datos: null, fotos, textoLimpio };
    }
    return { datos, fotos, textoLimpio };
  } catch (err) {
    console.error('⚠️ Bloque DATOS mal formado:', err.message);
    return { datos: null, fotos, textoLimpio };
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

function mensajeAgente(telefonoCliente, datos) {
  return `🔔 NUEVO PEDIDO — pasar a pago

👤 ${datos.nombre || 'Sin nombre'}${datos.cedula ? ` · CC ${datos.cedula}` : ''}
📱 ${datos.celular || telefonoCliente}
🛒 ${datos.pedido || 'Sin detalle'}${datos.total ? ` — ${datos.total}` : ''}
📍 ${datos.direccion || ''}${datos.ciudad ? `, ${datos.ciudad}` : ''}
💳 ${datos.medio_pago || 'Por definir'}

💬 Abrir chat: wa.me/${telefonoCliente}`;
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

async function getOrCreateContact(phone) {
  const { data: existing, error: findError } = await supabase
    .from('contacts')
    .select('id')
    .eq('client_id', CLIENT_ID)
    .eq('external_id', phone)
    .limit(1);

  if (findError) throw new Error(`buscar contacto: ${findError.message}`);
  if (existing && existing.length > 0) return existing[0].id;

  const { data: created, error: createError } = await supabase
    .from('contacts')
    .insert([{
      client_id: CLIENT_ID,
      channel_id: CHANNEL_ID,
      external_id: phone,
      display_name: phone
    }])
    .select('id');

  if (createError) throw new Error(`crear contacto: ${createError.message}`);

  console.log(`👤 Contacto nuevo creado: ${phone}`);
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

  // Claude exige que los mensajes alternen user / assistant,
  // que empiecen en 'user' y que NO terminen en 'user'
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

async function sendMessage(to, body) {
  return enviarAMeta(to, {
    messaging_product: 'whatsapp',
    to: to,
    type: 'text',
    text: { body: body }
  }, 'texto');
}

async function sendImage(to, imageUrl) {
  return enviarAMeta(to, {
    messaging_product: 'whatsapp',
    to: to,
    type: 'image',
    image: { link: imageUrl }
  }, 'imagen');
}

async function enviarAMeta(to, cuerpo, tipo) {
  try {
    const url = `https://graph.facebook.com/v19.0/${META_PHONE_NUMBER_ID}/messages`;

    console.log(`📲 Enviando ${tipo} a ${to}`);

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
      console.log(`✅ ${tipo} enviado a ${to}`);
    } else {
      console.error(`❌ Error Meta al enviar ${tipo} a ${to}:`, JSON.stringify(data));
    }
  } catch (error) {
    console.error(`❌ Error enviando ${tipo}:`, error);
  }
}

module.exports = router;