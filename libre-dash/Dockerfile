# Pinned to the version package.json's engines field requires.
FROM node:22.12-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:22.12-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist

# The node adapter binds to localhost unless told otherwise, which the Coolify
# proxy cannot reach.
ENV HOST=0.0.0.0
ENV PORT=4321
EXPOSE 4321
USER node
CMD ["node", "./dist/server/entry.mjs"]
