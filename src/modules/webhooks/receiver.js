const express = require('express');
const router = express.Router();
const { supabase } = require('../../config/database');
const { generateResponse } = require('../ai/claude');

const META_ACCESS_TOKEN = process.env.META_ACCESS_TOKEN;
const META_PHONE_NUMBER_ID = process.env.META_PHONE_NUMBER_ID;
const META_VERIFY_TOKEN = process.env.META_VERIFY_TOKEN;

router.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === META_VERIFY_TOKEN) {
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

router.post('/webhook', async (req, res) => {
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

        await processMessage(from, text);
      }
    }
  } catch (error) {
    console.error('Error:', error);
  }
});

async function processMessage(from, text) {
  try {
    const CLIENT_ID = 'c37d2508-c9d1-422d-9fef-23901bc51145';
    
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    const response = await generateResponse(text, from, CLIENT_ID);
    
    await sendWhatsAppMessage(from, response);
  } catch (error) {
    console.error('Error procesando:', error);
  }
}

async function sendWhatsAppMessage(to, body) {
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
        to: to,
        type: 'text',
        text: { body: body }
      })
    });

    await response.json();
  } catch (error) {
    console.error('Error enviando:', error);
  }
}

module.exports = router;