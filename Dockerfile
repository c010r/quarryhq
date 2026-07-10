# ---- Build del cliente (Vite) ----
FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

# ---- Imagen final: Express sirve API + estáticos ----
FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY server ./server
COPY --from=build /app/client/dist ./client/dist
USER node
EXPOSE 3001
CMD ["npx", "tsx", "server/index.ts"]
