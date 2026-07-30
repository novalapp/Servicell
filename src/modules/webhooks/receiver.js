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

// Agente que recibe los casos de pago
const AGENT_PHONE = '573207679813';   // con 57 al inicio, sin espacios
const AGENT_NAME = 'Duván';
const AGENT_DISPLAY = '320 767 9813'; // como se le muestra al cliente

// Cuántos mensajes anteriores se le pasan a Claude como contexto
const HISTORY_LIMIT = 10;

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
// FLUJO PRINCIPAL
// ---------------------------------------------------------------

async function handleMessage(from, text) {
  // Si escribe el agente, no lo tratamos como cliente
  if (from === AGENT_PHONE) {
    console.log('👔 Mensaje del agente, se ignora');
    return;
  }

  let contactId = null;
  let conversation = null;
  let history = [];

  console.log('⏳ Esperando 2 segundos...');
  await new Promise(resolve => setTimeout(resolve, 2000));

  // --- BLOQUE BASE DE DATOS (si falla, el chat continúa) ---
  try {
    contactId = await getOrCreateContact(from);
    conversation = await getOrCreateConversation(contactId);

    // Si ya está en manos de una persona, el bot se calla
    if (conversation.handled_by === 'human') {
      console.log('🤐 Conversación en manos del agente, el bot no responde');
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

  // --- BLOQUE RESPUESTA ---
  try {
    console.log('🤖 Llamando Claude...');
    const respuestaCruda = await generateResponse(text, CLIENT_ID, history);

    const { datos, textoLimpio } = extraerDatos(respuestaCruda);

    if (datos) {
      console.log('🛒 Pedido completo detectado, iniciando traspaso');
      await cerrarVenta(from, contactId, conversation, datos);
    } else {
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
// CIERRE DE VENTA Y TRASPASO
// ---------------------------------------------------------------

async function cerrarVenta(from, contactId, conversation, datos) {
  // 1. Mensaje al cliente (siempre, aunque falle lo demás)
  const mensajeCliente = mensajeTraspaso(datos);
  await sendMessage(from, mensajeCliente);

  // 2. Aviso al agente
  try {
    await sendMessage(AGENT_PHONE, mensajeAgente(from, datos));
    console.log(`🔔 Aviso enviado al agente ${AGENT_NAME}`);
  } catch (err) {
    console.error('⚠️ NO SE PUDO AVISAR AL AGENTE:', err.message);
  }

  // 3. Guardar todo
  if (!conversation || !contactId) return;

  try {
    await guardarDatosEnvio(contactId, datos);

    await supabase
      .from('conversations')
      .update({
        handled_by: 'human',
        status: 'waiting_agent',
        summary: `${datos.pedido || 'Pedido'} — ${datos.total || ''} — ${datos.ciudad || ''} — pago por ${datos.medio_pago || 'definir'}`
      })
      .eq('id', conversation.id);

    await saveMessage(conversation.id, contactId, 'agent', mensajeCliente);
    console.log('✅ Conversación traspasada al agente');
  } catch (err) {
    console.error('⚠️ Error guardando el traspaso:', err.message);
  }
}

// Busca el bloque [DATOS]{...}[/DATOS] en la respuesta de Claude
function extraerDatos(respuesta) {
  const patron = /\[DATOS\]([\s\S]*?)\[\/DATOS\]/;
  const encontrado = respuesta.match(patron);

  // El bloque nunca debe llegarle al cliente
  const textoLimpio = respuesta.replace(patron, '').trim();

  if (!encontrado) return { datos: null, textoLimpio };

  try {
    const datos = JSON.parse(encontrado[1].trim());
    if (!datos.nombre || !datos.direccion) {
      console.log('⚠️ Bloque DATOS incompleto, se ignora');
      return { datos: null, textoLimpio };
    }
    return { datos, textoLimpio };
  } catch (err) {
    console.error('⚠️ Bloque DATOS mal formado:', err.message);
    return { datos: null, textoLimpio };
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

function mensajeTraspaso(datos) {
  const nombre = (datos.nombre || '').split(' ')[0];

  return `¡Listo ${nombre}! Ya quedó registrado tu pedido:

📱 ${datos.pedido || 'Tu pedido'}${datos.total ? ` — ${datos.total}` : ''}
📍 ${datos.direccion || ''}${datos.ciudad ? `, ${datos.ciudad}` : ''}
💳 ${datos.medio_pago || 'Por definir'}

En unos minutos te escribe ${AGENT_NAME}, de nuestra área de ventas, desde el ${AGENT_DISPLAY}. No te asustes cuando te llegue de otro número, es parte del proceso 😊

Él ya tiene todos tus datos, así que te da la información de pago y te confirma el envío.`;
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
  return `Ya estás con nuestra área de ventas 😊 ${AGENT_NAME} te ayuda por ese chat con el pago y el envío.

Si aún no te ha escrito, puedes buscarlo en el ${AGENT_DISPLAY}.`;
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
  try {
    const url = `https://graph.facebook.com/v19.0/${META_PHONE_NUMBER_ID}/messages`;

    console.log(`📲 Enviando a ${to}`);

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${META_ACCESS_TOKEN}`
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to: to,
        type: 'text',
        text: { body: body }
      })
    });

    const data = await res.json();

    if (data.messages) {
      console.log(`✅ Mensaje enviado a ${to}`);
    } else {
      console.error(`❌ Error Meta al enviar a ${to}:`, JSON.stringify(data));
    }
  } catch (error) {
    console.error('❌ Error sendMessage:', error);
  }
}

module.exports = router;