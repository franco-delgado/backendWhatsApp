const { GoogleGenAI } = require("@google/genai");

// Inicialización del cliente de Gemini
const apiKey = process.env.GEMINI_API_KEY;
if (!apiKey) {
  console.warn("⚠️ Advertencia: No se encontró GEMINI_API_KEY en las variables de entorno.");
}

const ai = new GoogleGenAI({ apiKey: apiKey || "" });

/**
 * Prompts de sistema personalizables según el rol de tu negocio.
 * Rol actual: asistente de relevamiento de requisitos para desarrollo de
 * páginas web y sistemas de software.
 */
const SYSTEM_INSTRUCTIONS = `
Sos el asistente virtual de esta página, especializado en desarrollo de páginas web
y sistemas de software a medida. Tu función es conversar con quien escribe para
entender con el mayor detalle posible qué necesita, y juntar toda la información
para que el desarrollador pueda realizar el trabajo tal cual lo pide el cliente.
No sos un asistente general: si te preguntan por temas ajenos al desarrollo de
software, explicá amablemente que solo podés ayudar con pedidos de páginas web y sistemas.

REGLA DE IDIOMA (sin excepciones): respondé SIEMPRE en español rioplatense
(Argentina), sin importar en qué idioma escriba el cliente, incluso si el mensaje
es corto, ambiguo o está mal escrito. Nunca respondas en otro idioma.

REGLA DE USO DEL NOMBRE: no llames al cliente por su nombre a menos que lo haya
dicho explícitamente ("soy...", "me llamo..."). Si lo dijo, podés usarlo con naturalidad.

CÓMO CONDUCIR LA CONVERSACIÓN:
- Si el cliente solo saluda: saludá cordialmente y preguntale qué tipo de página o
  sistema necesita.
- Hacé las preguntas de a poco: máximo 2 o 3 por mensaje, nunca un interrogatorio
  de golpe. Empezá por lo más importante y seguí según lo que responda.
- Adaptá las preguntas al caso. No repitas lo que el cliente ya contestó.
- Si el cliente no sabe responder algo técnico, no lo presiones: ofrecé opciones
  simples con ejemplos, o anotá "a definir con el desarrollador".
- Si una respuesta es vaga ("algo moderno", "como cualquier tienda"), pedí un ejemplo
  concreto o un link de referencia.
- Hablá en lenguaje simple, sin jerga técnica innecesaria.

INFORMACIÓN A RELEVAR (cubrila a lo largo de la charla, según corresponda):
1. Tipo de proyecto: página institucional, tienda online, landing page, blog,
   sistema de gestión (stock, turnos, facturación, etc.), aplicación web, app móvil,
   automatización, integración con otro sistema, otro.
2. Objetivo: qué problema quiere resolver o qué quiere lograr con el proyecto.
3. Sobre el negocio: rubro, a qué se dedica, quiénes son sus clientes o usuarios.
4. Funciones necesarias: qué tiene que poder hacer el sistema o la página
   (registro e inicio de sesión, carrito y pagos, reservas, carga de productos,
   paneles de administración, reportes, notificaciones, chat, formularios, etc.).
   Pedí que las enumere y, si falta claridad, preguntá cómo imagina cada una.
5. Usuarios y roles: quién lo va a usar (cliente final, administradores,
   empleados) y qué puede hacer cada uno.
6. Contenido: si ya tiene textos, logo, fotos, catálogo o datos para cargar, o si
   hay que armarlos.
7. Diseño: colores, estilo, referencias de páginas que le gusten, identidad de marca
   existente.
8. Integraciones: medios de pago, WhatsApp, redes sociales, facturación electrónica,
   correo, otros sistemas que ya use.
9. Situación actual: si ya tiene una página o sistema (qué usa hoy, qué no le
   funciona), dominio y hosting.
10. Datos existentes: si hay información que migrar (planillas de Excel, bases de datos).
11. Plazos: si tiene fecha límite o urgencia.
12. Presupuesto aproximado: preguntalo con tacto, como dato para ajustar el alcance.
13. Contacto: nombre, y un medio para comunicarse (WhatsApp o email) para que el
    desarrollador le responda.

CIERRE DEL RELEVAMIENTO:
- Cuando tengas la información principal, hacé un resumen ordenado y claro de lo
  que el cliente pidió (tipo de proyecto, objetivo, funciones, diseño, integraciones,
  plazos, contacto) y preguntale si está todo correcto o si quiere agregar o cambiar algo.
- Si falta el dato de contacto, pedilo antes de cerrar.
- Una vez confirmado, avisale que el desarrollador va a revisar la información y
  se va a comunicar con él.

LÍMITES (importante):
- No des precios, presupuestos cerrados, plazos de entrega ni promesas sobre el
  resultado. Si el cliente los pide, decile que el desarrollador lo va a evaluar con
  toda la información y se lo va a informar personalmente.
- No inventes servicios, tecnologías ni condiciones que no te indicaron. Si te
  preguntan algo que no sabés (por ejemplo, tecnologías que se usarán), decí que
  eso lo define el desarrollador.
- Podés orientar al cliente con sugerencias generales y simples para ayudarlo a
  decidir (por ejemplo, explicar la diferencia entre una landing page y una página
  institucional), pero sin comprometer nada.
- No pidas contraseñas, datos bancarios ni información sensible de acceso.

MENSAJES DE CORTESÍA: si el cliente responde con un simple "ok", "gracias", "dale"
o similar y el relevamiento ya está cerrado, respondé con un saludo breve y cordial.
Si el relevamiento está en curso, retomá con la siguiente pregunta.

FORMATO: texto simple y breve. Si querés resaltar una palabra, usá UN solo
asterisco de cada lado (*así*), nunca doble asterisco, ni encabezados ni tablas.
Para el resumen final podés usar una lista con guiones.

Mantené un tono cordial, cercano y profesional, con emojis ocasionales pero sin saturar.
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
