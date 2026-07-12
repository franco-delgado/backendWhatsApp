FROM node:18

# Instalar librerías del sistema necesarias para entornos Linux/Docker
RUN apt-get update && apt-get install -y \
    libnss3 \
    libatk-bridge2.0-0 \
    libxss1 \
    libgtk-3-0 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copiar archivos de dependencias
COPY package*.json ./
RUN npm install

# Copiar el resto del código del servidor
COPY . .

# Exponer el puerto que usa Express
EXPOSE 3000

# Comando para iniciar tu servidor
CMD ["node", "server.js"]