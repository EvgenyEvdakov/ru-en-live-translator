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
let starting = false;

function setStatus(message, kind = "idle") {
  status.textContent = message;
  statusDot.classList.toggle("live", kind === "live");
  statusDot.classList.toggle("error", kind === "error");
}

function friendlyError(error) {
  if (!error) return "Неизвестная ошибка.";

  if (error.name === "NotAllowedError") {
    return "Доступ к микрофону/звуку запрещён. Разрешите доступ в настройках браузера и попробуйте снова.";
  }
  if (error.name === "NotFoundError") {
    return "Аудиоустройство не найдено. Проверьте микрофон или выбранный источник.";
  }
  if (error.name === "NotReadableError") {
    return "Браузер не может открыть аудиоустройство. Возможно, его использует другая программа.";
  }
  if (error.name === "AbortError") {
    return "Операция была прервана. Попробуйте ещё раз.";
  }

  return error.message || String(error);
}

function resetTranscriptPlaceholders() {
  sourceText = "";
  translatedText = "";
  sourceTranscript.textContent = "Русская речь появится здесь…";
  translatedTranscript.textContent = "English subtitles will appear here…";
}

function assertBrowserEnvironment() {
  if (location.protocol === "file:") {
    throw new Error(
      "Приложение открыто как файл. Запустите `npm run dev` и откройте http://localhost:3000 — напрямую index.html перевод работать не может."
    );
  }

  if (!window.isSecureContext) {
    throw new Error(
      "Браузер разрешает микрофон только в безопасном контексте. Используйте http://localhost:3000 или HTTPS."
    );
  }

  if (!navigator.mediaDevices) {
    throw new Error(
      "В этом браузере MediaDevices недоступен. Откройте приложение через http://localhost:3000 в Chrome или Edge."
    );
  }

  if (!window.RTCPeerConnection) {
    throw new Error("ҭтот браузер не поддерживает WebRTC, необходимый для перевода.");
  }
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 15000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function checkServer() {
  let response;
  try {
    response = await fetchWithTimeout("/api/health", { cache: "no-store" }, 5000);
  } catch (error) {
    if (error.name === "AbortError") {
      throw new Error("Локальный сервер не ответил за 5 секунд. Перезапустите `npm run dev`.");
    }
    throw new Error(
      "Не удалось связаться с локальным сервером. Запустите `npm install`, затем `npm run dev`, и откройте http://localhost:3000."
    );
  }

  if (!response.ok) {
    throw new Error(`Локальный сервер вернул HTTP ${response.status}. Перезапустите npm run dev.`);
  }

  const payload = await response.json();
  if (!payload.configured) {
    throw new Error(
      "На сервере не настроен OPENAI_API_KEY. Скопируйте .env.example в .env, вставьте ключ и перезапустите `npm run dev`."
    );
  }

  return payload;
}

function waitForEvent(target, eventName, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const onEvent = () => {
      cleanup();
      resolve();
    };
    const onError = () => {
      cleanup();
      reject(new Error("Браузер не смог прочитать выбранный видеофайл."));
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Не дождался события ${eventName} от видеофайла.`));
    }, timeoutMs);

    function cleanup() {
      clearTimeout(timer);
      target.removeEventListener(eventName, onEvent);
      target.removeEventListener("error", onError);
    }

    target.addEventListener(eventName, onEvent, { once: true });
    target.addEventListener("error", onError, { once: true });
  });
}

function waitForAudioTrack(stream, timeoutMs = 2000) {
  const existing = stream.getAudioTracks()[0];
  if (existing) return Promise.resolve(existing);

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      stream.removeEventListener("addtrack", onTrack);
      reject(new Error("Не удалось получить аудиодорожку видео. Проверьте, что в файле действительно есть звук."));
    }, timeoutMs);

    function onTrack(event) {
      if (event.track?.kind !== "audio") return;
      clearTimeout(timer);
      stream.removeEventListener("addtrack", onTrack);
      resolve(event.track);
    }

    stream.addEventListener("addtrack", onTrack);
  });
}

modeButtons.forEach((button) => {
  button.addEventListener("click", () => {
    if (pc || starting) return;
    mode = button.dataset.mode;
    modeButtons.forEach((item) => item.classList.toggle("active", item === button));
    fileBox.classList.toggle("hidden", mode !== "file");

    if (mode === "mic") setStatus("Режим: микрофон. Нажмите «Начать перевод».");
    if (mode === "screen") setStatus("Режим: звук вкладки/экрана. Нажмите «Начать перевод».");
    if (mode === "file") setStatus("Режим: видеофайл. Выберите файл и нажмите «Начать перевод».");
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
    setStatus("Выберите видеофайл.");
    return;
  }

  objectUrl = URL.createObjectURL(file);
  videoPreview.src = objectUrl;
  videoPreview.classList.add("has-file");
  videoPreview.load();
  setStatus(`Файл выбран: ${file.name}. Нажмите «Начать перевод».`);
});

async function getSourceAudio() {
  if (mode === "mic") {
    setStatus("Браузер должен запросить доступ к микрофону…");
    sourceStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true
      },
      video: false
    });

    const audioTrack = sourceStream.getAudioTracks()[0];
    if (!audioTrack) throw new Error("Браузер не вернул аудиодорожку микрофона.");
    setStatus(`Микрофон включён: ${audioTrack.label || "audio input"}. Подключаю перевод…`);
    return sourceStream;
  }

  if (mode === "screen") {
    setStatus("Выберите вкладку/экран и обязательно включите передачу звука…");
    displayStream = await navigator.mediaDevices.getDisplayMedia({
      video: true,
      audio: true
    });

    const audioTrack = displayStream.getAudioTracks()[0];
    if (!audioTrack) {
      displayStream.getTracks().forEach((track) => track.stop());
      displayStream = null;
      throw new Error(
        "Звук не передаётся. При выборе вкладки включите «Поделиться аудио» / «Share tab audio»."
      );
    }

    const videoTrack = displayStream.getVideoTracks()[0];
    if (videoTrack) {
      videoTrack.addEventListener("ended", () => {
        if (pc) stopTranslation();
      }, { once: true });
    }

    sourceStream = new MediaStream([audioTrack]);
    setStatus("Звук вкладки получен. Подключаю перевод…");
    return sourceStream;
  }

  if (mode === "file") {
    if (!videoFile.files?.[0]) {
      throw new Error("Сначала выберите видеофайл.");
    }

    if (videoPreview.readyState < HTMLMediaElement.HAVE_METADATA) {
      setStatus("Читаю видеофайл…");
      await waitForEvent(videoPreview, "loadedmetadata");
    }

    const capture = videoPreview.captureStream?.bind(videoPreview)
      || videoPreview.mozCaptureStream?.bind(videoPreview);

    if (!capture) {
      throw new Error(
        "Этот браузер не умеет захватывать звук локального видео. Используйте Chrome/Edge или режим «Видео / вкладка»."
      );
    }

    // Capture before play so Chromium can expose the media tracks as playback starts.
    fileCaptureStream = capture();

    try {
      await videoPreview.play();
    } catch (error) {
      throw new Error(`Не удалось запустить видео: ${friendlyError(error)}`);
    }

    const audioTrack = await waitForAudioTrack(fileCaptureStream);
    sourceStream = new MediaStream([audioTrack]);
    setStatus("Аудиодорожка видео получена. Подключаю перевод…");
    return sourceStream;
  }

  throw new Error("Неизвестный источник аудио.");
}

async function createClientSecret() {
  let response;

  try {
    response = await fetchWithTimeout(
      "/api/session",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ targetLanguage: "en" })
      },
      15000
    );
  } catch (error) {
    if (error.name === "AbortError") {
      throw new Error("OpenAI API не ответил за 15 секунд. Проверьте интернет и попробуйте снова.");
    }
    throw new Error(`Не удалось создать сессию перевода: ${friendlyError(error)}`);
  }

  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new Error(`Сервер вернул некорректный ответ (HTTP ${response.status}).`);
  }

  if (!response.ok) {
    throw new Error(payload.error || `Не удалось создать сессию перевода (HTTP ${response.status}).`);
  }

  if (!payload.value) {
    throw new Error("Сервер не вернул временный ключ Realtime API.");
  }

  return payload.value;
}

function onRealtimeEvent(event) {
  if (event.type === "session.created") {
    setStatus("Realtime-сессия создана. Жду русскую речь…", "live");
  }

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

async function connectRealtime(stream, clientSecret) {
  pc = new RTCPeerConnection();
  const audioTrack = stream.getAudioTracks()[0];

  if (!audioTrack) {
    throw new Error("Нет аудиодорожки для отправки в переводчик.");
  }

  pc.addTrack(audioTrack, stream);

  pc.ontrack = ({ streams, track }) => {
    const remoteStream = streams[0] || new MediaStream([track]);
    translatedAudio.srcObject = remoteStream;
    translatedAudio.play().catch((error) => {
      console.warn("Translated audio autoplay was blocked", error);
      setStatus(
        "Перевод подключён, но браузер заблокировал автоматическое воспроизведение английского звука. Разрешите autoplay для localhost.",
        "error"
      );
    });
  };

  pc.onconnectionstatechange = () => {
    if (!pc) return;

    if (pc.connectionState === "connected") {
      setStatus("Перевод идёт: русский → английский", "live");
    } else if (pc.connectionState === "connecting") {
      setStatus("Устанавливаю WebRTC-соединение…");
    } else if (["failed", "disconnected"].includes(pc.connectionState)) {
      setStatus("Соединение с переводчиком потеряно.", "error");
    }
  };

  pc.oniceconnectionstatechange = () => {
    if (!pc) return;
    console.info("ICE state:", pc.iceConnectionState);
  };

  dataChannel = pc.createDataChannel("oai-events");
  dataChannel.onopen = () => console.info("Realtime event channel opened");
  dataChannel.onerror = (event) => console.error("Realtime data channel error", event);
  dataChannel.onmessage = ({ data }) => {
    try {
      onRealtimeEvent(JSON.parse(data));
    } catch (error) {
      console.warn("Bad realtime event", error, data);
    }
  };

  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);

  setStatus("Подключаюсь к OpenAI Realtime…");

  const sdpResponse = await fetchWithTimeout(
    "https://api.openai.com/v1/realtime/translations/calls",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${clientSecret}`,
        "Content-Type": "application/sdp"
      },
      body: offer.sdp
    },
    20000
  );

  if (!sdpResponse.ok) {
    const message = await sdpResponse.text();
    throw new Error(`OpenAI WebRTC: HTTT ${sdpResponse.status}. ${message}`);
  }

  const answerSdp = await sdpResponse.text();
  await pc.setRemoteDescription({ type: "answer", sdp: answerSdp });
}

