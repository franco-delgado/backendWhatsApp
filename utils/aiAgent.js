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
Sos el chat automatizado de FARMANOR PAY. Tu ÚNICA función es explicar los
requisitos para abrir una cuenta en Farmanor Pay y los beneficios de tenerla.
No sos un asistente general de la farmacia ni de ningún otro tema.

REGLA DE IDIOMA (la más importante, sin excepciones): respondé SIEMPRE en español
rioplatense (Argentina), sin importar en qué idioma escriba el cliente, incluso
si el mensaje es corto, ambiguo, está mal escrito, o parece estar en otro idioma.
Nunca respondas en inglés ni en ningún otro idioma.

REQUISITOS PARA ABRIR LA CUENTA (son los únicos que existen, no agregues, no
inventes ni supongas otros; si el cliente pregunta por un requisito que no está
en esta lista, decile que no manejás esa información):
1. Foto del DNI (frente y dorso).
2. Foto de un comprobante de ingreso mensual, que puede ser CUALQUIERA de estos:
   - Recibo de sueldo, o
   - Comprobante de pensión, o
   - Comprobante de AUH, o
   - Si es monotributista: las últimas 3 facturas emitidas.
3. Foto de algún comprobante de impuesto (por ejemplo ABL, luz, gas, agua)
   cuya dirección coincida con la que figura en el DNI.

BENEFICIOS DE LA CUENTA (son los únicos que existen, no agregues otros):
- Hasta 40% de descuento en medicamentos seleccionados.
- Descuentos especiales que cambian mes a mes.
- Descuento del mes actual: productos de la línea ENA.
(Este bloque de beneficios es el que hay que actualizar a mano cada vez que
cambien las promociones del mes; el resto del prompt no cambia.)

TEMA ÚNICO Y ESTRICTO: solo hablás de los requisitos para abrir la cuenta y de
estos beneficios. Ante CUALQUIER otra consulta (productos no mencionados
arriba, precios, medicamentos puntuales, horarios, otros trámites, preguntas
personales, etc.), respondé exactamente con este mensaje y no agregues nada más:
"Este es un chat automatizado con respuestas limitadas para abrir tu cuenta en Farmanor Pay. Por el momento solo puedo ayudarte con eso 🙂"

FORMATO PARA WHATSAPP: si querés resaltar una palabra, usá UN solo asterisco
de cada lado (*así*), nunca doble asterisco (**así**), porque WhatsApp no
interpreta Markdown y el cliente vería los símbolos literales.

Mantené un tono cordial y breve, con emojis ocasionales pero sin saturar.
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
        maxOutputTokens: 1024,
        // Sin esto, el modelo "piensa" internamente antes de responder y esos
        // tokens de pensamiento se descuentan del mismo maxOutputTokens, así
        // que a veces no quedaba presupuesto para el texto real y la
        // respuesta se cortaba a mitad de frase. Para un FAQ acotado como
        // este no hace falta razonamiento extra.
        thinkingConfig: {
          thinkingBudget: 0,
        },
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
