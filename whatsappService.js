const axios = require('axios');

/**
 * Función interna genérica para realizar las peticiones a la API de WhatsApp Cloud.
 */
async function _enviarPeticionMeta(data) {
  const phoneNumberId = process.env.META_PHONE_NUMBER_ID;
  const token = process.env.META_ACCESS_TOKEN;

  if (!phoneNumberId || !token) {
    throw new Error('Faltan las credenciales META_PHONE_NUMBER_ID o META_ACCESS_TOKEN en las variables de entorno.');
  }

  const url = `https://graph.facebook.com/v22.0/${phoneNumberId}/messages`;

  // 🔍 LOG 3: Ver el payload final EXACTO que sale disparado hacia Meta
  console.log('🚀 [Meta Cloud API] Payload final enviado a Meta:', JSON.stringify(data, null, 2));

  try {
    const response = await axios.post(url, data, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      }
    });
    return response.data;
  } catch (error) {
    if (error.response) {
      const metaError = error.response.data?.error;
      console.error('❌ Error de Meta API:', JSON.stringify(metaError, null, 2));
      throw new Error(`Error WhatsApp Meta (${metaError?.code || error.response.status}): ${metaError?.message || 'Error desconocido'}`);
    }
    console.error('❌ Error de red/servidor:', error.message);
    throw error;
  }
}

/**
 * Sanitiza y valida el número de teléfono.
 */
function _limpiarNumero(numero) {
  const cleanNumber = String(numero).replace(/\D/g, '');
  if (!cleanNumber) throw new Error('El número de destino no es válido.');
  return cleanNumber;
}

// ==========================================
// MÉTODOS PÚBLICOS
// ==========================================

/**
 * 1. Envío de PLANTILLAS (Templates)
 */
async function enviarPlantillaWhatsApp(numeroDestino, parametros = [], templateName, languageCode = 'es_AR') {
  const cleanNumber = _limpiarNumero(numeroDestino);

  // 🔍 LOG 1: Verificar el valor que llegó como argumento en templateName
  console.log('📥 [enviarPlantillaWhatsApp] Parámetro templateName recibido:', templateName);

  // Garantizamos un nombre de plantilla válido
  const nombrePlantilla = templateName;

  // 🔍 LOG 2: Verificar la plantilla resuelta antes de armar el payload
  console.log('📌 [enviarPlantillaWhatsApp] Nombre de plantilla que se procesará:', nombrePlantilla);

  const templatePayload = {
    name: nombrePlantilla,
    language: { code: languageCode }
  };

  if (Array.isArray(parametros) && parametros.length > 0) {
    // 🔴 CASO A: Plantilla 'invitacion' (Header + Body)
    if (nombrePlantilla === 'invitacion' && parametros.length >= 2) {
      console.log('⚙️ [enviarPlantillaWhatsApp] Aplicando estructura de componentes: CASO A (invitacion: Header + Body)');
      const [headerText, ...bodyTexts] = parametros;

      templatePayload.components = [
        {
          type: 'header',
          parameters: [
            { type: 'text', text: String(headerText) }
          ]
        },
        {
          type: 'body',
          parameters: bodyTexts.map(texto => ({ type: 'text', text: String(texto) }))
        }
      ];
    } 
    // 🟢 CASO B: Plantillas estándar solo de Body (ej. 'mensaje_mensual')
    else {
      console.log('⚙️ [enviarPlantillaWhatsApp] Aplicando estructura de componentes: CASO B (Estándar: Solo Body)');
      templatePayload.components = [
        {
          type: 'body',
          parameters: parametros.map(texto => ({ type: 'text', text: String(texto) }))
        }
      ];
    }
  }

  return await _enviarPeticionMeta({
    messaging_product: 'whatsapp',
    to: cleanNumber,
    type: 'template',
    template: templatePayload
  });
}

/**
 * 2. Envío de TEXTO LIBRE (con opción de responder/citar mensaje previo)
 */
async function enviarTextoLibreWhatsApp(numeroDestino, texto, contextMessageId = null) {
  const cleanNumber = _limpiarNumero(numeroDestino);

  const payload = {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to: cleanNumber,
    type: 'text',
    text: { preview_url: true, body: texto }
  };

  // Si se pasa el ID del mensaje original, se agrega la referencia context
  if (contextMessageId) {
    payload.context = {
      message_id: contextMessageId
    };
  }

  return await _enviarPeticionMeta(payload);
}

/**
 * 3. Envío de IMÁGENES
 */
async function enviarImagenWhatsApp(numeroDestino, linkUrl, caption = '') {
  const cleanNumber = _limpiarNumero(numeroDestino);

  return await _enviarPeticionMeta({
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to: cleanNumber,
    type: 'image',
    image: {
      link: linkUrl,
      ...(caption && { caption })
    }
  });
}

/**
 * 4. Envío de DOCUMENTOS
 */
async function enviarDocumentoWhatsApp(numeroDestino, linkUrl, filename = 'documento.pdf', caption = '') {
  const cleanNumber = _limpiarNumero(numeroDestino);

  return await _enviarPeticionMeta({
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to: cleanNumber,
    type: 'document',
    document: {
      link: linkUrl,
      filename: filename,
      ...(caption && { caption })
    }
  });
}

module.exports = {
  enviarPlantillaWhatsApp,
  enviarTextoLibreWhatsApp,
  enviarImagenWhatsApp,
  enviarDocumentoWhatsApp
};