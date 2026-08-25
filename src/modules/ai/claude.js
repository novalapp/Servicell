const Anthropic = require("@anthropic-ai/sdk");
const supabase = require("../../config/database");

const client = new Anthropic({
  apiKey: process.env.CLAUDE_API_KEY,
});

const MODELO = "claude-haiku-4-5";
const MAX_TOKENS = 700;

// ---------------------------------------------------------------
// COLORES — traducción automática
// ---------------------------------------------------------------

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

function simplificar(texto) {
  return String(texto || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

function familiaDelColor(color) {
  const c = simplificar(color);
  for (const [familia, palabras] of Object.entries(FAMILIAS_COLOR)) {
    if (palabras.some(p => c.includes(p))) return familia;
  }
  return null;
}

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

  return `NOTA SOBRE EL COLOR: el cliente nombró un color que en este inventario corresponde a: ${equivalentes.join(', ')}. Si el modelo existe, dile que SÍ lo tienes en ese color, usando la palabra del cliente.`;
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

// Agrupa los productos iguales para que el inventario ocupe menos.
// En vez de 3 líneas (una por color), manda 1 con los colores juntos.
async function getProductsInfo(clientId) {
  const { data, error } = await supabase
    .from("products")
    .select("name, category, price, stock, capacity, color, battery_units")
    .eq("client_id", clientId)
    .eq("active", true)
    .order("name");

  if (error) {
    console.error("Error fetching products:", error);
    return { texto: "", colores: [] };
  }

  if (!data || data.length === 0) {
    return { texto: "Sin productos cargados", colores: [] };
  }

  const colores = new Set();
  const grupos = new Map();

  data.forEach(p => {
    if (p.color) colores.add(p.color);

    const bateria = bateriaMasAlta(p.battery_units);
    const hay = p.stock > 0;
    const clave = `${p.category}|${p.name}|${p.capacity}|${p.price}|${hay}|${bateria || ''}`;

    if (!grupos.has(clave)) {
      grupos.set(clave, {
        categoria: p.category,
        nombre: p.name,
        capacidad: p.capacity,
        precio: p.price,
        hay,
        bateria,
        colores: []
      });
    }

    if (p.color) grupos.get(clave).colores.push(p.color);
  });

  const porCategoria = {};

  for (const g of grupos.values()) {
    const cat = g.categoria || 'Otros';
    if (!porCategoria[cat]) porCategoria[cat] = [];

    const partes = [g.nombre];
    if (g.capacidad) partes.push(g.capacidad);
    if (g.colores.length) partes.push(g.colores.join('/'));

    const precio = `$${Number(g.precio).toLocaleString('es-CO')}`;
    const estado = g.hay ? '' : ' AGOTADO';
    const bat = g.bateria ? ` bat.${g.bateria}` : '';

    porCategoria[cat].push(`${partes.join(' ')} ${precio}${bat}${estado}`);
  }

  let texto = "INVENTARIO:\n";
  Object.entries(porCategoria).forEach(([cat, lineas]) => {
    texto += `${cat}: ${lineas.join(' | ')}\n`;
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

  const lineas = data.map(p => {
    const desc = p.discount_percentage
      ? `${p.discount_percentage}% dto`
      : `$${p.discount_amount?.toLocaleString('es-CO')} dto`;
    return `${p.title}: ${p.description} (${desc})`;
  });

  return `\nPROMOCIONES: ${lineas.join(' | ')}\n`;
}

// ---------------------------------------------------------------
// RESPUESTA
// ---------------------------------------------------------------

async function generateResponse(messageContent, clientId, conversationHistory = []) {
  try {
    const config = await getAgentConfig(clientId);

    const inventario = await getProductsInfo(clientId);
    const promociones = await getPromotionsInfo(clientId);

    // Esta parte es igual en todos los mensajes -> se puede cachear
    const parteEstable = `${config.system_prompt}

${inventario.texto}${promociones}

REGLAS:
- Consulta el inventario antes de confirmar disponibilidad
- Menciona la batería SOLO si preguntan, con el dato exacto del inventario. Nunca la inventes.
- Nunca digas cuántas unidades hay
- No prometas fechas de entrega sin verificar
- Tono ${config.tone}. Responde en español.`;

    // Esta cambia en cada mensaje -> va aparte para no romper el caché
    const nota = notaDeColor(textoDelMensaje(messageContent), inventario.colores);
    if (nota) console.log('🎨 Nota de color agregada');

    const system = [
      { type: "text", text: parteEstable, cache_control: { type: "ephemeral" } }
    ];

    if (nota) system.push({ type: "text", text: nota });

    const messages = [
      ...conversationHistory,
      { role: "user", content: messageContent }
    ];

    const response = await client.messages.create({
      model: MODELO,
      max_tokens: MAX_TOKENS,
      system: system,
      messages: messages,
    });

    const uso = response.usage || {};
    console.log(`💰 Tokens — entrada:${uso.input_tokens || 0} caché_leído:${uso.cache_read_input_tokens || 0} caché_creado:${uso.cache_creation_input_tokens || 0} salida:${uso.output_tokens || 0}`);

    return response.content[0].text;
  } catch (error) {
    console.error("Error calling Claude API:", error);
    throw new Error(`Failed to generate response: ${error.message}`);
  }
}

module.exports = { generateResponse };