FROM node:24-alpine

WORKDIR /app
ENV NODE_ENV=production

# Менеджер пакетів: спочатку лише залежності, щоб кешувалися слої
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src ./src

# Каталог для медіа-файлів (маунтиться як docker volume «uploads»)
RUN mkdir -p /app/uploads

ENV PORT=3001
EXPOSE 3001

# При старті контейнера: ідемпотентні міграції, потім — сам сервер
CMD ["sh", "-c", "node src/migrate.js && node src/index.js"]