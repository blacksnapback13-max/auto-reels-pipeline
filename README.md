# Авто сборка рилсов

Локальный MVP пайплайна:

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

- принимает ссылку YouTube / youtu.be;
- скачивает видео через `yt-dlp`;
- скачивает доступные YouTube subtitles / auto-captions в `json3` или `vtt`;
- выбирает несколько фрагментов по story-aware скорингу: крючок, поворот, вывод, естественная граница фразы;
- отбрасывает клиффхэнгерные концовки и может слегка продлить фрагмент, если payoff идет сразу после мягкого лимита;
- добавляет 1 секунду хвоста в конец каждого reel, чтобы фраза и реакция не обрывались резко;
- если субтитров нет, делает fallback-нарезку по таймингу;
- рендерит вертикальные `1080x1920` MP4 через `ffmpeg`;
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
health: /api/config
```

Docker-образ внутри себя ставит `ffmpeg`, `ffprobe`, `python3`, `Pillow` и свежий `yt-dlp`, поэтому онлайн-версия запускает тот же пайплайн, что и локальная.

Обязательные переменные Render:

```text
HOST=0.0.0.0
COVER_IMAGE_PROVIDER=auto
AI_IMAGE_PROVIDER_ORDER=gemini,cloudflare,huggingface,qwen,pollinations
POLLINATIONS_IMAGE_ENABLED=true
STORAGE_PROVIDER=auto
CLOUDINARY_FOLDER=auto-reels
```

Опциональные бесплатные ключи добавляются в Render Dashboard как секреты: `GEMINI_API_KEY`, `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN`, `HUGGINGFACE_API_KEY`, `DASHSCOPE_API_KEY`, `POLLINATIONS_API_KEY`.

Для постоянного хранения на бесплатном Render добавьте в секреты:

```text
CLOUDINARY_URL=cloudinary://<api_key>:<api_secret>@<cloud_name>
```

После этого MP4, PNG-обложки, reference frame и `job.json` будут сохраняться в Cloudinary. Локальная `data/jobs` остается рабочим кэшем, а ZIP-сборка умеет подтягивать MP4 обратно по внешним URL.

Важно: без `CLOUDINARY_URL` бесплатный Render все равно использует временную файловую систему. Рилсы и обложки доступны в `data/jobs` во время жизни инстанса, но после рестарта или redeploy могут исчезнуть.

## Следующий слой

- подключить полноценную ASR-транскрибацию для YouTube без субтитров;
- добавить LLM-переранжирование поверх story-aware кандидатов;
- добавить пресеты под проповеди, туториалы, интервью и Shorts/Reels;
- добавить пакетный экспорт и ручную правку выбранных фрагментов.

## Правило среды

Все файлы проекта, модели, ассеты, временные данные и заметки хранятся внутри этой папки или внутри `/Volumes/T eror/AI`.
