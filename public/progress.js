(() => {
  const startBtn = document.querySelector("#startBtn");
  const stopBtn = document.querySelector("#stopBtn");
  const video = document.querySelector("#videoPreview");
  const status = document.querySelector("#status");
  const bar = document.querySelector("#processingProgressBar");
  const value = document.querySelector("#processingProgressValue");
  const text = document.querySelector("#processingProgressText");
  const percent = document.querySelector("#processingProgressPercent");

  if (!startBtn || !stopBtn || !video || !bar || !value || !text || !percent) return;

  let startedAt = 0;
  let timer = null;

  const fmt = (seconds) => {
    const total = Math.max(0, Math.floor(Number(seconds) || 0));
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    return h > 0
      ? `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`
      : `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  };

  const currentMode = () => document.querySelector(".mode.active")?.dataset.mode || "mic";

  const reset = () => {
    if (timer) clearInterval(timer);
    timer = null;
    startedAt = 0;
    bar.classList.remove("live");
    bar.style.width = "0%";
    value.textContent = "00:00";
    text.textContent = "Ожидание запуска";
    percent.textContent = "0%";
  };

  const update = () => {
    if (!startBtn.disabled) {
      reset();
      return;
    }

    const mode = currentMode();
    if (mode === "file" && Number.isFinite(video.duration) && video.duration > 0) {
      const current = Math.min(video.duration, Math.max(0, video.currentTime || 0));
      const ratio = current / video.duration;
      bar.classList.remove("live");
      bar.style.width = `${(ratio * 100).toFixed(1)}%`;
      value.textContent = `${fmt(current)} / ${fmt(video.duration)}`;
      text.textContent = "Обработка видео и его аудиодорожки";
      percent.textContent = `${Math.round(ratio * 100)}%`;
      return;
    }

    if (!startedAt) startedAt = performance.now();
    const elapsed = (performance.now() - startedAt) / 1000;
    bar.style.width = "";
    bar.classList.add("live");
    value.textContent = fmt(elapsed);
    text.textContent = mode === "screen"
      ? "Обработка звука вкладки / экрана"
      : "Обработка звука микрофона";
    percent.textContent = "LIVE";
  };

  const startTimer = () => {
    if (!startedAt) startedAt = performance.now();
    if (!timer) timer = setInterval(update, 200);
    update();
  };

  startBtn.addEventListener("click", () => setTimeout(() => {
    if (startBtn.disabled) startTimer();
  }, 0));

  stopBtn.addEventListener("click", () => setTimeout(update, 0));
  video.addEventListener("timeupdate", update);
  video.addEventListener("loadedmetadata", update);
  video.addEventListener("ended", update);

  new MutationObserver(() => {
    if (startBtn.disabled) startTimer();
    else reset();
  }).observe(startBtn, { attributes: true, attributeFilter: ["disabled"] });

  new MutationObserver(() => {
    if (startBtn.disabled) {
      text.title = status.textContent || "";
    }
  }).observe(status, { childList: true, characterData: true, subtree: true });

  reset();
})();