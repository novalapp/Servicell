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
  try {
    const body = req.body;
    console.log('📨 Webhook recibido');

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

        console.log(`📱 Mensaje de ${from}: ${text}`);

        // Procesar el mensaje
        await processMessage(from, text);
      }
    }
  } catch (error) {
    console.error('❌ Error en webhook:', error);
  }
});

async function processMessage(phoneNumber, messageText) {
  try {
    const CLIENT_ID = 'c37d2508-c9d1-422d-9fef-23901bc51145';

    console.log('⏳ Esperando 2 segundos...');
    await new Promise(resolve => setTimeout(resolve, 2000));

    // Generar respuesta con Claude
    console.log('🤖 Llamando a Claude...');
    const responseText = await generateResponse(messageText, phoneNumber, CLIENT_ID);
    console.log(`✍️ Respuesta: ${responseText}`);

    // Enviar por WhatsApp
    console.log('📤 Enviando respuesta...');
    await sendWhatsAppMessage(phoneNumber, responseText);

  } catch (error) {
    console.error('❌ Error procesando:', error);
  }
}

async function sendWhatsAppMessage(phoneNumber, messageText) {
  try {
    const url = `https://graph.instagram.com/v19.0/${META_PHONE_NUMBER_ID}/messages`;

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
        text: { body: messageText }
      })
    });

    const data = await response.json();
    if (data.messages) {
      console.log(`✅ Mensaje enviado`);
    } else {
      console.error('❌ Error Meta:', data);
    }
  } catch (error) {
    console.error('❌ Error enviando:', error);
  }
}

module.exports = router;