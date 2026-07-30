const express = require('express');
const router = express.Router();
const supabase = require('../../config/database');
const { generateResponse } = require('../ai/claude');

const META_ACCESS_TOKEN = process.env.META_ACCESS_TOKEN;
const META_PHONE_NUMBER_ID = process.env.META_PHONE_NUMBER_ID;
const META_VERIFY_TOKEN = process.env.META_VERIFY_TOKEN;

// ID de Servicell en la tabla clients
const CLIENT_ID = 'c37d2508-c9d1-422d-9fef-23901bc51145';

// Cuántos mensajes anteriores se le pasan a Claude como contexto
const HISTORY_LIMIT = 10;

console.log('✅ Webhook receiver cargado');

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

        // Procesar en background
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
  let contactId = null;
  let conversationId = null;
  let history = [];

  console.log('⏳ Esperando 2 segundos...');
  await new Promise(resolve => setTimeout(resolve, 2000));

  // --- BLOQUE BASE DE DATOS ---
  // Si algo aquí falla, se registra y el chat CONTINÚA igual.
  try {
    contactId = await getOrCreateContact(from);
    conversationId = await getOrCreateConversation(contactId);

    // El historial se lee ANTES de guardar el mensaje actual,
    // porque generateResponse ya agrega el mensaje actual al final.
    history = await getHistory(conversationId);
    console.log(`📚 Historial recuperado: ${history.length} mensajes`);

    await saveMessage(conversationId, contactId, 'contact', text);
  } catch (dbError) {
    console.error('⚠️ Error de base de datos (el chat continúa):', dbError.message);
    history = [];
  }

  // --- BLOQUE RESPUESTA ---
  try {
    console.log('🤖 Llamando Claude...');
    const response = await generateResponse(text, CLIENT_ID, history);
    console.log(`✍️ Respuesta: ${response}`);

    console.log('📤 Enviando respuesta...');
    await sendMessage(from, response);

    // Guardar la respuesta del agente sin bloquear ni romper nada
    if (conversationId) {
      saveMessage(conversationId, contactId, 'agent', response)
        .catch(err => console.error('⚠️ No se guardó la respuesta:', err.message));
    }
  } catch (error) {
    console.error('❌ Error en handleMessage:', error);
  }
}

// ---------------------------------------------------------------
// BASE DE DATOS
// ---------------------------------------------------------------

// Busca el contacto por su número de WhatsApp. Si no existe, lo crea.
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
      external_id: phone,
      display_name: phone
    }])
    .select('id');

  if (createError) throw new Error(`crear contacto: ${createError.message}`);

  console.log(`👤 Contacto nuevo creado: ${phone}`);
  return created[0].id;
}

// Busca una conversación abierta del contacto. Si no hay, la crea.
async function getOrCreateConversation(contactId) {
  const { data: existing, error: findError } = await supabase
    .from('conversations')
    .select('id')
    .eq('client_id', CLIENT_ID)
    .eq('contact_id', contactId)
    .eq('status', 'open')
    .order('created_at', { ascending: false })
    .limit(1);

  if (findError) throw new Error(`buscar conversación: ${findError.message}`);
  if (existing && existing.length > 0) return existing[0].id;

  const { data: created, error: createError } = await supabase
    .from('conversations')
    .insert([{
      client_id: CLIENT_ID,
      contact_id: contactId,
      status: 'open',
      handled_by: 'ai',
      source: 'inbound'
    }])
    .select('id');

  if (createError) throw new Error(`crear conversación: ${createError.message}`);

  console.log('💬 Conversación nueva creada');
  return created[0].id;
}

// Guarda un mensaje en la conversación.
// senderType: 'contact' (el cliente) o 'agent' (el bot)
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

// Trae los últimos mensajes de la conversación en el formato que espera Claude.
async function getHistory(conversationId) {
  const { data, error } = await supabase
    .from('messages')
    .select('sender_type, content')
    .eq('conversation_id', conversationId)
    .order('created_at', { ascending: false })
    .limit(HISTORY_LIMIT);

  if (error) throw new Error(`leer historial: ${error.message}`);
  if (!data || data.length === 0) return [];

  // Vienen del más nuevo al más viejo; hay que voltearlos
  const ordenados = data
    .slice()
    .reverse()
    .filter(m => m.content)
    .map(m => ({
      role: m.sender_type === 'agent' ? 'assistant' : 'user',
      content: m.content
    }));

  // Claude exige que los mensajes alternen user / assistant,
  // que empiecen en 'user' y que NO terminen en 'user'
  // (porque después se agrega el mensaje actual, que es 'user').
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

    console.log(`🔗 URL: ${url}`);
    console.log(`📲 To: ${to}`);
    console.log(`💬 Body: ${body}`);

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
    console.log('📨 Respuesta Meta:', data);

    if (data.messages) {
      console.log(`✅ Mensaje enviado a ${to}`);
    } else {
      console.error('❌ Error Meta:', data);
    }
  } catch (error) {
    console.error('❌ Error sendMessage:', error);
  }
}

module.exports = router;