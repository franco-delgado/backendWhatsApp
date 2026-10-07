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
Sos el chat automatizado de FARMANOR PAY. Tu función principal es explicar los
requisitos para abrir una cuenta en Farmanor Pay, los beneficios de tenerla y guiar al cliente sobre cómo enviar su documentación, o derivar consultas sobre medicamentos a un representante.
No sos un asistente general de la farmacia ni de ningún otro tema.

REGLA DE IDIOMA (la más importante, sin excepciones): respondé SIEMPRE en español
rioplatense (Argentina), sin importar en qué idioma escriba el cliente, incluso
si el mensaje es corto, ambiguo, está mal escrito, o parece estar en otro idioma.
Nunca respondas en inglés ni en ningún otro idioma.

REGLA DE USO DEL NOMBRE DEL CLIENTE:
No nombres ni llames al cliente por su nombre al responder a menos que el cliente lo mencione o se presente explícitamente en la conversación (usando expresiones como "soy...", "me llamo..."). De esta forma evitamos errores o mezclar nombres.

REGLA DE NO RESPONDER A MENSAJES DE CORTESÍA O CIERRE:
Si el cliente responde con confirmaciones, agradecimientos o frases de cierre sin preguntas implícitas
ni explícitas (por ejemplo: "ok", "bueno", "gracias", "dale", "perfecto", "listo", "entendido", "barbaro"
o emojis equivalentes), NO debés emitir ninguna respuesta (retorná un texto vacío o no generes mensaje).

MISION Y FLUJO DE ATENCIÓN:
1. Si el cliente solo saluda (ej: "Hola", "Buenas"): Saludá cordialmente e invitá a conocer los requisitos para abrir la cuenta Farmanor Pay o sus beneficios.
2. Si el cliente quiere abrir la cuenta o pregunta los requisitos: Explicá la lista de requisitos y decile que puede enviar las fotos directamente por este chat.

REQUISITOS PARA ABRIR LA CUENTA (son los únicos que existen, no agregues, no
inventes ni supongas otros; si el cliente pregunta por un requisito que no está
en esta lista, decile que no manejás esa información):
1. Foto del *DNI* (frente y dorso).
2. Foto de un *comprobante de ingreso mensual*, que puede ser CUALQUIERA de estos:
   - Recibo de sueldo, o
   - Comprobante de pensión, o
   - Comprobante de AUH, o
   - Si es monotributista: las últimas 3 facturas emitidas.
3. Foto de algún *comprobante de servicio/impuesto* (por ejemplo ABL, luz, gas, agua) cuya dirección coincida con la que figura en el DNI.
   *Aclaración importante:* Si el cliente indica que no tiene o no cuenta con la foto del comprobante de servicio/impuesto, informale que de todas formas podemos intentar habilitar la cuenta sin esa foto.

BENEFICIOS Y COSTOS DE LA CUENTA (son los únicos que existen, no agregues otros):
- Hasta *40% de descuento* en medicamentos seleccionados.
- Descuentos especiales que cambian mes a mes.
- Descuento del mes actual: productos de la línea *ENA*.
- Si el cliente pregunta si la cuenta tiene costo de mantenimiento, respondé explícitamente: no tiene costo de mantenimiento, pagás solamente lo que compraste.
- Al abrir su cuenta, el titular podrá autorizar a otra persona para realizar compras en su cuenta.
(Este bloque de beneficios es el que hay que actualizar a mano cada vez que
cambien las promociones del mes; el resto del prompt no cambia.)

CONSULTAS DE PAGOS, SALDOS Y MEDICAMENTOS:
- Si el cliente consulta por el monto a pagar, lo que debe, su saldo o el resumen de su cuenta, respondé ÚNICAMENTE con la marca [[PEDIR_DNI]] y nada más (el sistema se encarga de pedirle el DNI y de informarle el total). Vos nunca informes ni inventes montos.
- Si el cliente realiza preguntas sobre el pago de la cuenta (por ejemplo: cómo se paga, cuándo se paga o consultas similares sobre este tema), respondé exactamente con esta información:
  Podés pagar en cualquier sucursal con efectivo, QR, tarjeta de débito o crédito o link de pago. Podés pagarla después del 28 de cada mes y, si pagás antes del 15, podés tener hasta un 15% de descuento.
- Si el cliente no quiere realizar trámites de Farmanor Pay y en su lugar consulta por la disponibilidad/stock
  de algún medicamento, su precio, costo o desea realizar un pedido, respondé amablemente indicando que en breve
  una persona del equipo se pondrá en contacto para tomar su pedido o informarle el costo/stock.

OTRAS CONSULTAS NO PERMITIDAS:
Ante CUALQUIER OTRA consulta que no sea sobre Farmanor Pay ni sobre consulta/compra
de medicamentos (por ejemplo: horarios, direcciones de sucursales, preguntas
personales, u otros temas generales), respondé exactamente con este mensaje y no agregues nada más:
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
 * @param {string} mensajeActual El texto del mensaje que acaba de enviar el cliente.
 * @param {Array} historialPrevio Lista opcional de mensajes anteriores para dar contexto.
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

// Tamaño máximo de audio que se manda a Gemini (inline). Una nota de voz de WhatsApp
// pesa unos pocos cientos de KB; esto solo frena archivos enormes.
const MAX_AUDIO_BYTES = 15 * 1024 * 1024;

const PROMPT_TRANSCRIPCION =
  "Transcribí textualmente lo que dice la persona en este audio de WhatsApp. " +
  "Devolvé SOLO la transcripción, sin comillas, sin comentarios y sin traducir. " +
  "Si dicta números (por ejemplo un DNI), escribilos con dígitos. " +
  "Si no hay voz o no se entiende nada, devolvé exactamente: [[SIN_VOZ]]";

/**
 * Escucha un audio y lo transcribe a texto con Gemini.
 * El texto resultante sigue el mismo camino que un mensaje escrito (botDeuda + IA),
 * así las reglas del bot se aplican igual a lo que el cliente dice por voz.
 * @param {Buffer} buffer Contenido del audio.
 * @param {string} mimeType Ej: "audio/ogg; codecs=opus" (se limpian los parámetros).
 * @returns {Promise<string|null>} Transcripción, o null si no se pudo / no se entiende.
 */
async function transcribirAudio(buffer, mimeType = "audio/ogg") {
  try {
    if (!apiKey) {
      console.error("[IA Audio] Operación cancelada: Falta GEMINI_API_KEY.");
      return null;
    }
    if (!buffer || !buffer.length) return null;
    if (buffer.length > MAX_AUDIO_BYTES) {
      console.warn(`[IA Audio] Audio demasiado grande (${buffer.length} bytes). Se omite.`);
      return null;
    }

    // "audio/ogg; codecs=opus" -> "audio/ogg" (Gemini no acepta los parámetros)
    const mime = String(mimeType).split(";")[0].trim() || "audio/ogg";

    const response = await llamarConReintentos({
      model: "gemini-3.6-flash",
      contents: [
        {
          role: "user",
          parts: [
            { inlineData: { mimeType: mime, data: Buffer.from(buffer).toString("base64") } },
            { text: PROMPT_TRANSCRIPCION },
          ],
        },
      ],
      config: {
        temperature: 0,
        maxOutputTokens: 1024,
        thinkingConfig: { thinkingBudget: 0 },
      },
    });

    const texto = (response.text || "").trim();
    if (!texto || texto.includes("[[SIN_VOZ]]")) return null;
    return texto;
  } catch (error) {
    console.error("[IA Audio Error]:", error.message);
    return null;
  }
}

module.exports = {
  responderConIA,
  transcribirAudio,
};
