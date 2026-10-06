from __future__ import annotations

import asyncio
import inspect
import json
import math
import os
import subprocess
import struct
import tempfile
import threading
import time
import uuid
import warnings
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
os.environ.setdefault("TRANSFORMERS_ATTN_IMPLEMENTATION", "eager")

def normalize_proxy_environment() -> None:
    """Ignore unsupported SOCKS4 proxy variables for Hugging Face/httpx.

    This avoids requiring extra SOCKS packages just to download local models.
    HTTP/HTTPS/SOCKS5 proxy values are left untouched.
    """
    for key in ("HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"):
        value = os.environ.get(key)
        if not value:
            continue
        lowered = value.lower()
        if lowered.startswith("socks4://") or lowered.startswith("socks4a://"):
            os.environ.pop(key, None)
            print(f"[proxy] {key}: ignored unsupported SOCKS4 proxy ({value}); using direct connection")

normalize_proxy_environment()

import imageio_ffmpeg
import numpy as np
import torch
from fastapi import FastAPI, File, HTTPException, UploadFile, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from faster_whisper import WhisperModel
from transformers import AutoModelForSeq2SeqLM, AutoTokenizer

warnings.filterwarnings("ignore", message="Recommended: pip install sacremoses.")

BASE_DIR = Path(__file__).resolve().parent
PUBLIC_DIR = BASE_DIR / "public"
OUTPUT_DIR = BASE_DIR / "outputs"
OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
VIDEO_JOBS: dict[str, dict] = {}
VIDEO_JOBS_LOCK = threading.Lock()
VIDEO_PROCESS_LOCK = threading.Lock()
VIDEO_TASKS: set[asyncio.Task] = set()
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

            import perth
            watermarker = getattr(perth, "PerthImplicitWatermarker", None)
            if not callable(watermarker):
                raise RuntimeError(
                    "Chatterbox watermarking is unavailable because the installed "
                    "setuptools version is incompatible with Perth. Run: "
                    ".\\.venv\\Scripts\\python.exe -m pip install \"setuptools<81\" "
                    "and restart the server."
                )

            from chatterbox.mtl_tts import ChatterboxMultilingualTTS

            loader = ChatterboxMultilingualTTS.from_pretrained
            params = inspect.signature(loader).parameters
            kwargs = {"device": self.tts_device}

            # chatterbox-tts 0.1.7 does not accept t3_model; newer builds do.
            # Use V3 when supported, otherwise load the package's default
            # multilingual checkpoint instead of crashing.
            if "t3_model" in params:
                kwargs["t3_model"] = os.getenv("CHATTERBOX_T3", "v3")
            else:
                print(
                    "[chatterbox] installed version has no t3_model argument; "
                    "using its default multilingual checkpoint"
                )

            self.tts = loader(**kwargs)

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

    def transcribe_ru_segments(self, audio: np.ndarray, progress_callback=None) -> list[dict]:
        assert self.asr is not None
        results: list[dict] = []
        with self._lock:
            segments, _ = self.asr.transcribe(
                audio.astype(np.float32),
                language="ru",
                task="transcribe",
                beam_size=1,
                vad_filter=True,
                condition_on_previous_text=False,
                temperature=0.0,
            )
            for segment in segments:
                text = segment.text.strip()
                if text:
                    results.append({
                        "start": float(segment.start),
                        "end": float(segment.end),
                        "text": text,
                    })
                if progress_callback:
                    progress_callback(float(segment.end))
        return results

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
            prepare = self.tts.prepare_conditionals
            params = inspect.signature(prepare).parameters
            kwargs = {}
            if "exaggeration" in params:
                kwargs["exaggeration"] = 0.5
            prepare(str(reference_wav), **kwargs)

    def synthesize_en(self, text: str) -> tuple[np.ndarray, int]:
        assert self.tts is not None
        with self._lock:
            generate = self.tts.generate
            params = inspect.signature(generate).parameters
            kwargs = {}

            if "language_id" in params:
                kwargs["language_id"] = "en"
            if "audio_prompt_path" in params:
                kwargs["audio_prompt_path"] = None
            if "exaggeration" in params:
                kwargs["exaggeration"] = 0.5
            if "cfg_weight" in params:
                # Recommended for cross-language voice transfer to reduce
                # accent leakage from the Russian reference voice.
                kwargs["cfg_weight"] = 0.0
            if "temperature" in params:
                kwargs["temperature"] = 0.8

            wav = generate(text[:300], **kwargs)
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
        self.queue: asyncio.Queue[tuple[bytes, float] | None] = asyncio.Queue()
        self.worker: asyncio.Task | None = None
        self.mode = "mic"
        self.source_duration: float | None = None
        self.received_samples = 0
        self.processed_source_seconds = 0.0
        self.last_progress_samples = 0
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

    async def send_progress(self, stage: str = "Ожидание аудио") -> None:
        received = self.received_samples / SAMPLE_RATE
        processed = self.processed_source_seconds
        await self.send_json({
            "type": "progress",
            "mode": self.mode,
            "stage": stage,
            "received_seconds": round(received, 3),
            "processed_seconds": round(processed, 3),
            "queue_seconds": round(max(0.0, received - processed), 3),
            "total_seconds": self.source_duration,
        })

    async def load_models(self) -> None:
        await self.send_progress("Загрузка моделей")
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

    async def start(self, payload: dict | None = None) -> None:
        if self.running:
            return
        payload = payload or {}
        self.mode = str(payload.get("mode") or "mic")
        duration = payload.get("duration")
        try:
            duration = float(duration) if duration is not None else None
        except (TypeError, ValueError):
            duration = None
        self.source_duration = duration if duration and duration > 0 else None
        self.received_samples = 0
        self.processed_source_seconds = 0.0
        self.last_progress_samples = 0
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
        self.received_samples += len(data) // 2
        received_seconds = self.received_samples / SAMPLE_RATE
        for segment in self.segmenter.push(data):
            await self.queue.put((segment, received_seconds))
        if self.received_samples - self.last_progress_samples >= SAMPLE_RATE // 2:
            self.last_progress_samples = self.received_samples
            await self.send_progress("Получение аудио")

    async def stop(self) -> None:
        if not self.running:
            return
        final_segment = self.segmenter.flush()
        if final_segment:
            await self.queue.put((final_segment, self.received_samples / SAMPLE_RATE))
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

        await self.send_progress("Распознавание речи")
        source_text = await asyncio.to_thread(MODELS.transcribe_ru, audio)
        if not source_text:
            return
        await self.send_json({"type": "source", "text": source_text})

        await self.send_progress("Перевод RU → EN")
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
                await self.send_progress("Озвучка клонированным голосом")
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
                item = await self.queue.get()
                if item is None:
                    self.queue.task_done()
                    break
                segment, source_end_seconds = item
                try:
                    await self._process_segment(segment)
                    self.processed_source_seconds = max(
                        self.processed_source_seconds,
                        source_end_seconds,
                    )
                    await self.send_progress("Фраза обработана")
                except Exception as exc:
                    await self.send_json({"type": "error", "message": str(exc)})
                finally:
                    self.queue.task_done()
        finally:
            self.tmpdir.cleanup()


