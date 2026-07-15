const { parseMetaWebhook } = require("./parser");
const { getOrCreateContact } = require("../contacts/manager");
const { getOrCreateConversation } = require("../conversations/manager");
const { saveIncomingMessage } = require("../messages/manager");
const supabase = require("../../config/database");
const { generateResponse } = require("../ai/claude");

// Get Servicell client ID from database
async function getServicellClientId() {
  console.log("\n=== DIAGNOSTIC: QUERYING CLIENTS TABLE ===");

  // Query 1: Get ALL clients
  const allClients = await supabase
    .from("clients")
    .select("*");

  console.log("ALL CLIENTS:", allClients);

  // Query 2: Get Servicell specifically
  const servicell = await supabase
    .from("clients")
    .select("*")
    .eq("slug", "servicell");

  console.log("SERVICELL QUERY:", servicell);
  console.log("==========================================\n");

  // Use the servicell result
  const { data, error } = servicell;

  if (error) {
    throw new Error(`Failed to fetch Servicell client: ${error.message}`);
  }

  if (!data || data.length === 0) {
    throw new Error("Servicell client not found in database");
  }

  if (data.length > 1) {
    throw new Error(`Multiple Servicell clients found (expected 1, got ${data.length})`);
  }

  return data[0].id;
}

// Process incoming webhook from Meta
async function processWebhookMessage(body) {
  // Parse webhook
  const parsedMessage = parseMetaWebhook(body);
  if (!parsedMessage) {
    return null;
  }

  // Get Servicell client ID
  const clientId = await getServicellClientId();

  // Get or create contact
  const contactId = await getOrCreateContact(
    clientId,
    parsedMessage.channel,
    parsedMessage.contactId,
    parsedMessage.contactName
  );

  // Get or create conversation
  const conversationId = await getOrCreateConversation(
    clientId,
    contactId,
    parsedMessage.channel
  );

  // Save message
const messageId = await saveIncomingMessage(conversationId, contactId, {
    externalId: parsedMessage.messageId,
    text: parsedMessage.messageText,
    timestamp: parsedMessage.timestamp,
  });

  // Generate AI response
  const aiResponse = await generateResponse(parsedMessage.messageText);
  
  // Save AI response to database
  const responseMessageId = await saveIncomingMessage(conversationId, contactId, {
    externalId: `response_${messageId}`,
    text: aiResponse,
    timestamp: Date.now() / 1000,
  });

  return {
    success: true,
    contactId,
    conversationId,
    messageId,
  };
}

module.exports = { processWebhookMessage };
