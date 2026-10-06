const $ = (selector) => document.querySelector(selector);

const startBtn = $("#startBtn");
const stopBtn = $("#stopBtn");
const status = $("#status");
const statusDot = $("#statusDot");
const sourceTranscript = $("#sourceTranscript");
const translatedTranscript = $("#translatedTranscript");
const translatedAudio = $("#translatedAudio");
const fileBox = $("#fileBox");
const videoFile = $("#videoFile");
const videoPreview = $("#videoPreview");
const modeButtons = [...document.querySelectorAll(".mode")];

let mode = "mic";
let pc = null;
let dataChannel = null;
let sourceStream = null;
let displayStream = null;
let fileCaptureStream = null;
let objectUrl = null;
let sourceText = "";
let translatedText = "";

function setStatus(message, kind = "idle") {
  status.textContent = message;
  statusDot.classList.toggle("live", kind === "live");
  statusDot.classList.toggle("error", kind === "error");
}

function resetTranscriptPlaceholders() {
  sourceText = "";
  translatedText = "";
  sourceTranscript.textContent = "Русская речь появится здесь…";
  translatedTranscript.textContent = "English subtitles will appear here…";
}

modeButtons.forEach((button) => {
  button.addEventListener("click", () => {
    if (pc) return;
    mode = button.dataset.mode;
    modeButtons.forEach((item) => item.classList.toggle("active", item === button));
    fileBox.classList.toggle("hidden", mode !== "file");
  });
});

videoFile.addEventListener("change", () => {
  if (objectUrl) URL.revokeObjectURL(objectUrl);
  const file = videoFile.files?.[0];
  if (!file) {
    videoPreview.removeAttribute("src");
    videoPreview.classList.remove("has-file");
    return;
  }
  objectUrl = URL.createObjectURL(file);
  videoPreview.src = objectUrl;
  videoPreview.classList.add("has-file");
});

async function getSourceAudio() {
  if (mode === "mic") {
    sourceStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true },
      video: false
    });
    return sourceStream;
  }

  if (mode === "screen") {
    displayStream = await navigator.mediaDevices.getDisplayMedia({
      video: true,
      audio: true
    });
    const audioTrack = displayStream.getAudioTracks()[0];
    if (!audioTrack) {
      displayStream.getTracks().forEach((track) => track.stop());
      displayStream = null;
      throw new Error("Звук не передаётся. При выборе вкладки включите «Поделиться аудио/звуком вкладки».");
    }
    sourceStream = new MediaStream([audioTrack]);
    return sourceStream;
  }

  if (mode === "file") {
    if (!videoFile.files?.[0]) {
      throw new Error("Сначала выберите видеофайл.");
    }

    await videoPreview.play();
    const capture = videoPreview.captureStream?.bind(videoPreview)
      || videoPreview.mozCaptureStream?.bind(videoPreview);

    if (!capture) {
      throw new Error("Этот браузер не умеет захватывать звук локального видео. Используйте Chrome/Edge или режим «Видео / вкладка».");
    }

    fileCaptureStream = capture();
    const audioTrack = fileCaptureStream.getAudioTracks()[0];
    if (!audioTrack) {
      throw new Error("Не удалось получить аудиодорожку видео.");
    }

    sourceStream = new MediaStream([audioTrack]);
    return sourceStream;
  }

  throw new Error("Неизвестный источник аудио.");
}

async function createClientSecret() {
  const response = await fetch("/api/session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ targetLanguage: "en" })
  });

  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload.error || "Не удалось создать сессию перевода.");
  }
  if (!payload.value) {
    throw new Error("Сервер не вернул временный ключ Realtime API.");
  }
  return payload.value;
}

function onRealtimeEvent(event) {
  if (event.type === "session.input_transcript.delta") {
    sourceText += event.delta || "";
    sourceTranscript.textContent = sourceText || "Русская речь появится здесь…";
  }

  if (event.type === "session.output_transcript.delta") {
    translatedText += event.delta || "";
    translatedTranscript.textContent = translatedText || "English subtitles will appear here…";
  }

  if (event.type === "error") {
    console.error("Realtime error", event);
    setStatus(event.error?.message || "Ошибка Realtime API", "error");
  }
}

async function startTranslation() {
  startBtn.disabled = true;
  modeButtons.forEach((button) => (button.disabled = true));
  resetTranscriptPlaceholders();
  setStatus("Получаю доступ к аудио…");

  try {
    const [stream, clientSecret] = await Promise.all([
      getSourceAudio(),
      createClientSecret()
    ]);

    pc = new RTCPeerConnection();
    pc.addTrack(stream.getAudioTracks()[0], stream);

    pc.ontrack = ({ streams }) => {
      translatedAudio.srcObject = streams[0];
      translatedAudio.play().catch(() => {});
    };

    pc.onconnectionstatechange = () => {
      if (!pc) return;
      if (pc.connectionState === "connected") {
        setStatus("Перевод идёт: русский → английский", "live");
      } else if (["failed", "disconnected"].includes(pc.connectionState)) {
        setStatus("Соединение с переводчиком потеряно", "error");
      }
    };

    dataChannel = pc.createDataChannel("oai-events");
    dataChannel.onmessage = ({ data }) => {
      try {
        onRealtimeEvent(JSON.parse(data));
      } catch (error) {
        console.warn("Bad realtime event", error);
      }
    };

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);

    const sdpResponse = await fetch(
      "https://api.openai.com/v1/realtime/translations/calls",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${clientSecret}`,
          "Content-Type": "application/sdp"
        },
        body: offer.sdp
      }
    );

    if (!sdpResponse.ok) {
      throw new Error(await sdpResponse.text());
    }

    await pc.setRemoteDescription({
      type: "answer",
      sdp: await sdpResponse.text()
    });

    stopBtn.disabled = false;
  } catch (error) {
    console.error(error);
    await stopTranslation({ keepStatus: true });
    setStatus(error.message || "Не удалось запустить перевод", "error");
  }
}

async function stopTranslation({ keepStatus = false } = {}) {
  dataChannel?.close();
  dataChannel = null;

  pc?.close();
  pc = null;

  sourceStream?.getTracks().forEach((track) => track.stop());
  sourceStream = null;

  displayStream?.getTracks().forEach((track) => track.stop());
  displayStream = null;

  translatedAudio.srcObject = null;

  fileCaptureStream?.getTracks().forEach((track) => track.stop());
  fileCaptureStream = null;

  if (mode === "file") videoPreview.pause();

  startBtn.disabled = false;
  stopBtn.disabled = true;
  modeButtons.forEach((button) => (button.disabled = false));
  if (!keepStatus) setStatus("Перевод остановлен");
}

startBtn.addEventListener("click", startTranslation);
stopBtn.addEventListener("click", () => stopTranslation());
window.addEventListener("beforeunload", () => {
  pc?.close();
  sourceStream?.getTracks().forEach((track) => track.stop());
  displayStream?.getTracks().forEach((track) => track.stop());
});
