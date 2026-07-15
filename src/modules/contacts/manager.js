const supabase = require("../../config/database");
console.log("✅ CARGÓ EL CONTACTS MANAGER NUEVO");

// Get channel ID from channel name (whatsapp, instagram, etc.)
async function getChannelId(clientId, channelTypeCode) {
  console.log("DEBUG: Buscando canal con clientId:", clientId, "channelTypeCode:", channelTypeCode);
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

// Find or create a contact by external ID and channel
async function getOrCreateContact(clientId, channelName, externalId, name) {
  // Get the channel ID for this channel name
  const channelId = await getChannelId(clientId, channelName);

  // Try to find existing contact
  const { data: existingContacts, error: fetchError } = await supabase
    .from("contacts")
    .select("id")
    .eq("client_id", clientId)
    .eq("channel_id", channelId)
    .eq("external_id", externalId);

  if (fetchError) {
    throw new Error(`Failed to fetch contact: ${fetchError.message}`);
  }

  // Contact exists, return its ID
  if (existingContacts && existingContacts.length > 0) {
    return existingContacts[0].id;
  }

  // Contact doesn't exist, create it
  const { data: newContact, error: createError } = await supabase
    .from("contacts")
    .insert([
      {
        client_id: clientId,
        channel_id: channelId,
        external_id: externalId,
        display_name: name,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
    ])
    .select("id");

  if (createError) {
    throw new Error(`Failed to create contact: ${createError.message}`);
  }

  if (!newContact || newContact.length === 0) {
    throw new Error("Failed to create contact");
  }

  return newContact[0].id;
}

module.exports = { getOrCreateContact };
