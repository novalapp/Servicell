const supabase = require("../../config/database");

// Save an incoming message to the database
async function saveIncomingMessage(conversationId, contactId, messageData) {
  const {
    externalId,
    text,
    timestamp,
  } = messageData;

  const { data, error } = await supabase
    .from("messages")
  .insert([
      {
        conversation_id: conversationId,
        contact_id: contactId,
        external_message_id: externalId,
        sender_type: "contact",
        message_type: "text",
        content: text,
        created_at: new Date(timestamp * 1000).toISOString(),
      },
    ])
    .select("id");

  if (error) {
    throw new Error(`Failed to save message: ${error.message}`);
  }

  if (!data || data.length === 0) {
    throw new Error("Failed to save message");
  }

  return data[0].id;
}

module.exports = { saveIncomingMessage };
