FROM node:22-slim

WORKDIR /app

# Instala dependencias primero para aprovechar la cache de capas de Docker
# cuando solo cambia el código y no package*.json.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .

# data/ es donde vive la base SQLite — se monta como volumen para que
# sobreviva a recrear el contenedor (ver docker-compose.yml).
RUN mkdir -p /app/data

ENV PORT=3000
EXPOSE 3000

VOLUME ["/app/data"]

CMD ["node", "server.js"]
