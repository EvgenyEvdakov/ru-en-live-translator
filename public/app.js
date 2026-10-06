const $ = (s) => document.querySelector(s);

const startBtn = $("#startBtn");
const stopBtn = $("#stopBtn");
const statusEl = $("#status");
const statusDot = $("#statusDot");
const sourceTextEl = $("#sourceTranscript");
const translatedTextEl = $("#translatedTranscript");
const translatedAudio = $("#translatedAudio");
const fileBox = $("#fileBox");
const videoFile = $("#videoFile");
const video = $("#videoPreview");
const modeButtons = [...document.querySelectorAll(".mode")];

let mode = "mic";
let pc = null;
let events = null;
let sourceStream = null;
let displayStream = null;
let fileStream = null;
let fileUrl = null;
let starting = false;
let sourceText = "";
let translatedText = "";

function setStatus(text, kind = "idle") {
  statusEl.textContent = text;
  statusDot.classList.toggle("live", kind === "live");
  statusDot.classList.toggle("error", kind === "error");
}

function message(error) {
  if (!error) return "Неизвестная ошибка.";
  if (error.name === "NotAllowedError") return "Нет доступа к микрофону или звуку. Разрешите доступ в браузере и попробуйте снова.";
  if (error.name === "NotFoundError") return "Аудиоустройство не найдено.";
  if (error.name === "NotReadableError") return "Не удалось открыть аудиоустройство. Возможно, его использует другая программа.";
  if (error.name === "AbortError") return "Операция прервана или сервер не ответил вовремя.";
  return error.message || String(error);
}

function resetText() {
  sourceText = "";
  translatedText = "";
  sourceTextEl.textContent = "Русская речь появится здесь…";
  translatedTextEl.textContent = "English subtitles will appear here…";
}

function assertEnvironment() {
  if (location.protocol === "file:") {
    throw new Error("Нельзя открывать index.html двойным кликом. Запустите npm run dev и откройте http://localhost:3000");
  }
  if (!window.isSecureContext || !navigator.mediaDevices) {
    throw new Error("Микрофон доступен только через http://localhost:3000 или HTTPS.");
  }
  if (!window.RTCPeerConnection) {
    throw new Error("Этот браузер не поддерживает WebRTC. Используйте Chrome или Edge.");
  }
}

async function fetchTimeout(url, options = {}, ms = 15000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function checkServer() {
  let response;
  try {
    response = await fetchTimeout("/api/health", { cache: "no-store" }, 5000);
  } catch (e) {
    throw new Error("Локальный сервер недоступен. Выполните npm install, затем npm run dev и откройте http://localhost:3000");
  }
  if (!response.ok) throw new Error("Ошибка локального сервера: HTTP " + response.status);
  const data = await response.json();
  if (!data.configured) {
    throw new Error("OPENAI_API_KEY не настроен. Создайте .env по образцу .env.example, вставьте ключ и перезапустите npm run dev.");
  }
}

async function createSession() {
  const response = await fetchTimeout("/api/session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ targetLanguage: "en" })
  }, 15000);

  let data = {};
  try { data = await response.json(); } catch {}
  if (!response.ok) throw new Error(data.error || ("Не удалось создать Realtime-сессию: HTTP " + response.status));
  if (!data.value) throw new Error("Сервер не вернул временный Realtime client secret.");
  return data.value;
}

function waitForAudioTrack(stream, ms = 3000) {
  const existing = stream.getAudioTracks()[0];
  if (existing) return Promise.resolve(existing);

  return new Promise((resolve, reject) => {
    const deadline = Date.now() + ms;
    const timer = setInterval(() => {
      const track = stream.getAudioTracks()[0];
      if (track) {
        clearInterval(timer);
        resolve(track);
      } else if (Date.now() >= deadline) {
        clearInterval(timer);
        reject(new Error("В видео не найдена аудиодорожка."));
      }
    }, 50);
  });
}

