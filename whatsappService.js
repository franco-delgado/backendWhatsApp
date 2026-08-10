const axios = require('axios');
const fs = require('fs');
const path = require('path');

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
// MÉTODOS PÚBLICOS DE ENVÍO
// ==========================================

/**
 * Envía una plantilla de WhatsApp.
 *
 * `componentesOParametros` acepta 3 formatos:
 *  1) Array de componentes ya armados por Meta: [{ type: 'header', parameters: [...] }, ...]
 *  2) Objeto { header, body } -> arma un componente 'header' y uno 'body', cada uno
 *     con su propio parámetro de texto. Usado por ej. en la plantilla "invitacion" o "alta".
 *  3) Array de strings sueltos -> se mandan todos como parámetros del 'body'
 *     (en orden, {{1}}, {{2}}, ...). Usado por ej. en la plantilla "mensaje_mensual".
 */
async function enviarPlantillaWhatsApp(numeroDestino, componentesOParametros = [], templateName, languageCode = 'es_AR') {
  const cleanNumber = _limpiarNumero(numeroDestino);
  const nombrePlantilla = templateName;

  const templatePayload = {
    name: nombrePlantilla,
    language: { code: languageCode }
  };

  // 1️⃣ Ya vienen componentes estructurados de Meta (cada item con "type")
  if (Array.isArray(componentesOParametros) && componentesOParametros[0]?.type) {
    templatePayload.components = componentesOParametros;
  }
  // 2️⃣ Objeto { header, body } (ej: plantilla "invitacion" o "alta")
  else if (
    componentesOParametros &&
    typeof componentesOParametros === 'object' &&
    !Array.isArray(componentesOParametros) &&
    (componentesOParametros.header !== undefined || componentesOParametros.body !== undefined)
  ) {
    const components = [];

    // Header
    if (componentesOParametros.header !== undefined && String(componentesOParametros.header).trim() !== '') {
      components.push({
        type: 'header',
        parameters: [{ type: 'text', text: String(componentesOParametros.header).trim() }]
      });
    }

    // Body (soporta string único o array con múltiples variables)
    if (componentesOParametros.body !== undefined) {
      let bodyParams = [];

      if (Array.isArray(componentesOParametros.body)) {
        bodyParams = componentesOParametros.body
          .filter(val => val !== null && val !== undefined)
          .map(val => ({ type: 'text', text: String(val).trim() }));
      } else if (String(componentesOParametros.body).trim() !== '') {
        bodyParams = [{ type: 'text', text: String(componentesOParametros.body).trim() }];
      }

      if (bodyParams.length > 0) {
        components.push({
          type: 'body',
          parameters: bodyParams
        });
      }
    }

    templatePayload.components = components;
  }
  // 3️⃣ Array de parámetros sueltos (ej: plantilla "mensaje_mensual") u otros formatos legacy
  else {
    let params = [];

    if (Array.isArray(componentesOParametros)) {
      params = componentesOParametros;
    } else if (componentesOParametros && typeof componentesOParametros === 'object') {
      params = componentesOParametros.parametros ||
               componentesOParametros.params ||
               componentesOParametros.components || [];
    } else if (typeof componentesOParametros === 'string' && componentesOParametros.trim() !== '') {
      params = [componentesOParametros];
    }

    params = params.filter(p => p !== null && p !== undefined).map(p => String(p).trim());

    if (params.length > 0) {
      templatePayload.components = [
        {
          type: 'body',
          parameters: params.map(texto => ({ type: 'text', text: texto }))
        }
      ];
    } else {
      // Respaldo de seguridad si no llegó ningún parámetro
      templatePayload.components = [
        {
          type: 'body',
          parameters: [{ type: 'text', text: 'Franco' }]
        }
      ];
    }
  }

  console.log("📤 PAYLOAD REAL ENVIADO A META:", JSON.stringify(templatePayload, null, 2));

  return await _enviarPeticionMeta({
    messaging_product: 'whatsapp',
    to: cleanNumber,
    type: 'template',
    template: templatePayload
  });
}

async function enviarTextoLibreWhatsApp(numeroDestino, texto, contextMessageId = null) {
  const cleanNumber = _limpiarNumero(numeroDestino);

  const payload = {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to: cleanNumber,
    type: 'text',
    text: { preview_url: true, body: texto }
  };

  if (contextMessageId) {
    payload.context = {
      message_id: contextMessageId
    };
  }

  return await _enviarPeticionMeta(payload);
}

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

// ==========================================
// MÉTODOS PÚBLICOS DE RECEPCIÓN / DESCARGA
// ==========================================

async function descargarMediaWhatsApp(mediaId) {
  const token = process.env.META_ACCESS_TOKEN;

  if (!token) {
    throw new Error('Falta la credencial META_ACCESS_TOKEN en las variables de entorno.');
  }

  try {
    const metaRes = await axios.get(`https://graph.facebook.com/v22.0/${mediaId}`, {
      headers: { Authorization: `Bearer ${token}` }
    });

    const downloadUrl = metaRes.data.url;

    const mediaResponse = await axios.get(downloadUrl, {
      headers: { Authorization: `Bearer ${token}` },
      responseType: 'arraybuffer'
    });

    const mimeType = mediaResponse.headers['content-type'] || '';
    let ext = 'bin';
    if (mimeType.includes('image/jpeg')) ext = 'jpg';
    else if (mimeType.includes('image/png')) ext = 'png';
    else if (mimeType.includes('image/webp')) ext = 'webp';
    else if (mimeType.includes('audio/ogg')) ext = 'ogg';
    else if (mimeType.includes('audio/mpeg')) ext = 'mp3';
    else if (mimeType.includes('audio/aac')) ext = 'aac';
    else if (mimeType.includes('application/pdf')) ext = 'pdf';

    const uploadsFolder = path.join(__dirname, 'public', 'uploads');
    if (!fs.existsSync(uploadsFolder)) {
      fs.mkdirSync(uploadsFolder, { recursive: true });
    }

    const fileName = `${mediaId}.${ext}`;
    const filePath = path.join(uploadsFolder, fileName);

    fs.writeFileSync(filePath, mediaResponse.data);

    return `/uploads/${fileName}`;
  } catch (error) {
    console.error('❌ Error al descargar archivo multimedia de Meta:', error.message);
    throw error;
  }
}

module.exports = {
  enviarPlantillaWhatsApp,
  enviarTextoLibreWhatsApp,
  enviarImagenWhatsApp,
  enviarDocumentoWhatsApp,
  descargarMediaWhatsApp
};