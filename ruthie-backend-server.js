const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = Number(process.env.PORT || 8787);
const DATA_DIR = process.env.RUTHIE_DATA_DIR || path.join(__dirname, "ruthie-data");
const OWNER_NAME = process.env.RUTHIE_OWNER_NAME || "Gorkem Cirik";
const OWNER_SECRET = process.env.RUTHIE_OWNER_SECRET || "";
const OWNER_SECURITY_ANSWER = process.env.RUTHIE_OWNER_SECURITY_ANSWER || "enes";
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-5.4-mini";
const KNOWLEDGE_FILE = process.env.RUTHIE_KNOWLEDGE_FILE || path.join(__dirname, "ruthie-bilgi-bankasi.txt");

const STATS_PATH = path.join(DATA_DIR, "daily-stats.json");
const EVENTS_PATH = path.join(DATA_DIR, "conversation-events.jsonl");
const ownerChallenges = new Set();
const conversationMemory = new Map();

fs.mkdirSync(DATA_DIR, { recursive: true });

const server = http.createServer(async (req, res) => {
  setCors(res);

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  try {
    if (req.method === "POST" && req.url === "/api/event") {
      const body = await readJson(req);
      if (body.type === "message_sent" || body.type === "image_attached") {
        recordEvent(body);
      }
      sendJson(res, { ok: true });
      return;
    }

    if (req.method === "POST" && req.url === "/api/chat") {
      if (!String(req.headers["content-type"] || "").includes("application/json")) {
        sendJson(res, {
          handoff: true,
          message: "Fotografi aldim ama gorsel yorumlama baglantisi bu surumde kapali. WhatsApp destek ekibimiz fotograf uzerinden hemen yardimci olabilir."
        });
        return;
      }

      const body = await readJson(req);
      const message = String(body.message || "").trim();
      const sessionId = String(body.sessionId || createSessionId());
      const visitorName = String(body.visitorName || body.customerName || "").trim();

      if (ownerChallenges.has(sessionId) && isOwnerSecurityAnswer(message)) {
        ownerChallenges.delete(sessionId);
        sendJson(res, { message: buildOwnerReport() });
        return;
      }

      if (isOwnerReportRequest(message)) {
        ownerChallenges.add(sessionId);
        sendJson(res, { message: `${OWNER_NAME}, guvenlik icin: En sevdiginiz hayvan nedir?` });
        return;
      }

      recordEvent({
        type: "message_sent",
        sessionId,
        visitorName,
        payload: { visitorName },
        pageUrl: body.pageUrl || "",
        pageTitle: body.pageTitle || "",
        createdAt: new Date().toISOString()
      });

      const reply = await answerWithOpenAI({
        message,
        sessionId,
        visitorName,
        pageUrl: body.pageUrl || "",
        pageTitle: body.pageTitle || ""
      });

      sendJson(res, reply);
      return;
    }

    if (req.method === "GET" && req.url.startsWith("/api/admin/report")) {
      const url = new URL(req.url, `http://${req.headers.host}`);
      const code = url.searchParams.get("code") || "";
      if (!OWNER_SECRET || code !== OWNER_SECRET) {
        sendJson(res, { ok: false, error: "unauthorized" }, 401);
        return;
      }

      sendJson(res, { ok: true, report: buildReportObject() });
      return;
    }

    sendJson(res, {
      ok: true,
      service: "Ruthie backend is running",
      assistantReady: Boolean(OPENAI_API_KEY),
      model: OPENAI_MODEL
    });
  } catch (error) {
    sendJson(res, {
      handoff: true,
      message: "Ruthie su anda yaniti netlestiremedi. WhatsApp destek ekibimiz hemen yardimci olabilir."
    }, 200);
  }
});

server.listen(PORT, () => {
  console.log(`Ruthie backend listening on http://localhost:${PORT}`);
});

function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function sendJson(res, payload, status = 200) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > 1_000_000) {
        reject(new Error("body_too_large"));
        req.destroy();
      }
    });
    req.on("end", () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });
}

