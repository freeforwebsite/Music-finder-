FROM node:20-slim
RUN apt-get update && apt-get install -y ffmpeg curl python3 tar && rm -rf /var/lib/apt/lists/*
RUN curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp && chmod a+rx /usr/local/bin/yt-dlp
RUN curl -L https://github.com/acoustid/chromaprint/releases/download/v1.5.1/chromaprint-fpcalc-1.5.1-linux-x86_64.tar.gz | tar -xz -C /usr/local/bin --strip-components=1 chromaprint-fpcalc-1.5.1-linux-x86_64/fpcalc
WORKDIR /app
COPY backend/package*.json ./
RUN npm install --production
COPY backend/ .
ENV NODE_ENV=production
CMD ["node", "server.js"]
