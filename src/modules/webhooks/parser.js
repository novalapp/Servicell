// Parse incoming webhook from Meta (WhatsApp or Instagram)
function parseMetaWebhook(body) {
  if (!body.entry || !body.entry[0]) {
    return null;
  }

  const entry = body.entry[0];

  // WhatsApp webhook
  if (body.object === "whatsapp_business_account") {
    return parseWhatsAppWebhook(entry);
  }

  // Instagram webhook
  if (body.object === "instagram") {
    return parseInstagramWebhook(entry);
  }

  return null;
}

function parseWhatsAppWebhook(entry) {
  const changes = entry.changes?.[0];
  if (!changes || !changes.value) {
    return null;
  }

  const value = changes.value;
  const messages = value.messages?.[0];
  const contacts = value.contacts?.[0];

  if (!messages || messages.type !== "text") {
    return null;
  }

  return {
    channel: "whatsapp",
    contactId: messages.from,
    contactName: contacts?.profile?.name || "Unknown",
    messageText: messages.text?.body || "",
    messageId: messages.id,
    timestamp: parseInt(messages.timestamp),
  };
}

function parseInstagramWebhook(entry) {
  const messaging = entry.messaging?.[0];
  if (!messaging || !messaging.message || !messaging.message.text) {
    return null;
  }

  return {
    channel: "instagram",
    contactId: messaging.sender.id,
    contactName: "Instagram User",
    messageText: messaging.message.text,
    messageId: messaging.message.mid,
    timestamp: messaging.timestamp,
  };
}

module.exports = { parseMetaWebhook };
