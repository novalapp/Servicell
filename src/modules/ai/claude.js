const Anthropic = require("@anthropic-ai/sdk");
const supabase = require("../../config/database");

const client = new Anthropic({
  apiKey: process.env.CLAUDE_API_KEY,
});

// ---------------------------------------------------------------
// COLORES — traducción automática
// ---------------------------------------------------------------

// Palabras que el cliente puede usar, agrupadas por familia.
// Si hace falta agregar una, va aquí.
const FAMILIAS_COLOR = {
  claros:    ['plata', 'plateado', 'silver', 'blanco', 'white', 'gris', 'gray', 'grey', 'natural'],
  oscuros:   ['negro', 'black', 'grafito', 'graphite', 'medianoche', 'midnight', 'espacial'],
  dorados:   ['oro', 'dorado', 'dorada', 'gold', 'champan', 'champagne'],
  azules:    ['azul', 'blue', 'sierra'],
  naranjas:  ['naranja', 'orange', 'cobre', 'bronce'],
  morados:   ['morado', 'morada', 'lila', 'purpura', 'violeta', 'purple', 'malva'],
  rosados:   ['rosa', 'rosado', 'rosada', 'pink'],
  verdes:    ['verde', 'green', 'pino'],
  amarillos: ['amarillo', 'amarilla', 'yellow'],
  rojos:     ['rojo', 'roja', 'red']
};

// Quita tildes y pasa a minúsculas, conservando los espacios
function simplificar(texto) {
  return String(texto || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

// A qué familia pertenece un color del inventario ("Titán Blanco" -> claros)
function familiaDelColor(color) {
  const c = simplificar(color);
  for (const [familia, palabras] of Object.entries(FAMILIAS_COLOR)) {
    if (palabras.some(p => c.includes(p))) return familia;
  }
  return null;
}

// Saca el texto del mensaje, venga como string o como bloques con imagen
function textoDelMensaje(messageContent) {
  if (typeof messageContent === 'string') return messageContent;
  if (Array.isArray(messageContent)) {
    return messageContent
      .filter(b => b && b.type === 'text')
      .map(b => b.text)
      .join(' ');
  }
  return '';
}

// Si el cliente nombró un color, le dice a la IA cuál es el equivalente
// exacto del inventario, para que no tenga que adivinarlo.
function notaDeColor(mensaje, coloresInventario) {
  const palabras = simplificar(mensaje).split(/[^a-z0-9]+/).filter(Boolean);
  if (palabras.length === 0) return '';

  const familiasPedidas = new Set();
  for (const [familia, claves] of Object.entries(FAMILIAS_COLOR)) {
    if (claves.some(k => palabras.includes(k))) familiasPedidas.add(familia);
  }

  if (familiasPedidas.size === 0) return '';

  const equivalentes = coloresInventario.filter(color => {
    const familia = familiaDelColor(color);
    return familia && familiasPedidas.has(familia);
  });

  if (equivalentes.length === 0) return '';

  return `
NOTA AUTOMÁTICA SOBRE EL COLOR:
El cliente nombró un color. En este inventario, ese color corresponde a: ${equivalentes.join(', ')}.
Si el modelo que pide existe en el inventario, dile que SÍ lo tienes en ese color.
Responde usando la palabra que usó el cliente, nunca el nombre del inventario.
`;
}

// ---------------------------------------------------------------
// CONFIGURACIÓN E INVENTARIO
// ---------------------------------------------------------------

async function getAgentConfig(clientId) {
  const { data, error } = await supabase
    .from("agent_config")
    .select("*")
    .eq("client_id", clientId)
    .eq("active", true);

  if (error) throw new Error(`Failed to fetch agent config: ${error.message}`);
  if (!data || data.length === 0) throw new Error("Agent config not found for this client");

  return data[0];
}

// De ["90%", "95%"] devuelve "95%" — la más alta
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

// Devuelve { texto, colores } — el inventario formateado y la lista de colores
async function getProductsInfo(clientId) {
  const { data, error } = await supabase
    .from("products")
    .select("name, sku, category, price, stock, capacity, color, battery_units")
    .eq("client_id", clientId)
    .eq("active", true)
    .order("name");

  if (error) {
    console.error("Error fetching products:", error);
    return { texto: "", colores: [] };
  }

  if (!data || data.length === 0) {
    return { texto: "No products available", colores: [] };
  }

  const productsByCategory = {};
  const colores = new Set();

  data.forEach(product => {
    if (product.color) colores.add(product.color);

    if (!productsByCategory[product.category]) {
      productsByCategory[product.category] = [];
    }

    const stock = product.stock > 0 ? "Disponible" : "Agotado";

    const detalles = [product.capacity, product.color].filter(Boolean).join(" ");
    const detallesTexto = detalles ? ` ${detalles}` : "";

    const bateria = bateriaMasAlta(product.battery_units);
    const bateriaTexto = bateria ? ` | Batería: ${bateria}` : "";

    productsByCategory[product.category].push(
      `- ${product.name}${detallesTexto} (${product.sku}): $${product.price.toLocaleString('es-CO')} COP - ${stock}${bateriaTexto}`
    );
  });

  let texto = "INVENTARIO ACTUAL:\n";
  Object.entries(productsByCategory).forEach(([category, products]) => {
    texto += `\n${category}:\n${products.join("\n")}\n`;
  });

  return { texto, colores: Array.from(colores) };
}

async function getPromotionsInfo(clientId) {
  const now = new Date();

  const { data, error } = await supabase
    .from("promotions")
    .select("title, description, discount_percentage, discount_amount, valid_until")
    .eq("client_id", clientId)
    .eq("active", true)
    .gt("valid_until", now.toISOString());

  if (error || !data || data.length === 0) return "";

  let promotionsInfo = "\nPROMOCIONES VIGENTES:\n";
  data.forEach(promo => {
    const discount = promo.discount_percentage
      ? `${promo.discount_percentage}% de descuento`
      : `Descuento de $${promo.discount_amount?.toLocaleString('es-CO')} COP`;
    promotionsInfo += `- ${promo.title}: ${promo.description} (${discount})\n`;
  });

  return promotionsInfo;
}

// ---------------------------------------------------------------
// RESPUESTA
// ---------------------------------------------------------------

async function generateResponse(messageContent, clientId, conversationHistory = []) {
  try {
    const config = await getAgentConfig(clientId);

    const inventario = await getProductsInfo(clientId);
    const promotionsInfo = await getPromotionsInfo(clientId);

    // Traduce el color que dijo el cliente al del inventario
    const nota = notaDeColor(textoDelMensaje(messageContent), inventario.colores);
    if (nota) console.log('🎨 Nota de color agregada');

    const completeSystemPrompt = `${config.system_prompt}

${inventario.texto}
${promotionsInfo}
${nota}

INSTRUCCIONES IMPORTANTES:
- Siempre consulta el inventario antes de confirmar disponibilidad
- El inventario incluye el estado de batería de cada equipo. Menciónalo
  SOLO si el cliente pregunta. Da el dato exacto que aparece ahí, nunca
  inventes un porcentaje ni des uno aproximado.
- Si un equipo no tiene dato de batería en el inventario, dile al cliente
  que la asesora se lo confirma
- Si no hay stock, ofrece registrar al cliente para avisar cuando llegue
- Nunca prometas fechas exactas de entrega sin verificar
- Nunca le digas al cliente cuántas unidades hay disponibles
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