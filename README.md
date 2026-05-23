# Авто сборка рилсов Онлайн

Эта папка — онлайн-ветка проекта: GitHub + Render. Основной автономный сценарий:
пользователь загружает готовый MP4/MOV с телефона, а сайт сам режет его на рилсы.
Локальный Mac-воркер остается запасным режимом только для YouTube-ссылок, если YouTube блокирует облачный IP.

Стабильная оффлайн-версия сохранена отдельно и больше не трогается в рамках online-доработок:

```text
/Volumes/T eror/AI/Apps/Авто сборка рилсов Оффлайн
```

Основной online-пайплайн:

```text
uploaded video -> ffprobe -> timing/story clips -> trendy captions when transcript exists -> ffmpeg -> vertical reels
```

Если подключен Cloudflare Workers AI, uploaded video сначала проходит ASR:

```text
uploaded video -> ffmpeg audio chunks -> Cloudflare Whisper -> source.asr.vtt -> story-aware clips -> trendy captions
```

Запасной YouTube-пайплайн:

```text
YouTube URL -> yt-dlp -> captions/transcript -> story-aware clips -> trendy captions -> ffmpeg -> vertical reels
```

Рабочая папка:

```text
/Volumes/T eror/AI/Apps/Авто сборка рилсов
```

## Запуск

```bash
npm run dev
```

Открыть:

```text
http://127.0.0.1:3232
```

Онлайн:

```text
https://auto-reels-shtunda13.onrender.com
```

GitHub:

```text
https://github.com/blacksnapback13-max/auto-reels-pipeline
```

## Что уже умеет

- принимает готовый видеофайл `MP4`, `MOV`, `M4V`, `WEBM` или `MKV` через `/api/jobs/upload`;
- для загруженного файла полностью работает на Render без Mac и без YouTube anti-bot;
- для загруженного файла умеет делать ASR-транскрибацию через Cloudflare Workers AI Whisper и затем резать уже по тексту;
- принимает ссылку YouTube / youtu.be как дополнительный режим;
- скачивает видео через `yt-dlp`;
- если YouTube не отдает выбранный формат, автоматически пробует несколько fallback-вариантов: легкий 720p MP4, общий bestvideo+bestaudio и single best;
- поддерживает YouTube browser cookies через секреты `YTDLP_COOKIES_BASE64`, `YTDLP_COOKIES_TEXT` или локальный `YTDLP_COOKIES_PATH`, чтобы обходить серверную проверку "Sign in to confirm you're not a bot";
- если Render получает anti-bot даже с cookies, автоматически повторяет `yt-dlp` через anti-bot fallback `youtube:player_skip=webpage,configs;player_client=default,mweb`, bgutil PO-token provider и третий публичный режим без cookies;
- скачивает доступные YouTube subtitles / auto-captions в `json3` или `vtt`;
- выбирает несколько фрагментов по story-aware скорингу: крючок, поворот, вывод, естественная граница фразы;
- отбрасывает клиффхэнгерные концовки и может слегка продлить фрагмент, если payoff идет сразу после мягкого лимита;
- добавляет 1 секунду хвоста в конец каждого reel, чтобы фраза и реакция не обрывались резко;
- если субтитров нет, делает fallback-нарезку по таймингу;
- рендерит вертикальные MP4 через `ffmpeg`; размер и профиль задаются `REEL_WIDTH`, `REEL_HEIGHT`, `REEL_BACKGROUND_MODE`, `REEL_VIDEO_PRESET`, `REEL_VIDEO_CRF`;
- показывает live-прогресс текущего reel из `ffmpeg -progress pipe:1`;
- добавляет blurred background, foreground fit, loudness normalize, 30ms audio fades;
- опционально добавляет чистые Reels-style burned-in captions через PNG-оверлеи, сгенерированные Pillow;
- показывает готовые MP4 прямо в панели проекта с прямой ссылкой на файл;
- позволяет скачать все MP4 одним ZIP-архивом;
- при подключенном Cloudinary автоматически зеркалит MP4, PNG-обложки, референс-кадры и job-манифесты во внешнее хранилище, поэтому ссылки продолжают жить после рестарта Render;
- генерирует и сохраняет черновик описания для каждого reel по транскрибированному фрагменту;
- обложка 9:16 строится по этому описанию, с чистым кадром из исходника как референсом, и сохраняется рядом с job;
- AI-генератор делает только визуальный фон, а финальный триггерный заголовок, контрастные плашки, обводка и очистка псевдотекста накладываются локально через Pillow, чтобы слова были читаемыми на мобильном превью;
- image-генерация работает в free-only очереди как в PostMaker: `gemini -> cloudflare -> huggingface -> qwen -> pollinations`, с дневным учетом в `data/image-usage.json`;
- если AI-провайдеры недоступны, автоматически делает локальную fallback-обложку из кадра через Pillow, без внешнего API; макеты меняют композицию: герой-стикер, постер, журнал, split, большой заголовок;
- если Pillow недоступен, может fallback-нуться на `ffmpeg subtitles/libass`, если фильтр есть в системе;
- хранит каждую задачу в `data/jobs/<job-id>/`.

