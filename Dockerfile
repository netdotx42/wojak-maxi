FROM node:22-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
ENV NITRO_PRESET=node-server
ENV VITE_AUTH_ENABLED=false
RUN npm run build
ENV HOST=0.0.0.0
ENV PORT=8080
EXPOSE 8080
CMD ["node", ".output/server/index.mjs"]
