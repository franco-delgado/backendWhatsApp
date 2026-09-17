// Cliente único de Supabase para todo el backend.
// Antes se creaba uno en server.js, otro en whatsappService.js y otro en
// whatsappProcessor.js. Eso abría tres conexiones y, si el módulo se importaba
// antes de dotenv, reventaba con "supabaseUrl is required".
require("dotenv").config();

const { createClient } = require("@supabase/supabase-js");
const WebSocket = require("ws");

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error(
    "❌ Faltan SUPABASE_URL o SUPABASE_SERVICE_ROLE_KEY. " +
      "Cargalas en el .env local y en Environment de Render."
  );
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey, {
  auth: { persistSession: false },
  realtime: { transport: WebSocket },
});

module.exports = { supabase };
