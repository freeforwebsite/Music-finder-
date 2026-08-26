FROM node:20-slim
RUN apt-get update && apt-get install -y ffmpeg chromaprint && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY backend/package*.json ./
RUN npm install --production
COPY backend/ .
ENV NODE_ENV=production
CMD ["node", "server.js"]