## Зависимости

На машине должны быть доступны:

- Node.js 22+
- `yt-dlp`
- `ffmpeg`
- `ffprobe`
- Python 3 с `Pillow` для трендовых PNG captions
- бесплатные image-ключи по необходимости: `GEMINI_API_KEY`, `CLOUDFLARE_ACCOUNT_ID` + `CLOUDFLARE_API_TOKEN`, `HUGGINGFACE_API_KEY`, `DASHSCOPE_API_KEY`; Pollinations включается без ключа;

Текущий Homebrew `ffmpeg` может не иметь `subtitles`/`drawtext`. Для этого проекта это нормально: основной путь субтитров теперь идет через PNG-оверлеи, поэтому `libass` не обязателен.

## Онлайн-деплой

Проект развернут на Render как Docker web service через GitHub.

Render:

```text
service: auto-reels-shtunda13
url: https://auto-reels-shtunda13.onrender.com
repo: https://github.com/blacksnapback13-max/auto-reels-pipeline
runtime: docker
plan: free
region: frankfurt
health: /api/health
```

Docker-образ внутри себя ставит `ffmpeg`, `ffprobe`, `python3`, `Pillow` и свежий `yt-dlp`, поэтому онлайн-версия запускает тот же пайплайн, что и локальная. Render healthcheck использует легкий `/api/health`, а полный `/api/config` кэширует проверку инструментов.
Для бесплатного Render включен облегченный профиль `720x1280 + crop + ultrafast`, потому что тяжелый `1080x1920 + blur` на free-инстансе может перезапустить процесс во время ffmpeg.

В Docker также ставится `bgutil-ytdlp-pot-provider` 1.3.1. Это бесплатный PO-token provider для `yt-dlp`, который помогает на облачных IP, где YouTube отклоняет даже browser cookies.

Обязательные переменные Render:

```text
HOST=0.0.0.0
COVER_IMAGE_PROVIDER=auto
AI_IMAGE_PROVIDER_ORDER=gemini,cloudflare,huggingface,qwen,pollinations
POLLINATIONS_IMAGE_ENABLED=true
STORAGE_PROVIDER=auto
CLOUDINARY_FOLDER=auto-reels
UPLOAD_VIDEO_LIMIT_MB=700
ASR_PROVIDER=auto
CLOUDFLARE_ASR_MODEL=@cf/openai/whisper
ASR_CHUNK_SECONDS=55
REEL_WIDTH=720
REEL_HEIGHT=1280
REEL_BACKGROUND_MODE=crop
REEL_VIDEO_PRESET=ultrafast
REEL_VIDEO_CRF=24
```

Опциональные бесплатные/low-cost ключи добавляются в Render Dashboard как секреты: `GEMINI_API_KEY`, `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN`, `HUGGINGFACE_API_KEY`, `DASHSCOPE_API_KEY`, `POLLINATIONS_API_KEY`.
`CLOUDFLARE_ACCOUNT_ID` + `CLOUDFLARE_API_TOKEN` включают и обложки через Workers AI, и ASR для uploaded video. Если этих секретов нет, uploaded video продолжит резаться по таймингу без транскрипта.