def _video_job_update(job_id: str, **changes) -> None:
    with VIDEO_JOBS_LOCK:
        job = VIDEO_JOBS.get(job_id)
        if not job:
            return
        job.update(changes)
        if job.get("started_at"):
            job["elapsed_seconds"] = round(time.monotonic() - job["started_at"], 1)


def _video_job_public(job_id: str) -> dict:
    with VIDEO_JOBS_LOCK:
        job = VIDEO_JOBS.get(job_id)
        if not job:
            raise KeyError(job_id)
        return {
            "id": job_id,
            "state": job.get("state", "queued"),
            "stage": job.get("stage", "Ожидание"),
            "progress": round(float(job.get("progress", 0.0)), 1),
            "processed_seconds": round(float(job.get("processed_seconds", 0.0)), 2),
            "total_seconds": job.get("total_seconds"),
            "elapsed_seconds": round(float(job.get("elapsed_seconds", 0.0)), 1),
            "source_text": job.get("source_text", ""),
            "translation_text": job.get("translation_text", ""),
            "error": job.get("error"),
            "download_url": job.get("download_url"),
        }


def _video_cancel_requested(job_id: str) -> bool:
    with VIDEO_JOBS_LOCK:
        return bool(VIDEO_JOBS.get(job_id, {}).get("cancel_requested"))


