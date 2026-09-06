FROM node:22-slim AS build

WORKDIR /app

# Instala TODAS las dependencias (incluida `typescript`, de desarrollo) para
# poder compilar — esta etapa nunca llega a la imagen final.
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci
COPY src ./src
RUN npm run build

FROM node:22-slim

WORKDIR /app

# Instala solo dependencias de producción (sin `typescript` ni los demás
# devDependencies) para aprovechar la cache de capas de Docker cuando solo
# cambia el código y no package*.json.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY --from=build /app/dist ./dist
COPY public ./public

# data/ es donde vive la base SQLite — se monta como volumen para que
# sobreviva a recrear el contenedor (ver docker-compose.yml).
RUN mkdir -p /app/data

ENV PORT=3000
EXPOSE 3000

VOLUME ["/app/data"]

CMD ["node", "dist/server.js"]
