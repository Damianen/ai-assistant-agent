# Stage 1: Build
FROM node:20-alpine AS builder
WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY prisma/ ./prisma/
COPY prisma.config.ts ./
RUN npx prisma generate

COPY src/ ./src/
COPY tsconfig.json ./
RUN npm run build

# Stage 2: Production
FROM node:20-alpine
WORKDIR /app

RUN addgroup -g 1001 appgroup && \
    adduser -u 1001 -G appgroup -s /bin/sh -D appuser

COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/prisma.config.ts ./

RUN npx prisma generate

RUN chown -R appuser:appgroup /app

USER appuser

EXPOSE 3001

CMD ["sh", "-c", "npx prisma db push --url \"$DATABASE_URL\" && node dist/index.js"]