def _run_ffmpeg(args: list[str]) -> None:
    process = subprocess.run(
        args,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
        creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
    )
    if process.returncode != 0:
        message = process.stderr.decode("utf-8", errors="replace")
        raise RuntimeError(f"FFmpeg error: {message[-3000:]}")


def _read_pcm16_wav(path: Path) -> tuple[np.ndarray, int]:
    with wave.open(str(path), "rb") as wav:
        channels = wav.getnchannels()
        sample_rate = wav.getframerate()
        frames = wav.readframes(wav.getnframes())
    pcm = np.frombuffer(frames, dtype=PCM_DTYPE)
    if channels > 1:
        pcm = pcm.reshape(-1, channels).mean(axis=1).astype(PCM_DTYPE)
    return pcm.astype(np.float32) / 32768.0, sample_rate


def _write_silence(wav_out, samples: int) -> None:
    zero_chunk = b"\x00\x00" * 8192
    remaining = max(0, int(samples))
    while remaining:
        count = min(remaining, 8192)
        wav_out.writeframesraw(zero_chunk[: count * 2])
        remaining -= count


def _build_voice_reference(audio: np.ndarray, segments: list[dict], path: Path) -> None:
    target = max(1, int(VOICE_REFERENCE_SECONDS * SAMPLE_RATE))
    parts: list[np.ndarray] = []
    collected = 0
    for segment in segments:
        start = max(0, int(segment["start"] * SAMPLE_RATE))
        end = min(audio.size, int(segment["end"] * SAMPLE_RATE))
        if end <= start:
            continue
        piece = audio[start:end]
        need = target - collected
        if need <= 0:
            break
        piece = piece[:need]
        if piece.size:
            parts.append(piece)
            collected += piece.size
    if not parts:
        raise RuntimeError("В видео не удалось найти русскую речь для клонирования голоса.")
    reference = np.concatenate(parts)
    if reference.size < SAMPLE_RATE:
        raise RuntimeError("Слишком мало чистой речи для клонирования голоса. Нужно хотя бы около 1 секунды.")
    pcm16 = np.clip(reference * 32767.0, -32768, 32767).astype(PCM_DTYPE)
    write_pcm16_wav(path, pcm16)


