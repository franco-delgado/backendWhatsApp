import { useEffect, useState } from "react";

/**
 * Componente de ejemplo para tu app React.
 * Consume la API del servidor Node (server.js) para:
 *  - Mostrar el QR mientras no esté conectado
 *  - Mostrar el estado de conexión
 *  - Enviar un mensaje de prueba una vez conectado
 *
 * Cambiá API_URL por la dirección real de tu servidor Linux.
 */

// Detecta automáticamente si estás en local o en producción
const API_URL =
  window.location.hostname === "localhost"
    ? "http://localhost:3000"
    : "https://backend-whatsapp-docker.onrender.com";

export default function QrConnect() {
  const [status, setStatus] = useState("disconnected");
  const [qr, setQr] = useState(null);
  const [numero, setNumero] = useState("");
  const [mensaje, setMensaje] = useState("");
  const [enviando, setEnviando] = useState(false);

  // Polling: consulta el estado cada 2.5 segundos
  useEffect(() => {
    const interval = setInterval(async () => {
      try {
        const res = await fetch(`${API_URL}/status`);
        const data = await res.json();
        setStatus(data.status);

        if (data.status === "qr") {
          const qrRes = await fetch(`${API_URL}/qr`);
          const qrData = await qrRes.json();
          if (qrData.qr) setQr(qrData.qr);
        } else {
          setQr(null);
        }
      } catch (err) {
        console.error("Error consultando estado:", err);
      }
    }, 2500);

    return () => clearInterval(interval);
  }, []);

  const enviarMensaje = async () => {
    setEnviando(true);
    try {
      const res = await fetch(`${API_URL}/send`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ number: numero, message: mensaje }),
      });
      const data = await res.json();
      if (data.success) {
        alert("Mensaje enviado ✅");
      } else {
        alert(`Error: ${data.error}`);
      }
    } catch (err) {
      alert("Error de conexión con el servidor.");
    } finally {
      setEnviando(false);
    }
  };

  return (
    <div
      style={{
        maxWidth: 420,
        margin: "0 auto",
        textAlign: "center",
        fontFamily: "sans-serif",
      }}
    >
      <h2>Conexión de WhatsApp</h2>

      {status === "connected" && <p style={{ color: "green" }}>✅ Conectado</p>}
      {status === "connecting" && <p>Conectando...</p>}
      {status === "disconnected" && (
        <p style={{ color: "red" }}>Desconectado</p>
      )}

      {status === "qr" && qr && (
        <div>
          <p>Escaneá este código desde WhatsApp &gt; Dispositivos vinculados</p>
          <img
            src={qr}
            alt="Código QR de WhatsApp"
            style={{ width: 300, height: 300 }}
          />
        </div>
      )}

      {status === "connected" && (
        <div style={{ marginTop: 24 }}>
          <input
            type="text"
            placeholder="Número (ej: 5491122334455)"
            value={numero}
            onChange={(e) => setNumero(e.target.value)}
            style={{
              display: "block",
              width: "100%",
              marginBottom: 8,
              padding: 8,
            }}
          />
          <textarea
            placeholder="Mensaje"
            value={mensaje}
            onChange={(e) => setMensaje(e.target.value)}
            style={{
              display: "block",
              width: "100%",
              marginBottom: 8,
              padding: 8,
            }}
          />
          <button onClick={enviarMensaje} disabled={enviando}>
            {enviando ? "Enviando..." : "Enviar mensaje"}
          </button>
        </div>
      )}
    </div>
  );
}