async function answerWithOpenAI({ message, sessionId, visitorName, pageUrl, pageTitle }) {
  if (!OPENAI_API_KEY) {
    return {
      handoff: true,
      message: "Ruthie'nin AI baglantisi acilmak uzere. Simdilik WhatsApp destek ekibimiz size yardimci olabilir."
    };
  }

  const history = conversationMemory.get(sessionId) || [];
  const historyText = history
    .map((turn) => `Musteri: ${turn.user}\nRuthie: ${turn.assistant}`)
    .join("\n\n");
  const inputText = [
    `Musteri adi: ${visitorName || "bilinmiyor"}`,
    `Sayfa: ${pageTitle || ""} ${pageUrl || ""}`.trim(),
    historyText ? `Son konusma:\n${historyText}` : "",
    `Yeni mesaj: ${message || ""}`
  ].filter(Boolean).join("\n\n");

  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${OPENAI_API_KEY}`
    },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      reasoning: { effort: "low" },
      text: { verbosity: "low" },
      instructions: buildAssistantInstructions(),
      input: inputText
    })
  });

  if (!response.ok) {
    throw new Error(`openai_error_${response.status}`);
  }

  const data = await response.json();
  const rawText = extractOutputText(data).trim();
  const cleaned = rawText.replace(/^WHATSAPP_YONLENDIR\s*[:\-]?\s*/i, "").trim();
  const handoff = /^WHATSAPP_YONLENDIR/i.test(rawText);
  const messageText = cleaned || "Bu konu icin sizi WhatsApp destek ekibimize yonlendirmem en dogrusu.";

  rememberTurn(sessionId, message, messageText);

  return {
    handoff,
    message: messageText.slice(0, 1200)
  };
}

function buildAssistantInstructions() {
  return [
    "Sen RUTH ISTANBUL magazasi icin calisan Ruthie adli musteri hizmetleri asistanisin.",
    "Turkce konus. Tonun sicak, kisa, net ve butik taki markasina uygun zarif olsun.",
    "Musteri urun, siparis, kargo, iade, degisim, beden/olcu, stok ve bakim konularinda soru sorabilir.",
    "Kesin bilmedigin fiyat, stok, siparis durumu, kargo hareketi veya kisisel veri iceren konularda asla uydurma.",
    "Siparis durumu sorulursa siparis numarasi ve sipariste kullanilan e-posta/telefon bilgisini iste; canli magaza paneli bagli degilse net durum soyleme.",
    "Eger cevap icin magaza paneli, gercek stok, odeme, kargo ekrani veya insan destegi gerekiyorsa cevabin basina WHATSAPP_YONLENDIR yaz.",
    "WHATSAPP_YONLENDIR kullanirsan sonrasinda musteriye neden WhatsApp destegine yonlendirdigini tek cumleyle acikla.",
    "Urun onerilerinde nazik ve satis odakli ol ama abartili vaat verme.",
    "Bilgi bankasinda olmayan bilgiyi kesinmis gibi soyleme.",
    "",
    "RUTHIE BILGI BANKASI:",
    readKnowledge()
  ].join("\n");
}

function readKnowledge() {
  try {
    return fs.readFileSync(KNOWLEDGE_FILE, "utf8").slice(0, 12000);
  } catch (error) {
    return [
      "Marka: RUTH ISTANBUL",
      "Alan: handmade jewelry / taki",
      "WhatsApp destek: 908503469789",
      "Asistan emin olmadigi her konuda WhatsApp destegine yonlendirir.",
      "Magaza paneli ve canli siparis/urun stok baglantisi henuz eklenmedi."
    ].join("\n");
  }
}

function extractOutputText(data) {
  if (typeof data.output_text === "string") return data.output_text;
  const parts = [];
  for (const item of data.output || []) {
    for (const content of item.content || []) {
      if (typeof content.text === "string") parts.push(content.text);
    }
  }
  return parts.join("\n");
}

function rememberTurn(sessionId, userText, assistantText) {
  const history = conversationMemory.get(sessionId) || [];
  history.push({ user: userText || "", assistant: assistantText || "" });
  conversationMemory.set(sessionId, history.slice(-8));
}

function recordEvent(event) {
  const createdAt = event.createdAt || new Date().toISOString();
  const visitorName = event.visitorName || event.payload?.visitorName || "";
  const safeEvent = {
    type: event.type || "unknown",
    sessionId: event.sessionId || createSessionId(),
    visitorName,
    pageUrl: event.pageUrl || "",
    pageTitle: event.pageTitle || "",
    createdAt
  };

  fs.appendFileSync(EVENTS_PATH, `${JSON.stringify(safeEvent)}\n`, "utf8");

  const stats = readStats();
  const day = createdAt.slice(0, 10);
  stats.days[day] = stats.days[day] || {
    sessions: {},
    people: {},
    conversationCount: 0,
    messageCount: 0,
    imageCount: 0,
    lastMessageAt: ""
  };

  const dayStats = stats.days[day];
  if (!dayStats.sessions[safeEvent.sessionId]) {
    dayStats.sessions[safeEvent.sessionId] = true;
    dayStats.conversationCount += 1;
  }

  dayStats.people = dayStats.people || {};
  dayStats.people[safeEvent.sessionId] = visitorName || "Anonim ziyaretci";
  if (safeEvent.type === "message_sent") dayStats.messageCount += 1;
  if (safeEvent.type === "image_attached") dayStats.imageCount += 1;
  dayStats.lastMessageAt = createdAt;

  writeStats(stats);
}

function readStats() {
  try {
    return JSON.parse(fs.readFileSync(STATS_PATH, "utf8"));
  } catch (error) {
    return { days: {} };
  }
}

function writeStats(stats) {
  fs.writeFileSync(STATS_PATH, JSON.stringify(stats, null, 2), "utf8");
}

function buildOwnerReport() {
  const report = buildReportObject();
  const today = report.today;

  return [
    `${OWNER_NAME} patron raporu:`,
    `Bugun konusan kisi: ${today.conversationCount}`,
    `Bugun konusulan kisiler: ${Object.values(today.people || {}).join(", ") || "Henuz yok"}`,
    `Bugunku mesaj: ${today.messageCount}`,
    `Bugunku fotograf: ${today.imageCount || 0}`,
    `Toplam kayitli gun: ${report.totalDays}`,
    `Toplam gorusme: ${report.totalConversations}`,
    `Toplam mesaj: ${report.totalMessages}`,
    `Son gorusme zamani: ${today.lastMessageAt || "Henuz yok"}`
  ].join("\n");
}

function buildReportObject() {
  const stats = readStats();
  const todayKey = new Date().toISOString().slice(0, 10);
  const today = stats.days[todayKey] || {
    conversationCount: 0,
    messageCount: 0,
    imageCount: 0,
    lastMessageAt: "",
    people: {}
  };

  const days = Object.entries(stats.days || {}).map(([date, item]) => ({
    date,
    conversationCount: item.conversationCount || 0,
    messageCount: item.messageCount || 0,
    imageCount: item.imageCount || 0,
    people: Object.values(item.people || {}),
    lastMessageAt: item.lastMessageAt || ""
  }));

  return {
    today,
    days,
    totalDays: days.length,
    totalConversations: days.reduce((sum, item) => sum + item.conversationCount, 0),
    totalMessages: days.reduce((sum, item) => sum + item.messageCount, 0)
  };
}

function isOwnerReportRequest(message) {
  const text = normalize(message);
  const owner = normalize(OWNER_NAME);
  const mentionsOwner = owner && text.includes(owner);
  const mentionsBoss = /(patron|admin|yonetici|sahip|gorkem)/.test(text);
  const asksReport = /(rapor|veri|istatistik|kac kisi|konusan|musteri|bugun|gunluk|toplam)/.test(text);
  return asksReport && (mentionsOwner || mentionsBoss);
}

function isOwnerSecurityAnswer(message) {
  return normalize(message).trim() === normalize(OWNER_SECURITY_ANSWER);
}

function normalize(value) {
  return String(value || "")
    .toLocaleLowerCase("tr")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\u00e7/g, "c")
    .replace(/\u011f/g, "g")
    .replace(/\u0131/g, "i")
    .replace(/\u00f6/g, "o")
    .replace(/\u015f/g, "s")
    .replace(/\u00fc/g, "u");
}

function createSessionId() {
  return `ruth_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}
