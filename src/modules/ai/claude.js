const Anthropic = require("@anthropic-ai/sdk");
const supabase = require("../../config/database");

const client = new Anthropic({
  apiKey: process.env.CLAUDE_API_KEY,
});

// Get agent configuration from Supabase
async function getAgentConfig(clientId) {
  const { data, error } = await supabase
    .from("agent_config")
    .select("*")
    .eq("client_id", clientId)
    .eq("active", true);

  if (error) {
    throw new Error(`Failed to fetch agent config: ${error.message}`);
  }

  if (!data || data.length === 0) {
    throw new Error("Agent config not found for this client");
  }

  return data[0];
}

// De ["90%", "95%", ">90%"] devuelve "95%" — la más alta.
// Si no hay nada, devuelve null.
function bateriaMasAlta(unidades) {
  if (!Array.isArray(unidades) || unidades.length === 0) return null;

  let mejorTexto = null;
  let mejorValor = -1;

  for (const u of unidades) {
    const texto = String(u || "").trim();
    if (!texto) continue;

    const numero = parseFloat(texto.replace(/[^\d.]/g, ""));
    if (isNaN(numero)) continue;

    if (numero > mejorValor) {
      mejorValor = numero;
      mejorTexto = texto;
    }
  }

  return mejorTexto;
}

// Get products for a client
async function getProductsInfo(clientId) {
  const { data, error } = await supabase
    .from("products")
    .select("name, sku, category, price, stock, capacity, color, battery_units")
    .eq("client_id", clientId)
    .eq("active", true)
    .order("name");

  if (error) {
    console.error("Error fetching products:", error);
    return "";
  }

  if (!data || data.length === 0) {
    return "No products available";
  }

  const productsByCategory = {};

  data.forEach(product => {
    if (!productsByCategory[product.category]) {
      productsByCategory[product.category] = [];
    }

    const stock = product.stock > 0 ? `${product.stock} en stock` : "Agotado";

    const detalles = [product.capacity, product.color].filter(Boolean).join(" ");
    const detallesTexto = detalles ? ` ${detalles}` : "";

    const bateria = bateriaMasAlta(product.battery_units);
    const bateriaTexto = bateria ? ` | Batería: ${bateria}` : "";

    productsByCategory[product.category].push(
      `- ${product.name}${detallesTexto} (${product.sku}): $${product.price.toLocaleString('es-CO')} COP - ${stock}${bateriaTexto}`
    );
  });

  let productsInfo = "INVENTARIO ACTUAL:\n";
  Object.entries(productsByCategory).forEach(([category, products]) => {
    productsInfo += `\n${category}:\n${products.join("\n")}\n`;
  });

  return productsInfo;
}

// Get active promotions
async function getPromotionsInfo(clientId) {
  const now = new Date();

  const { data, error } = await supabase
    .from("promotions")
    .select("title, description, discount_percentage, discount_amount, valid_until")
    .eq("client_id", clientId)
    .eq("active", true)
    .gt("valid_until", now.toISOString());

  if (error || !data || data.length === 0) {
    return "";
  }

  let promotionsInfo = "\nPROMOCIONES VIGENTES:\n";
  data.forEach(promo => {
    const discount = promo.discount_percentage
      ? `${promo.discount_percentage}% de descuento`
      : `Descuento de $${promo.discount_amount?.toLocaleString('es-CO')} COP`;
    promotionsInfo += `- ${promo.title}: ${promo.description} (${discount})\n`;
  });

  return promotionsInfo;
}

// Generate AI response for a message
async function generateResponse(messageContent, clientId, conversationHistory = []) {
  try {
    const config = await getAgentConfig(clientId);

    const productsInfo = await getProductsInfo(clientId);
    const promotionsInfo = await getPromotionsInfo(clientId);

    const completeSystemPrompt = `${config.system_prompt}

${productsInfo}
${promotionsInfo}

INSTRUCCIONES IMPORTANTES:
- Siempre consulta el inventario antes de confirmar disponibilidad
- El inventario incluye el estado de batería de cada equipo. Menciónalo
  SOLO si el cliente pregunta. Da el dato exacto que aparece ahí, nunca
  inventes un porcentaje ni des uno aproximado.
- Si un equipo no tiene dato de batería en el inventario, dile al cliente
  que el asesor se lo confirma
- Si no hay stock, ofrece registrar al cliente para avisar cuando llegue
- Nunca prometas fechas exactas de entrega sin verificar
- Nunca le digas al cliente cuántas unidades hay en stock
- Mantén un tono ${config.tone}
- Responde en español`;

    const messages = [
      ...conversationHistory,
      {
        role: "user",
        content: messageContent,
      },
    ];

    const response = await client.messages.create({
      model: "claude-haiku-4-5",
      max_tokens: 1024,
      system: completeSystemPrompt,
      messages: messages,
    });

    return response.content[0].text;
  } catch (error) {
    console.error("Error calling Claude API:", error);
    throw new Error(`Failed to generate response: ${error.message}`);
  }
}

module.exports = { generateResponse };