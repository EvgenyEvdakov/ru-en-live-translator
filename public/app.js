const $ = (selector) => document.querySelector(selector);

const startBtn = $("#startBtn");
const stopBtn = $("#stopBtn");
const status = $("#status");
const statusDot = $("#statusDot");
const sourceTranscript = $("#sourceTranscript");
const translatedTranscript = $("#translatedTranscript");
const fileBox = $("#fileBox");
const videoFile = $("#videoFile");
const videoPreview = $("#videoPreview");
const modeButtons = [...document.querySelectorAll(".mode")];

let mode = "mic";
let socket = null;
let mediaStream = null;
let audioContext = null;
let captureSource = null;
let processor = null;
let silentGain = null;
let fileMediaSource = null;
let objectUrl = null;
let nextPlayTime = 0;
let startedCapture = false;
let stopping = false;
let sourceLines = [];
let translatedLines = [];

function setStatus(message, kind = "idle") {
  status.textContent = message;
  statusDot.classList.toggle("live", kind === "live");
  statusDot.classList.toggle("error", kind === "error");
}

function setControls(running) {
  startBtn.disabled = running;
  stopBtn.disabled = !running;
  modeButtons.forEach((button) => (button.disabled = running));
  videoFile.disabled = running;
}

function resetText() {
  sourceLines = [];
  translatedLines = [];
  sourceTranscript.textContent = "Русская речь появится здесь…";
  translatedTranscript.textContent = "English translation will appear here…";
}

function appendText(target, lines, text, placeholder) {
  if (!text) return;
  lines.push(text);
  if (lines.length > 12) lines.shift();
  target.textContent = lines.join("\n") || placeholder;
  target.scrollTop = target.scrollHeight;
}

modeButtons.forEach((button) => {
  button.addEventListener("click", () => {
    if (socket) return;
    mode = button.dataset.mode;
    modeButtons.forEach((item) => item.classList.toggle("active", item === button));
    fileBox.classList.toggle("hidden", mode !== "file");
  });
});

videoFile.addEventListener("change", () => {
  if (objectUrl) URL.revokeObjectURL(objectUrl);
  const file = videoFile.files?.[0];
  if (!file) {
    videoPreview.pause();
    videoPreview.removeAttribute("src");
    videoPreview.load();
    videoPreview.classList.remove("has-file");
    return;
  }
  objectUrl = URL.createObjectURL(file);
  videoPreview.src = objectUrl;
  videoPreview.load();
  videoPreview.classList.add("has-file");
  setStatus(`Файл выбран: ${file.name}`);
});

async function getInput() {
  if (!navigator.mediaDevices) {
    throw new Error("MediaDevices недоступен. Откройте приложение через http://localhost:8000 в Chrome/Edge.");
  }

  if (mode === "mic") {
    return navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      video: false,
    });
  }

  if (mode === "screen") {
    const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
    if (!stream.getAudioTracks().length) {
      stream.getTracks().forEach((track) => track.stop());
      throw new Error("У выбранной вкладки нет передаваемого аудио. Включите «Поделиться аудио вкладки».");
    }
    return stream;
  }

  if (mode === "file") {
    if (!videoFile.files?.[0]) throw new Error("Сначала выберите видеофайл.");
    return null;
  }

  throw new Error("Неизвестный режим аудио.");
}

