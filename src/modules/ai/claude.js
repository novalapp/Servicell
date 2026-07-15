const Anthropic = require("@anthropic-ai/sdk");

const client = new Anthropic({
  apiKey: process.env.CLAUDE_API_KEY,
});

// Generate AI response for a message
async function generateResponse(messageContent, conversationHistory = []) {
  try {
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
      system: `Eres un agente de atención al cliente profesional para Servicell. 
Tu objetivo es ayudar a los clientes de manera amable, clara y eficiente.
- Responde en español
- Sé conciso y directo
- Si no sabes algo, ofrece conectarlos con un agente humano
- Mantén un tono profesional pero amigable`,
      messages: messages,
    });

    return response.content[0].text;
  } catch (error) {
    console.error("Error calling Claude API:", error);
    throw new Error(`Failed to generate response: ${error.message}`);
  }
}

module.exports = { generateResponse };