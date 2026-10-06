from __future__ import annotations

import asyncio
import json
import math
import os
import struct
import tempfile
import threading
import wave
from collections import deque
from pathlib import Path

from dotenv import load_dotenv

# Load .env before importing Hugging Face libraries. On some Windows systems
# hf-xet/CAS fails while reconstructing large model files. Hugging Face
# officially supports HF_HUB_DISABLE_XET=1 to force the regular HTTP path.
load_dotenv()
os.environ.setdefault("HF_HUB_DISABLE_XET", "1")
os.environ.setdefault("HF_HUB_DISABLE_SYMLINKS_WARNING", "1")
os.environ.setdefault("HF_HUB_DOWNLOAD_TIMEOUT", "120")
os.environ.setdefault("HF_HUB_ETAG_TIMEOUT", "30")

import numpy as np
import torch
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.staticfiles import StaticFiles
from faster_whisper import WhisperModel
from transformers import AutoModelForSeq2SeqLM, AutoTokenizer

BASE_DIR = Path(__file__).resolve().parent
PUBLIC_DIR = BASE_DIR / "public"
SAMPLE_RATE = 16_000
PCM_DTYPE = np.dtype("<i2")
FRAME_MS = 20
FRAME_SAMPLES = SAMPLE_RATE * FRAME_MS // 1000
FRAME_BYTES = FRAME_SAMPLES * 2

WHISPER_MODEL = os.getenv("WHISPER_MODEL", "small")
MT_MODEL = os.getenv("MT_MODEL", "Helsinki-NLP/opus-mt-ru-en")
VOICE_REFERENCE_SECONDS = float(os.getenv("VOICE_REFERENCE_SECONDS", "5"))
VAD_RMS = float(os.getenv("VAD_RMS", "420"))
MIN_SEGMENT_SECONDS = float(os.getenv("MIN_SEGMENT_SECONDS", "0.7"))
MAX_SEGMENT_SECONDS = float(os.getenv("MAX_SEGMENT_SECONDS", "7.0"))
SILENCE_MS = int(os.getenv("SILENCE_MS", "420"))


def choose_torch_device() -> str:
    requested = os.getenv("TTS_DEVICE", "auto").lower()
    if requested != "auto":
        return requested
    if torch.cuda.is_available():
        return "cuda"
    if getattr(torch.backends, "mps", None) and torch.backends.mps.is_available():
        return "mps"
    return "cpu"


def choose_whisper_device() -> tuple[str, str]:
    requested = os.getenv("ASR_DEVICE", "auto").lower()
    if requested == "auto":
        requested = "cuda" if torch.cuda.is_available() else "cpu"
    compute_type = os.getenv("ASR_COMPUTE_TYPE") or (
        "float16" if requested == "cuda" else "int8"
    )
    return requested, compute_type


