const {
  enviarPlantillaWhatsApp,
  enviarTextoLibreWhatsApp,
  enviarImagenWhatsApp,
  enviarDocumentoWhatsApp,
} = require("../whatsappService");

// NOTA: este archivo tenía una segunda copia de procesarMensajeEntrante que
// nadie llamaba (la buena vive en server.js) y que guardaba el sender sin
// nombre. Se eliminó para que no haya dos rutas de guardado divergentes.

async function procesarEnvio(payload = {}) {
  const number = payload.number || payload.to || payload.phone;
  const type = payload.type || "template";
  const parameters = payload.parameters || payload.params || [];
  const templateName =
    payload.templateName || payload.template_name || payload.template;
  const languageCode =
    payload.languageCode || payload.language_code || "es_AR";

  if (!number) {
    throw new Error("El parámetro 'number' (o 'to') es obligatorio.");
  }

  switch (type) {
    case "template": {
      if (!templateName) {
        throw new Error(
          "Para tipo 'template' el campo 'templateName' es obligatorio."
        );
      }
      console.log(
        `[procesarEnvio] Template "${templateName}" para destino: ${number}`
      );
      return await enviarPlantillaWhatsApp(
        number,
        parameters,
        templateName,
        languageCode
      );
    }

    case "text": {
      if (!payload.text) {
        throw new Error(
          "Para mensajes de tipo 'text', el campo 'text' es obligatorio."
        );
      }
      const contextMessageId =
        payload.contextMessageId || payload.context_message_id || null;
      return await enviarTextoLibreWhatsApp(number, payload.text, contextMessageId);
    }

    case "image": {
      if (!payload.mediaUrl) {
        throw new Error("Para tipo 'image', el campo 'mediaUrl' es obligatorio.");
      }
      return await enviarImagenWhatsApp(number, payload.mediaUrl, payload.caption || "");
    }

    case "document": {
      if (!payload.mediaUrl) {
        throw new Error("Para tipo 'document', el campo 'mediaUrl' es obligatorio.");
      }
      return await enviarDocumentoWhatsApp(
        number,
        payload.mediaUrl,
        payload.filename || "archivo.pdf",
        payload.caption || ""
      );
    }

    default:
      throw new Error(`Tipo de mensaje no soportado: '${type}'.`);
  }
}

module.exports = { procesarEnvio };
