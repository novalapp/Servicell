const supabase = require("../../config/database");

// Get channel ID from channel name (whatsapp, instagram, etc.)
async function getChannelId(clientId, channelTypeCode) {
  const { data, error } = await supabase
    .from("channels")
    .select("id, channel_types!inner(code)")
    .eq("client_id", clientId)
    .eq("active", true)
    .eq("channel_types.code", channelTypeCode);

  if (error) {
    throw new Error(`Failed to fetch channel: ${error.message}`);
  }

  if (!data || data.length === 0) {
    throw new Error(`Channel "${channelTypeCode}" not found for client`);
  }

  return data[0].id;
}

// Find or create a conversation for a contact
async function getOrCreateConversation(clientId, contactId, channelName) {
  // Get the channel ID for this channel name
  const channelId = await getChannelId(clientId, channelName);

  // Try to find an a.from("conversations")ctive conversation
  const { data: existingConversations, error: fetchError } = await supabase
    .from("conversations")
    .select("id")
    .eq("client_id", clientId)
    .eq("contact_id", contactId)
    .eq("channel_id", channelId)
    .eq("status", "active");

  if (fetchError) {
    throw new Error(`Failed to fetch conversation: ${fetchError.message}`);
  }

  // Active conversation exists, return its ID
  if (existingConversations && existingConversations.length > 0) {
    return existingConversations[0].id;
  }

  // No active conversation, create one
  const { data: newConversation, error: createError } = await supabase
    .from("conversations")
    .insert([
      {
        client_id: clientId,
        contact_id: contactId,
        channel_id: channelId,
        status: "open",
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
    ])
    .select("id");

  if (createError) {
    throw new Error(`Failed to create conversation: ${createError.message}`);
  }

  if (!newConversation || newConversation.length === 0) {
    throw new Error("Failed to create conversation");
  }

  return newConversation[0].id;
}

module.exports = { getOrCreateConversation };
