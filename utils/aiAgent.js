const { GoogleGenAI } = require("@google/genai");

// Inicialización del cliente de Gemini
const apiKey = process.env.GEMINI_API_KEY;
if (!apiKey) {
  console.warn("⚠️ Advertencia: No se encontró GEMINI_API_KEY en las variables de entorno.");
}

const ai = new GoogleGenAI({ apiKey: apiKey || "" });

/**
 * Prompts de sistema personalizables según el rol de tu negocio.
 */
const SYSTEM_INSTRUCTIONS = `
Eres un asistente virtual de atención al cliente amable, rápido y profesional.
Tus responsabilidades:
1. Responder dudas y consultas de forma concisa y clara en español.
2. Si el usuario envía mensajes confusos o solicita hablar con un humano, indícale amablemente que un agente tomará la conversación en breve.
3. Mantén un tono cordial, usando emojis ocasionales pero sin saturar.
`;

// Reintenta ante errores transitorios de Gemini (503 "sobrecargado", 429 "rate limit").
// Otros errores (API key inválida, etc.) no tiene sentido reintentarlos: se cortan al toque.
async function llamarConReintentos(payload, intentos = 3) {
  for (let intento = 1; intento <= intentos; intento++) {
    try {
      return await ai.models.generateContent(payload);
    } catch (error) {
      const esTransitorio = /503|429|UNAVAILABLE|RESOURCE_EXHAUSTED/i.test(error.message || "");
      const quedanIntentos = intento < intentos;

      if (esTransitorio && quedanIntentos) {
        const esperaMs = 1000 * intento; // 1s, 2s, 3s...
        console.warn(
          `[IA Framework] Gemini sobrecargado (intento ${intento}/${intentos}). Reintentando en ${esperaMs}ms.`
        );
        await new Promise((resolve) => setTimeout(resolve, esperaMs));
        continue;
      }

      throw error;
    }
  }
}

/**
 * Framework para interactuar con el modelo de IA.
 * @param {string} mensajeActual - El texto del mensaje que acaba de enviar el cliente.
 * @param {Array} historialPrevio - Lista opcional de mensajes anteriores para dar contexto.
 * @returns {Promise<string|null>} Texto de respuesta generado por la IA o null si falla.
 */
async function responderConIA(mensajeActual, historialPrevio = []) {
  try {
    if (!apiKey) {
      console.error("[IA Framework] Operación cancelada: Falta GEMINI_API_KEY.");
      return null;
    }

    // Formatear historial si se proporciona (útil para conversaciones continuas)
    const contents = [];

    if (Array.isArray(historialPrevio) && historialPrevio.length > 0) {
      historialPrevio.forEach((msg) => {
        contents.push({
          role: msg.esCliente ? "user" : "model",
          parts: [{ text: msg.texto }],
        });
      });
    }

    // Agregar el mensaje actual del cliente
    contents.push({
      role: "user",
      parts: [{ text: mensajeActual }],
    });

    const response = await llamarConReintentos({
      model: "gemini-3.6-flash",
      contents: contents,
      config: {
        systemInstruction: SYSTEM_INSTRUCTIONS,
        temperature: 0.7,
        maxOutputTokens: 500,
      },
    });

    return response.text || null;
  } catch (error) {
    console.error("[IA Framework Error]:", error.message);
    return null;
  }
}

module.exports = {
  responderConIA,
};
