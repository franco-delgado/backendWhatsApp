const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');

// Inicializar cliente de Supabase
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

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

async function enviarPlantillaWhatsApp(numeroDestino, componentesOParametros = [], templateName, languageCode = 'es_AR') {
  const cleanNumber = _limpiarNumero(numeroDestino);
  const nombrePlantilla = templateName;

  const templatePayload = {
    name: nombrePlantilla,
    language: { code: languageCode }
  };

  if (Array.isArray(componentesOParametros) && componentesOParametros[0]?.type) {
    templatePayload.components = componentesOParametros;
  } else if (
    componentesOParametros &&
    typeof componentesOParametros === 'object' &&
    !Array.isArray(componentesOParametros) &&
    (componentesOParametros.header !== undefined || componentesOParametros.body !== undefined)
  ) {
    const components = [];

    if (componentesOParametros.header !== undefined && String(componentesOParametros.header).trim() !== '') {
      components.push({
        type: 'header',
        parameters: [{ type: 'text', text: String(componentesOParametros.header).trim() }]
      });
    }

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
  } else {
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
// MÉTODOS PÚBLICOS DE RECEPCIÓN / DESCARGA (ADAPTADO A SUPABASE)
// ==========================================

/**
 * Descarga el archivo de medios de Meta y lo sube directamente al Bucket 'whatsapp-media' de Supabase Storage.
 */
async function descargarMediaWhatsApp(mediaId, mimeTypeEntrante = null) {
  const token = process.env.META_ACCESS_TOKEN;

  if (!token) {
    throw new Error('Falta la credencial META_ACCESS_TOKEN en las variables de entorno.');
  }

  try {
    // 1. Obtener la URL temporal de Meta
    const metaRes = await axios.get(`https://graph.facebook.com/v22.0/${mediaId}`, {
      headers: { Authorization: `Bearer ${token}` }
    });

    const downloadUrl = metaRes.data.url;

    // 2. Descargar el contenido binario del archivo
    const mediaResponse = await axios.get(downloadUrl, {
      headers: { Authorization: `Bearer ${token}` },
      responseType: 'arraybuffer'
    });

    // 3. Determinar el MIME type exacto
    const mimeType = mimeTypeEntrante || mediaResponse.headers['content-type'] || 'image/jpeg';
    
    // 4. Determinar extensión del archivo
    let ext = 'jpg';
    const cleanMime = mimeType.toLowerCase();

    if (cleanMime.includes('png')) ext = 'png';
    else if (cleanMime.includes('webp')) ext = 'webp';
    else if (cleanMime.includes('jpeg') || cleanMime.includes('jpg')) ext = 'jpg';
    else if (cleanMime.includes('ogg')) ext = 'ogg';
    else if (cleanMime.includes('mpeg') || cleanMime.includes('mp3')) ext = 'mp3';
    else if (cleanMime.includes('aac')) ext = 'aac';
    else if (cleanMime.includes('pdf')) ext = 'pdf';

    const fileName = `${Date.now()}_${mediaId}.${ext}`;

    // 5. Subir archivo a Supabase Storage
    const { data: uploadData, error: uploadError } = await supabase.storage
      .from('whatsapp-media')
      .upload(fileName, mediaResponse.data, {
        contentType: mimeType.split(';')[0].trim(),
        upsert: true
      });

    if (uploadError) {
      console.error('❌ Error al subir archivo a Supabase Storage:', uploadError.message);
      throw uploadError;
    }

    // 6. Obtener la URL pública permanente
    const { data: publicUrlData } = supabase.storage
      .from('whatsapp-media')
      .getPublicUrl(fileName);

    console.log(`📁 Archivo subido con éxito a Supabase Storage: ${publicUrlData.publicUrl}`);

    return publicUrlData.publicUrl;
  } catch (error) {
    console.error('❌ Error al procesar archivo multimedia para Supabase:', error.message);
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