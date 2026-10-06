import "dotenv/config";
import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";

const app = express();
const port = Number(process.env.PORT || 3000);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

app.use(express.json({ limit: "32kb" }));
app.use(express.static(path.join(__dirname, "public")));

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, model: "gpt-realtime-translate" });
});

app.post("/api/session", async (req, res) => {
  if (!process.env.OPENAI_API_KEY) {
    return res.status(500).json({ error: "OPENAI_API_KEY is not configured on the server." });
  }

  const targetLanguage = req.body?.targetLanguage || "en";
  if (targetLanguage !== "en") {
    return res.status(400).json({ error: "This MVP is configured for Russian → English translation only." });
  }

  try {
    const response = await fetch(
      "https://api.openai.com/v1/realtime/translations/client_secrets",
      {
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
              output: { language: "en" }
            }
          }
        })
      }
    );

    const body = await response.text();
    res.status(response.status).type("application/json").send(body);
  } catch (error) {
    console.error("Failed to create realtime translation session", error);
    res.status(502).json({ error: "Could not reach OpenAI Realtime API." });
  }
});

app.listen(port, () => {
  console.log(`RU → EN Live Translator: http://localhost:${port}`);
});