def _process_video_job(job_id: str, input_path: Path, output_path: Path) -> None:
    with VIDEO_PROCESS_LOCK:
        try:
            _video_job_update(job_id, state="running", stage="Загрузка локальных моделей", progress=2)
            MODELS.load_asr()
            MODELS.load_translation()
            MODELS.load_tts()
            if _video_cancel_requested(job_id):
                _video_job_update(job_id, state="cancelled", stage="Отменено")
                return

            work_dir = input_path.parent
            source_wav = work_dir / "source_16k.wav"
            reference_wav = work_dir / "voice_reference.wav"
            translated_wav = work_dir / "translated_voice.wav"
            ffmpeg = imageio_ffmpeg.get_ffmpeg_exe()

            _video_job_update(job_id, stage="Извлечение аудио из видео", progress=6)
            _run_ffmpeg([ffmpeg, "-y", "-i", str(input_path), "-vn", "-ac", "1", "-ar", str(SAMPLE_RATE), "-c:a", "pcm_s16le", str(source_wav)])

            audio, sample_rate = _read_pcm16_wav(source_wav)
            if sample_rate != SAMPLE_RATE or audio.size == 0:
                raise RuntimeError("Не удалось извлечь звуковую дорожку из видео.")
            total_seconds = audio.size / SAMPLE_RATE
            _video_job_update(job_id, total_seconds=round(total_seconds, 3), stage="Распознавание русской речи", progress=10)

            def asr_progress(end_seconds: float) -> None:
                ratio = min(1.0, max(0.0, end_seconds / max(total_seconds, 0.001)))
                _video_job_update(job_id, stage="Распознавание русской речи", progress=10 + ratio * 22, processed_seconds=min(end_seconds, total_seconds))

            segments = MODELS.transcribe_ru_segments(audio, asr_progress)
            if not segments:
                raise RuntimeError("Русская речь в видео не распознана.")

            _video_job_update(job_id, stage="Подготовка образца голоса", progress=34)
            _build_voice_reference(audio, segments, reference_wav)
            MODELS.prepare_voice(reference_wav)

            source_lines: list[str] = []
            english_lines: list[str] = []
            tts_sample_rate = int(MODELS.tts.sr)
            cursor_samples = 0

            with wave.open(str(translated_wav), "wb") as wav_out:
                wav_out.setnchannels(1)
                wav_out.setsampwidth(2)
                wav_out.setframerate(tts_sample_rate)

                for index, segment in enumerate(segments):
                    if _video_cancel_requested(job_id):
                        _video_job_update(job_id, state="cancelled", stage="Отменено")
                        return

                    source_text = segment["text"]
                    _video_job_update(job_id, stage=f"Перевод фразы {index + 1}/{len(segments)}", progress=36 + (index / max(1, len(segments))) * 10, processed_seconds=float(segment["start"]))
                    english = MODELS.translate_ru_en(source_text)
                    if not english:
                        continue

                    source_lines.append(source_text)
                    english_lines.append(english)
                    _video_job_update(
                        job_id,
                        stage=f"Озвучка {index + 1}/{len(segments)} клонированным голосом",
                        progress=46 + (index / max(1, len(segments))) * 44,
                        source_text="\n".join(source_lines),
                        translation_text="\n".join(english_lines),
                    )

                    speech, speech_rate = MODELS.synthesize_en(english)
                    if speech_rate != tts_sample_rate:
                        old_x = np.linspace(0.0, 1.0, speech.size, endpoint=False)
                        new_size = max(1, int(speech.size * tts_sample_rate / speech_rate))
                        new_x = np.linspace(0.0, 1.0, new_size, endpoint=False)
                        speech = np.interp(new_x, old_x, speech).astype(np.float32)

                    target_start = max(int(float(segment["start"]) * tts_sample_rate), cursor_samples)
                    _write_silence(wav_out, target_start - cursor_samples)
                    speech_pcm = np.clip(speech * 32767.0, -32768, 32767).astype(PCM_DTYPE)
                    wav_out.writeframesraw(speech_pcm.tobytes())
                    cursor_samples = target_start + speech_pcm.size
                    _video_job_update(job_id, processed_seconds=min(float(segment["end"]), total_seconds), progress=46 + ((index + 1) / max(1, len(segments))) * 44)

                minimum_samples = int(total_seconds * tts_sample_rate)
                _write_silence(wav_out, minimum_samples - cursor_samples)
                cursor_samples = max(cursor_samples, minimum_samples)

            translated_duration = cursor_samples / tts_sample_rate
            extra_video = max(0.0, translated_duration - total_seconds)
            _video_job_update(job_id, stage="Сборка готового MP4", progress=93, processed_seconds=total_seconds)

            command = [ffmpeg, "-y", "-i", str(input_path), "-i", str(translated_wav)]
            if extra_video > 0.05:
                command += ["-vf", f"tpad=stop_mode=clone:stop_duration={extra_video + 0.1:.3f}"]
            command += ["-map", "0:v:0", "-map", "1:a:0", "-c:v", "libx264", "-preset", "veryfast", "-crf", "21", "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", "-shortest", str(output_path)]
            _run_ffmpeg(command)

            if not output_path.exists() or output_path.stat().st_size < 1024:
                raise RuntimeError("FFmpeg не создал итоговый MP4.")

            _video_job_update(job_id, state="done", stage="Готово — MP4 собран", progress=100, processed_seconds=total_seconds, download_url=f"/api/video/jobs/{job_id}/download")
        except Exception as exc:
            _video_job_update(job_id, state="error", stage="Ошибка обработки", error=str(exc))


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


