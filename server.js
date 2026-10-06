import "dotenv/config";
import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";

const app = express();
const port = Number(process.env.PORT || 3000);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TRANSLATION_SECRET_URL =
  "https://api.openai.com/v1/realtime/translations/client_secrets";

app.disable("x-powered-by");
app.use(express.json({ limit: "32kb" }));
app.use(express.static(path.join(__dirname, "public")));

app.get("/api/health", (_req, res) => {
  res.set("Cache-Control", "no-store");
  res.json({
    ok: true,
    configured: Boolean(process.env.OPENAI_API_KEY),
    model: "gpt-realtime-translate"
  });
});

app.post("/api/session", async (req, res) => {
  res.set("Cache-Control", "no-store");

  if (!process.env.OPENAI_API_KEY) {
    return res.status(500).json({
      error:
        "OPENAI_API_KEY не настроен. Создайте .env из .env.example, вставьте API-ключ и перезапустите npm run dev."
    });
  }

  const targetLanguage = req.body?.targetLanguage || "en";
  if (targetLanguage !== "en") {
    return res.status(400).json({
      error: "Эта версия настроена только на перевод русский → английский."
    });
  }

  try {
    const response = await fetch(TRANSLATION_SECRET_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        session: {
          model: "gpt-realtime-translate",
          audio: {
            input: {
              transcription: { model: "gpt-realtime-whisper" }
            },
            output: {
              language: targetLanguage
            }
          }
        }
      })
    });

    const text = await response.text();
    let body;

    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }

    if (!response.ok) {
      const upstreamMessage =
        body?.error?.message ||
        body?.error ||
        text ||
        `OpenAI API returned HTTP ${response.status}`;

      console.error("OpenAI client secret error:", response.status, upstreamMessage);
      return res.status(response.status).json({
        error: `OpenAI API: ${upstreamMessage}`
      });
    }

    if (!body?.value) {
      console.error("OpenAI response did not contain client secret:", body);
      return res.status(502).json({
        error: "OpenAI API не вернул временный Realtime client secret."
      });
    }

    return res.json(body);
  } catch (error) {
    console.error("Failed to create realtime translation session", error);
    return res.status(502).json({
      error: `Не удалось связаться с OpenAI Realtime API: ${error.message}`
    });
  }
});

app.listen(port, () => {
  console.log(`RU → EN Live Translator: http://localhost:${port}`);
  if (!process.env.OPENAI_API_KEY) {
    console.warn("OPENAI_API_KEY is missing. Add it to .env and restart the server.");
  }
});
