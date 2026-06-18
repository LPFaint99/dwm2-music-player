FROM node:24-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.src.json ./
COPY src/ ./src/
RUN npm run typecheck && npm run build
