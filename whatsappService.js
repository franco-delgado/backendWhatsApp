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

async function enviarPlantillaWhatsApp(numeroDestino, parametros = [], templateName, languageCode = 'es_AR') {
  const cleanNumber = _limpiarNumero(numeroDestino);

  const nombrePlantilla = templateName;
  const templatePayload = {
    name: nombrePlantilla,
    language: { code: languageCode }
  };

  if (Array.isArray(parametros) && parametros.length > 0) {
    if (nombrePlantilla === 'invitacion' && parametros.length >= 2) {
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
    } else {
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