async function startTranslation() {
  if (starting || pc) return;

  starting = true;
  startBtn.disabled = true;
  stopBtn.disabled = false;
  modeButtons.forEach((button) => (button.disabled = true));
  resetTranscriptPlaceholders();

  try {
    assertBrowserEnvironment();

    // Ask for/capture audio first, directly from the user's button click.
    const stream = await getSourceAudio();

    setStatus("Проверяю локальный сервер и API-ключ…");
    await checkServer();

    setStatus("Создаю защищённую сессию перевода…");
    const clientSecret = await createClientSecret();

    await connectRealtime(stream, clientSecret);
  } catch (error) {
    console.error("Translation startup failed", error);
    await stopTranslation({ keepStatus: true });
    setStatus(friendlyError(error), "error");
  } finally {
    starting = false;
    if (!pc) {
      startBtn.disabled = false;
      stopBtn.disabled = true;
      modeButtons.forEach((button) => (button.disabled = false));
    }
  }
}

async function stopTranslation({ keepStatus = false } = {}) {
  if (dataChannel?.readyState === "open") {
    try {
      dataChannel.send(JSON.stringify({ type: "session.close" }));
    } catch {
      // Peer may already be closing.
    }
  }

  dataChannel?.close();
  dataChannel = null;

  pc?.close();
  pc = null;

  sourceStream?.getTracks().forEach((track) => track.stop());
  sourceStream = null;

  displayStream?.getTracks().forEach((track) => track.stop());
  displayStream = null;

  translatedAudio.pause();
  translatedAudio.srcObject = null;

  fileCaptureStream?.getTracks().forEach((track) => track.stop());
  fileCaptureStream = null;

  if (mode === "file") videoPreview.pause();

  startBtn.disabled = false;
  stopBtn.disabled = true;
  modeButtons.forEach((button) => (button.disabled = false));

  if (!keepStatus) setStatus("Перевод остановлен.");
}

startBtn.addEventListener("click", startTranslation);
stopBtn.addEventListener("click", () => stopTranslation());

window.addEventListener("beforeunload", () => {
  dataChannel?.close();
  pc?.close();
  sourceStream?.getTracks().forEach((track) => track.stop());
  displayStream?.getTracks().forEach((track) => track.stop());
});

if (location.protocol === "file:") {
  setStatus("Запустите приложение через `npm run dev`, а не открывайте index.html напрямую.", "error");
} else if (!window.isSecureContext || !navigator.mediaDevices) {
  setStatus("Микрофон недоступен в текущем контексте. Используйте http://localhost:3000 или HTTPS.", "error");
} else {
  setStatus("Интерфейс загружен. Выберите источник и нажмите «Начать перевод».");
}
