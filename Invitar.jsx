import { useState, useEffect } from "react";
import { useEnviarWhatsApp } from "../hooks/useEnviarWhatsApp";
import "./Invitar.css";
import useAgenda from "../hooks/useAgenda";

export default function Invitar() {
  // La agenda viene del servidor (igual que en Cobrar), no del localStorage.
  const { contactos, error: errorAgenda } = useAgenda();

  const [seleccionados, setSeleccionados] = useState([]);

  // Estados adaptados a las variables de la plantilla en Meta
  const [tituloVar, setTituloVar] = useState("");          // Header {{1}}
  const [textoAdicional, setTextoAdicional] = useState(""); // Body {{2}} (Quien saluda, ej: "Franco")
  const [nombreNegocio, setNombreNegocio] = useState("");   // Body {{3}} (Nombre de la empresa, ej: "FARMANOR")

  const { enviarMasivo, loading: cargando } = useEnviarWhatsApp();

  useEffect(() => {
    setSeleccionados(contactos.map((c) => c.id));
  }, [contactos]);

  const manejarSeleccion = (id) => {
    if (seleccionados.includes(id)) {
      setSeleccionados(seleccionados.filter((item) => item !== id));
    } else {
      setSeleccionados([...seleccionados, id]);
    }
  };

  const enviarInvitaciones = async () => {
    const listaAEnviar = contactos.filter((c) => seleccionados.includes(c.id));

    if (listaAEnviar.length === 0) {
      alert("Por favor, selecciona al menos un contacto de la lista.");
      return;
    }

    const valTitulo = tituloVar.trim() || "¡Abrí tu cuenta FARMANOR PAY!";
    const valCuerpo2 = textoAdicional.trim() || "el equipo";
    const valCuerpo3 = nombreNegocio.trim() || "FARMANOR";

    const contactsPayload = listaAEnviar.map((usuario) => {
      let numeroLimpio = usuario.numero.replace(/\D/g, "");

      if (!numeroLimpio.startsWith("54")) {
        numeroLimpio = `54${numeroLimpio}`;
      }

      const valCuerpo1 = usuario.nombre?.trim() || "Cliente";

      return {
        number: numeroLimpio,
        type: "template",
        templateName: "invitacion2109", // NOMBRE DE TU PLANTILLA
        languageCode: "es_AR",
        parameters: {
          header: [valTitulo],                       // Header {{1}}
          body: [valCuerpo1, valCuerpo2, valCuerpo3] // Body {{1}}, Body {{2}} y Body {{3}}
        }
      };
    });

    try {
      const datos = await enviarMasivo(contactsPayload);

      if (datos?.success) {
        const fallidos = datos.fallidos || 0;
        if (fallidos > 0) {
          // Por ejemplo, contactos que pertenecen a otro usuario del número compartido.
          const primero = (datos.results || []).find((r) => r.status === "error");
          alert(
            `Enviados: ${datos.enviados ?? datos.processed - fallidos}. No se pudieron enviar: ${fallidos}.` +
              (primero ? `\nEjemplo: ${primero.number} → ${primero.error}` : "")
          );
        } else {
          alert(`¡Mensajes enviados con éxito! Procesados: ${datos.processed} envíos. 🚀`);
        }
        console.log("Detalle del resultado:", datos.results);
      }
    } catch (err) {
      console.error("Error al procesar el envío:", err);
      alert(`Ocurrió un error en el envío: ${err.message}`);
    }
  };

  return (
    <div className="invitar-container">
      <h2 className="invitar-title">📧 Enviar Invitaciones Masivas</h2>

      {/* Inputs para configurar las variables de la plantilla */}
      <div style={{ display: "flex", gap: "10px", marginBottom: "15px", flexWrap: "wrap" }}>
        <div style={{ flex: 1, minWidth: "200px" }}>
          <label
            htmlFor="tituloVar"
            style={{ display: "block", fontWeight: "bold", marginBottom: "5px", fontSize: "13px" }}
          >
            Título (Encabezado {"{{1}}"}):
          </label>
          <input
            id="tituloVar"
            type="text"
            placeholder="ej: ¡Abrí tu cuenta FARMANOR PAY!"
            value={tituloVar}
            onChange={(e) => setTituloVar(e.target.value)}
            style={{ width: "100%", padding: "8px", borderRadius: "5px", border: "1px solid #ccc", fontSize: "14px" }}
          />
        </div>

        <div style={{ flex: 1, minWidth: "200px" }}>
          <label
            htmlFor="textoAdicional"
            style={{ display: "block", fontWeight: "bold", marginBottom: "5px", fontSize: "13px" }}
          >
            Nombre de quien saluda (Cuerpo {"{{2}}"}):
          </label>
          <input
            id="textoAdicional"
            type="text"
            placeholder="ej: Franco"
            value={textoAdicional}
            onChange={(e) => setTextoAdicional(e.target.value)}
            style={{ width: "100%", padding: "8px", borderRadius: "5px", border: "1px solid #ccc", fontSize: "14px" }}
          />
        </div>

        <div style={{ flex: 1, minWidth: "200px" }}>
          <label
            htmlFor="nombreNegocio"
            style={{ display: "block", fontWeight: "bold", marginBottom: "5px", fontSize: "13px" }}
          >
            Nombre Negocio (Cuerpo {"{{3}}"}):
          </label>
          <input
            id="nombreNegocio"
            type="text"
            placeholder="ej: FARMANOR"
            value={nombreNegocio}
            onChange={(e) => setNombreNegocio(e.target.value)}
            style={{ width: "100%", padding: "8px", borderRadius: "5px", border: "1px solid #ccc", fontSize: "14px" }}
          />
        </div>
      </div>

      {/* Vista previa de la Plantilla */}
      <div className="preview-box">
        <p style={{ margin: "0 0 5px 0", fontSize: "12px", color: "#666" }}>
          <strong>Vista previa de la Plantilla:</strong>
        </p>

        <h4 style={{ margin: "0 0 8px 0", color: "#007bff", fontStyle: "italic" }}>
          {tituloVar.trim() || "{{1}}"}
        </h4>

        <div style={{ margin: 0, fontSize: "13px", lineHeight: "1.4", color: "#444" }}>
          <p style={{ margin: "0 0 8px 0" }}>
            Hola <strong style={{ color: "#28a745" }}>{"{Nombre agendado}"}</strong>, te saluda{" "}
            <strong style={{ color: "#28a745" }}>{textoAdicional.trim() || "{{2}}"}</strong> de{" "}
            <strong style={{ color: "#28a745" }}>{nombreNegocio.trim() || "{{3}}"}</strong>. 👋
          </p>

          <p style={{ margin: "0 0 8px 0" }}>
            Queremos invitarte a abrir tu cuenta FARMANOR PAY y disfrutar de estos beneficios:<br />
            🔹 Compras en hasta 3 cuotas.<br />
            🔹 15% de descuento pagando antes del día 15.<br />
            🔹 Hasta 40% OFF en medicamentos seleccionados y promociones exclusivas.
          </p>

          <p style={{ margin: "0 0 8px 0" }}>
            ¿Qué necesitas para abrirla?<br />
            Solo envianos por este medio foto de:<br />
            1️⃣ DNI (frente y dorso).<br />
            2️⃣ Un servicio (luz, agua, cable o internet).<br />
            3️⃣ Comprobante de ingresos (recibo de sueldo, AUH, pensión o últimas 3 facturas si sos monotributista).
          </p>

          <p style={{ margin: 0 }}>¡Escribinos para cualquier consulta!</p>
        </div>

        <p style={{ margin: "10px 0 0 0", fontSize: "11px", color: "#999" }}>
          * "{"{Nombre agendado}"}" se reemplaza automáticamente por el nombre asignado a cada contacto.
        </p>
      </div>

      <button
        onClick={enviarInvitaciones}
        disabled={cargando}
        className="btn-enviar-cobros"
        style={{ width: "100%", marginTop: "15px" }}
      >
        {cargando ? "Enviando..." : `Enviar Invitaciones (${seleccionados.length})`}
      </button>

      <div className="usuarios-section" style={{ marginTop: "20px" }}>
        <h3>Contactos Disponibles</h3>
        <div className="usuarios-lista">
          {contactos.map((usuario) => (
            <div key={usuario.id} className="usuario-item">
              <input
                type="checkbox"
                checked={seleccionados.includes(usuario.id)}
                onChange={() => manejarSeleccion(usuario.id)}
              />
              <div className="usuario-info">
                <strong>{`${usuario.nombre} ${usuario.apellido || ""}`.trim()}</strong> ({usuario.numero})
                {usuario.monto > 0 && (
                  <span
                    style={{
                      color: "#d9534f",
                      fontSize: "12px",
                      marginLeft: "8px",
                      fontWeight: "bold"
                    }}
                  >
                    Deuda: ${usuario.monto}
                  </span>
                )}
              </div>
            </div>
          ))}

          {errorAgenda && (<p style={{ color: "#d9534f", fontSize: "13px" }}>⚠️ No se pudo cargar la agenda: {errorAgenda}</p>)}
          {contactos.length === 0 && !errorAgenda && (
            <p
              style={{
                fontSize: "14px",
                color: "#777",
                textAlign: "center",
                margin: "10px 0",
              }}
            >
              No hay contactos guardados.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}