@app.post("/api/video/jobs")
async def create_video_job(file: UploadFile = File(...)) -> dict:
    filename = Path(file.filename or "video.mp4").name
    suffix = Path(filename).suffix.lower() or ".mp4"
    job_id = uuid.uuid4().hex
    job_dir = OUTPUT_DIR / job_id
    job_dir.mkdir(parents=True, exist_ok=True)
    input_path = job_dir / f"input{suffix}"
    output_path = job_dir / "translated_en.mp4"

    with input_path.open("wb") as target:
        while True:
            chunk = await file.read(1024 * 1024)
            if not chunk:
                break
            target.write(chunk)
    await file.close()
    if input_path.stat().st_size == 0:
        raise HTTPException(status_code=400, detail="Пустой видеофайл.")

    with VIDEO_JOBS_LOCK:
        VIDEO_JOBS[job_id] = {
            "state": "queued", "stage": "Файл загружен, запуск обработки",
            "progress": 1.0, "processed_seconds": 0.0, "total_seconds": None,
            "elapsed_seconds": 0.0, "source_text": "", "translation_text": "",
            "error": None, "download_url": None, "cancel_requested": False,
            "started_at": time.monotonic(), "input_path": str(input_path), "output_path": str(output_path),
        }

    task = asyncio.create_task(asyncio.to_thread(_process_video_job, job_id, input_path, output_path))
    VIDEO_TASKS.add(task)
    task.add_done_callback(VIDEO_TASKS.discard)
    return _video_job_public(job_id)


@app.get("/api/video/jobs/{job_id}")
async def get_video_job(job_id: str) -> dict:
    try:
        return _video_job_public(job_id)
    except KeyError:
        raise HTTPException(status_code=404, detail="Задача не найдена.")


@app.post("/api/video/jobs/{job_id}/cancel")
async def cancel_video_job(job_id: str) -> dict:
    with VIDEO_JOBS_LOCK:
        job = VIDEO_JOBS.get(job_id)
        if not job:
            raise HTTPException(status_code=404, detail="Задача не найдена.")
        job["cancel_requested"] = True
        job["stage"] = "Остановка после текущей фразы"
    return _video_job_public(job_id)


@app.get("/api/video/jobs/{job_id}/download")
async def download_video_job(job_id: str):
    with VIDEO_JOBS_LOCK:
        job = VIDEO_JOBS.get(job_id)
        if not job:
            raise HTTPException(status_code=404, detail="Задача не найдена.")
        if job.get("state") != "done":
            raise HTTPException(status_code=409, detail="Видео ещё не готово.")
        output_path = Path(job["output_path"])
    if not output_path.exists():
        raise HTTPException(status_code=404, detail="Итоговый файл не найден.")
    return FileResponse(output_path, media_type="video/mp4", filename="translated_en_voice.mp4")


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
                        await session.start(payload)
                    except Exception as exc:
                        message = str(exc)
                        if (
                            "xethub" in message.lower()
                            or "cas client" in message.lower()
                            or "reconstruction" in message.lower()
                            or "unknown scheme for proxy" in message.lower()
                        ):
                            message = (
                                "Ошибка сетевого доступа к Hugging Face. Приложение автоматически отключает Xet/CAS "
                                "и игнорирует неподдерживаемый socks4:// proxy для загрузки моделей. "
                                "Перезапустите сервер и нажмите «Начать перевод» ещё раз."
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
