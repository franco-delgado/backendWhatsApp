# Conector de WhatsApp (Baileys) — Backend + ejemplo React

Este proyecto conecta con WhatsApp usando el protocolo de WhatsApp Web (librería **Baileys**, no oficial pero muy estable y usada en producción), genera un QR para vincular tu número, y expone una API REST simple para que tu página React envíe mensajes.

## 1. Instalación en el servidor Linux

```bash
# Copiar esta carpeta al servidor (por scp, git, etc.)
cd whatsapp-connector
npm install
node server.js
```

Vas a ver algo como:

```
[Servidor] API corriendo en http://localhost:3000
[WhatsApp] Nuevo QR generado. Escaneá desde /qr
```

## 2. Ver el QR

Tenés 3 formas de verlo:

- **Directo en el navegador (imagen):** `http://TU_SERVIDOR:3000/qr/image`
- **Como JSON base64** (para tu frontend React): `GET http://TU_SERVIDOR:3000/qr` → devuelve `{ "qr": "data:image/png;base64,..." }`
- Desde tu React, usá el componente de ejemplo en `ejemplo-frontend/QrConnect.jsx`

Escaneá el QR desde tu celular: **WhatsApp > Configuración > Dispositivos vinculados > Vincular un dispositivo**.

## 3. Endpoints disponibles

| Método | Ruta         | Descripción                                                        |
|--------|--------------|---------------------------------------------------------------------|
| GET    | `/status`    | Estado actual: `disconnected`, `connecting`, `qr`, `connected`      |
| GET    | `/qr`        | QR en base64 (JSON), listo para `<img src={qr} />`                 |
| GET    | `/qr/image`  | QR como imagen PNG directa                                          |
| POST   | `/send`      | Envía un mensaje. Body: `{ "number": "5491122334455", "message": "Hola" }` |
| POST   | `/logout`    | Cierra sesión para vincular otro número                             |

**Importante sobre el número:** va sin `+`, sin espacios ni guiones, con código de país. Ejemplo Argentina: `5491122334455`.

## 4. Mantener el servidor corriendo (PM2)

Para que no se caiga y se reinicie solo si el servidor reinicia:

```bash
npm install -g pm2
pm2 start server.js --name whatsapp-connector
pm2 save
pm2 startup   # seguí las instrucciones que imprime para que arranque solo al bootear el servidor
```

## 5. La sesión (no perder la vinculación)

La carpeta `auth_info/` que se crea al escanear el QR guarda tu sesión. **No la borres** mientras quieras seguir conectado — si la borrás vas a tener que escanear el QR de nuevo. Hacé backup de esa carpeta si migrás de servidor.

## 6. Integración con React

Copiá `ejemplo-frontend/QrConnect.jsx` a tu proyecto React, cambiá la constante `API_URL` por la IP o dominio real de tu servidor, e importalo donde quieras mostrar la pantalla de vinculación/envío.

Si tu React corre en un dominio distinto al del backend, acordate de que el backend ya tiene `cors()` habilitado para evitar bloqueos del navegador. En producción, lo ideal es restringir el CORS solo a tu dominio (en `server.js`, reemplazar `app.use(cors())` por `app.use(cors({ origin: "https://tu-dominio.com" }))`).

## 7. Advertencias importantes

- Esto usa tu número de WhatsApp personal/comercial normal, **no** la API oficial de Meta (WhatsApp Business Platform). Es más rápido de implementar pero **hay riesgo de que Meta banee el número** si detecta envíos masivos, no solicitados, o patrones de spam.
- Recomendaciones para reducir riesgo:
  - No enviar a números que no te escribieron primero o no dieron consentimiento.
  - Espaciar los envíos (no mandar cientos de mensajes en segundos).
  - Usar un número que no sea crítico para el negocio como primera prueba.
- Si en el futuro necesitás volumen alto y garantías, la alternativa oficial es la **WhatsApp Business API de Meta** (de pago, requiere aprobación y un Business Manager verificado).
