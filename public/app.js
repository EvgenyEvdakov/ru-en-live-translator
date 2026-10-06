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
  if (!error) return "–ù–µ–∏–∑–≤–µ—Å—Ç–Ω–∞—è –æ—à–∏–±–∫–∞.";

  if (error.name === "NotAllowedError") {
    return "–î–æ—Å—Ç—É–ø –∫ –º–∏–∫—Ä–æ—Ñ–æ–Ω—É/–∑–≤—É–∫—É –∑–∞–ø—Ä–µ—â—ë–Ω. –†–∞–∑—Ä–µ—à–∏—Ç–µ –¥–æ—Å—Ç—É–ø –≤ –Ω–∞—Å—Ç—Ä–æ–π–∫–∞—Ö –±—Ä–∞—É–∑–µ—Ä–∞ –∏ –ø–æ–ø—Ä–æ–±—É–π—Ç–µ —Å–Ω–æ–≤–∞.";
  }
  if (error.name === "NotFoundError") {
    return "–ê—É–¥–∏–æ—É—Å—Ç—Ä–æ–π—Å—Ç–≤–æ –Ω–µ –Ω–∞–π–¥–µ–Ω–æ. –ü—Ä–æ–≤–µ—Ä—å—Ç–µ –º–∏–∫—Ä–æ—Ñ–æ–Ω –∏–ª–∏ –≤—ã–±—Ä–∞–Ω–Ω—ã–π –∏—Å—Ç–æ—á–Ω–∏–∫.";
  }
  if (error.name === "NotReadableError") {
    return "–ë—Ä–∞—É–∑–µ—Ä –Ω–µ –º–æ–∂–µ—Ç –æ—Ç–∫—Ä—ã—Ç—å –∞—É–¥–∏–æ—É—Å—Ç—Ä–æ–π—Å—Ç–≤–æ. –í–æ–∑–º–æ–∂–Ω–æ, –µ–≥–æ –∏—Å–ø–æ–ª—å–∑—É–µ—Ç –¥—Ä—É–≥–∞—è –ø—Ä–æ–≥—Ä–∞–º–º–∞.";
  }
  if (error.name === "AbortError") {
    return "–û–ø–µ—Ä–∞—Ü–∏—è –±—ã–ª–∞ –ø—Ä–µ—Ä–≤–∞–Ω–∞. –ü–æ–ø—Ä–æ–±—É–π—Ç–µ –µ—â—ë —Ä–∞–∑.";
  }

  return error.message || String(error);
}

function resetTranscriptPlaceholders() {
  sourceText = "";
  translatedText = "";
  sourceTranscript.textContent = "–†—É—Å—Å–∫–∞—è —Ä–µ—á—å –ø–æ—è–≤–∏—Ç—Å—è –∑–¥–µ—Å—å‚Ä¶";
  translatedTranscript.textContent = "English subtitles will appear here‚Ä¶";
}

