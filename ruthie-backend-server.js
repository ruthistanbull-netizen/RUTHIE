const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = Number(process.env.PORT || 8787);
const DATA_DIR = process.env.RUTHIE_DATA_DIR || path.join(__dirname, "ruthie-data");
const OWNER_NAME = process.env.RUTHIE_OWNER_NAME || "Görkem Çirik";
const OWNER_SECRET = process.env.RUTHIE_OWNER_SECRET || "";
const OWNER_SECURITY_ANSWER = process.env.RUTHIE_OWNER_SECURITY_ANSWER || "enes";
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-5.5";
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
          message: "Fotoğrafı aldım ama görsel yorumlama bağlantısı bu sürümde kapalı. WhatsApp destek ekibimiz fotoğraf üzerinden hemen yardımcı olabilir."
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
        sendJson(res, { message: `${OWNER_NAME}, güvenlik için: En sevdiğiniz hayvan nedir?` });
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
      message: "Ruthie şu anda yanıtı netleştiremedi. WhatsApp destek ekibimiz hemen yardımcı olabilir."
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
      message: "Ruthie'nin AI bağlantısı açılmak üzere. Şimdilik WhatsApp destek ekibimiz size yardımcı olabilir."
    };
  }

  const history = conversationMemory.get(sessionId) || [];
  const historyText = history
    .map((turn) => `Müşteri: ${turn.user}\nRuthie: ${turn.assistant}`)
    .join("\n\n");
  const inputText = [
    `Müşteri adı: ${visitorName || "bilinmiyor"}`,
    `Sayfa: ${pageTitle || ""} ${pageUrl || ""}`.trim(),
    historyText ? `Son konuşma:\n${historyText}` : "",
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
  const messageText = cleaned || "Bu konu için sizi WhatsApp destek ekibimize yönlendirmem en doğrusu.";

  rememberTurn(sessionId, message, messageText);

  return {
    handoff,
    message: messageText.slice(0, 1200)
  };
}

function buildAssistantInstructions() {
  return [
    "Sen RUTH ISTANBUL mağazası için çalışan Ruthie adlı müşteri hizmetleri asistanısın.",
    "Türkçe konuş. Tonun sıcak, kısa, net ve butik takı markasına uygun zarif olsun.",
    "Müşteri ürün, sipariş, kargo, iade, değişim, beden/ölçü, stok ve bakım konularında soru sorabilir.",
    "Kesin bilmediğin fiyat, stok, sipariş durumu, kargo hareketi veya kişisel veri içeren konularda asla uydurma.",
    "Sipariş durumu sorulursa sipariş numarası ve siparişte kullanılan e-posta/telefon bilgisini iste; canlı mağaza paneli bağlı değilse net durum söyleme.",
    "Eğer cevap için mağaza paneli, gerçek stok, ödeme, kargo ekranı veya insan desteği gerekiyorsa cevabın başına WHATSAPP_YONLENDIR yaz.",
    "WHATSAPP_YONLENDIR kullanırsan sonrasında müşteriye neden WhatsApp desteğe yönlendirdiğini tek cümleyle açıkla.",
    "Ürün önerilerinde nazik ve satış odaklı ol ama abartılı vaat verme.",
    "Bilgi bankasında olmayan bilgiyi kesinmiş gibi söyleme.",
    "",
    "RUTHIE BİLGİ BANKASI:",
    readKnowledge()
  ].join("\n");
}

function readKnowledge() {
  try {
    return fs.readFileSync(KNOWLEDGE_FILE, "utf8").slice(0, 12000);
  } catch (error) {
    return [
      "Marka: RUTH ISTANBUL",
      "Alan: handmade jewelry / takı",
      "WhatsApp destek: 908503469789",
      "Asistan emin olmadığı her konuda WhatsApp desteğe yönlendirir.",
      "Mağaza paneli ve canlı sipariş/ürün stok bağlantısı henüz eklenmedi."
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
  dayStats.people[safeEvent.sessionId] = visitorName || "Anonim ziyaretçi";
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
    `Bugün konuşan kişi: ${today.conversationCount}`,
    `Bugün konuşulan kişiler: ${Object.values(today.people || {}).join(", ") || "Henüz yok"}`,
    `Bugünkü mesaj: ${today.messageCount}`,
    `Bugünkü fotoğraf: ${today.imageCount || 0}`,
    `Toplam kayıtlı gün: ${report.totalDays}`,
    `Toplam görüşme: ${report.totalConversations}`,
    `Toplam mesaj: ${report.totalMessages}`,
    `Son görüşme zamanı: ${today.lastMessageAt || "Henüz yok"}`
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
    .replace(/ç/g, "c")
    .replace(/ğ/g, "g")
    .replace(/ı/g, "i")
    .replace(/ö/g, "o")
    .replace(/ş/g, "s")
    .replace(/ü/g, "u");
}

function createSessionId() {
  return `ruth_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}
