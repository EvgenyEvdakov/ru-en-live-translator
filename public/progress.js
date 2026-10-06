(() => {
  const startBtn = document.querySelector("#startBtn");
  const bar = document.querySelector("#processingProgressBar");
  const value = document.querySelector("#processingProgressValue");
  const text = document.querySelector("#processingProgressText");
  const percent = document.querySelector("#processingProgressPercent");

  if (!startBtn || !bar || !value || !text || !percent) return;

  let last = {
    mode: "mic",
    stage: "Ожидание запуска",
    received_seconds: 0,
    processed_seconds: 0,
    queue_seconds: 0,
    total_seconds: null,
    overall_percent: null,
    elapsed_seconds: 0,
  };

  const fmt = (seconds) => {
    const total = Math.max(0, Math.floor(Number(seconds) || 0));
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    return h > 0
      ? `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`
      : `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  };

  const render = () => {
    if (!startBtn.disabled) {
      bar.classList.remove("live");
      bar.style.width = "0%";
      value.textContent = "00:00";
      text.textContent = "Ожидание запуска";
      percent.textContent = "0%";
      return;
    }

    const received = Number(last.received_seconds) || 0;
    const processed = Number(last.processed_seconds) || 0;
    const queue = Math.max(0, Number(last.queue_seconds) || 0);
    const total = Number(last.total_seconds) || 0;

    bar.classList.remove("live");

    if (last.mode === "file" && total > 0) {
      const overall = Number(last.overall_percent);
      const ratio = Number.isFinite(overall)
        ? Math.max(0, Math.min(1, overall / 100))
        : Math.max(0, Math.min(1, processed / total));
      bar.style.width = `${(ratio * 100).toFixed(1)}%`;
      const elapsed = Number(last.elapsed_seconds) || 0;
      value.textContent = `${fmt(processed)} / ${fmt(total)} · прошло ${fmt(elapsed)}`;
      percent.textContent = `${Math.round(ratio * 100)}%`;
    } else if (received > 0) {
      const ratio = Math.max(0, Math.min(1, processed / received));
      bar.style.width = `${Math.max(2, ratio * 100).toFixed(1)}%`;
      value.textContent = `${fmt(processed)} / ${fmt(received)}`;
      percent.textContent = "LIVE";
    } else {
      bar.style.width = "";
      bar.classList.add("live");
      value.textContent = "00:00";
      percent.textContent = last.mode === "file" ? "0%" : "LIVE";
    }

    const queueText = queue > 0.05 ? ` · очередь ${queue.toFixed(1)} с` : "";
    text.textContent = `${last.stage || "Обработка"} · получено ${fmt(received)} · обработано ${fmt(processed)}${queueText}`;
  };

  window.addEventListener("translator-progress", (event) => {
    last = { ...last, ...(event.detail || {}) };
    render();
  });

  new MutationObserver(() => {
    if (!startBtn.disabled) {
      last = {
        mode: "mic",
        stage: "Ожидание запуска",
        received_seconds: 0,
        processed_seconds: 0,
        queue_seconds: 0,
        total_seconds: null,
        overall_percent: null,
        elapsed_seconds: 0,
      };
    }
    render();
  }).observe(startBtn, { attributes: true, attributeFilter: ["disabled"] });

  render();
})();