function assertBrowserEnvironment() {
  if (location.protocol === "file:") {
    throw new Error(
      "–ü—Ä–∏–ª–æ–∂–µ–Ω–∏–µ –æ—Ç–∫—Ä—ã—Ç–æ –∫–∞–∫ —Ñ–∞–π–ª. –ó–∞–ø—É—Å—Ç–∏—Ç–µ `npm run dev` –∏ –æ—Ç–∫—Ä–æ–π—Ç–µ http://localhost:3000 ‚Äî –Ω–∞–ø—Ä—è–º—É—é index.html –ø–µ—Ä–µ–≤–æ–¥ —Ä–∞–±–æ—Ç–∞—Ç—å –Ω–µ –º–æ–∂–µ—Ç."
    );
  }

  if (!window.isSecureContext) {
    throw new Error(
      "–ë—Ä–∞—É–∑–µ—Ä —Ä–∞–∑—Ä–µ—à–∞–µ—Ç –º–∏–∫—Ä–æ—Ñ–æ–Ω —Ç–æ–ª—å–∫–æ –≤ –±–µ–∑–æ–ø–∞—Å–Ω–æ–º –∫–æ–Ω—Ç–µ–∫—Å—Ç–µ. –ò—Å–ø–æ–ª—å–∑—É–π—Ç–µ http://localhost:3000 –∏–ª–∏ HTTPS."
    );
  }

  if (!navigator.mediaDevices) {
    throw new Error(
      "–í —ç—Ç–æ–º –±—Ä–∞—É–∑–µ—Ä–µ MediaDevices –Ω–µ–¥–æ—Å—Ç—É–ø–µ–Ω. –û—Ç–∫—Ä–æ–π—Ç–µ –ø—Ä–∏–ª–æ–∂–µ–Ω–∏–µ —á–µ—Ä–µ–∑ http://localhost:3000 –≤ Chrome –∏–ª–∏ Edge."
    );
  }

  if (!window.RTCPeerConnection) {
    throw new Error("–≠—Ç–æ—Ç –±—Ä–∞—É–∑–µ—Ä –Ω–µ –ø–æ–¥–¥–µ—Ä–∂–∏–≤–∞–µ—Ç WebRTC, –Ω–µ–æ–±—Ö–æ–¥–∏–º—ã–π –¥–ª—è –ø–µ—Ä–µ–≤–æ–¥–∞.");
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
      throw new Error("–õ–æ–∫–∞–ª—å–Ω—ã–π —Å–µ—Ä–≤–µ—Ä –Ω–µ –æ—Ç–≤–µ—Ç–∏–ª –∑–∞ 5 —Å–µ–∫—É–Ω–¥. –ü–µ—Ä–µ–∑–∞–ø—É—Å—Ç–∏—Ç–µ `npm run dev`.");
    }
    throw new Error(
      "–ù–µ —É–¥–∞–ª–æ—Å—å —Å–≤—è–∑–∞—Ç—å—Å—è —Å –ª–æ–∫–∞–ª—å–Ω—ã–º —Å–µ—Ä–≤–µ—Ä–æ–º. –ó–∞–ø—É—Å—Ç–∏—Ç–µ `npm install`, –∑–∞—Ç–µ–º `npm run dev`, –∏ –æ—Ç–∫—Ä–æ–π—Ç–µ http://localhost:3000."
    );
  }

  if (!response.ok) {
    throw new Error(`–õ–æ–∫–∞–ª—å–Ω—ã–π —Å–µ—Ä–≤–µ—Ä –≤–µ—Ä–Ω—É–ª HTTP ${response.status}. –ü–µ—Ä–µ–∑–∞–ø—É—Å—Ç–∏—Ç–µ npm run dev.`);
  }

  const payload = await response.json();
  if (!payload.configured) {
    throw new Error(
      "–ù–∞ —Å–µ—Ä–≤–µ—Ä–µ –Ω–µ –Ω–∞—Å—Ç—Ä–æ–µ–Ω OPENAI_API_KEY. –°–∫–æ–ø–∏—Ä—É–π—Ç–µ .env.example –≤ .env, –≤—Å—Ç–∞–≤—å—Ç–µ –∫–ª—é—á –∏ –ø–µ—Ä–µ–∑–∞–ø—É—Å—Ç–∏—Ç–µ `npm run dev`."
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
      reject(new Error("–ë—Ä–∞—É–∑–µ—Ä –Ω–µ —Å–º–æ–≥ –ø—Ä–æ—á–∏—Ç–∞—Ç—å –≤—ã–±—Ä–∞–Ω–Ω—ã–π –≤–∏–¥–µ–æ—Ñ–∞–π–ª."));
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`–ù–µ –¥–æ–∂–¥–∞–ª—Å—è —Å–æ–±—ã—Ç–∏—è ${eventName} –æ—Ç –≤–∏–¥–µ–æ—Ñ–∞–π–ª–∞.`));
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
      reject(new Error("–ù–µ —É–¥–∞–ª–æ—Å—å –ø–æ–ª—É—á–∏—Ç—å –∞—É–¥–∏–æ–¥–æ—Ä–æ–∂–∫—É –≤–∏–¥–µ–æ. –ü—Ä–æ–≤–µ—Ä—å—Ç–µ, —á—Ç–æ –≤ —Ñ–∞–π–ª–µ –¥–µ–π—Å—Ç–≤–∏—Ç–µ–ª—å–Ω–æ –µ—Å—Ç—å –∑–≤—É–∫."));
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

    if (mode === "mic") setStatus("–†–µ–∂–∏–º: –º–∏–∫—Ä–æ—Ñ–æ–Ω. –ù–∞–∂–º–∏—Ç–µ ¬´–ù–∞—á–∞—Ç—å –ø–µ—Ä–µ–≤–æ–¥¬ª.");
    if (mode === "screen") setStatus("–†–µ–∂–∏–º: –∑–≤—É–∫ –≤–∫–ª–∞–¥–∫–∏/—ç–∫—Ä–∞–Ω–∞. –ù–∞–∂–º–∏—Ç–µ ¬´–ù–∞—á–∞—Ç—å –ø–µ—Ä–µ–≤–æ–¥¬ª.");
    if (mode === "file") setStatus("–†–µ–∂–∏–º: –≤–∏–¥–µ–æ—Ñ–∞–π–ª. –í—ã–±–µ—Ä–∏—Ç–µ —Ñ–∞–π–ª –∏ –Ω–∞–∂–º–∏—Ç–µ ¬´–ù–∞—á–∞—Ç—å –ø–µ—Ä–µ–≤–æ–¥¬ª.");
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
    setStatus("–í—ã–±–µ—Ä–∏—Ç–µ –≤–∏–¥–µ–æ—Ñ–∞–π–ª.");
    return;
  }

  objectUrl = URL.createObjectURL(file);
  videoPreview.src = objectUrl;
  videoPreview.classList.add("has-file");
  videoPreview.load();
  setStatus(`–§–∞–π–ª –≤—ã–±—Ä–∞–Ω: ${file.name}. –ù–∞–∂–º–∏—Ç–µ ¬´–ù–∞—á–∞—Ç—å –ø–µ—Ä–µ–≤–æ–¥¬ª.`);
});

