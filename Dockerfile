FROM node:22-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates \
    ffmpeg \
    python3 \
    python3-pil \
    python3-pip \
  && python3 -m pip install --break-system-packages --no-cache-dir --upgrade yt-dlp \
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

EXPOSE 10000

CMD ["npm", "start"]
