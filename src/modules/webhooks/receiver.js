const express = require('express');
const router = express.Router();
const { supabase } = require('../../config/database');
const { generateResponse } = require('../ai/claude');

const META_ACCESS_TOKEN = process.env.META_ACCESS_TOKEN;
const META_PHONE_NUMBER_ID = process.env.META_PHONE_NUMBER_ID;
const META_VERIFY_TOKEN = process.env.META_VERIFY_TOKEN;

console.log('META_PHONE_NUMBER_ID:', META_PHONE_NUMBER_ID);
console.log('META_ACCESS_TOKEN:', META_ACCESS_TOKEN ? 'SET' : 'NOT SET');
console.log('META_VERIFY_TOKEN:', META_VERIFY_TOKEN);

// Webhook verification (GET)
router.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === META_VERIFY_TOKEN) {
    console.log('✅ Webhook verificado correctamente');
    res.status(200).send(challenge);
  } else {
    console.log('❌ Token de verificación inválido', { mode, token });
    res.sendStatus(403);
  }
});

// Webhook receiver (POST)
router.post('/webhook', async (req, res) => {
  const body = req.body;

  // Responder inmediatamente a Meta
  res.status(200).send('EVENT_RECEIVED');

  console.log('📨 Webhook recibido:', JSON.stringify(body, null, 2));

  if (body.object === 'whatsapp_business_account') {
    const entry = body.entry[0];
    const changes = entry.changes[0];
    const value = changes.value;

    // Verificar si hay mensajes
    if (value.messages && value.messages.length > 0) {
      const message = value.messages[0];
      const from = message.from;
      const text = message.text?.body || '';
      const messageId = message.id;
      const timestamp = message.timestamp;

      console.log(`📱 Mensaje recibido de ${from}: ${text}`);

      // Procesar el mensaje
      processMessage(from, text, messageId, timestamp);
    }
  }
});

async function processMessage(phoneNumber, messageText, messageId, timestamp) {
  try {
    const CLIENT_ID = 'c37d2508-c9d1-422d-9fef-23901bc51145';

    console.log(`⏳ Esperando 2 segundos antes de responder...`);
    // Esperar 2 segundos (para que se sienta humano)
    await new Promise(resolve => setTimeout(resolve, 2000));

    // Obtener o crear contacto
    const { data: contactData, error: contactError } = await supabase
      .from('contacts')
      .select('id')
      .eq('phone_number', phoneNumber)
      .eq('client_id', CLIENT_ID)
      .single();

    let contactId;
    if (contactError || !contactData) {
      const { data: newContact } = await supabase
        .from('contacts')
        .insert([{
          client_id: CLIENT_ID,
          phone_number: phoneNumber,
          source: 'whatsapp'
        }])
        .select()
        .single();
      contactId = newContact.id;
      console.log(`👤 Nuevo contacto creado: ${contactId}`);
    } else {
      contactId = contactData.id;
      console.log(`👤 Contacto existente: ${contactId}`);
    }

    // Obtener o crear conversación
    const { data: conversationData, error: convError } = await supabase
      .from('conversations')
      .select('id')
      .eq('contact_id', contactId)
      .eq('status', 'open')
      .order('created_at', { ascending: false })
      .limit(1)
      .single();

    let conversationId;
    if (convError || !conversationData) {
      const { data: newConv } = await supabase
        .from('conversations')
        .insert([{
          contact_id: contactId,
          client_id: CLIENT_ID,
          status: 'open'
        }])
        .select()
        .single();
      conversationId = newConv.id;
      console.log(`💬 Nueva conversación creada: ${conversationId}`);
    } else {
      conversationId = conversationData.id;
      console.log(`💬 Conversación existente: ${conversationId}`);
    }

    // Guardar mensaje del cliente
    await supabase
      .from('messages')
      .insert([{
        conversation_id: conversationId,
        sender_type: 'contact',
        message_text: messageText,
        external_message_id: messageId
      }]);
    console.log(`💾 Mensaje del cliente guardado`);

    // Generar respuesta con Claude
    console.log(`🤖 Generando respuesta con Claude...`);
    const responseText = await generateResponse(messageText, contactId, CLIENT_ID);
    console.log(`✍️ Respuesta generada: ${responseText}`);

    // Guardar respuesta del agente
    await supabase
      .from('messages')
      .insert([{
        conversation_id: conversationId,
        sender_type: 'agent',
        message_text: responseText
      }]);
    console.log(`💾 Respuesta guardada en BD`);

    // Enviar mensaje por WhatsApp
    console.log(`📤 Enviando mensaje por WhatsApp a ${phoneNumber}...`);
    await sendWhatsAppMessage(phoneNumber, responseText);

  } catch (error) {
    console.error('❌ Error procesando mensaje:', error);
  }
}

async function sendWhatsAppMessage(phoneNumber, messageText) {
  try {
    const url = `https://graph.instagram.com/v18.0/${META_PHONE_NUMBER_ID}/messages`;

    console.log(`🔗 URL: ${url}`);
    console.log(`📲 Enviando a: ${phoneNumber}`);
    console.log(`💬 Mensaje: ${messageText}`);

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${META_ACCESS_TOKEN}`
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to: phoneNumber,
        type: 'text',
        text: {
          body: messageText
        }
      })
    });

    const data = await response.json();
    console.log(`📨 Respuesta de Meta:`, JSON.stringify(data));

    if (data.messages) {
      console.log(`✅ Mensaje enviado a ${phoneNumber}`);
    } else {
      console.error('❌ Error al enviar mensaje:', data);
    }
  } catch (error) {
    console.error('❌ Error enviando WhatsApp:', error);
  }
}

module.exports = router;