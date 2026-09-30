# Build stage: compile the TypeScript service.
FROM node:22-alpine AS build
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

# Runtime stage: production dependencies + compiled output + migrations.
FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=build /app/dist ./dist
# The migration runner reads sql/*.sql from the package root at runtime.
COPY sql ./sql
COPY scripts/seed-if-empty.mjs ./scripts/seed-if-empty.mjs

# Run unprivileged; node:alpine already ships a `node` user.
USER node
EXPOSE 4000

HEALTHCHECK --interval=15s --timeout=4s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/server.js"]
