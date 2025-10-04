FROM node:20-alpine
WORKDIR /app

# Instala deps primero para cache eficiente
COPY package.json package-lock.json* ./
RUN npm install --production

# Copia el resto del código
COPY . .

ENV NODE_ENV=production
ENV PORT=8080
EXPOSE 8080

CMD ["npm","start"]
