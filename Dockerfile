FROM node:20

# Instalar librerías del sistema para Linux
RUN apt-get update && apt-get install -y \
    libnss3 \
    libatk-bridge2.0-0 \
    libxss1 \
    libgtk-3-0 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copiar paquetes de dependencias
COPY package*.json ./

# Limpiar caché de npm e instalar de forma directa e independiente
RUN npm cache clean --force
RUN npm install --no-audit --no-fund --legacy-peer-deps

# Copiar el resto del código
COPY . .

EXPOSE 3000

CMD ["node", "server.js"]