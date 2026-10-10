# ---- Stage 1: збірка React ----
FROM node:24-alpine AS build
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build

# ---- Stage 2: статика + проксі на бекенд ----
FROM nginx:1.27-alpine

# Upstream бекенда; можна перевизначити через -e / compose environment
ENV BACKEND_URL=http://server:3001

# Шаблон nginx: офіційний образ заміняє ${BACKEND_URL} через envsubst
COPY nginx.template.conf /etc/nginx/templates/default.conf.template

COPY --from=build /app/dist /usr/share/nginx/html

EXPOSE 80