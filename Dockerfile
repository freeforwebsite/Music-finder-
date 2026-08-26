FROM node:20-slim
RUN apt-get update && apt-get install -y ffmpeg libchromaprint-tools curl python3 && rm -rf /var/lib/apt/lists/*
RUN curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp && chmod a+rx /usr/local/bin/yt-dlp
WORKDIR /app
COPY backend/package*.json ./
RUN npm install --production
COPY backend/ .
ENV NODE_ENV=production
CMD ["node", "server.js"]
