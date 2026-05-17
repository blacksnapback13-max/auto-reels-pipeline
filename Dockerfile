FROM node:22-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates \
    ffmpeg \
    git \
    python3 \
    python3-pil \
    python3-pip \
  && python3 -m pip install --break-system-packages --no-cache-dir --upgrade yt-dlp bgutil-ytdlp-pot-provider==1.3.1 \
  && git clone --depth 1 --branch 1.3.1 https://github.com/Brainicism/bgutil-ytdlp-pot-provider.git /opt/bgutil-ytdlp-pot-provider \
  && cd /opt/bgutil-ytdlp-pot-provider/server \
  && npm ci \
  && npx tsc \
  && npm cache clean --force \
  && apt-get clean \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY . .

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=10000
ENV COVER_IMAGE_PROVIDER=auto
ENV AI_IMAGE_PROVIDER_ORDER=gemini,cloudflare,huggingface,qwen,pollinations
ENV POLLINATIONS_IMAGE_ENABLED=true
ENV STORAGE_PROVIDER=auto
ENV CLOUDINARY_FOLDER=auto-reels

EXPOSE 10000

CMD ["npm", "start"]
