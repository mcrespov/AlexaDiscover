FROM node:20-alpine
WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY scripts ./scripts
COPY config.example.json ./

VOLUME /app/data