function websocketUrl() {
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${location.host}/ws/translate`;
}

function connectSocket() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(websocketUrl());
    ws.binaryType = "arraybuffer";
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error("Локальный сервер не ответил. Запустите python local_server.py."));
    }, 8000);

    ws.addEventListener("open", () => {
      clearTimeout(timer);
      resolve(ws);
    }, { once: true });

    ws.addEventListener("error", () => {
      clearTimeout(timer);
      reject(new Error("Не удалось подключиться к локальному серверу."));
    }, { once: true });
  });
}

function resampleTo16k(input, sourceRate) {
  if (sourceRate === 16000) return input.slice();
  const ratio = sourceRate / 16000;
  const outputLength = Math.max(1, Math.round(input.length / ratio));
  const output = new Float32Array(outputLength);

  for (let i = 0; i < outputLength; i += 1) {
    const pos = i * ratio;
    const left = Math.floor(pos);
    const right = Math.min(input.length - 1, left + 1);
    const frac = pos - left;
    output[i] = input[left] * (1 - frac) + input[right] * frac;
  }
  return output;
}

function floatToPcm16(floatData) {
  const pcm = new Int16Array(floatData.length);
  for (let i = 0; i < floatData.length; i += 1) {
    const sample = Math.max(-1, Math.min(1, floatData[i]));
    pcm[i] = sample < 0 ? sample * 32768 : sample * 32767;
  }
  return pcm;
}

async function startCapture() {
  if (startedCapture) return;
  audioContext ||= new AudioContext();
  await audioContext.resume();

  processor = audioContext.createScriptProcessor(4096, 1, 1);
  silentGain = audioContext.createGain();
  silentGain.gain.value = 0;
  processor.connect(silentGain);
  silentGain.connect(audioContext.destination);

  if (mode === "file") {
    if (!fileMediaSource) fileMediaSource = audioContext.createMediaElementSource(videoPreview);
    captureSource = fileMediaSource;
    captureSource.connect(processor);
    await videoPreview.play();
  } else {
    captureSource = audioContext.createMediaStreamSource(mediaStream);
    captureSource.connect(processor);
  }

  processor.onaudioprocess = (event) => {
    if (!socket || socket.readyState !== WebSocket.OPEN || stopping) return;
    const channel = event.inputBuffer.getChannelData(0);
    const resampled = resampleTo16k(channel, audioContext.sampleRate);
    const pcm16 = floatToPcm16(resampled);
    socket.send(pcm16.buffer);
  };

  startedCapture = true;
  setStatus("Слушаю русскую речь…", "live");
}

function playPcmPacket(buffer) {
  if (!audioContext || buffer.byteLength <= 4) return;
  const view = new DataView(buffer);
  const sampleRate = view.getUint32(0, true);
  const pcm = new Int16Array(buffer.slice(4));
  const floats = new Float32Array(pcm.length);
  for (let i = 0; i < pcm.length; i += 1) floats[i] = pcm[i] / 32768;

  const audioBuffer = audioContext.createBuffer(1, floats.length, sampleRate);
  audioBuffer.copyToChannel(floats, 0);
  const node = audioContext.createBufferSource();
  node.buffer = audioBuffer;
  node.connect(audioContext.destination);

  const now = audioContext.currentTime;
  const startAt = Math.max(now + 0.03, nextPlayTime || now);
  node.start(startAt);
  nextPlayTime = startAt + audioBuffer.duration;
}

function handleServerMessage(event) {
  if (event.data instanceof ArrayBuffer) {
    playPcmPacket(event.data);
    return;
  }

  let message;
  try {
    message = JSON.parse(event.data);
  } catch {
    return;
  }

  if (message.type === "status" || message.type === "connected") {
    setStatus(message.message || "Работаю…", "live");
  } else if (message.type === "ready") {
    setStatus(`${message.message} Устройство: ${message.device}.`, "live");
    startCapture().catch((error) => fail(error));
  } else if (message.type === "voice_ready") {
    setStatus(message.message, "live");
  } else if (message.type === "progress") {
    window.dispatchEvent(new CustomEvent("translator-progress", { detail: message }));
  } else if (message.type === "source") {
    appendText(sourceTranscript, sourceLines, message.text, "Русская речь появится здесь…");
  } else if (message.type === "translation") {
    appendText(translatedTranscript, translatedLines, message.text, "English translation will appear here…");
  } else if (message.type === "error") {
    setStatus(message.message || "Ошибка локального перевода.", "error");
  } else if (message.type === "stopped") {
    finishStop();
    setStatus(message.message || "Перевод остановлен.");
  }
}

async function startTranslation() {
  if (socket) return;
  if (location.protocol === "file:") {
    setStatus("Нельзя открывать index.html двойным кликом. Запустите python local_server.py и откройте http://localhost:8000.", "error");
    return;
  }

  resetText();
  setControls(true);
  stopping = false;
  nextPlayTime = 0;

  try {
    setStatus("Запрашиваю доступ к источнику звука…");
    mediaStream = await getInput();
    setStatus("Подключаюсь к локальным моделям…");
    socket = await connectSocket();
    socket.addEventListener("message", handleServerMessage);
    socket.addEventListener("close", () => {
      if (!stopping) {
        setStatus("Соединение с локальным сервером закрыто.", "error");
        finishStop();
      }
    });
    const duration = mode === "file" && Number.isFinite(videoPreview.duration)
      ? videoPreview.duration
      : null;
    socket.send(JSON.stringify({ type: "start", mode, duration }));
  } catch (error) {
    fail(error);
  }
}

function stopCapture() {
  if (processor) {
    processor.onaudioprocess = null;
    try { processor.disconnect(); } catch {}
    processor = null;
  }
  if (captureSource) {
    try { captureSource.disconnect(); } catch {}
    captureSource = null;
  }
  if (silentGain) {
    try { silentGain.disconnect(); } catch {}
    silentGain = null;
  }

  if (mediaStream) {
    mediaStream.getTracks().forEach((track) => track.stop());
    mediaStream = null;
  }
  if (mode === "file") videoPreview.pause();
  startedCapture = false;
}

function finishStop() {
  stopCapture();
  if (socket) {
    try { socket.close(); } catch {}
  }
  socket = null;
  stopping = false;
  setControls(false);
}

function fail(error) {
  console.error(error);
  setStatus(error?.message || String(error), "error");
  finishStop();
}

function stopTranslation() {
  if (!socket) {
    finishStop();
    return;
  }
  stopping = true;
  stopCapture();
  setStatus("Завершаю последнюю фразу…");
  try {
    socket.send(JSON.stringify({ type: "stop" }));
  } catch {
    finishStop();
  }
}

startBtn.addEventListener("click", startTranslation);
stopBtn.addEventListener("click", stopTranslation);

window.addEventListener("beforeunload", () => {
  stopCapture();
  try { socket?.close(); } catch {}
  if (objectUrl) URL.revokeObjectURL(objectUrl);
});
