FROM node:20-alpine
WORKDIR /app

# Instalar dependencias (sin dev)
COPY package.json ./
RUN npm install --omit=dev

# Copiar el código
COPY server.js ./

# Puerto interno donde escucha Express
EXPOSE 8080

# Comando de arranque
CMD ["node", "server.js"]
