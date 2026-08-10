const mongoose = require("mongoose");

const mensajeSchema = new mongoose.Schema({
  id: { type: String, unique: true }, // ID único de Meta
  from: String,
  nombre: String,
  type: String,
  text: String,
  timestamp: Date,
}, { timestamps: true });

module.exports = mongoose.model('Mensaje', mensajeSchema);