def write_pcm16_wav(path: Path, pcm16: np.ndarray, sample_rate: int = SAMPLE_RATE) -> None:
    with wave.open(str(path), "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(sample_rate)
        wav.writeframes(np.asarray(pcm16, dtype=PCM_DTYPE).tobytes())


class LocalModels:
    """Lazy-loaded local models. No paid API is used anywhere in this class."""

    def __init__(self) -> None:
        self.asr: WhisperModel | None = None
        self.mt_tokenizer = None
        self.mt_model = None
        self.tts = None
        self.tts_device = choose_torch_device()
        self.asr_device, self.asr_compute_type = choose_whisper_device()
        self._lock = threading.RLock()

    def load_asr(self) -> None:
        with self._lock:
            if self.asr is not None:
                return
            self.asr = WhisperModel(
                WHISPER_MODEL,
                device=self.asr_device,
                compute_type=self.asr_compute_type,
            )

    def load_translation(self) -> None:
        with self._lock:
            if self.mt_model is not None:
                return
            self.mt_tokenizer = AutoTokenizer.from_pretrained(MT_MODEL)
            self.mt_model = AutoModelForSeq2SeqLM.from_pretrained(MT_MODEL)
            self.mt_model.eval()
            mt_device = os.getenv("MT_DEVICE", "cpu").lower()
            if mt_device == "cuda" and torch.cuda.is_available():
                self.mt_model.to("cuda")

    def load_tts(self) -> None:
        with self._lock:
            if self.tts is not None:
                return
            from chatterbox.mtl_tts import ChatterboxMultilingualTTS

            self.tts = ChatterboxMultilingualTTS.from_pretrained(
                device=self.tts_device,
                t3_model=os.getenv("CHATTERBOX_T3", "v3"),
            )

    def transcribe_ru(self, audio: np.ndarray) -> str:
        assert self.asr is not None
        with self._lock:
            segments, _ = self.asr.transcribe(
                audio.astype(np.float32),
                language="ru",
                task="transcribe",
                beam_size=1,
                vad_filter=False,
                condition_on_previous_text=False,
                temperature=0.0,
            )
            text = " ".join(segment.text.strip() for segment in segments).strip()
        return text

    def translate_ru_en(self, text: str) -> str:
        assert self.mt_model is not None and self.mt_tokenizer is not None
        with self._lock:
            tokens = self.mt_tokenizer(
                [text],
                return_tensors="pt",
                truncation=True,
                max_length=512,
            )
            device = next(self.mt_model.parameters()).device
            tokens = {key: value.to(device) for key, value in tokens.items()}
            generated = self.mt_model.generate(
                **tokens,
                num_beams=2,
                max_new_tokens=256,
            )
            translated = self.mt_tokenizer.batch_decode(
                generated,
                skip_special_tokens=True,
            )[0].strip()
        return translated

    def prepare_voice(self, reference_wav: Path) -> None:
        assert self.tts is not None
        with self._lock:
            self.tts.prepare_conditionals(str(reference_wav), exaggeration=0.5)

    def synthesize_en(self, text: str) -> tuple[np.ndarray, int]:
        assert self.tts is not None
        with self._lock:
            wav = self.tts.generate(
                text[:300],
                language_id="en",
                audio_prompt_path=None,
                exaggeration=0.5,
                cfg_weight=0.0,
                temperature=0.8,
            )
            audio = wav.detach().float().cpu().numpy().reshape(-1)
            sample_rate = int(self.tts.sr)
        return np.clip(audio, -1.0, 1.0), sample_rate


MODELS = LocalModels()


class SpeechSegmenter:
    def __init__(self) -> None:
        self.pending = bytearray()
        self.pre_roll: deque[bytes] = deque(maxlen=max(1, 240 // FRAME_MS))
        self.voice_history: deque[bool] = deque(maxlen=max(1, 160 // FRAME_MS))
        self.active = False
        self.segment = bytearray()
        self.silence_frames = 0
        self.max_frames = max(1, int(MAX_SEGMENT_SECONDS * 1000 / FRAME_MS))
        self.min_frames = max(1, int(MIN_SEGMENT_SECONDS * 1000 / FRAME_MS))
        self.stop_silence_frames = max(1, SILENCE_MS // FRAME_MS)

    @staticmethod
    def _is_voice(frame: bytes) -> bool:
        samples = np.frombuffer(frame, dtype=PCM_DTYPE).astype(np.float32)
        if samples.size == 0:
            return False
        rms = math.sqrt(float(np.mean(samples * samples)))
        return rms >= VAD_RMS

    def push(self, chunk: bytes) -> list[bytes]:
        self.pending.extend(chunk)
        completed: list[bytes] = []

        while len(self.pending) >= FRAME_BYTES:
            frame = bytes(self.pending[:FRAME_BYTES])
            del self.pending[:FRAME_BYTES]
            voiced = self._is_voice(frame)

            if not self.active:
                self.pre_roll.append(frame)
                self.voice_history.append(voiced)
                if sum(self.voice_history) >= 3:
                    self.active = True
                    self.segment = bytearray().join(self.pre_roll)
                    self.silence_frames = 0
                    self.pre_roll.clear()
                    self.voice_history.clear()
                continue

            self.segment.extend(frame)
            self.silence_frames = 0 if voiced else self.silence_frames + 1
            frame_count = len(self.segment) // FRAME_BYTES

            reached_pause = (
                frame_count >= self.min_frames
                and self.silence_frames >= self.stop_silence_frames
            )
            reached_max = frame_count >= self.max_frames

            if reached_pause or reached_max:
                completed.append(bytes(self.segment))
                self.active = False
                self.segment.clear()
                self.silence_frames = 0
                self.pre_roll.clear()
                self.voice_history.clear()

        return completed

    def flush(self) -> bytes | None:
        if self.active and len(self.segment) >= self.min_frames * FRAME_BYTES:
            result = bytes(self.segment)
        else:
            result = None
        self.pending.clear()
        self.pre_roll.clear()
        self.voice_history.clear()
        self.segment.clear()
        self.active = False
        self.silence_frames = 0
        return result


class TranslationSession:
    def __init__(self, websocket: WebSocket) -> None:
        self.ws = websocket
        self.segmenter = SpeechSegmenter()
        self.queue: asyncio.Queue[bytes | None] = asyncio.Queue()
        self.worker: asyncio.Task | None = None
        self.reference_parts: list[np.ndarray] = []
        self.reference_samples = 0
        self.reference_target = int(VOICE_REFERENCE_SECONDS * SAMPLE_RATE)
        self.voice_ready = False
        self.pending_speech: list[str] = []
        self.tmpdir = tempfile.TemporaryDirectory(prefix="ru_en_voice_")
        self.reference_wav = Path(self.tmpdir.name) / "speaker_reference.wav"
        self.running = False

    async def send_json(self, payload: dict) -> None:
        await self.ws.send_text(json.dumps(payload, ensure_ascii=False))

    async def load_models(self) -> None:
        await self.send_json({"type": "status", "message": f"Загружаю распознавание речи ({WHISPER_MODEL})…"})
        await asyncio.to_thread(MODELS.load_asr)
        await self.send_json({"type": "status", "message": "Загружаю локальный перевод RU → EN…"})
        await asyncio.to_thread(MODELS.load_translation)
        await self.send_json({"type": "status", "message": "Загружаю модель клонирования голоса Chatterbox…"})
        await asyncio.to_thread(MODELS.load_tts)
        await self.send_json({
            "type": "ready",
            "message": "Модели готовы. Начинаю слушать речь…",
            "device": MODELS.tts_device,
        })

    async def start(self) -> None:
        if self.running:
            return
        self.running = True
        try:
            await self.load_models()
        except Exception:
            self.running = False
            raise
        self.worker = asyncio.create_task(self._worker())

    async def add_audio(self, data: bytes) -> None:
        if not self.running:
            return
        for segment in self.segmenter.push(data):
            await self.queue.put(segment)

    async def stop(self) -> None:
        if not self.running:
            return
        final_segment = self.segmenter.flush()
        if final_segment:
            await self.queue.put(final_segment)
        await self.queue.put(None)
        if self.worker:
            await self.worker
        self.running = False
        await self.send_json({"type": "stopped", "message": "Перевод остановлен."})

    def _append_reference(self, audio_float: np.ndarray) -> bool:
        if self.voice_ready or self.reference_samples >= self.reference_target:
            return False
        need = self.reference_target - self.reference_samples
        piece = audio_float[:need]
        if piece.size:
            self.reference_parts.append(piece.copy())
            self.reference_samples += piece.size
        return self.reference_samples >= self.reference_target

    async def _prepare_voice_if_ready(self) -> None:
        if self.voice_ready or self.reference_samples < self.reference_target:
            return
        reference = np.concatenate(self.reference_parts)
        pcm16 = np.clip(reference * 32767.0, -32768, 32767).astype(PCM_DTYPE)
        write_pcm16_wav(self.reference_wav, pcm16)
        await self.send_json({"type": "status", "message": "Калибрую голос говорящего…"})
        await asyncio.to_thread(MODELS.prepare_voice, self.reference_wav)
        self.voice_ready = True
        await self.send_json({
            "type": "voice_ready",
            "message": "Голос откалиброван. Английская речь будет генерироваться этим тембром.",
        })

    async def _send_speech(self, text: str) -> None:
        audio, sample_rate = await asyncio.to_thread(MODELS.synthesize_en, text)
        pcm16 = np.clip(audio * 32767.0, -32768, 32767).astype(PCM_DTYPE)
        await self.ws.send_bytes(struct.pack("<I", sample_rate) + pcm16.tobytes())

    async def _process_segment(self, pcm_bytes: bytes) -> None:
        pcm = np.frombuffer(pcm_bytes, dtype=PCM_DTYPE)
        if pcm.size < int(MIN_SEGMENT_SECONDS * SAMPLE_RATE):
            return
        audio = pcm.astype(np.float32) / 32768.0

        source_text = await asyncio.to_thread(MODELS.transcribe_ru, audio)
        if not source_text:
            return
        await self.send_json({"type": "source", "text": source_text})

        english = await asyncio.to_thread(MODELS.translate_ru_en, source_text)
        if not english:
            return
        await self.send_json({"type": "translation", "text": english})

        became_ready = self._append_reference(audio)
        if became_ready:
            await self._prepare_voice_if_ready()

        if self.voice_ready:
            to_speak = self.pending_speech + [english]
            self.pending_speech.clear()
            for phrase in to_speak:
                await self.send_json({"type": "status", "message": "Озвучиваю перевод тем же голосом…"})
                await self._send_speech(phrase)
            await self.send_json({"type": "status", "message": "Слушаю следующую фразу…"})
        else:
            self.pending_speech.append(english)
            seconds = self.reference_samples / SAMPLE_RATE
            await self.send_json({
                "type": "status",
                "message": f"Запоминаю голос: {seconds:.1f}/{VOICE_REFERENCE_SECONDS:.1f} сек…",
            })

    async def _worker(self) -> None:
        try:
            while True:
                segment = await self.queue.get()
                if segment is None:
                    self.queue.task_done()
                    break
                try:
                    await self._process_segment(segment)
                except Exception as exc:
                    await self.send_json({"type": "error", "message": str(exc)})
                finally:
                    self.queue.task_done()
        finally:
            self.tmpdir.cleanup()


app = FastAPI(title="Free Local RU→EN Voice Translator")


@app.get("/api/health")
async def health() -> dict:
    return {
        "ok": True,
        "paid_api": False,
        "sample_rate": SAMPLE_RATE,
        "whisper_model": WHISPER_MODEL,
        "translation_model": MT_MODEL,
        "tts": "Chatterbox Multilingual V3",
        "tts_device": MODELS.tts_device,
        "asr_device": MODELS.asr_device,
    }


@app.websocket("/ws/translate")
async def translate_socket(websocket: WebSocket) -> None:
    await websocket.accept()
    session = TranslationSession(websocket)
    await session.send_json({"type": "connected", "message": "Локальный сервер подключён."})

    try:
        while True:
            message = await websocket.receive()
            if message.get("type") == "websocket.disconnect":
                break

            text_message = message.get("text")
            if text_message is not None:
                payload = json.loads(text_message)
                if payload.get("type") == "start":
                    try:
                        await session.start()
                    except Exception as exc:
                        message = str(exc)
                        if "xethub" in message.lower() or "cas client" in message.lower() or "reconstruction" in message.lower():
                            message = (
                                "Ошибка загрузки Hugging Face Xet/CAS. Xet теперь отключён автоматически. "
                                "Перезапустите сервер и нажмите «Начать перевод» ещё раз — загрузка продолжится через HTTP."
                            )
                        await session.send_json({"type": "error", "message": message})
                elif payload.get("type") == "stop":
                    await session.stop()
                continue

            data = message.get("bytes")
            if data:
                await session.add_audio(data)
    except WebSocketDisconnect:
        pass
    finally:
        if session.running:
            try:
                await session.stop()
            except Exception:
                pass


app.mount("/", StaticFiles(directory=PUBLIC_DIR, html=True), name="public")


if __name__ == "__main__":
    import uvicorn

    host = os.getenv("HOST", "127.0.0.1")
    port = int(os.getenv("PORT", "8000"))
    uvicorn.run("local_server:app", host=host, port=port, reload=False)