async function captureSource() {
  if (mode === "mic") {
    setStatus("Запрашиваю доступ к микрофону…");
    sourceStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      video: false
    });
    const track = sourceStream.getAudioTracks()[0];
    if (!track) throw new Error("Браузер не вернул аудиодорожку микрофона.");
    setStatus("Микрофон включён. Подключаю перевод…");
    return sourceStream;
  }

  if (mode === "screen") {
    setStatus("Выберите вкладку и включите «Поделиться аудио» / Share tab audio…");
    displayStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
    const track = displayStream.getAudioTracks()[0];
    if (!track) {
      displayStream.getTracks().forEach((t) => t.stop());
      displayStream = null;
      throw new Error("Звук вкладки не передаётся. При выборе вкладки включите Share tab audio.");
    }
    const screenTrack = displayStream.getVideoTracks()[0];
    if (screenTrack) screenTrack.addEventListener("ended", () => stopTranslation(), { once: true });
    sourceStream = new MediaStream([track]);
    setStatus("Звук вкладки получен. Подключаю перевод…");
    return sourceStream;
  }

  if (mode === "file") {
    if (!videoFile.files || !videoFile.files[0]) throw new Error("Сначала выберите видеофайл.");
    if (!video.captureStream && !video.mozCaptureStream) {
      throw new Error("Ваш браузер не поддерживает захват звука видеофайла. Используйте Chrome/Edge или режим «Видео / вкладка».");
    }

    if (video.readyState < HTMLMediaElement.HAVE_METADATA) {
      await new Promise((resolve, reject) => {
        const ok = () => { cleanup(); resolve(); };
        const bad = () => { cleanup(); reject(new Error("Не удалось прочитать видеофайл.")); };
        const cleanup = () => {
          video.removeEventListener("loadedmetadata", ok);
          video.removeEventListener("error", bad);
        };
        video.addEventListener("loadedmetadata", ok, { once: true });
        video.addEventListener("error", bad, { once: true });
      });
    }

    const capture = (video.captureStream || video.mozCaptureStream).bind(video);
    fileStream = capture();
    await video.play();
    const track = await waitForAudioTrack(fileStream);
    sourceStream = new MediaStream([track]);
    setStatus("Аудиодорожка видео получена. Подключаю перевод…");
    return sourceStream;
  }

  throw new Error("Неизвестный источник аудио.");
}

function handleEvent(event) {
  if (event.type === "session.input_transcript.delta") {
    sourceText += event.delta || "";
    sourceTextEl.textContent = sourceText || "Русская речь появится здесь…";
  }
  if (event.type === "session.output_transcript.delta") {
    translatedText += event.delta || "";
    translatedTextEl.textContent = translatedText || "English subtitles will appear here…";
  }
  if (event.type === "error") {
    console.error("Realtime API error", event);
    setStatus(event.error?.message || "Ошибка Realtime API", "error");
  }
}

async function connectRealtime(stream, clientSecret) {
  pc = new RTCPeerConnection();
  const track = stream.getAudioTracks()[0];
  if (!track) throw new Error("Нет аудиодорожки для отправки в переводчик.");

  pc.addTrack(track, stream);

  pc.ontrack = ({ streams, track: remoteTrack }) => {
    translatedAudio.srcObject = streams[0] || new MediaStream([remoteTrack]);
    translatedAudio.play().catch(() => {
      setStatus("Перевод подключён, но браузер заблокировал английский звук. Разрешите autoplay для localhost.", "error");
    });
  };

  pc.onconnectionstatechange = () => {
    if (!pc) return;
    if (pc.connectionState === "connected") setStatus("Перевод идёт: русский → английский", "live");
    if (pc.connectionState === "connecting") setStatus("Устанавливаю WebRTC-соединение…");
    if (["failed", "disconnected"].includes(pc.connectionState)) setStatus("Соединение с переводчиком потеряно.", "error");
  };

  events = pc.createDataChannel("oai-events");
  events.onmessage = ({ data }) => {
    try { handleEvent(JSON.parse(data)); }
    catch (e) { console.warn("Bad realtime event", e, data); }
  };
  events.onerror = (e) => console.error("Realtime data channel error", e);

  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  setStatus("Подключаюсь к OpenAI Realtime…");

  const response = await fetchTimeout("https://api.openai.com/v1/realtime/translations/calls", {
    method: "POST",
    headers: {
      Authorization: "Bearer " + clientSecret,
      "Content-Type": "application/sdp"
    },
    body: offer.sdp
  }, 20000);

  if (!response.ok) throw new Error("OpenAI WebRTC: HTTP " + response.status + ". " + await response.text());
  await pc.setRemoteDescription({ type: "answer", sdp: await response.text() });
}