async function getSourceAudio() {
  if (mode === "mic") {
    setStatus("–ë—Ä–∞—É–∑–µ—Ä –¥–æ–ª–∂–µ–Ω –∑–∞–ø—Ä–æ—Å–∏—Ç—å –¥–æ—Å—Ç—É–ø –∫ –º–∏–∫—Ä–æ—Ñ–æ–Ω—É‚Ä¶");
    sourceStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true
      },
      video: false
    });

    const audioTrack = sourceStream.getAudioTracks()[0];
    if (!audioTrack) throw new Error("–ë—Ä–∞—É–∑–µ—Ä –Ω–µ –≤–µ—Ä–Ω—É–ª –∞—É–¥–∏–æ–¥–æ—Ä–æ–∂–∫—É –º–∏–∫—Ä–æ—Ñ–æ–Ω–∞.");
    setStatus(`–ú–∏–∫—Ä–æ—Ñ–æ–Ω –≤–∫–ª—é—á—ë–Ω: ${audioTrack.label || "audio input"}. –ü–æ–¥–∫–ª—é—á–∞—é –ø–µ—Ä–µ–≤–æ–¥‚Ä¶`);
    return sourceStream;
  }

  if (mode === "screen") {
    setStatus("–í—ã–±–µ—Ä–∏—Ç–µ –≤–∫–ª–∞–¥–∫—É/—ç–∫—Ä–∞–Ω –∏ –æ–±—è–∑–∞—Ç–µ–ª—å–Ω–æ –≤–∫–ª—é—á–∏—Ç—Ç–µ –ø–µ—Ä–µ–¥–∞—á—É –∑–≤—É–∫–‚Ä¶");
    displayStream = await navigator.mediaDevices.getDisplayMedia({
      video: true,
      audio: true
    });

    const audioTrack = displayStream.getAudioTracks()[0];
    if (!audioTrack) {
      displayStream.getTracks().forEach((track) => track.stop());
      displayStream = null;
      throw new Error(
        "–ó–≤—É–∫ –Ω–µ –ø–µ—Ä–µ–¥–∞—ë—Ç—Å—è. –ü—Ä–∏ –≤—ã–±–æ—Ä–µ –≤–∫–ª–∞–¥–∫–∏ –≤–∫–ª—é—á–∏—Ç–µ ¬´–ü–æ–¥–µ–ª–∏—Ç—å—Å—è –∞—É–¥–∏–æ¬ª / ¬´Share tab audio¬ª."
      );
    }

    const videoTrack = displayStream.getVideoTracks()[0];
    if (videoTrack) {
      videoTrack.addEventListener("ended", () => {
        if (pc) stopTranslation();
      }, { once: true });
    }

    sourceStream = new MediaStream([audioTrack]);
    setStatus("–ó–≤—É–∫ –≤–∫–ª–∞–¥–∫–∏ –ø–æ–ª—É—á–µ–Ω. –ü–æ–¥–∫–ª—é—á–∞—é –ø–µ—Ä–µ–≤–æ–¥‚Ä¶");
    return sourceStream;
  }

  if (mode === "file") {
    if (!videoFile.files?.[0]) {
      throw new Error("–°–Ω–∞—á–∞–ª–∞ –≤—ã–±–µ—Ä–∏—Ç–µ –≤–∏–¥–µ–æ—Ñ–∞–π–ª.");
    }

    if (videoPreview.readyState < HTMLMediaElement.HAVE_METADATA_) {
      setStatus("–ß–∏—Ç–∞—é –≤–∏–¥–µ–æ—Ñ–∞–π–∑‚Ä¶");
      await waitForEvent(videoPreview, "loadedmetadata");
    }

    const capture = videoPreview.captureStream?.bind(videoPreview)
      || videoPreview.mozCaptureStream?.bind(videoPreview);

    if (!capture) {
      throw new Error(
        "–≠—Ç–æ—Ç –±—Ä–∞—É–∑–µ—Ä –Ω–µ —É–º–µ–µ—Ç –∑–∞—Ö–≤–∞—Ç—ã–≤–∞—Ç—å –∑–≤—É–∫ –ø–æ–∫–∞–ª—å–Ω–æ–≥–æ –≤–∏–¥–µ–æ. –ò—Å–ø–æ–ª—å–∑—É–π—Ç–µ Chrome/Edge –∏–ª–∏ —Ä–µ–∂–∏–º ¬´–í–∏–¥–µ–æ / –≤–∫–ª–∞–¥–∫–∞¬ª."
      );
    }

    // Capture before play so Chromium can expose the media tracks as playback starts.
    fileCaptureStream = capture();

    try {
      await videoPreview.play();
    } catch (error) {
      throw new Error(`–ù–µ —É–¥–∞–ª–æ—Å—å –∑–∞–ø—É—Å—Ç–∏—Ç—å —Ç–∏–¥–µ–æ: ${friendlyError(error)}`);
    }

    const audioTrack = await waitForAudioTrack(fileCaptureStream);
    sourceStream = new MediaStream([audioTrack]);
    setStatus("–ê—É–¥–∏–æ–¥–æ—Ä–æ–∂–∫–∞ –≤–∏–¥–µ–æ –ø–æ–ª—É—á–µ–Ω–∞. –ü–æ–¥–∫–ª—é—á–∞—é –ø–µ—Ä–µ–≤–æ–∑‚Ä¶");
    return sourceStream;
  }

  throw new Error("–ù–µ–∏–∑–≤–µ—Å—Ç–Ω—ã–π –∏—Å—Ç–æ—á–Ω–∏–∫#B√FB”B„B¯∏à§Ï)Ù()ÖÕÂπåÅô’πç—•Ω∏Åç…ïÖ—ï±•ïπ—Mïç…ï–†§ÅÏ(ÄÅ±ï–Å…ïÕ¡ΩπÕîÏ((ÄÅ—…‰ÅÏ(ÄÄÄÅ…ïÕ¡ΩπÕîÄÙÅÖ›Ö•–Åôï—ç°]•—°Q•µïΩ’–†(ÄÄÄÄÄÄàΩÖ¡§ΩÕïÕÕ•Ω∏à∞(ÄÄÄÄÄÅÏ(ÄÄÄÄÄÄÄÅµï—°ΩêËÄâA=MPà∞(ÄÄÄÄÄÄÄÅ°ïÖëï…ÃËÅÏÄâΩπ—ïπ–µQÂ¡îàËÄâÖ¡¡±•çÖ—•Ω∏Ω©ÕΩ∏àÅÙ∞(ÄÄÄÄÄÄÄÅâΩë‰ËÅ)M=8πÕ—…•πù•ô‰°ÏÅ—Ö…ùï—1Öπù’ÖùîËÄâï∏àÅÙ§(ÄÄÄÄÄÅÙ∞(ÄÄÄÄÄÄƒ‘¿¿¿(ÄÄÄÄ§Ï(ÄÅÙÅçÖ—ç†Ä°ï……Ω»§ÅÏ(ÄÄÄÅ•òÄ°ï……Ω»ππÖµîÄÙÙÙÄââΩ…—……Ω»à§ÅÏ(ÄÄÄÄÄÅ—°…Ω‹Åπï‹Å……Ω»†â=¡ïπ$ÅA$ÉB˜B‘ÉB˚FBÀB◊FB„BÏÉBﬂB¿Äƒ‘ÉFB◊BÎFB˜B–∏ÉBFB˚BÀB◊FF3FB‘ÉB„B˜FB◊FB˜B◊FÉB‡ÉBˇB˚BˇFB˚B«FBÁFB‘ÉFB˜B˚BÀB¿∏à§Ï(ÄÄÄÅÙ(ÄÄÄÅ—°…Ω‹Åπï‹Å……Ω»†£BwB‘ÉFB”B√BÔB˚FF0ÉFB˚BﬂB”B√FF0ÉFB◊FFB„F8ÉBˇB◊FB◊BÀB˚B”B¿ËÄëÌ…•ïπë±Â……Ω»°ï……Ω»•Ù§§ÏÄ(ÄÅÙ((ÄÅ±ï–Å¡ÖÂ±ΩÖêÏ(ÄÅ—…‰ÅÏ(ÄÄÄÅ¡ÖÂ±ΩÖêÄÙÅÖ›Ö•–Å…ïÕ¡ΩπÕîπ©ÕΩ∏†§Ï(ÄÅÙÅçÖ—ç†ÅÏ(ÄÄÄÅ—°…Ω‹Åπï‹Å……Ω»†£BáB◊FBÀB◊F ÉBÀB◊FB˜FBÏÉB˜B◊BÎB˚FFB◊BÎFB˜F/B‰ÉB˚FBÀB◊FÄ°!QQ@ÄëÌ…ïÕ¡ΩπÕîπÕ—Ö—’ÕÙ§∏§§Ï(ÄÅÙ((ÄÅ•òÄ†Ö…ïÕ¡ΩπÕîπΩ¨§ÅÏ(ÄÄÄÅ—°…Ω‹Åπï‹Å……Ω»°¡ÖÂ±ΩÖêπï……Ω»ÅÒÄ£BwB‘ÉFB”B√BÔB˚FF0ÉFB˚BﬂB”B√FF0ÉFB◊FFB„F8ÉBˇB◊FB◊BÀB˚B”B¿Ä°!QQ@ÄëÌ…ïÕ¡ΩπÕîπÕ—Ö—’ÕÙ§∏§§Ï(ÄÅÙ((ÄÅ•òÄ†Ö¡ÖÂ±ΩÖêπŸÖ±’î§ÅÏ(ÄÄÄÅ—°…Ω‹Åπï‹Å……Ω»†ãBáB◊FBÀB◊F ÉB˜B‘ÉBÀB◊FB˜FBÏÉBÀFB◊BÛB◊B˜B˜F/B‰ÉBÎBÔF;FÅIïÖ±—•µîÅA$∏à§Ï(ÄÅÙ((ÄÅ…ï—’…∏Å¡ÖÂ±ΩÖêπŸÖ±’îÏ)Ù()ô’πç—•Ω∏ÅΩπIïÖ±—•µïŸïπ–°ïŸïπ–§ÅÏ(ÄÅ•òÄ°ïŸïπ–π—Â¡îÄÙÙÙÄâÕïÕÕ•Ω∏πç…ïÖ—ïêà§ÅÏ(ÄÄÄÅÕï—M—Ö—’Ã†âIïÖ±—•µî∑FB◊FFB„F<ÉB◊FB˚BﬂB”B√B˜B¿∏ÉBGB”FÉFFFFBÎFF8ÉFB◊FF3äòà∞Äâ±•Ÿîà§Ï(ÄÅÙ((ÄÅ•òÄ°ïŸïπ–π—Â¡îÄÙÙÙÄâÕïÕÕ•Ω∏π•π¡’—}—…ÖπÕç…•¡–πëï±—Ñà§ÅÏ(ÄÄÄÅÕΩ’…çïQï·–Ä¨ÙÅïŸïπ–πëï±—ÑÅÒÄààÏ(ÄÄÄÅÕΩ’…çïQ…ÖπÕç…•¡–π—ï·—Ωπ—ïπ–ÄÙÅÕΩ’…çïQï·–ÅÒÄãBÉFFFBÎB√F<ÉFB◊FF0ÉBˇB˚F?BÀB„FFF<ÉBﬂB”B◊FF3äòàÏ(ÄÅÙ((ÄÅ•òÄ°ïŸïπ–π—Â¡îÄÙÙÙÄâÕïÕÕ•Ω∏πΩ’—¡’—}—…ÖπÕç…•¡–πëï±—Ñà§ÅÏ(ÄÄÄÅ—…ÖπÕ±Ö—ïëQï·–Ä¨ÙÅïŸïπ–πëï±—ÑÅÒÄààÏ(ÄÄÄÅ—…ÖπÕ±Ö—ïëQ…ÖπÕç…•¡–π—ï·—Ωπ—ïπ–ÄÙÅ—…ÖπÕ±Ö—ïëQï·–ÅÒÄâπù±•Õ†ÅÕ’â—•—±ïÃÅ›•±∞ÅÖ¡¡ïÖ»Å°ï…óäòàÏ(ÄÅÙ((ÄÅ•òÄ°ïŸïπ–π—Â¡îÄÙÙÙÄâï……Ω»à§ÅÏ(ÄÄÄÅçΩπÕΩ±îπï……Ω»†âIïÖ±—•µîÅï……Ω»à∞ÅïŸïπ–§Ï(ÄÄÄÅÕï—M—Ö—’Ã°ïŸïπ–πï……Ω»¸πµïÕÕÖùîÅÒÄãB{F#B„B«BÎB¿ÅIïÖ±—•µîÅA$à∞Äâï……Ω»à§Ï(ÄÅÙ)Ù()ÖÕÂπåÅô’πç—•Ω∏ÅçΩππïç—IïÖ±—•µî°Õ—…ïÖ¥∞Åç±•ïπ—Mïç…ï–§ÅÏ(ÄÅ¡åÄÙÅπï‹ÅIQAïï…Ωππïç—•Ω∏†§Ï(ÄÅçΩπÕ–ÅÖ’ë•ΩQ…Öç¨ÄÙÅÕ—…ïÖ¥πùï—’ë•ΩQ…Öç≠Ã†•l¡tÏ((ÄÅ•òÄ†ÖÖ’ë•ΩQ…Öç¨§ÅÏ(ÄÄÄÅ—°…Ω‹Åπï‹Å……Ω»†ãBwB◊FÉB√FB”B„B˚B”B˚FB˚B€BÎB‡ÉB”BÔF<ÉB˚FBˇFB√BÀBÎB‡ÉB»ÉBˇB◊FB◊BÀB˚B”FB„BË∏à§Ï(ÄÅÙ((ÄÅ¡åπÖëëQ…Öç¨°Ö’ë•ΩQ…Öç¨∞ÅÕ—…ïÖ¥§Ï((ÄÅ¡åπΩπ—…Öç¨ÄÙÄ°ÏÅÕ—…ïÖµÃ∞Å—…Öç¨ÅÙ§ÄÙ¯ÅÏ(ÄÄÄÅçΩπÕ–Å…ïµΩ—ïM—…ïÖ¥ÄÙÅÕ—…ïÖµÕl¡tÅÒÅπï‹Å5ïë•ÖM—…ïÖ¥°m—…Öç≠t§Ï(ÄÄÄÅ—…ÖπÕ±Ö—ïë’ë•ºπÕ…ç=â©ïç–ÄÙÅ…ïµΩ—ïM—…ïÖ¥Ï(ÄÄÄÅ—…ÖπÕ±Ö—ïë’ë•ºπ¡±Ö‰†§πçÖ—ç††°ï……Ω»§ÄÙ¯ÅÏ(ÄÄÄÄÄÅçΩπÕΩ±îπ›Ö…∏†âQ…ÖπÕ±Ö—ïêÅÖ’ë•ºÅÖ’—Ω¡±Ö‰Å›ÖÃÅâ±Ωç≠ïêà∞Åï……Ω»§Ï(ÄÄÄÄÄÅÕï—M—Ö—’Ã†(ÄÄÄÄÄÄÄÄãBB◊FB◊BÀB˚B–ÉBˇB˚B”BÎBÔF;FFGBÙ∞ÉB˜B¯ÉB«FB√FBﬂB◊F ÉBﬂB√B«BÔB˚BÎB„FB˚BÀB√BÏÉB√BÀFB˚BÛB√FB„FB◊FBÎB˚B‘ÉBÀB˚FBˇFB˚B„BﬂBÀB◊B”B◊B˜B„B‘ÉB√B˜BœBÔB„BÁFBÎB˚BœB¯ÉBﬂBÀFBÎB¿∏ÉBÉB√BﬂFB◊F#B„FB‘ÅÖ’—Ω¡±Ö‰ÉB”BÔF<Å±ΩçÖ±°ΩÕ–∏à∞(ÄÄÄÄÄÄÄÄâï……Ω»à(ÄÄÄÄÄÄ§Ï(ÄÄÄÅÙ§Ï(ÄÅÙÏ((ÄÅ¡åπΩπçΩππïç—•ΩπÕ—Ö—ïç°ÖπùîÄÙÄ†§ÄÙ¯ÅÏ(ÄÄÄÅ•òÄ†Ö¡å§Å…ï—’…∏Ï((ÄÄÄÅ•òÄ°¡åπçΩππïç—•ΩπM—Ö—îÄÙÙÙÄâçΩππïç—ïêà§ÅÏ(ÄÄÄÄÄÅÕï—M—Ö—’Ã†ãBB◊FB◊BÀB˚B–ÉB„B”FGFËÉFFFFBÎB„B‰ÉäHÉB√B˜BœBÔB„BÁFBÎB„B‰à∞Äâ±•Ÿîà§Ï(ÄÄÄÅÙÅï±ÕîÅ•òÄ°¡åπçΩππïç—•ΩπM—Ö—îÄÙÙÙÄâçΩππïç—•πúà§ÅÏ(ÄÄÄÄÄÅÕï—M—Ö—’Ã†ãBèFFB√B˜B√BÀBÔB„BÀB√F8Å]ïâIQ∑FB˚B◊B”B„B˜B◊B˜B„B◊äòà§Ï(ÄÄÄÅÙÅï±ÕîÅ•òÄ°lâôÖ•±ïêà∞Äâë•ÕçΩππïç—ïêâtπ•πç±’ëïÃ°¡åπçΩππïç—•ΩπM—Ö—î§§ÅÏ(ÄÄÄÄÄÅÕï—M—Ö—’Ã†ãBáB˚B◊B”B„B˜B◊B˜B„B‘ÉFÉBˇB◊FB◊BÀB˚B”FB„BÎB˚BÉBˇB˚FB◊FF?B˜B¯∏à∞Äâï……Ω»à§Ï(ÄÄÄÅÙ(ÄÅÙÏ((ÄÅ¡åπΩπ•çïçΩππïç—•ΩπÕ—Ö—ïç°ÖπùîÄÙÄ†§ÄÙ¯ÅÏ(ÄÄÄÅ•òÄ†Ö¡å§Å…ï—’…∏Ï(ÄÄÄÅçΩπÕΩ±îπ•πôº†â%ÅÕ—Ö—îËà∞Å¡åπ•çïΩππïç—•ΩπM—Ö—î§Ï(ÄÅÙÏ((ÄÅëÖ—Ö°Öππï∞ÄÙÅ¡åπç…ïÖ—ïÖ—Ö°Öππï∞†âΩÖ§µïŸïπ—Ãà§Ï(ÄÅëÖ—Ö°Öππï∞πΩπΩ¡ï∏ÄÙÄ†§ÄÙ¯ÅçΩπÕΩ±îπ•πôº†âIïÖ±—•µîÅïŸïπ–Åç°Öππï∞ÅΩ¡ïπïêà§Ï(ÄÅëÖ—Ö°Öππï∞πΩπï……Ω»ÄÙÄ°ïŸïπ–§ÄÙ¯ÅçΩπÕΩ±îπï……Ω»†âIïÖ±—•µîÅëÖ—ÑÅç°Öππï∞Åï……Ω»à∞ÅïŸïπ–§Ï(ÄÅëÖ—Ö°Öππï∞πΩπµïÕÕÖùîÄÙÄ°ÏÅëÖ—ÑÅÙ§ÄÙ¯ÅÏ(ÄÄÄÅ—…‰ÅÏ(ÄÄÄÄÄÅΩπIïÖ±—•µïŸïπ–°)M=8π¡Ö…Õî°ëÖ—Ñ§§Ï(ÄÄÄÅÙÅçÖ—ç†Ä°ï……Ω»§ÅÏ(ÄÄÄÄÄÅçΩπÕΩ±îπ›Ö…∏†â	ÖêÅ…ïÖ±—•µîÅïŸïπ–à∞Åï……Ω»∞ÅëÖ—Ñ§Ï(ÄÄÄÅÙ(ÄÅÙÏ((ÄÅçΩπÕ–ÅΩôôï»ÄÙÅÖ›Ö•–Å¡åπç…ïÖ—ï=ôôï»†§Ï(ÄÅÖ›Ö•–Å¡åπÕï—1ΩçÖ±ïÕç…•¡—•Ω∏°Ωôôï»§Ï((ÄÅÕï—M—Ö—’Ã†ãBB˚B”BÎBÔF;FB√F;FF0ÉBËÅ=¡ïπ$ÅIïÖ±—•µóäòà§Ï((ÄÅçΩπÕ–ÅÕë¡IïÕ¡ΩπÕîÄÙÅÖ›Ö•–Åôï—ç°]•—°Q•µïΩ’–†(ÄÄÄÄâ°——¡ÃËºΩÖ¡§πΩ¡ïπÖ§πçΩ¥ΩÿƒΩ…ïÖ±—•µîΩ—…ÖπÕ±Ö—•ΩπÃΩçÖ±±Ãà∞(ÄÄÄÅÏ(ÄÄÄÄÄÅµï—°ΩêËÄâA=MPà∞(ÄÄÄÄÄÅ°ïÖëï…ÃËÅÏ(ÄÄÄÄÄÄÄÅ’—°Ω…•ÈÖ—•Ω∏ËÅÅ	ïÖ…ï»ÄëÌç±•ïπ—Mïç…ï—ıÄ∞(ÄÄÄÄÄÄÄÄâΩπ—ïπ–µQÂ¡îàËÄâÖ¡¡±•çÖ—•Ω∏ΩÕë¿à(ÄÄÄÄÄÅÙ∞(ÄÄÄÄÄÅâΩë‰ËÅΩôôï»πÕë¿(ÄÄÄÅÙ∞(ÄÄÄÄ»¿¿¿¿(ÄÄ§Ï((ÄÅ•òÄ†ÖÕë¡IïÕ¡ΩπÕîπΩ¨§ÅÏ(ÄÄÄÅçΩπÕ–ÅµïÕÕÖùîÄÙÅÖ›Ö•–ÅÕë¡IïÕ¡ΩπÕîπ—ï·–†§Ï(ÄÄÄÅ—°…Ω‹Åπï‹Å……Ω»†°=¡ïπ$Å]ïâIQËÅ!QQ@ÄëÌÕë¡IïÕ¡ΩπÕîπÕ—Ö—’ÕÙ∏ÄëÌµïÕÕÖùïÙ§§Ï(ÄÅÙ((ÄÅçΩπÕ–ÅÖπÕ›ï…Më¿ÄÙÅÖ›Ö•–ÅÕë¡IïÕ¡ΩπÕîπ—ï·–†§Ï(ÄÅÖ›Ö•–Å¡åπÕï—IïµΩ—ïïÕç…•¡—•Ω∏°ÏÅ—Â¡îËÄâÖπÕ›ï»à∞ÅÕë¿ËÅÖπÕ›ï…Më¿ÅÙ§Ï)Ù()ÖÕÂπåÅô’πç—•Ω∏ÅÕ—Ö…—Q…ÖπÕ±Ö—•Ω∏†§ÅÏ(ÄÅ•òÄ°Õ—Ö…—•πúÅÒÅ¡å§Å…ï—’…∏Ï((ÄÅÕ—Ö…—•πúÄÙÅ—…’îÏ(ÄÅÕ—Ö…—	—∏πë•ÕÖâ±ïêÄÙÅ—…’îÏ(ÄÅÕ—Ω¡	—∏πë•ÕÖâ±ïêÄÙÅôÖ±ÕîÏ(ÄÅµΩëï	’——ΩπÃπôΩ…Öç††°â’——Ω∏§ÄÙ¯Ä°â’——Ω∏πë•ÕÖâ±ïêÄÙÅ—…’î§§Ï(ÄÅ…ïÕï—Q…ÖπÕç…•¡—A±Öçï°Ω±ëï…Ã†§Ï((ÄÅ—…‰ÅÏ(ÄÄÄÅÖÕÕï…—	…Ω›Õï…πŸ•…Ωπµïπ–†§Ï((ÄÄÄÄººÅÕ¨ÅôΩ»ΩçÖ¡—’…îÅÖ’ë•ºÅô•…Õ–∞Åë•…ïç—±‰Åô…Ω¥Å—°îÅ’Õï»ùÃÅâ’——Ω∏Åç±•ç¨∏(ÄÄÄÅçΩπÕ–ÅÕ—…ïÖ¥ÄÙÅÖ›Ö•–Åùï—MΩ’…çï’ë•º†§Ï((ÄÄÄÅÕï—M—Ö—’Ã†ãBFB˚BÀB◊FF?F8ÉBÔB˚BÎB√BÔF3B˜F/B‰ÉFB◊FBÀB◊F ÉB‡ÅA$∑BÎBÔF;Fäòà§Ï(ÄÄÄÅÖ›Ö•–Åç°ïç≠Mï…Ÿï»†§Ï((ÄÄÄÅÕï—M—Ö—’Ã†ãBáB˚BﬂB”B√F8ÉBﬂB√F'B„F'FGB˜B˜FF8ÉFB◊FFB„F8ÉBˇB◊FB◊BÀB˚B”B√äòà§Ï(ÄÄÄÅçΩπÕ–Åç±•ïπ—Mïç…ï–ÄÙÅÖ›Ö•–Åç…ïÖ—ï±•ïπ—Mïç…ï–†§Ï((ÄÄÄÅÖ›Ö•–ÅçΩππïç—IïÖ±—•µî°Õ—…ïÖ¥∞Åç±•ïπ—Mïç…ï–§Ï(ÄÅÙÅçÖ—ç†Ä°ï……Ω»§ÅÏ(ÄÄÄÅçΩπÕΩ±îπï……Ω»†âQ…ÖπÕ±Ö—•Ω∏ÅÕ—Ö…—’¿ÅôÖ•±ïêà∞Åï……Ω»§Ï(ÄÄÄÅÖ›Ö•–ÅÕ—Ω¡Q…ÖπÕ±Ö—•Ω∏°ÏÅ≠ïï¡M—Ö—’ÃËÅ—…’îÅÙ§Ï(ÄÄÄÅÕï—M—Ö—’Ã°ô…•ïπë±Â……Ω»°ï……Ω»§∞Äâï……Ω»à§Ï(ÄÅÙÅô•πÖ±±‰ÅÏ(ÄÄÄÅÕ—Ö…—•πúÄÙÅôÖ±ÕîÏ(ÄÄÄÅ•òÄ†Ö¡å§ÅÏ(ÄÄÄÄÄÅÕ—Ö…—	—∏πë•ÕÖâ±ïêÄÙÅôÖ±ÕîÏ(ÄÄÄÄÄÅÕ—Ω¡	—∏πë•ÕÖâ±ïêÄÙÅ—…’îÏ(ÄÄÄÄÄÅµΩëï	’——ΩπÃπôΩ…Öç††°â’——Ω∏§ÄÙ¯Ä°â’——Ω∏πë•ÕÖâ±ïêÄÙÅôÖ±Õî§§Ï(ÄÄÄÅÙ(ÄÅÙ)Ù( if (!pc) {
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

  if (!keepStatus) setStatus("–ü–µ—Ä–µ–≤–æ–¥ –æ—Å—Ç–∞–Ω–æ–≤–ª–µ–Ω.");
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
  setStatus("–ó–∞–ø—É—Å—Ç–∏—Ç–µ –ø—Ä–∏–ª–æ–∂–µ–Ω–∏–µ —á–µ—Ä–µ–∑ `npm run dev`, –∞ –Ω–µ –æ—Ç–∫—Ä—ã–≤–∞–π—Ç–µ index.html –Ω–∞–ø—Ä—è–º—É—é.", "error");
} else if (!window.isSecureContext || !navigator.mediaDevices) {
  setStatus("–ú–∏–∫—Ä–æ—Ñ–æ–Ω –Ω–µ–¥–æ—Å—Ç—É–ø–µ–Ω –≤ —Ç–µ–∫—É—â–µ–º –∫–æ–Ω—Ç–µ–∫—Å—Ç–µ. –ò—Å–ø–æ–ª—å–∑—É–π—Ç–µ http://localhost:3000 –∏–ª–∏ HTTPS.", "error");
} else {
  setStatus("–ò–Ω—Ç–µ—Ä—Ñ–µ–π—Å –∑–∞–≥—Ä—É–∂–µ–Ω. –í—ã–±–µ—Ä–∏—Ç–µ –∏—Å—Ç–æ—á–Ω–∏–∫ –∏ –Ω–∞–∂–º–∏—Ç–µ ¬´–ù–∞—á–∞—Ç—å –ø–µ—Ä–µ–≤–æ–¥¬ª.");
}
