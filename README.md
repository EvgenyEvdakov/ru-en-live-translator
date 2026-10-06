# Local RU → EN Voice Translator

Бесплатный локальный переводчик русской речи в английскую с клонированием голоса говорящего.

**Без OpenAI API, без API-ключей, без платных кредитов и без Docker.** Распознавание, перевод и синтез речи выполняются на вашем компьютере.

## Как работает

```text
микрофон / вкладка / видеофайл
          ↓
16 kHz PCM audio
          ↓
faster-whisper: русский звук → русский текст
          ↓
Helsinki-NLP/opus-mt-ru-en: русский текст → English
          ↓
Chatterbox Multilingual V3: English → речь с voice reference говорящего
          ↓
браузер воспроизводит английскую речь
```

Первые несколько секунд чистой речи используются как voice reference. Пока голос калибруется, текстовый перевод уже может появляться; английская озвучка начинается после подготовки голосового профиля.

## Важно про «идентичный» голос

Используется zero-shot voice cloning. Модель старается сохранить тембр и особенности голоса, но идентичность 1:1 гарантировать нельзя: акцент, эмоция и интонация могут немного отличаться.

Для лучшего результата первые 5–10 секунд должны содержать одного говорящего без музыки и сильного шума. Используйте клонирование только для голосов, которые вы имеете право использовать.

## Требования

- Python 3.11 рекомендуется;
- Chrome или Edge;
- интернет нужен при первом запуске для скачивания моделей;
- для задержки близкой к реальному времени желательно NVIDIA GPU.

На CPU распознавание может быть приемлемым, но генерация клонированного голоса может заметно отставать.

## Установка без Docker

### Windows PowerShell

```powershell
py -3.11 -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install --upgrade pip
pip install -r requirements.txt
copy .env.example .env
python local_server.py
```

### macOS / Linux

```bash
python3.11 -m venv .venv
source .venv/bin/activate
python -m pip install --upgrade pip
pip install -r requirements.txt
cp .env.example .env
python local_server.py
```

Откройте:

```text
http://localhost:8000
```

Не открывайте `public/index.html` двойным кликом: микрофон и WebSocket должны работать через локальный сервер.

## Первый запуск

Модели скачиваются автоматически и сохраняются в локальный cache. Первый запуск может занять несколько минут и несколько гигабайт диска.

Интерфейс показывает этапы загрузки Whisper, локального RU→EN переводчика и Chatterbox, затем начинает захват речи и калибровку голоса.

## Режимы

**Микрофон:** выберите «Микрофон» → «Начать перевод».

**YouTube / стрим / вкладка:** выберите «Видео / вкладка» и при выборе вкладки обязательно включите «Поделиться аудио вкладки».

**Локальный видеофайл:** выберите «Видео файл», загрузите MP4/WebM и нажмите «Начать перевод».

## Настройка

`.env`:

```env
WHISPER_MODEL=small
VOICE_REFERENCE_SECONDS=5
VAD_RMS=420
MAX_SEGMENT_SECONDS=7
```

Для NVIDIA GPU:

```env
WHISPER_MODEL=large-v3-turbo
ASR_DEVICE=cuda
ASR_COMPUTE_TYPE=float16
TTS_DEVICE=cuda
```

Если тихую речь приложение не замечает, уменьшите `VAD_RMS`, например до `250`. Если фон постоянно принимается за речь — увеличьте значение.

## Используемые модели

- [faster-whisper](https://github.com/SYSTRAN/faster-whisper) — локальное распознавание;
- [Helsinki-NLP/opus-mt-ru-en](https://huggingface.co/Helsinki-NLP/opus-mt-ru-en) — локальный RU→EN перевод;
- [Chatterbox](https://github.com/resemble-ai/chatterbox) — zero-shot voice cloning и TTS.

Chatterbox добавляет в генерируемое аудио встроенный watermark модели.

## Отличие от первой версии

Первая версия использовала платный OpenAI Realtime API. Текущая версия полностью убирает OpenAI API из рабочего пайплайна: `.env` больше не содержит `OPENAI_API_KEY`, а приложение не отправляет речь в OpenAI.