async function startTranslation() {
  if (starting || pc) return;
  starting = true;
  startBtn.disabled = true;
  stopBtn.disabled = false;
  modeButtons.forEach((b) => b.disabled = true);
  resetText();

  try {
    assertEnvironment();
    const stream = await captureSource();
    setStatus("Проверяю локальный сервер и API-ключ…");
    await checkServer();
    setStatus("Создаю защищённую сессию перевода…");
    const secret = await createSession();
    await connectRealtime(stream, secret);
  } catch (e) {
    console.error("Translation startup failed", e);
    await stopTranslation(true);
    setStatus(message(e), "error");
  } finally {
    starting = false;
    if (!pc) {
      startBtn.disabled = false;
      stopBtn.disabled = true;
      modeButtons.forEach((b) => b.disabled = false);
    }
  }
}

async function stopTranslation(keepStatus = false) {
  if (events?.readyState === "open") {
    try { events.send(JSON.stringify({ type: "session.close" })); } catch {}
  }
  events?.close();
  events = null;
  pc?.close();
  pc = null;

  sourceStream?.getTracks().forEach((t) => t.stop());
  sourceStream = null;
  displayStream?.getTracks().forEach((t) => t.stop());
  displayStream = null;
  fileStream?.getTracks().forEach((t) => t.stop());
  fileStream = null;

  translatedAudio.pause();
  translatedAudio.srcObject = null;
  if (mode === "file") video.pause();

  startBtn.disabled = false;
  stopBtn.disabled = true;
  modeButtons.forEach((b) => b.disabled = false);
  if (!keepStatus) setStatus("Перевод остановлен.");
}

modeButtons.forEach((button) => button.addEventListener("click", () => {
  if (starting || pc) return;
  mode = button.dataset.mode;
  modeButtons.forEach((b) => b.classList.toggle("active", b === button));
  fileBox.classList.toggle("hidden", mode !== "file");
  if (mode === "mic") setStatus("Режим: микрофон. Нажмите «Начать перевод».");
  if (mode === "screen") setStatus("Режим: звук вкладки/экрана. Нажмите «Начать перевод».");
  if (mode === "file") setStatus("Режим: видеофайл. Выберите файл и нажмите «Начать перевод».");
}));

videoFile.addEventListener("change", () => {
  if (fileUrl) URL.revokeObjectURL(fileUrl);
  const file = videoFile.files?.[0];
  if (!file) {
    video.removeAttribute("src");
    video.load();
    video.classList.remove("has-file");
    return;
  }
  fileUrl = URL.createObjectURL(file);
  video.src = fileUrl;
  video.classList.add("has-file");
  video.load();
  setStatus("Файл выбран: " + file.name + ". Нажмите «Начать перевод».");
});

startBtn.addEventListener("click", startTranslation);
stopBtn.addEventListener("click", () => stopTranslation());

window.addEventListener("beforeunload", () => {
  pc?.close();
  sourceStream?.getTracks().forEach((t) => t.stop());
  displayStream?.getTracks().forEach((t) => t.stop());
});

if (location.protocol === "file:") {
  setStatus("Запустите приложение через npm run dev и откройте http://localhost:3000, а не index.html напрямую.", "error");
} else if (!window.isSecureContext || !navigator.mediaDevices) {
  setStatus("Микрофон недоступен в текущем контексте. Используйте http://localhost:3000 или HTTPS.", "error");
} else {
  setStatus("Интерфейс загружен. Выберите источник и нажмите «Начать перевод».");
}