Если YouTube пишет `Sign in to confirm you're not a bot`, добавьте browser cookies в Render как секрет:

```text
YTDLP_COOKIES_BASE64=<base64 от cookies.txt>
```

`cookies.txt` должен быть в Netscape-формате из браузера, где YouTube уже открыт и аккаунт подтвержден. Секрет не логируется: приложение записывает его во временный файл `data/runtime/youtube-cookies.txt` и передает в `yt-dlp` как `--cookies`.

Для более жестких YouTube anti-bot случаев можно добавить дополнительные секреты:

```text
YTDLP_PO_TOKEN=<web+... или сам token>
YTDLP_PROXY=<proxy url>
YTDLP_EXTRACTOR_ARGS=<ручные yt-dlp extractor args>
```

Anti-bot fallback включен по умолчанию. Отключить его можно через `YTDLP_ANTIBOT_FALLBACK=false`, а заменить аргументы через `YTDLP_ANTIBOT_EXTRACTOR_ARGS`.
Третий fallback без cookies для публичных видео включен через `YTDLP_ANTIBOT_NO_COOKIES=true`.

## Online-режим: загрузка видео

Публичная online-версия рассчитана на автономный сценарий без Mac-воркера:

1. пользователь открывает сайт с телефона или компьютера;
2. выбирает локальный MP4/MOV/WebM/MKV-файл;
3. при желании добавляет музыкальную подложку;
4. сервер рендерит вертикальные MP4 и отдает готовые файлы.

YouTube-ссылки не являются основным online-входом: облачные IP вроде Render часто
получают anti-bot проверку YouTube. В production этот вход отключен через
`YOUTUBE_INPUT_ENABLED=false`, а публичная выдача последней общей задачи отключена
через `PUBLIC_LATEST_JOB_ENABLED=false`, чтобы посетители не видели задачи друг друга.

## Локальный воркер для старого YouTube fallback

Если Render получает YouTube anti-bot, online-задача переходит в статус “Ждёт Mac”.
На Mac запустить:

```bash
npm run worker
```

Воркер читает локальный `.env.local-worker`:

```text
ONLINE_BASE_URL=https://auto-reels-shtunda13.onrender.com
LOCAL_WORKER_TOKEN=тот-же-секрет-что-на-Render
LOCAL_BASE_URL=http://127.0.0.1:3233
YTDLP_COOKIES_PATH=/Volumes/T eror/AI/Apps/Авто сборка рилсов/data/runtime/local-youtube-cookies.txt
YTDLP_METADATA_TIMEOUT_MS=240000
YTDLP_DOWNLOAD_TIMEOUT_MS=1200000
```

Он поднимает локальный pipeline на `127.0.0.1:3233`, забирает online-задачу,
делает рилсы локально через сохраненный cookies-файл и загружает MP4 обратно в online job.

Для постоянного хранения на бесплатном Render добавьте в секреты:

```text
CLOUDINARY_URL=cloudinary://<api_key>:<api_secret>@<cloud_name>
```

После этого MP4, PNG-обложки, reference frame и `job.json` будут сохраняться в Cloudinary. Локальная `data/jobs` остается рабочим кэшем, а ZIP-сборка умеет подтягивать MP4 обратно по внешним URL. В `/api/config` режим хранения должен стать `external-assets`.

Важно: без `CLOUDINARY_URL` бесплатный Render все равно использует временную файловую систему. Рилсы и обложки доступны в `data/jobs` во время жизни инстанса, но после рестарта или redeploy могут исчезнуть.

## Следующий слой

- подключить полноценную ASR-транскрибацию для YouTube без субтитров;
- добавить LLM-переранжирование поверх story-aware кандидатов;
- добавить пресеты под проповеди, туториалы, интервью и Shorts/Reels;
- добавить пакетный экспорт и ручную правку выбранных фрагментов.

## Правило среды

Все файлы проекта, модели, ассеты, временные данные и заметки хранятся внутри этой папки или внутри `/Volumes/T eror/AI`.
