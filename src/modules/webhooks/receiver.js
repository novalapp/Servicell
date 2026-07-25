const express = require('express');
const router = express.Router();
const { supabase } = require('../../config/database');
const { generateResponse } = require('../ai/claude');

const META_ACCESS_TOKEN = process.env.META_ACCESS_TOKEN;
const META_PHONE_NUMBER_ID = process.env.META_PHONE_NUMBER_ID;
const META_VERIFY_TOKEN = process.env.META_VERIFY_TOKEN;

// Webhook verification (GET)
router.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === META_VERIFY_TOKEN) {
    console.log('✅ Webhook verificado correctamente');
    res.status(200).send(challenge);
  } else {
    console.log('❌ Token de verificación inválido');
    res.sendStatus(403);
  }
});

// Webhook receiver (POST)
router.post('/webhook', async (req, res) => {
  const body = req.body;

  // Responder inmediatamente a Meta
  res.status(200).send('EVENT_RECEIVED');

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
    } else {
      contactId = contactData.id;
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
    } else {
      conversationId = conversationData.id;
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

    // Generar respuesta con Claude
    const responseText = await generateResponse(messageText, contactId, CLIENT_ID);

    // Guardar respuesta del agente
    await supabase
      .from('messages')
      .insert([{
        conversation_id: conversationId,
        sender_type: 'agent',
        message_text: responseText
      }]);

    // Enviar mensaje por WhatsApp
    await sendWhatsAppMessage(phoneNumber, responseText);

  } catch (error) {
    console.error('Error procesando mensaje:', error);
  }
}

async function sendWhatsAppMessage(phoneNumber, messageText) {
  try {
    const url = `https://graph.instagram.com/v18.0/${META_PHONE_NUMBER_ID}/messages`;

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
    if (data.messages) {
      console.log(`✅ Mensaje enviado a ${phoneNumber}`);
    } else {
      console.error('❌ Error al enviar mensaje:', data);
    }
  } catch (error) {
    console.error('Error enviando WhatsApp:', error);
  }
}

module.exports = router;