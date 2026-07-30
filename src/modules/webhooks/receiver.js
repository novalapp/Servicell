const express = require('express');
const router = express.Router();
const { supabase } = require('../../config/database');
const { generateResponse } = require('../ai/claude');

const META_ACCESS_TOKEN = process.env.META_ACCESS_TOKEN;
const META_PHONE_NUMBER_ID = process.env.META_PHONE_NUMBER_ID;
const META_VERIFY_TOKEN = process.env.META_VERIFY_TOKEN;

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

        handleMessage(from, text).catch(err => {
          console.error('Error en handleMessage:', err);
        });
      }
    }
  } catch (error) {
    console.error('❌ Error en POST webhook:', error);
  }
});

async function handleMessage(from, text) {
  try {
    const CLIENT_ID = 'c37d2508-c9d1-422d-9fef-23901bc51145';
    
    console.log('⏳ Esperando 2 segundos...');
    await new Promise(resolve => setTimeout(resolve, 2000));

    // Obtener o crear contacto
    const { data: contactData, error: contactError } = await supabase
      .from('contacts')
      .select('id')
      .eq('phone_number', from)
      .eq('client_id', CLIENT_ID)
      .single();

    let contactId;
    if (contactError || !contactData) {
      const { data: newContact } = await supabase
        .from('contacts')
        .insert([{
          client_id: CLIENT_ID,
          phone_number: from,
          source: 'whatsapp'
        }])
        .select()
        .single();
      contactId = newContact.id;
    } else {
      contactId = contactData.id;
    }

    // Obtener o crear conversación
    const { data: conversationData } = await supabase
      .from('conversations')
      .select('id')
      .eq('contact_id', contactId)
      .eq('status', 'open')
      .order('created_at', { ascending: false })
      .limit(1)
      .single();

    let conversationId;
    if (!conversationData) {
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
        message_text: text
      }]);

    // Recuperar historial de mensajes previos
    const { data: messageHistory } = await supabase
      .from('messages')
      .select('sender_type, message_text')
      .eq('conversation_id', conversationId)
      .order('created_at', { ascending: true })
      .limit(20);

    // Convertir historial al formato que Claude espera
    const conversationHistory = (messageHistory || []).map(msg => ({
      role: msg.sender_type === 'agent' ? 'assistant' : 'user',
      content: msg.message_text
    }));

    console.log('🤖 Llamando Claude con historial...');
    const response = await generateResponse(text, CLIENT_ID, conversationHistory);
    console.log(`✍️ Respuesta: ${response}`);

    // Guardar respuesta del agente
    await supabase
      .from('messages')
      .insert([{
        conversation_id: conversationId,
        sender_type: 'agent',
        message_text: response
      }]);

    console.log('📤 Enviando respuesta...');
    await sendMessage(from, response);

  } catch (error) {
    console.error('❌ Error en handleMessage:', error);
  }
}

async function sendMessage(to, body) {
  try {
    const url = `https://graph.facebook.com/v19.0/${META_PHONE_NUMBER_ID}/messages`;
    
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
      console.log(`✅ Mensaje enviado`);
    } else {
      console.error('❌ Error Meta:', data);
    }
  } catch (error) {
    console.error('❌ Error sendMessage:', error);
  }
}

module.exports = router;