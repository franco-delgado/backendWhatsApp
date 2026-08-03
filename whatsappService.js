const axios = require('axios');
const fs = require('fs');
const path = require('path');

// Función interna genérica para realizar las peticiones a la API de WhatsApp Cloud.

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

// 1. Envío de PLANTILLAS (Templates)
 
async function enviarPlantillaWhatsApp(numeroDestino, parametros = [], templateName, languageCode = 'es_AR') {
  const cleanNumber = _limpiarNumero(numeroDestino);

  console.log('📥 [enviarPlantillaWhatsApp] Parámetro templateName recibido:', templateName);
  const nombrePlantilla = templateName;
  console.log('📌 [enviarPlantillaWhatsApp] Nombre de plantilla que se procesará:', nombrePlantilla);

  const templatePayload = {
    name: nombrePlantilla,
    language: { code: languageCode }
  };

  if (Array.isArray(parametros) && parametros.length > 0) {
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
    } else {
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

// 5. Descarga de archivos multimedia recibidos (Imágenes / Audios)
 
async function descargarMediaWhatsApp(mediaId) {
  const token = process.env.META_ACCESS_TOKEN;

  if (!token) {
    throw new Error('Falta la credencial META_ACCESS_TOKEN en las variables de entorno.');
  }

  try {
    // 1. Obtener URL temporal de descarga desde Meta
    const metaRes = await axios.get(`https://graph.facebook.com/v22.0/${mediaId}`, {
      headers: { Authorization: `Bearer ${token}` }
    });

    const downloadUrl = metaRes.data.url;

    // 2. Descargar el binario del archivo
    const mediaResponse = await axios.get(downloadUrl, {
      headers: { Authorization: `Bearer ${token}` },
      responseType: 'arraybuffer'
    });

    // 3. Determinar extensión por el Content-Type
    const mimeType = mediaResponse.headers['content-type'] || '';
    let ext = 'bin';
    if (mimeType.includes('image/jpeg')) ext = 'jpg';
    else if (mimeType.includes('image/png')) ext = 'png';
    else if (mimeType.includes('image/webp')) ext = 'webp';
    else if (mimeType.includes('audio/ogg')) ext = 'ogg';
    else if (mimeType.includes('audio/mpeg')) ext = 'mp3';
    else if (mimeType.includes('audio/aac')) ext = 'aac';
    else if (mimeType.includes('application/pdf')) ext = 'pdf';

    // 4. Asegurar la creación de la carpeta pública de descargas
    const uploadsFolder = path.join(__dirname, 'public', 'uploads');
    if (!fs.existsSync(uploadsFolder)) {
      fs.mkdirSync(uploadsFolder, { recursive: true });
    }

    const fileName = `${mediaId}.${ext}`;
    const filePath = path.join(uploadsFolder, fileName);

    fs.writeFileSync(filePath, mediaResponse.data);

    // Devuelve la URL estática relativa que Express servirá al frontend
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