const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = Number(process.env.PORT || 8787);
const DATA_DIR = process.env.RUTHIE_DATA_DIR || path.join(__dirname, "ruthie-data");
const OWNER_NAME = process.env.RUTHIE_OWNER_NAME || "Gorkem Cirik";
const OWNER_SECRET = process.env.RUTHIE_OWNER_SECRET || "";
const OWNER_SECURITY_ANSWER = process.env.RUTHIE_OWNER_SECURITY_ANSWER || "enes";
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";
const OPENAI_VISION_MODEL = process.env.OPENAI_VISION_MODEL || OPENAI_MODEL;
const MAX_IMAGE_UPLOAD_BYTES = Number(process.env.RUTHIE_MAX_IMAGE_UPLOAD_BYTES || 6_000_000);
const KNOWLEDGE_FILE = process.env.RUTHIE_KNOWLEDGE_FILE || path.join(__dirname, "ruthie-bilgi-bankasi.txt");
const IKAS_STORE_DOMAIN = process.env.IKAS_STORE_DOMAIN || "";
const IKAS_CLIENT_ID = process.env.IKAS_CLIENT_ID || "";
const IKAS_CLIENT_SECRET = process.env.IKAS_CLIENT_SECRET || "";
const IKAS_SITE_URL = process.env.IKAS_SITE_URL || "";

const STATS_PATH = path.join(DATA_DIR, "daily-stats.json");
const EVENTS_PATH = path.join(DATA_DIR, "conversation-events.jsonl");
const ownerChallenges = new Set();
const conversationMemory = new Map();
const recentImageSessions = new Map();
const lastProductSessions = new Map();
const pendingOrderSessions = new Set();
const pendingProductSessions = new Set();
let ikasTokenCache = { token: "", expiresAt: 0 };

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
      const contentType = String(req.headers["content-type"] || "");
      let body = {};
      let imageFile = null;

      if (contentType.includes("application/json")) {
        body = await readJson(req);
      } else if (contentType.includes("multipart/form-data")) {
        const multipart = await readMultipart(req);
        body = multipart.fields;
        imageFile = multipart.files.find((file) => file.fieldName === "image")
          || multipart.files.find((file) => /^image\//i.test(file.contentType));
      } else {
        sendJson(res, {
          handoff: true,
          message: "Mesajinizi alamadim. Lutfen tekrar yazar misiniz?"
        });
        return;
      }

      const message = String(body.message || "").trim();
      const sessionId = String(body.sessionId || createSessionId());
      const visitorName = String(body.visitorName || body.customerName || "").trim();

      if (ownerChallenges.has(sessionId) && isOwnerSecurityAnswer(message)) {
        ownerChallenges.delete(sessionId);
        sendJson(res, { message: buildOwnerReport() });
        return;
      }

      if (isOwnerIdentityRequest(message) || isOwnerReportRequest(message)) {
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

      if (imageFile) {
        const imageReply = await answerImageWithOpenAI({
          message,
          imageFile,
          sessionId,
          visitorName,
          pageUrl: body.pageUrl || "",
          pageTitle: body.pageTitle || ""
        });
        sendJson(res, imageReply);
        return;
      }

      const availabilityReply = answerAvailabilityQuestionIfNeeded(message, sessionId);
      if (availabilityReply) {
        sendJson(res, availabilityReply);
        return;
      }

      const panelReply = await answerFromIkasPanelIfPossible(message, {
        pageUrl: body.pageUrl || "",
        pageTitle: body.pageTitle || ""
      }, sessionId);
      if (panelReply) {
        sendJson(res, panelReply);
        return;
      }

      const productPanelReply = await answerProductFromIkasPanelIfPossible(message, {
        pageUrl: body.pageUrl || "",
        pageTitle: body.pageTitle || ""
      }, sessionId);
      if (productPanelReply) {
        sendJson(res, productPanelReply);
        return;
      }

      const liveContext = await buildIkasLiveContext(message, {
        pageUrl: body.pageUrl || "",
        pageTitle: body.pageTitle || ""
      });

      const reply = await answerWithOpenAI({
        message,
        sessionId,
        visitorName,
        pageUrl: body.pageUrl || "",
        pageTitle: body.pageTitle || "",
        liveContext
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

    if (req.method === "GET" && req.url.startsWith("/api/ikas/test")) {
      const url = new URL(req.url, `http://${req.headers.host}`);
      const code = url.searchParams.get("code") || "";
      if (!OWNER_SECRET || code !== OWNER_SECRET) {
        sendJson(res, { ok: false, error: "unauthorized" }, 401);
        return;
      }

      sendJson(res, await buildIkasTestReport(url.searchParams.get("orderNumber") || ""));
      return;
    }

    if (req.method === "GET") {
      const panelUrl = new URL(req.url, `http://${req.headers.host}`);

      if (panelUrl.pathname === "/" || panelUrl.pathname === "/panel" || panelUrl.pathname === "/admin") {
        sendHtml(res, buildPanelHtml());
        return;
      }

      if (panelUrl.pathname === "/manifest.webmanifest") {
        sendText(res, JSON.stringify(buildPanelManifest(), null, 2), "application/manifest+json; charset=utf-8");
        return;
      }

      if (panelUrl.pathname === "/favicon.svg" || panelUrl.pathname === "/apple-touch-icon.svg") {
        sendText(res, buildPanelIconSvg(), "image/svg+xml; charset=utf-8");
        return;
      }

      if (panelUrl.pathname === "/sw.js") {
        sendText(res, buildPanelServiceWorker(), "application/javascript; charset=utf-8");
        return;
      }
    }

    sendJson(res, {
      ok: true,
      service: "Ruthie backend is running",
      assistantReady: Boolean(OPENAI_API_KEY),
      ikasReady: isIkasConfigured(),
      model: OPENAI_MODEL,
      visionModel: OPENAI_VISION_MODEL
    });
  } catch (error) {
    console.error("Ruthie request error:", error && error.message ? error.message : error);
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

function sendHtml(res, html, status = 200) {
  res.writeHead(status, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store"
  });
  res.end(html);
}

function sendText(res, text, contentType = "text/plain; charset=utf-8", status = 200) {
  res.writeHead(status, {
    "Content-Type": contentType,
    "Cache-Control": contentType.includes("javascript") ? "no-cache" : "public, max-age=3600"
  });
  res.end(text);
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

function readRaw(req, limit = MAX_IMAGE_UPLOAD_BYTES + 500_000) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;

    req.on("data", (chunk) => {
      total += chunk.length;
      if (total > limit) {
        reject(new Error("body_too_large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

async function readMultipart(req) {
  const contentType = String(req.headers["content-type"] || "");
  const boundaryMatch = contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/i);
  const boundary = (boundaryMatch?.[1] || boundaryMatch?.[2] || "").trim();
  if (!boundary) throw new Error("multipart_boundary_missing");

  const body = await readRaw(req);
  const raw = body.toString("latin1");
  const parts = raw.split(`--${boundary}`).slice(1, -1);
  const fields = {};
  const files = [];

  for (let part of parts) {
    if (part.startsWith("\r\n")) part = part.slice(2);
    if (part.endsWith("\r\n")) part = part.slice(0, -2);
    if (part.endsWith("--")) part = part.slice(0, -2);

    const separator = part.indexOf("\r\n\r\n");
    if (separator === -1) continue;

    const headerText = part.slice(0, separator);
    let valueText = part.slice(separator + 4);
    if (valueText.endsWith("\r\n")) valueText = valueText.slice(0, -2);

    const headers = {};
    for (const line of headerText.split("\r\n")) {
      const index = line.indexOf(":");
      if (index === -1) continue;
      headers[line.slice(0, index).trim().toLowerCase()] = line.slice(index + 1).trim();
    }

    const disposition = headers["content-disposition"] || "";
    const name = disposition.match(/name="([^"]+)"/)?.[1] || "";
    const filename = disposition.match(/filename="([^"]*)"/)?.[1] || "";
    if (!name) continue;

    const buffer = Buffer.from(valueText, "latin1");
    if (filename) {
      files.push({
        fieldName: name,
        filename,
        contentType: headers["content-type"] || "application/octet-stream",
        buffer
      });
    } else {
      fields[name] = buffer.toString("utf8");
    }
  }

  return { fields, files };
}

async function answerWithOpenAI({ message, sessionId, visitorName, pageUrl, pageTitle, liveContext }) {
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
    liveContext ? `IKAS CANLI PANEL VERILERI:\n${liveContext}` : "",
    historyText ? `Son konusma:\n${historyText}` : "",
    `Yeni mesaj: ${message || ""}`
  ].filter(Boolean).join("\n\n");

  const requestBody = withModelSpecificOptions({
    model: OPENAI_MODEL,
    instructions: buildAssistantInstructions(),
    input: inputText
  }, OPENAI_MODEL);

  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${OPENAI_API_KEY}`
    },
    body: JSON.stringify(requestBody)
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => "");
    throw new Error(`openai_error_${response.status}: ${errorText.slice(0, 300)}`);
  }

  const data = await response.json();
  const rawText = extractOutputText(data).trim();
  const cleaned = rawText.replace(/^WHATSAPP_YONLENDIR\s*[:\-]?\s*/i, "").trim();
  const handoff = /^WHATSAPP_YONLENDIR/i.test(rawText);
  let messageText = sanitizeCustomerMessage(cleaned || "Bu konu icin sizi WhatsApp destek ekibimize yonlendirmem en dogrusu.");

  if (shouldBlockUnverifiedPrice(message, messageText, liveContext)) {
    messageText = "Panelde dogrulanmayan bir fiyat paylasamam. Urun adini ya da urun linkini yazarsaniz fiyat bilgisini panelden kontrol ederek yardimci olabilirim.";
  }

  rememberTurn(sessionId, message, messageText);

  return {
    handoff,
    message: messageText.slice(0, 1200)
  };
}

async function answerImageWithOpenAI({ message, imageFile, sessionId, visitorName, pageUrl, pageTitle }) {
  if (!OPENAI_API_KEY) {
    return {
      handoff: true,
      message: "Fotografi aldim. AI gorsel yorumu acilmak uzere; WhatsApp destek ekibimiz fotograf uzerinden hemen yardimci olabilir."
    };
  }

  if (!imageFile || !imageFile.buffer || imageFile.buffer.length === 0) {
    return { message: "Fotografi alamadim. Lutfen tekrar yukler misiniz?" };
  }

  if (imageFile.buffer.length > MAX_IMAGE_UPLOAD_BYTES) {
    return { message: "Fotograf biraz buyuk geldi. Daha dusuk boyutlu bir fotograf yukleyebilir misiniz?" };
  }

  if (!/^image\/(png|jpe?g|webp|gif)$/i.test(imageFile.contentType || "")) {
    return { message: "Bu dosya fotograf gibi gorunmuyor. PNG, JPG veya WEBP olarak tekrar gonderebilir misiniz?" };
  }

  const photoCatalogContext = await buildPhotoCatalogContext().catch(() => "");

  const prompt = [
    "Musterinin gonderdigi fotografi yorumla.",
    "RUTH ISTANBUL handmade taki markasi icin Ruthie adli musteri hizmetleri asistanisin.",
    "Turkce, sicak, kisa ve zarif cevap ver.",
    "Gorseldeki taki tarzi, renk, model benzerligi, kombin onerisi veya bakim sorusu icin yardimci ol.",
    "Gorseldeki urunu katalogdaki urunlerden biriyle guvenli sekilde eslestirebiliyorsan urun adini ve linkini ver.",
    "Sayfa URL'si urun sayfasi gibi gorunuyorsa link olarak o URL'yi de kullanabilirsin.",
    "Kesin urun eslestirmesi yapamiyorsan emin olmadigini soyle; link uydurma, urun adi ya da urun linki iste.",
    "Musteri 'var mi' diye sorsa bile urun uygunlugu, adet, kalan urun veya var/yok bilgisi verme.",
    "Musteriye hicbir durumda stok, adet, kalan urun veya var/yok bilgisi verme.",
    photoCatalogContext ? `IKAS KATALOG URUNLERI:\n${photoCatalogContext}` : "",
    "RUTHIE EGITIM METNI:",
    readKnowledge(),
    `Musteri adi: ${visitorName || "bilinmiyor"}`,
    `Sayfa: ${pageTitle || ""} ${pageUrl || ""}`.trim(),
    `Musteri mesaji: ${message || "Fotograf gonderdi."}`
  ].filter(Boolean).join("\n");

  try {
    const requestBody = withModelSpecificOptions({
      model: OPENAI_VISION_MODEL,
      input: [
        {
          role: "user",
          content: [
            { type: "input_text", text: prompt },
            {
              type: "input_image",
              image_url: `data:${imageFile.contentType};base64,${imageFile.buffer.toString("base64")}`
            }
          ]
        }
      ]
    }, OPENAI_VISION_MODEL);

    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${OPENAI_API_KEY}`
      },
      body: JSON.stringify(requestBody)
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => "");
      throw new Error(`openai_image_error_${response.status}: ${errorText.slice(0, 300)}`);
    }

    const data = await response.json();
    const messageText = sanitizeCustomerMessage(extractOutputText(data).trim() || "Fotoğrafı aldım. Bu ürün için ürün adını ya da linkini paylaşırsanız daha net yardımcı olabilirim.");
    rememberImageContext(sessionId, messageText);
    rememberTurn(sessionId, message || "[fotograf]", messageText);

    return { message: messageText.slice(0, 1200) };
  } catch (error) {
    console.error("OpenAI image analysis error:", error && error.message ? error.message : error);
    return {
      handoff: true,
      message: "Fotografi aldim fakat su an net yorumlayamadim. WhatsApp destek ekibimiz fotograf uzerinden hemen yardimci olabilir."
    };
  }
}

function buildAssistantInstructions() {
  return [
    "Sen RUTH ISTANBUL magazasi icin calisan Ruthie adli musteri hizmetleri asistanisin.",
    "Turkce konus. Tonun sicak, kisa, net ve butik taki markasina uygun zarif olsun.",
    "Musteri urun, siparis, kargo, iade, degisim, beden/olcu ve bakim konularinda soru sorabilir.",
    "Musterinin her mesajini once niyetine gore degerlendir: urun sorusu mu, siparis mi, iade/degisim mi, garanti/bakim mi, genel sohbet mi, yoksa onceki cevaba itiraz mi?",
    "Onceki urun konusmasini otomatik devam ettirme; musteri baska bir sey sorarsa o yeni soruya gore cevap ver.",
    "Genel sohbet ve basit sorularda dogal cevap ver; her seyi urun sorusu gibi algilama.",
    "Kesin bilmedigin fiyat, siparis durumu, kargo hareketi veya kisisel veri iceren konularda asla uydurma.",
    "Fiyati sadece musteri acikca fiyat, ne kadar, kac TL veya ucret diye sorarsa ve IKAS CANLI PANEL VERILERI icinde dogrulanmis fiyat varsa soyle.",
    "Musteri sadece urun adi yazarsa urunu buldugunu ve linkini soyle; kendiliginden fiyat yazma.",
    "Onceki konusmada gecen veya senin urettigin bir fiyati gercek kabul etme; panelde dogrulanmayan fiyatlari tekrar etme.",
    "Musteriye hicbir durumda stok, adet, kalan urun veya var/yok bilgisi verme; bu tip sorularda urun adi ya da urun linki iste.",
    "Siparis durumu sorulursa siparis numarasi ve sipariste kullanilan e-posta/telefon bilgisini iste; canli magaza paneli bagli degilse net durum soyleme.",
    "IKAS CANLI PANEL VERILERI basligi gelirse urun, fiyat ve siparis cevaplarinda bu verileri oncelikli kullan.",
    "IKAS verisinde olmayan fiyat, kargo takip veya siparis detayini uydurma.",
    "Eger cevap icin magaza paneli, odeme, kargo ekrani veya insan destegi gerekiyorsa cevabin basina WHATSAPP_YONLENDIR yaz.",
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
      "Magaza paneli ve canli siparis/urun baglantisi henuz eklenmedi."
    ].join("\n");
  }
}

function withModelSpecificOptions(body, model) {
  const normalized = String(model || "").toLowerCase();
  if (normalized.startsWith("gpt-5") || /^o\d/.test(normalized)) {
    return {
      ...body,
      reasoning: { effort: "low" },
      text: { verbosity: "low" }
    };
  }
  return body;
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

function rememberImageContext(sessionId, text) {
  recentImageSessions.set(sessionId, {
    text: String(text || "").slice(0, 800),
    createdAt: Date.now()
  });
}

function getRecentImageContext(sessionId) {
  const item = recentImageSessions.get(sessionId);
  if (!item) return null;
  if (Date.now() - item.createdAt > 30 * 60 * 1000) {
    recentImageSessions.delete(sessionId);
    return null;
  }
  return item;
}

function answerAvailabilityQuestionIfNeeded(message, sessionId) {
  const text = normalize(message);
  if (!isAvailabilityQuestion(message)) {
    return null;
  }

  const genericReference = /\b(bu|bunlar|su|foto|fotograf|gorsel|urunler|urun)\b/.test(text);
  const term = extractProductSearchTerm(message, {});
  const imageContext = getRecentImageContext(sessionId);
  const onlyGenericTerm = !term || /^(urun|urunler|varmi|var|bunlar|foto|fotograf|gorsel)(\s|$)/.test(term);

  if (genericReference || imageContext || onlyGenericTerm) {
    pendingProductSessions.add(sessionId);
    return {
      message: [
        imageContext ? "Fotoğraftaki ürünü/ürünleri gördüm." : "Hangi ürünü sorduğunuzu netleştireyim.",
        "Ürün uygunluğu veya kalan adet bilgisi paylaşamıyorum.",
        "Ürün adını ya da ürün linkini yazarsanız panelden ürün bilgilerini kontrol edip fiyat/link konusunda yardımcı olabilirim."
      ].join("\n")
    };
  }

  return null;
}

function isAvailabilityQuestion(message) {
  const text = normalize(message);
  return /(var\s*mi|varmi|var m[iı]|mevcut|bulunuyor|satis|satiliyor|satista|alabilir miyim|urunler var)/.test(text);
}

function sanitizeCustomerMessage(value) {
  return String(value || "")
    .replace(/^ruthie\s*[:\-]\s*/i, "")
    .replace(/\bstok[a-z]*/gi, "urun uygunlugu")
    .replace(/\bsto\u011f[a-z]*/gi, "urun uygunlugu")
    .replace(/\bstock[a-z]*/gi, "product availability")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function shouldBlockUnverifiedPrice(userMessage, assistantMessage, liveContext) {
  if (!containsPriceText(assistantMessage)) return false;
  if (!isPriceQuestion(userMessage)) return true;
  return !containsPriceText(liveContext);
}

function containsPriceText(value) {
  return /\b\d+(?:[.,]\d+)?\s*(?:tl|try|₺)\b/i.test(String(value || ""));
}

async function answerFromIkasPanelIfPossible(message, page, sessionId) {
  const orderNumber = extractOrderNumber(message);
  const contact = extractCustomerContact(message);
  const hasContact = Boolean(contact.email || contact.phone);
  const looksLikeOrderDetails = Boolean(orderNumber && hasContact);
  const shouldHandleOrder = isOrderStatusRequest(message) || pendingOrderSessions.has(sessionId) || looksLikeOrderDetails;

  if (!shouldHandleOrder) return null;

  if (!isIkasConfigured()) {
    return {
      handoff: true,
      message: "Siparis paneli baglantisi henuz hazir gorunmuyor. WhatsApp destek ekibimiz siparisinizi hemen kontrol edebilir."
    };
  }

  if (!orderNumber || !hasContact) {
    pendingOrderSessions.add(sessionId);
    return {
      message: "Siparisinizi kontrol edebilmem icin siparis numaranizi ve sipariste kullandiginiz e-posta ya da telefon bilgisini birlikte yazar misiniz?"
    };
  }

  try {
    const order = await findIkasOrder(orderNumber);
    if (!order) {
      pendingOrderSessions.add(sessionId);
      return {
        handoff: true,
        message: "Bu siparis numarasini panelde net bulamadim. Bilgilerinizi birlikte kontrol etmek icin sizi WhatsApp destegimize yonlendiriyorum."
      };
    }

    if (!doesContactMatchOrder(contact, order)) {
      pendingOrderSessions.add(sessionId);
      return {
        message: "Guvenlik icin sipariste kullanilan e-posta ya da telefon bilgisi eslesmedi. Lutfen siparis numarasi ile birlikte dogru e-posta/telefon bilgisini yazar misiniz?"
      };
    }

    pendingOrderSessions.delete(sessionId);
    return {
      message: formatOrderStatus(order)
    };
  } catch (error) {
    console.error("Ikas order lookup error:", error && error.message ? error.message : error);
    pendingOrderSessions.add(sessionId);
    return {
      handoff: true,
      message: "Siparis paneline su an ulasamadim. WhatsApp destek ekibimiz siparisinizi hemen kontrol edebilir."
    };
  }
}

async function answerProductFromIkasPanelIfPossible(message, page, sessionId) {
  const pendingProduct = pendingProductSessions.has(sessionId);
  const term = extractProductSearchTerm(message, page);
  const explicitProductRequest = isProductInfoRequest(message, page);
  const lastProduct = lastProductSessions.get(sessionId);

  if (!term && lastProduct && isProductFollowupRequest(message)) {
    pendingProductSessions.delete(sessionId);
    return {
      message: formatProductDetailAnswer(lastProduct, message)
    };
  }

  const shouldHandleProduct = explicitProductRequest || (pendingProduct && Boolean(term));
  if (!shouldHandleProduct) {
    if (pendingProduct) pendingProductSessions.delete(sessionId);
    return null;
  }

  if (!isIkasConfigured()) {
    return {
      handoff: true,
      message: "Urun paneli baglantisi henuz hazir gorunmuyor. WhatsApp destek ekibimiz urun bilgisini hemen kontrol edebilir."
    };
  }

  if (!term || isGenericProductRequest(message)) {
    pendingProductSessions.add(sessionId);
    return {
      message: "Hangi urunu sormak istiyorsunuz? Urun adini veya urun linkini yazarsaniz panelden kontrol edebilirim."
    };
  }

  try {
    const products = await findIkasProducts(term);
    if (!products.length) {
      pendingProductSessions.add(sessionId);
      return {
        message: "Panelde bu isimle net bir urun bulamadim. Urun adini biraz daha tam yazabilir veya urun linkini gonderebilir misiniz?"
      };
    }

    pendingProductSessions.delete(sessionId);
    if (products.length === 1) rememberLastProduct(sessionId, products[0]);
    return {
      message: formatProductAnswer(products, { includePrice: isPriceQuestion(message) })
    };
  } catch (error) {
    console.error("Ikas product lookup error:", error && error.message ? error.message : error);
    pendingProductSessions.add(sessionId);
    return {
      handoff: true,
      message: "Urun paneline su an ulasamadim. WhatsApp destek ekibimiz urun bilgisini hemen kontrol edebilir."
    };
  }
}

async function buildIkasLiveContext(message, page) {
  if (!isIkasConfigured() || !isProductInfoRequest(message, page)) return "";

  try {
    const products = await findIkasProducts(extractProductSearchTerm(message, page));
    if (!products.length) return "Panelde bu soruyla eslesen urun bulunamadi.";

    return products
      .map((product) => formatProductContext(product, { includePrice: isPriceQuestion(message) }))
      .join("\n---\n")
      .slice(0, 10000);
  } catch (error) {
    console.error("Ikas live product context error:", error && error.message ? error.message : error);
    return "Ikas panelinden urun bilgisi alinamadi; kesin fiyat bilgisi verme.";
  }
}

async function buildPhotoCatalogContext() {
  if (!isIkasConfigured()) return "";

  const products = await findIkasProducts("");
  return products
    .slice(0, 80)
    .map((product) => {
      const description = stripHtml(product.shortDescription || product.description || "").slice(0, 160);
      const link = buildProductUrl(product);
      return [
        `Urun: ${product.name}`,
        description ? `Aciklama: ${description}` : "",
        link ? `Link: ${link}` : ""
      ].filter(Boolean).join(" | ");
    })
    .join("\n")
    .slice(0, 12000);
}

async function buildIkasTestReport(orderNumber) {
  const report = {
    ok: false,
    ikasConfigured: isIkasConfigured(),
    tokenOk: false,
    productOk: false,
    productCount: 0,
    sampleProducts: [],
    orderOk: null,
    orderNumber: orderNumber || "",
    error: ""
  };

  try {
    await getIkasAccessToken();
    report.tokenOk = true;

    const products = await findIkasProducts("");
    report.productOk = true;
    report.productCount = products.length;
    report.sampleProducts = products.slice(0, 5).map((product) => ({
      name: product.name,
      price: getProductPriceText(product)
    }));

    if (orderNumber) {
      const order = await findIkasOrder(orderNumber);
      report.orderOk = Boolean(order);
      if (order) {
        report.order = {
          orderNumber: order.orderNumber,
          status: order.status,
          paymentStatus: order.orderPaymentStatus,
          packageStatus: order.orderPackageStatus
        };
      }
    }

    report.ok = report.ikasConfigured && report.tokenOk && report.productOk;
    return report;
  } catch (error) {
    report.error = error && error.message ? error.message : String(error);
    return report;
  }
}

function isIkasConfigured() {
  return Boolean(IKAS_STORE_DOMAIN && IKAS_CLIENT_ID && IKAS_CLIENT_SECRET);
}

async function getIkasAccessToken() {
  const now = Date.now();
  if (ikasTokenCache.token && ikasTokenCache.expiresAt > now + 60_000) {
    return ikasTokenCache.token;
  }

  const params = new URLSearchParams();
  params.set("grant_type", "client_credentials");
  params.set("client_id", IKAS_CLIENT_ID);
  params.set("client_secret", IKAS_CLIENT_SECRET);

  const response = await fetch(`https://${normalizeIkasStoreDomain(IKAS_STORE_DOMAIN)}/api/admin/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params
  });

  if (!response.ok) throw new Error(`ikas_token_${response.status}`);
  const data = await response.json();
  ikasTokenCache = {
    token: data.access_token,
    expiresAt: now + Math.max(60, Number(data.expires_in || 3600) - 120) * 1000
  };
  return ikasTokenCache.token;
}

async function ikasGraphql(query, variables = {}) {
  const token = await getIkasAccessToken();
  const response = await fetch("https://api.myikas.com/api/v1/admin/graphql", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`
    },
    body: JSON.stringify({ query, variables })
  });

  const data = await response.json();
  if (!response.ok || data.errors) {
    throw new Error(`ikas_graphql_${response.status}: ${JSON.stringify(data.errors || data).slice(0, 500)}`);
  }
  return data.data || {};
}

function normalizeIkasStoreDomain(value) {
  const raw = String(value || "").trim().replace(/^https?:\/\//i, "").replace(/\/.*$/, "");
  if (!raw) return "";
  return raw.includes(".") ? raw : `${raw}.myikas.com`;
}

async function findIkasProducts(term) {
  const productFields = `
    data {
      id
      name
      shortDescription
      description
      variants {
        id
        sku
        prices {
          sellPrice
          discountPrice
          currencyCode
          currencySymbol
        }
      }
    }
  `;
  const query = term ? `
    query RuthieProducts($term: String) {
      listProduct(name: { like: $term }, pagination: { limit: 200, page: 1 }, sort: "name") {
        ${productFields}
      }
    }
  ` : `
    query RuthieProducts {
      listProduct(pagination: { limit: 200, page: 1 }, sort: "name") {
        ${productFields}
      }
    }
  `;

  try {
    const data = await ikasGraphql(query, term ? { term } : {});
    const products = data.listProduct?.data || [];
    if (!term) return products;

    const ranked = rankProductMatches(products, term);
    if (ranked.length) return ranked;

    const fallbackData = await ikasGraphql(`
      query RuthieProductsAll {
        listProduct(pagination: { limit: 200, page: 1 }, sort: "name") {
          ${productFields}
        }
      }
    `);
    return rankProductMatches(fallbackData.listProduct?.data || [], term);
  } catch (error) {
    const fallbackQuery = `
      query RuthieProductsFallback {
        listProduct(pagination: { limit: 200, page: 1 }, sort: "name") {
          ${productFields}
        }
      }
    `;
    const data = await ikasGraphql(fallbackQuery);
    const products = data.listProduct?.data || [];
    return term ? rankProductMatches(products, term) : products;
  }
}

function rankProductMatches(products, term) {
  const search = normalizeProductSearch(term);
  if (!search) return products;

  const searchTokens = getProductSearchTokens(search);
  const scored = (products || [])
    .map((product) => {
      const name = normalizeProductSearch(product.name);
      const skuText = normalizeProductSearch((product.variants || []).map((variant) => variant.sku || "").join(" "));
      const description = normalizeProductSearch(`${product.shortDescription || ""} ${stripHtml(product.description || "")}`);
      const nameTokens = getProductSearchTokens(name);
      let score = 0;

      if (name === search) score = 120;
      else if (name.includes(search)) score = 105;
      else if (search.includes(name) && name.length >= 5) score = 95;
      else if (searchTokens.length && searchTokens.every((token) => nameTokens.includes(token))) score = 85 + searchTokens.length;
      else if (searchTokens.length >= 2 && searchTokens.every((token) => description.includes(token))) score = 45 + searchTokens.length;
      else if (searchTokens.length === 1 && (nameTokens.includes(searchTokens[0]) || skuText.includes(searchTokens[0]))) score = 35;
      else if (skuText && skuText.includes(search)) score = 90;

      return { product, score, name };
    })
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));

  return scored.slice(0, 12).map((item) => item.product);
}

function normalizeProductSearch(value) {
  return normalize(stripHtml(value))
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function getProductSearchTokens(value) {
  const ignored = new Set([
    "the", "and", "with", "for", "bir", "bu", "su", "urun", "urunler", "kolye", "yuzuk",
    "bileklik", "kupe", "necklace", "ring", "bracelet", "earring", "set", "model"
  ]);
  return normalizeProductSearch(value)
    .split(" ")
    .filter((token) => token.length > 2 && !ignored.has(token));
}

async function findIkasOrder(orderNumber) {
  const query = `
    query RuthieOrder($orderNumber: String!) {
      listOrder(orderNumber: { eq: $orderNumber }, pagination: { limit: 1, page: 1 }) {
        data {
          id
          orderNumber
          orderedAt
          status
          orderPackageStatus
          orderPaymentStatus
          totalFinalPrice
          currencyCode
          customer {
            email
            phone
            fullName
          }
          shippingAddress {
            phone
          }
          billingAddress {
            phone
          }
          orderLineItems {
            quantity
            status
            variant {
              name
              sku
            }
          }
          orderPackages {
            orderPackageNumber
            orderPackageFulfillStatus
            trackingInfo {
              cargoCompany
              trackingNumber
              trackingLink
            }
          }
        }
      }
    }
  `;

  const data = await ikasGraphql(query, { orderNumber });
  return data.listOrder?.data?.[0] || null;
}

function formatProductContext(product, options = {}) {
  const includePrice = Boolean(options.includePrice);
  const variants = (product.variants || []).slice(0, 6).map((variant) => {
    const price = variant.prices?.[0] || {};
    const sale = price.discountPrice && price.discountPrice < price.sellPrice
      ? `${price.discountPrice} ${price.currencySymbol || price.currencyCode || ""} indirimli`
      : "";
    return [
      `SKU: ${variant.sku || "yok"}`,
      includePrice ? `fiyat: ${price.sellPrice || "belirsiz"} ${price.currencySymbol || price.currencyCode || ""}` : "",
      includePrice ? sale : ""
    ].filter(Boolean).join(", ");
  }).join(" | ");

  const productUrl = buildProductUrl(product);
  return [
    `Urun: ${product.name}`,
    product.shortDescription ? `Kisa aciklama: ${stripHtml(product.shortDescription)}` : "",
    product.description ? `Aciklama: ${stripHtml(product.description).slice(0, 700)}` : "",
    variants ? `Varyantlar: ${variants}` : "",
    productUrl ? `Link: ${productUrl}` : ""
  ].filter(Boolean).join("\n");
}

function formatProductAnswer(products, options = {}) {
  const includePrice = Boolean(options.includePrice);
  const visible = products.slice(0, 5);

  if (visible.length === 1) {
    const product = visible[0];
    return [
      `${product.name} urununu panelde buldum.`,
      includePrice ? `Fiyat: ${getProductPriceText(product)}.` : "",
      buildProductUrl(product) ? `Urun linki: ${buildProductUrl(product)}` : "",
      includePrice ? "Bu urun hakkinda baska hangi bilgiyi merak ediyorsunuz?" : "Bu urun hakkinda fiyat, materyal, olcu veya kullanim gibi hangi bilgiyi merak ediyorsunuz?"
    ].filter(Boolean).join("\n");
  }

  return [
    "Panelde birden fazla eslesen urun buldum:",
    ...visible.map((product, index) => {
      const link = buildProductUrl(product);
      const price = includePrice ? ` - fiyat: ${getProductPriceText(product)}` : "";
      return `${index + 1}. ${product.name}${price}${link ? ` - link: ${link}` : ""}`;
    }),
    "Hangisini soruyorsunuz? Urun adini biraz daha net yazabilir veya urun linkini gonderebilirsiniz."
  ].join("\n");
}

function formatProductDetailAnswer(product, message) {
  const lines = [`${product.name} modeliyle ilgili devam edeyim.`];
  const description = stripHtml(`${product.shortDescription || ""} ${product.description || ""}`).trim();
  const material = getProductMaterialText(product);
  const link = buildProductUrl(product);

  if (isPriceQuestion(message)) {
    lines.push(`Fiyat: ${getProductPriceText(product)}.`);
  }

  if (isMaterialQuestion(message)) {
    lines.push(material || "Panel aciklamasinda bu urun icin net materyal bilgisi gorunmuyor. Urun linkinden ya da destek ekibimizden netlestirebiliriz.");
  } else if (description) {
    lines.push(`Panel aciklamasi: ${description.slice(0, 420)}${description.length > 420 ? "..." : ""}`);
    if (material) lines.push(material);
  } else if (material) {
    lines.push(material);
  } else {
    lines.push("Panelde bu urun icin detay aciklama sinirli gorunuyor. Isterseniz urun linki uzerinden birlikte netlestirebiliriz.");
  }

  if (link) lines.push(`Urun linki: ${link}`);
  return lines.filter(Boolean).join("\n");
}

function rememberLastProduct(sessionId, product) {
  if (!sessionId || !product) return;
  lastProductSessions.set(sessionId, product);
  if (lastProductSessions.size > 500) {
    const firstKey = lastProductSessions.keys().next().value;
    if (firstKey) lastProductSessions.delete(firstKey);
  }
}

function getProductMaterialText(product) {
  const text = normalize(stripHtml(`${product.shortDescription || ""} ${product.description || ""} ${product.name || ""}`));
  if (/(925|gumus|silver|sterling)/.test(text)) {
    return "Panel aciklamasinda gumus/925 ayar bilgisini goruyorum.";
  }
  if (/(pirinc|brass)/.test(text)) {
    return "Panel aciklamasinda pirinc materyal bilgisi goruyorum.";
  }
  if (/(kaplama|plated|gold plated|altin kaplama)/.test(text)) {
    return "Panel aciklamasinda kaplama bilgisi geciyor; kesin materyal icin urun sayfasi bilgisini esas almak gerekir.";
  }
  return "";
}

function getProductPriceText(product) {
  const prices = (product.variants || []).flatMap((variant) => variant.prices || []);
  const price = prices.find((item) => typeof item.sellPrice === "number") || prices[0];
  if (!price) return "belirsiz";
  const currency = price.currencySymbol || price.currencyCode || price.currency || "TL";
  if (price.discountPrice && price.discountPrice < price.sellPrice) {
    return `${price.discountPrice} ${currency} indirimli, normal ${price.sellPrice} ${currency}`;
  }
  return `${price.sellPrice} ${currency}`;
}

function buildProductUrl(product) {
  const site = String(IKAS_SITE_URL || "").trim().replace(/\/$/, "");
  if (!site || !product.name) return "";
  const slug = normalize(product.name)
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-");
  return slug ? `${site}/products/${slug}` : "";
}

function formatOrderStatus(order) {
  const items = (order.orderLineItems || [])
    .map((item) => `${item.variant?.name || "Ürün"} x ${item.quantity || 1}`)
    .slice(0, 4)
    .join(", ");
  const tracking = (order.orderPackages || [])
    .map((pack) => pack.trackingInfo)
    .filter(Boolean)
    .find((info) => info.trackingNumber || info.trackingLink || info.cargoCompany);

  return [
    `Siparişinizi buldum. Sipariş no: ${order.orderNumber}.`,
    `Sipariş durumu: ${humanizeOrderStatus(order.status, "order")}.`,
    `Ödeme durumu: ${humanizeOrderStatus(order.orderPaymentStatus, "payment")}.`,
    `Kargo/paket durumu: ${humanizeOrderStatus(order.orderPackageStatus, "package")}.`,
    items ? `Ürünler: ${items}.` : "",
    tracking?.cargoCompany ? `Kargo firması: ${tracking.cargoCompany}.` : "",
    tracking?.trackingNumber ? `Takip no: ${tracking.trackingNumber}.` : "",
    tracking?.trackingLink ? `Takip linki: ${tracking.trackingLink}` : ""
  ].filter(Boolean).join("\n");
}

function humanizeOrderStatus(status, type = "order") {
  const raw = String(status || "").trim().toUpperCase();
  if (!raw) return "Belirsiz";

  const common = {
    CREATED: "Oluşturuldu",
    OPEN: "Açık",
    CLOSED: "Kapalı",
    COMPLETED: "Tamamlandı",
    CANCELLED: "İptal edildi",
    CANCELED: "İptal edildi",
    PROCESSING: "İşlemde",
    PENDING: "Beklemede",
    APPROVED: "Onaylandı",
    REJECTED: "Reddedildi"
  };

  const byType = {
    payment: {
      PAID: "Ödendi",
      UNPAID: "Ödeme bekliyor",
      PARTIALLY_PAID: "Kısmen ödendi",
      REFUNDED: "İade edildi",
      PARTIALLY_REFUNDED: "Kısmen iade edildi",
      WAITING_PAYMENT: "Ödeme bekliyor",
      AWAITING_PAYMENT: "Ödeme bekliyor",
      FAILED: "Ödeme başarısız",
      AUTHORIZED: "Ödeme onaylandı"
    },
    package: {
      DELIVERED: "Teslim edildi",
      SHIPPED: "Kargoya verildi",
      FULFILLED: "Hazırlandı",
      UNFULFILLED: "Hazırlanıyor",
      PARTIALLY_FULFILLED: "Kısmen hazırlandı",
      READY_FOR_SHIPMENT: "Kargoya hazır",
      READY_TO_SHIP: "Kargoya hazır",
      IN_TRANSIT: "Yolda",
      OUT_FOR_DELIVERY: "Dağıtıma çıktı",
      RETURNED: "İade edildi"
    },
    order: {
      CREATED: "Oluşturuldu",
      FULFILLED: "Hazırlandı",
      UNFULFILLED: "Hazırlanıyor",
      PARTIALLY_FULFILLED: "Kısmen hazırlandı",
      REFUNDED: "İade edildi"
    }
  };

  return byType[type]?.[raw] || common[raw] || "Kontrol ediliyor";
}

function doesContactMatchOrder(contact, order) {
  const email = String(contact.email || "").toLowerCase();
  const phone = digitsOnly(contact.phone || "");
  const orderEmails = [order.customer?.email].filter(Boolean).map((value) => String(value).toLowerCase());
  const orderPhones = [order.customer?.phone, order.shippingAddress?.phone, order.billingAddress?.phone]
    .filter(Boolean)
    .map(digitsOnly);

  if (email && orderEmails.includes(email)) return true;
  if (phone.length >= 7 && orderPhones.some((value) => value.endsWith(phone.slice(-7)))) return true;
  return false;
}

function isOrderStatusRequest(message) {
  return /(siparis|kargo|takip|nerede|durum|order)/.test(normalize(message));
}

function isProductInfoRequest(message, page) {
  const text = normalize(message);
  const pageUrl = normalize(page?.pageUrl || "");
  const asksAboutCurrentProduct = /\/products\//.test(pageUrl)
    && /(bu|bunun|buradaki|sayfadaki|model|urun|fiyat|ne kadar|kac tl|materyal|malzeme|gumus|kaplama|ozellik|olcu|beden|link|garanti|bakim)/.test(text);

  return /\/products\//.test(text)
    || /(urun|kolye|bileklik|yuzuk|kupe|fiyat|ucret|ne kadar|kac tl|kaç tl|beden|olcu|materyal|malzeme|gumus|kaplama|ozellik|link|necklace|ring|bracelet|earring)/.test(text)
    || asksAboutCurrentProduct;
}

function isPriceQuestion(message) {
  const text = normalize(message);
  return /(fiyat|ucret|tutar|ne kadar|kac tl|kaç tl|\btl\b|₺|try)/.test(text);
}

function isMaterialQuestion(message) {
  const text = normalize(message);
  return /(gumus|silver|925|pirinc|brass|materyal|malzeme|kaplama|altin kaplama|celik|kararir|kararma|solar|solma)/.test(text);
}

function isProductFollowupRequest(message) {
  const text = normalize(message);
  return isPriceQuestion(message)
    || isMaterialQuestion(message)
    || /(ozellik|detay|olcu|beden|rengi|renk|tas|zincir|uzunluk|agirlik|link|bakim|garanti|suya dayanir|su gecirir|kullanim|ayarlanabilir)/.test(text);
}

function isGenericProductRequest(message) {
  const text = normalize(message);
  return /bir urun hakkinda bilgi almak istiyorum|urun hakkinda bilgi|urun sorusu|urun bilgisi|urun bakmak/.test(text);
}

function extractOrderNumber(message) {
  const direct = normalize(message).match(/(?:siparis|order|no|numara|#)\D*(\d{3,10})/i);
  if (direct) return direct[1];
  const loose = String(message || "").match(/\b\d{4,8}\b/);
  return loose ? loose[0] : "";
}

function extractCustomerContact(message) {
  const text = String(message || "");
  const email = text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0] || "";
  const phone = text.match(/(?:\+?90|0)?[\s.-]*(?:5\d{2})[\s.-]*\d{3}[\s.-]*\d{2}[\s.-]*\d{2}/)?.[0] || "";
  return { email, phone };
}

function extractProductSearchTerm(message, page) {
  const productPath = String(message || "").match(/\/products\/([^?#\s]+)/i)?.[1] || "";
  const readablePath = productPath.replace(/[-_]+/g, " ");
  const source = `${readablePath} ${message || ""} ${page?.pageTitle || ""}`;
  const ignored = new Set([
    "urun", "urunler", "hakkinda", "bilgi", "stok", "fiyat", "var", "varmi", "mi", "mu",
    "nedir", "kac", "tl", "ruth", "istanbul", "kolye", "yuzuk", "bileklik", "kupe",
    "bir", "bu", "bunlar", "su", "foto", "fotograf", "gorsel", "mevcut", "satis", "satiliyor", "satista",
    "almak", "istiyorum", "soruyorum", "sorarim", "sorabilir", "hangi",
    "http", "https", "www", "com", "products", "product", "the", "and", "with", "for",
    "necklace", "ring", "bracelet", "earring", "jewelry", "jewellery", "model",
    "nasil", "nasıl", "neden", "evet", "hayir", "hayır", "tamam", "olur", "olmaz", "peki",
    "tesekkur", "tesekkurler", "saol", "sagol", "yardim", "yardimci"
  ]);
  const words = normalize(source)
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length > 2 && !ignored.has(word) && !/^\d+$/.test(word));
  return [...new Set(words)].slice(0, 5).join(" ");
}

function stripHtml(value) {
  return String(value || "")
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function digitsOnly(value) {
  return String(value || "").replace(/\D/g, "");
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
  const day = getIstanbulDateKey(createdAt);
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
    `${OWNER_NAME} patron raporu (${report.todayKey}):`,
    "Bu rapor bugun kaydedilen tum sohbetleri kapsar.",
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
  const todayKey = getIstanbulDateKey();
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
    todayKey,
    today,
    days,
    totalDays: days.length,
    totalConversations: days.reduce((sum, item) => sum + item.conversationCount, 0),
    totalMessages: days.reduce((sum, item) => sum + item.messageCount, 0)
  };
}

function getIstanbulDateKey(value) {
  const date = value ? new Date(value) : new Date();
  const parts = new Intl.DateTimeFormat("en", {
    timeZone: "Europe/Istanbul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(date);
  const map = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${map.year}-${map.month}-${map.day}`;
}

function isOwnerReportRequest(message) {
  const text = normalize(message);
  const owner = normalize(OWNER_NAME);
  const mentionsOwner = owner && text.includes(owner);
  const mentionsBoss = /(patron|admin|yonetici|sahip|gorkem)/.test(text);
  const asksReport = /(rapor|veri|istatistik|kac kisi|konusan|musteri|bugun|gunluk|toplam)/.test(text);
  return asksReport && (mentionsOwner || mentionsBoss);
}

function isOwnerIdentityRequest(message) {
  const text = normalize(message);
  return /(ben gorkem cirik|ben gorkem|gorkem cirik benim|gorkem cirik)/.test(text);
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


function buildPanelManifest() {
  return {
    name: "Ruthie Panel",
    short_name: "Ruthie",
    description: "Ruth Istanbul destek paneli",
    start_url: "/panel",
    scope: "/",
    display: "standalone",
    background_color: "#f6f0e7",
    theme_color: "#18130f",
    icons: [
      { src: "/favicon.svg", sizes: "192x192", type: "image/svg+xml" },
      { src: "/apple-touch-icon.svg", sizes: "512x512", type: "image/svg+xml" }
    ]
  };
}

function buildPanelIconSvg() {
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#f6efe3"/>
      <stop offset="0.55" stop-color="#d7bc91"/>
      <stop offset="1" stop-color="#17120f"/>
    </linearGradient>
  </defs>
  <rect width="512" height="512" rx="118" fill="url(#g)"/>
  <rect x="38" y="38" width="436" height="436" rx="92" fill="none" stroke="rgba(255,255,255,.46)" stroke-width="2"/>
  <text x="256" y="309" text-anchor="middle" font-family="Georgia, 'Times New Roman', serif" font-size="196" font-weight="500" fill="#15110e">R</text>
</svg>`;
}

function buildPanelServiceWorker() {
  return `const CACHE_NAME = 'ruthie-panel-v2';
const SHELL = ['/panel', '/favicon.svg', '/apple-touch-icon.svg'];
self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key !== CACHE_NAME).map(key => caches.delete(key)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (url.pathname.startsWith('/api/')) return;
  event.respondWith(fetch(event.request).catch(() => caches.match(event.request).then(response => response || caches.match('/panel'))));
});`;
}

function buildPanelHtml() {
  return `<!doctype html>
<html lang="tr">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
  <meta name="theme-color" content="#18130f" />
  <meta name="apple-mobile-web-app-capable" content="yes" />
  <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
  <meta name="apple-mobile-web-app-title" content="Ruthie" />
  <meta name="format-detection" content="telephone=no" />
  <link rel="manifest" href="/manifest.webmanifest" />
  <link rel="icon" href="/favicon.svg" type="image/svg+xml" />
  <link rel="apple-touch-icon" href="/apple-touch-icon.svg" />
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=Cinzel:wght@400;500;600;700&family=Montserrat:wght@300;400;500;600;700&display=swap" rel="stylesheet" />
  <title>Ruthie Panel</title>
  <style>
    :root {
      --ink: #18130f;
      --ink-2: #33291f;
      --paper: #f7f1e8;
      --paper-2: #efe4d4;
      --paper-3: #fffaf3;
      --gold: #b99663;
      --gold-2: #d8bd8e;
      --gold-3: #8b704b;
      --line: rgba(38, 29, 20, .12);
      --line-2: rgba(185, 150, 99, .35);
      --white-glass: rgba(255, 250, 243, .72);
      --black-glass: rgba(24, 19, 15, .76);
      --danger: #8a332b;
      --ok: #486f55;
      --shadow: 0 24px 70px rgba(45, 33, 21, .14);
      --shadow-soft: 0 16px 42px rgba(45, 33, 21, .10);
      --radius-xl: 34px;
      --radius-lg: 24px;
      --radius-md: 18px;
      --safe-top: env(safe-area-inset-top, 0px);
      --safe-bottom: env(safe-area-inset-bottom, 0px);
      color-scheme: light;
    }

    * { box-sizing: border-box; }
    html { min-height: 100%; background: var(--paper); -webkit-text-size-adjust: 100%; }
    body {
      min-height: 100vh;
      margin: 0;
      font-family: Montserrat, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      color: var(--ink);
      background:
        radial-gradient(circle at 12% 8%, rgba(216, 189, 142, .28), transparent 32vw),
        radial-gradient(circle at 88% 4%, rgba(185, 150, 99, .20), transparent 30vw),
        linear-gradient(135deg, #fbf6ee 0%, #efe3d2 48%, #f8f0e4 100%);
      overflow-x: hidden;
      overscroll-behavior: none;
      -webkit-tap-highlight-color: transparent;
    }

    body::before {
      content: "";
      position: fixed;
      inset: 0;
      pointer-events: none;
      opacity: .32;
      background-image:
        linear-gradient(rgba(24, 19, 15, .04) 1px, transparent 1px),
        linear-gradient(90deg, rgba(24, 19, 15, .04) 1px, transparent 1px);
      background-size: 48px 48px;
      mask-image: linear-gradient(to bottom, rgba(0,0,0,.7), transparent 78%);
      z-index: 0;
    }

    a { color: inherit; text-decoration: none; }
    button, input, textarea { font: inherit; }
    button { cursor: pointer; }

    .app-shell {
      position: relative;
      z-index: 1;
      min-height: 100vh;
      padding: calc(18px + var(--safe-top)) 18px calc(24px + var(--safe-bottom));
      display: grid;
      grid-template-columns: 290px minmax(0, 1fr);
      gap: 18px;
    }

    .sidebar {
      position: sticky;
      top: calc(18px + var(--safe-top));
      height: calc(100vh - 36px - var(--safe-top) - var(--safe-bottom));
      border: 1px solid rgba(255,255,255,.42);
      background: linear-gradient(180deg, rgba(24, 19, 15, .94), rgba(45, 34, 25, .88));
      color: #fff8ed;
      border-radius: var(--radius-xl);
      box-shadow: var(--shadow);
      overflow: hidden;
      isolation: isolate;
    }

    .sidebar::before {
      content: "";
      position: absolute;
      inset: -20%;
      background:
        radial-gradient(circle at 24% 8%, rgba(216, 189, 142, .28), transparent 28%),
        radial-gradient(circle at 70% 80%, rgba(255,255,255,.11), transparent 24%);
      z-index: -1;
      animation: glowDrift 12s ease-in-out infinite alternate;
    }

    .brand-card {
      padding: 28px 24px 20px;
      border-bottom: 1px solid rgba(255,255,255,.12);
    }

    .brand-row { display: flex; align-items: center; gap: 14px; }
    .brand-mark {
      width: 54px; height: 54px; border-radius: 20px;
      display: grid; place-items: center;
      background: linear-gradient(135deg, #f8efd7, #b99663 62%, #6f5432);
      color: #15100d;
      font-family: Cinzel, Georgia, serif;
      font-size: 30px;
      box-shadow: 0 15px 34px rgba(0,0,0,.28), inset 0 1px 0 rgba(255,255,255,.6);
      transform: translateZ(0);
    }

    .brand-kicker {
      margin: 0 0 4px;
      font-size: 10px;
      letter-spacing: .28em;
      text-transform: uppercase;
      color: rgba(255,248,237,.58);
    }

    .brand-title {
      margin: 0;
      font-family: Cinzel, Georgia, serif;
      font-size: 22px;
      font-weight: 500;
      letter-spacing: .05em;
    }

    .brand-subtitle {
      margin: 16px 0 0;
      max-width: 220px;
      color: rgba(255,248,237,.70);
      font-size: 12px;
      line-height: 1.75;
    }

    .nav {
      display: grid;
      gap: 8px;
      padding: 18px 14px;
    }

    .nav-button {
      width: 100%;
      border: 1px solid transparent;
      border-radius: 18px;
      padding: 14px 14px;
      color: rgba(255,248,237,.78);
      background: transparent;
      display: flex;
      align-items: center;
      gap: 12px;
      text-align: left;
      transition: transform .22s ease, background .22s ease, border-color .22s ease, color .22s ease;
      touch-action: manipulation;
    }

    .nav-button:active { transform: scale(.975); }
    .nav-button:hover,
    .nav-button.active {
      color: #fff9ef;
      background: rgba(255,255,255,.09);
      border-color: rgba(216,189,142,.25);
    }

    .nav-icon {
      width: 34px; height: 34px;
      border-radius: 13px;
      display: grid; place-items: center;
      background: rgba(255,255,255,.08);
      border: 1px solid rgba(255,255,255,.10);
      color: var(--gold-2);
      flex: 0 0 auto;
    }

    .nav-copy { display: grid; gap: 2px; }
    .nav-label { font-size: 13px; font-weight: 600; letter-spacing: .02em; }
    .nav-hint { font-size: 10px; color: rgba(255,248,237,.48); }

    .sidebar-footer {
      position: absolute;
      left: 14px; right: 14px; bottom: 14px;
      padding: 14px;
      border-radius: 22px;
      background: rgba(255,255,255,.07);
      border: 1px solid rgba(255,255,255,.10);
      color: rgba(255,248,237,.66);
      font-size: 11px;
      line-height: 1.55;
    }

    .main { min-width: 0; display: grid; gap: 18px; align-content: start; }

    .topbar {
      position: sticky;
      top: calc(18px + var(--safe-top));
      z-index: 10;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 14px;
      padding: 14px 16px;
      border-radius: 28px;
      background: rgba(255,250,243,.72);
      border: 1px solid rgba(255,255,255,.65);
      box-shadow: var(--shadow-soft);
      backdrop-filter: blur(20px);
      -webkit-backdrop-filter: blur(20px);
    }

    .mobile-menu-button { display: none; }
    .page-title { min-width: 0; }
    .page-title p {
      margin: 0 0 4px;
      font-size: 10px;
      letter-spacing: .24em;
      text-transform: uppercase;
      color: rgba(24,19,15,.52);
    }
    .page-title h1 {
      margin: 0;
      font-family: Cinzel, Georgia, serif;
      font-size: clamp(23px, 3vw, 42px);
      font-weight: 500;
      letter-spacing: .025em;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .top-actions { display: flex; align-items: center; gap: 10px; }

    .pill-button,
    .ghost-button,
    .icon-button {
      border: 1px solid rgba(24,19,15,.12);
      min-height: 44px;
      color: var(--ink);
      border-radius: 999px;
      background: rgba(255,255,255,.56);
      box-shadow: 0 10px 26px rgba(41,31,21,.08);
      transition: transform .2s ease, box-shadow .2s ease, border-color .2s ease, background .2s ease;
      touch-action: manipulation;
      user-select: none;
    }
    .pill-button { padding: 0 18px; font-size: 12px; font-weight: 600; letter-spacing: .04em; }
    .ghost-button { padding: 0 16px; font-size: 12px; font-weight: 600; background: transparent; }
    .icon-button { width: 44px; display: grid; place-items: center; }
    .pill-button:hover,
    .ghost-button:hover,
    .icon-button:hover { transform: translateY(-1px); border-color: var(--line-2); box-shadow: 0 14px 32px rgba(41,31,21,.12); }
    .pill-button:active,
    .ghost-button:active,
    .icon-button:active { transform: scale(.97); }
    .pill-button.primary {
      color: #fff8ed;
      border-color: rgba(24,19,15,.18);
      background: linear-gradient(135deg, #19130f, #3b2c1f 58%, #b99663 160%);
    }

    .view {
      display: none;
      animation: viewIn .46s cubic-bezier(.22,1,.36,1) both;
    }
    .view.active { display: block; }

    .hero-grid {
      display: grid;
      grid-template-columns: minmax(0, 1.2fr) minmax(270px, .8fr);
      gap: 18px;
      align-items: stretch;
    }

    .hero-card,
    .panel-card {
      border-radius: var(--radius-xl);
      background: rgba(255,250,243,.74);
      border: 1px solid rgba(255,255,255,.70);
      box-shadow: var(--shadow-soft);
      backdrop-filter: blur(18px);
      -webkit-backdrop-filter: blur(18px);
      overflow: hidden;
    }

    .hero-card {
      min-height: 310px;
      padding: clamp(24px, 4vw, 48px);
      position: relative;
      isolation: isolate;
    }
    .hero-card::before {
      content: "";
      position: absolute;
      inset: auto -18% -42% 30%;
      height: 290px;
      border-radius: 999px;
      background: radial-gradient(circle, rgba(185,150,99,.24), transparent 68%);
      z-index: -1;
      animation: floatGlow 8s ease-in-out infinite alternate;
    }

    .eyebrow {
      margin: 0 0 14px;
      font-size: 11px;
      letter-spacing: .28em;
      text-transform: uppercase;
      color: var(--gold-3);
      font-weight: 600;
    }
    .hero-card h2 {
      margin: 0;
      max-width: 670px;
      font-family: Cinzel, Georgia, serif;
      font-size: clamp(34px, 5vw, 72px);
      font-weight: 400;
      line-height: .98;
      letter-spacing: -.035em;
    }
    .hero-card h2 span { color: #9e7b4d; }
    .hero-copy {
      margin: 22px 0 0;
      max-width: 590px;
      color: rgba(24,19,15,.62);
      line-height: 1.85;
      font-size: 14px;
    }
    .hero-actions { margin-top: 28px; display: flex; flex-wrap: wrap; gap: 10px; }

    .status-card { padding: 22px; display: grid; gap: 14px; }
    .status-top { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
    .status-dot {
      width: 10px; height: 10px; border-radius: 999px; background: var(--ok);
      box-shadow: 0 0 0 7px rgba(72,111,85,.12);
      animation: pulse 2.2s ease-in-out infinite;
    }
    .mini-title { margin: 0; font-size: 12px; letter-spacing: .18em; text-transform: uppercase; color: rgba(24,19,15,.48); }
    .big-number { margin: 0; font-family: Cinzel, Georgia, serif; font-size: clamp(42px, 7vw, 82px); line-height: .9; font-weight: 400; }
    .muted { color: rgba(24,19,15,.56); }

    .stats-grid {
      display: grid;
      grid-template-columns: repeat(4, minmax(0, 1fr));
      gap: 14px;
      margin-top: 18px;
    }
    .stat-card {
      position: relative;
      min-height: 150px;
      padding: 20px;
      border-radius: 28px;
      background: rgba(255,250,243,.74);
      border: 1px solid rgba(255,255,255,.70);
      box-shadow: 0 14px 36px rgba(45,33,21,.08);
      overflow: hidden;
    }
    .stat-card::after {
      content: "";
      position: absolute;
      inset: auto -20px -50px auto;
      width: 120px; height: 120px; border-radius: 999px;
      background: rgba(185,150,99,.14);
    }
    .stat-card p { margin: 0; position: relative; z-index: 1; }
    .stat-label { font-size: 11px; letter-spacing: .15em; text-transform: uppercase; color: rgba(24,19,15,.48); }
    .stat-value { margin-top: 18px !important; font-family: Cinzel, Georgia, serif; font-size: 42px; line-height: 1; }
    .stat-note { margin-top: 10px !important; font-size: 11px; color: rgba(24,19,15,.52); line-height: 1.5; }

    .section-grid { display: grid; grid-template-columns: minmax(0, .95fr) minmax(290px, .55fr); gap: 18px; margin-top: 18px; }
    .panel-card { padding: 22px; }
    .card-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 14px; margin-bottom: 16px; }
    .card-head h3 { margin: 0; font-family: Cinzel, Georgia, serif; font-weight: 500; font-size: 23px; }
    .card-head p { margin: 5px 0 0; font-size: 12px; line-height: 1.6; color: rgba(24,19,15,.54); }

    .bar-chart { display: grid; gap: 12px; padding-top: 6px; }
    .bar-row { display: grid; grid-template-columns: 94px minmax(0, 1fr) 42px; gap: 10px; align-items: center; font-size: 12px; color: rgba(24,19,15,.60); }
    .bar-track { height: 12px; border-radius: 999px; background: rgba(24,19,15,.08); overflow: hidden; }
    .bar-fill { height: 100%; width: 0%; border-radius: inherit; background: linear-gradient(90deg, #18130f, #b99663); transition: width .7s cubic-bezier(.22,1,.36,1); }

    .person-list, .timeline-list { display: grid; gap: 10px; }
    .person-item, .timeline-item {
      padding: 14px;
      border-radius: 20px;
      background: rgba(255,255,255,.44);
      border: 1px solid rgba(24,19,15,.08);
      display: flex;
      align-items: center;
      gap: 12px;
      animation: itemIn .45s ease both;
    }
    .avatar {
      width: 38px; height: 38px; border-radius: 15px;
      display: grid; place-items: center;
      background: linear-gradient(135deg, #18130f, #b99663);
      color: #fff8ed;
      font-family: Cinzel, Georgia, serif;
      flex: 0 0 auto;
    }
    .item-copy { min-width: 0; }
    .item-copy strong { display: block; font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .item-copy span { display: block; margin-top: 3px; font-size: 11px; color: rgba(24,19,15,.52); }

    .form-grid { display: grid; gap: 12px; }
    .field { display: grid; gap: 7px; }
    .field label { font-size: 11px; letter-spacing: .12em; text-transform: uppercase; color: rgba(24,19,15,.55); font-weight: 600; }
    .field input, .field textarea, .field select {
      width: 100%;
      border: 1px solid rgba(24,19,15,.12);
      background: rgba(255,255,255,.62);
      color: var(--ink);
      border-radius: 18px;
      min-height: 48px;
      padding: 13px 15px;
      outline: none;
      font-size: 16px;
      transition: border-color .2s ease, box-shadow .2s ease, background .2s ease;
    }
    .field textarea { resize: vertical; min-height: 132px; line-height: 1.65; }
    .field input:focus, .field textarea:focus, .field select:focus {
      border-color: rgba(185,150,99,.56);
      box-shadow: 0 0 0 4px rgba(185,150,99,.13);
      background: rgba(255,255,255,.84);
    }

    .login-screen {
      position: fixed;
      inset: 0;
      z-index: 50;
      display: none;
      place-items: center;
      padding: calc(20px + var(--safe-top)) 18px calc(20px + var(--safe-bottom));
      background:
        radial-gradient(circle at 20% 10%, rgba(216,189,142,.32), transparent 35vw),
        linear-gradient(135deg, rgba(24,19,15,.88), rgba(67,48,32,.80));
      backdrop-filter: blur(10px);
      -webkit-backdrop-filter: blur(10px);
    }
    .login-screen.active { display: grid; }
    .login-card {
      width: min(480px, 100%);
      padding: 28px;
      border-radius: 34px;
      background: rgba(255,250,243,.92);
      border: 1px solid rgba(255,255,255,.68);
      box-shadow: 0 30px 90px rgba(0,0,0,.25);
      animation: viewIn .45s cubic-bezier(.22,1,.36,1) both;
    }
    .login-card h2 { margin: 14px 0 8px; font-family: Cinzel, Georgia, serif; font-weight: 500; font-size: 31px; }
    .login-card p { margin: 0 0 20px; color: rgba(24,19,15,.56); line-height: 1.7; font-size: 13px; }

    .chat-box { display: grid; gap: 14px; }
    .chat-window {
      min-height: 330px;
      max-height: 52vh;
      overflow: auto;
      padding: 14px;
      border-radius: 24px;
      background: rgba(255,255,255,.42);
      border: 1px solid rgba(24,19,15,.08);
    }
    .bubble { max-width: 84%; margin: 0 0 10px; padding: 12px 14px; border-radius: 20px; font-size: 13px; line-height: 1.65; white-space: pre-wrap; }
    .bubble.user { margin-left: auto; color: #fff8ed; background: linear-gradient(135deg, #18130f, #493624); border-bottom-right-radius: 7px; }
    .bubble.bot { background: rgba(255,255,255,.72); border: 1px solid rgba(24,19,15,.08); border-bottom-left-radius: 7px; }

    .settings-list { display: grid; gap: 12px; }
    .setting-row {
      display: grid;
      grid-template-columns: 1fr auto;
      gap: 12px;
      align-items: center;
      padding: 14px;
      border-radius: 20px;
      background: rgba(255,255,255,.42);
      border: 1px solid rgba(24,19,15,.08);
    }
    .code-chip {
      font-size: 11px;
      padding: 8px 10px;
      border-radius: 999px;
      background: rgba(24,19,15,.08);
      color: rgba(24,19,15,.68);
      white-space: nowrap;
    }

    .toast {
      position: fixed;
      right: 18px;
      bottom: calc(18px + var(--safe-bottom));
      z-index: 80;
      transform: translateY(18px);
      opacity: 0;
      pointer-events: none;
      padding: 13px 16px;
      border-radius: 18px;
      color: #fff8ed;
      background: rgba(24,19,15,.88);
      border: 1px solid rgba(255,255,255,.14);
      box-shadow: 0 18px 40px rgba(0,0,0,.22);
      transition: opacity .25s ease, transform .25s ease;
      font-size: 12px;
    }
    .toast.active { opacity: 1; transform: translateY(0); }

    .mobile-backdrop { display: none; }

    @keyframes viewIn { from { opacity: 0; transform: translateY(16px) scale(.985); } to { opacity: 1; transform: translateY(0) scale(1); } }
    @keyframes itemIn { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } }
    @keyframes pulse { 0%,100% { transform: scale(1); opacity: 1; } 50% { transform: scale(.82); opacity: .72; } }
    @keyframes glowDrift { from { transform: translate3d(-2%, -1%, 0) rotate(-2deg); } to { transform: translate3d(2%, 1%, 0) rotate(2deg); } }
    @keyframes floatGlow { from { transform: translateY(0); } to { transform: translateY(-22px); } }

    @media (max-width: 1120px) {
      .app-shell { grid-template-columns: 1fr; }
      .sidebar {
        position: fixed;
        z-index: 60;
        inset: calc(12px + var(--safe-top)) auto calc(12px + var(--safe-bottom)) 12px;
        width: min(320px, calc(100vw - 24px));
        height: auto;
        transform: translateX(calc(-100% - 22px));
        transition: transform .45s cubic-bezier(.22,1,.36,1);
      }
      .sidebar.open { transform: translateX(0); }
      .mobile-backdrop {
        position: fixed;
        inset: 0;
        z-index: 55;
        display: block;
        opacity: 0;
        pointer-events: none;
        background: rgba(24,19,15,.36);
        backdrop-filter: blur(4px);
        -webkit-backdrop-filter: blur(4px);
        transition: opacity .25s ease;
      }
      .mobile-backdrop.open { opacity: 1; pointer-events: auto; }
      .mobile-menu-button { display: grid; }
      .topbar { top: calc(10px + var(--safe-top)); }
    }

    @media (max-width: 820px) {
      .app-shell { padding: calc(10px + var(--safe-top)) 10px calc(16px + var(--safe-bottom)); gap: 12px; }
      .topbar { border-radius: 24px; padding: 10px; }
      .page-title p { display: none; }
      .page-title h1 { font-size: 22px; }
      .top-actions .ghost-button { display: none; }
      .hero-grid, .section-grid { grid-template-columns: 1fr; gap: 12px; }
      .stats-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; }
      .hero-card, .panel-card { border-radius: 26px; }
      .hero-card { min-height: auto; padding: 26px 22px; }
      .hero-card h2 { font-size: 38px; line-height: 1.05; }
      .hero-copy { font-size: 13px; }
      .stat-card { min-height: 124px; padding: 16px; border-radius: 23px; }
      .stat-value { font-size: 34px; }
      .bar-row { grid-template-columns: 78px minmax(0, 1fr) 34px; }
      .sidebar-footer { display: none; }
    }

    @media (max-width: 520px) {
      .top-actions { gap: 7px; }
      .pill-button { padding: 0 13px; }
      .stats-grid { grid-template-columns: 1fr 1fr; }
      .stat-card { min-height: 112px; }
      .status-card { min-height: 210px; }
      .setting-row { grid-template-columns: 1fr; }
      .code-chip { justify-self: start; }
    }
  </style>
</head>
<body>
  <div class="mobile-backdrop" id="mobileBackdrop"></div>
  <div class="app-shell">
    <aside class="sidebar" id="sidebar">
      <div class="brand-card">
        <div class="brand-row">
          <div class="brand-mark">R</div>
          <div>
            <p class="brand-kicker">Ruth Istanbul</p>
            <h2 class="brand-title">Ruthie</h2>
          </div>
        </div>
        <p class="brand-subtitle">Safari ana ekrana ve masaüstü kullanıma uygun, Ruth Istanbul temasında yönetim paneli.</p>
      </div>
      <nav class="nav" aria-label="Panel menüsü">
        <button class="nav-button active" data-view-button="dashboard"><span class="nav-icon">⌁</span><span class="nav-copy"><span class="nav-label">Genel Bakış</span><span class="nav-hint">Bugünkü durum</span></span></button>
        <button class="nav-button" data-view-button="reports"><span class="nav-icon">◌</span><span class="nav-copy"><span class="nav-label">Raporlar</span><span class="nav-hint">Günlük kayıtlar</span></span></button>
        <button class="nav-button" data-view-button="chat"><span class="nav-icon">✦</span><span class="nav-copy"><span class="nav-label">Sohbet Testi</span><span class="nav-hint">Ruthie yanıt kontrolü</span></span></button>
        <button class="nav-button" data-view-button="settings"><span class="nav-icon">◇</span><span class="nav-copy"><span class="nav-label">Ayarlar</span><span class="nav-hint">Endpoint ve PWA</span></span></button>
      </nav>
      <div class="sidebar-footer">Temel server ve API yapısı korunur. Bu panel sadece görünen arayüzü yeniler.</div>
    </aside>

    <main class="main">
      <header class="topbar">
        <button class="icon-button mobile-menu-button" id="menuButton" aria-label="Menüyü aç">☰</button>
        <div class="page-title">
          <p id="pageKicker">Ruthie Panel</p>
          <h1 id="pageTitle">Genel Bakış</h1>
        </div>
        <div class="top-actions">
          <button class="ghost-button" id="copyEndpointButton">Endpoint Kopyala</button>
          <button class="pill-button primary" id="refreshButton">Yenile</button>
        </div>
      </header>

      <section class="view active" id="view-dashboard">
        <div class="hero-grid">
          <div class="hero-card">
            <p class="eyebrow">Canlı destek asistanı</p>
            <h2>Ruthie paneli <span>yenilendi.</span></h2>
            <p class="hero-copy">Telefon ekranında uygulama gibi, bilgisayarda masaüstü panel gibi çalışacak şekilde Ruth Istanbul’un sade lüks görünümüne taşındı.</p>
            <div class="hero-actions">
              <button class="pill-button primary" data-view-button="chat">Sohbeti Test Et</button>
              <button class="pill-button" data-view-button="reports">Raporları Gör</button>
            </div>
          </div>
          <div class="panel-card status-card">
            <div class="status-top"><p class="mini-title">Bugünkü görüşme</p><span class="status-dot"></span></div>
            <p class="big-number" id="todayConversationCount">0</p>
            <p class="muted" id="todayStatusText">Veriler yükleniyor.</p>
          </div>
        </div>

        <div class="stats-grid">
          <div class="stat-card"><p class="stat-label">Bugünkü mesaj</p><p class="stat-value" id="todayMessageCount">0</p><p class="stat-note">Müşteri mesaj kayıtları</p></div>
          <div class="stat-card"><p class="stat-label">Bugünkü fotoğraf</p><p class="stat-value" id="todayImageCount">0</p><p class="stat-note">Eklenen görsel sayısı</p></div>
          <div class="stat-card"><p class="stat-label">Toplam görüşme</p><p class="stat-value" id="totalConversationCount">0</p><p class="stat-note">Kayıtlı tüm dönem</p></div>
          <div class="stat-card"><p class="stat-label">Toplam mesaj</p><p class="stat-value" id="totalMessageCount">0</p><p class="stat-note">Ruthie geçmişi</p></div>
        </div>

        <div class="section-grid">
          <div class="panel-card">
            <div class="card-head"><div><h3>Son günler</h3><p>Günlük görüşme yoğunluğu.</p></div></div>
            <div class="bar-chart" id="barChart"></div>
          </div>
          <div class="panel-card">
            <div class="card-head"><div><h3>Bugün konuşanlar</h3><p>İsim gelmediyse anonim görünür.</p></div></div>
            <div class="person-list" id="peopleList"></div>
          </div>
        </div>
      </section>

      <section class="view" id="view-reports">
        <div class="panel-card">
          <div class="card-head"><div><h3>Günlük raporlar</h3><p>Tüm kayıtlı günler burada temiz kartlarla listelenir.</p></div><button class="pill-button" id="downloadReportButton">JSON İndir</button></div>
          <div class="timeline-list" id="reportList"></div>
        </div>
      </section>

      <section class="view" id="view-chat">
        <div class="section-grid">
          <div class="panel-card">
            <div class="card-head"><div><h3>Sohbet testi</h3><p>Ruthie’nin müşteri tarafında nasıl cevap verdiğini buradan deneyebilirsin.</p></div></div>
            <div class="chat-box">
              <div class="chat-window" id="chatWindow"></div>
              <div class="form-grid">
                <div class="field"><label>Test mesajı</label><textarea id="chatMessage" placeholder="Örn: Bu kolyenin materyali nedir?"></textarea></div>
                <button class="pill-button primary" id="sendChatButton">Mesajı Gönder</button>
              </div>
            </div>
          </div>
          <div class="panel-card">
            <div class="card-head"><div><h3>Hızlı not</h3><p>Bu alan sadece test içindir. Gerçek müşterinin sohbet akışını bozmaz.</p></div></div>
            <div class="settings-list">
              <div class="setting-row"><div><strong>API</strong><br><span class="muted">/api/chat aynı şekilde çalışıyor.</span></div><span class="code-chip">POST</span></div>
              <div class="setting-row"><div><strong>Rapor</strong><br><span class="muted">Gizli kodla günlük rapor alınır.</span></div><span class="code-chip">/api/admin/report</span></div>
            </div>
          </div>
        </div>
      </section>

      <section class="view" id="view-settings">
        <div class="section-grid">
          <div class="panel-card">
            <div class="card-head"><div><h3>Panel ayarları</h3><p>Bu panel ana ekrana eklenebilir ve masaüstünde uygulama gibi kullanılabilir.</p></div></div>
            <div class="settings-list">
              <div class="setting-row"><div><strong>Canlı destek endpoint</strong><br><span class="muted">Sitedeki sohbet baloncuğunun kullanacağı adres.</span></div><span class="code-chip" id="chatEndpointChip">/api/chat</span></div>
              <div class="setting-row"><div><strong>Yönetici raporu</strong><br><span class="muted">Gizli kod girilince istatistikleri gösterir.</span></div><span class="code-chip">/api/admin/report</span></div>
              <div class="setting-row"><div><strong>Safari ana ekran</strong><br><span class="muted">Paylaş → Ana Ekrana Ekle ile tam ekran açılır.</span></div><span class="code-chip">PWA</span></div>
            </div>
          </div>
          <div class="panel-card">
            <div class="card-head"><div><h3>Gizli kod</h3><p>Kodu değiştirirsen panel tekrar giriş ister.</p></div></div>
            <div class="form-grid">
              <div class="field"><label>RUTHIE_OWNER_SECRET</label><input id="secretInputInline" type="password" placeholder="Gizli kod" /></div>
              <button class="pill-button primary" id="saveSecretInlineButton">Kaydet ve Yenile</button>
              <button class="ghost-button" id="logoutButton">Panelden Çık</button>
            </div>
          </div>
        </div>
      </section>
    </main>
  </div>

  <div class="login-screen" id="loginScreen">
    <div class="login-card">
      <div class="brand-mark">R</div>
      <h2>Ruthie Panel</h2>
      <p>Panel raporlarını görmek için Render ortam değişkenindeki <strong>RUTHIE_OWNER_SECRET</strong> kodunu gir.</p>
      <div class="form-grid">
        <div class="field"><label>Gizli kod</label><input id="secretInput" type="password" placeholder="Panel kodu" autocomplete="current-password" /></div>
        <button class="pill-button primary" id="saveSecretButton">Panele Gir</button>
      </div>
    </div>
  </div>

  <div class="toast" id="toast">Kopyalandı</div>

  <script>
    (function () {
      var state = {
        secret: localStorage.getItem('ruthie_owner_secret') || '',
        report: null,
        currentView: 'dashboard',
        sessionId: localStorage.getItem('ruthie_panel_session') || ('panel_' + Date.now() + '_' + Math.random().toString(16).slice(2))
      };
      localStorage.setItem('ruthie_panel_session', state.sessionId);

      var titles = {
        dashboard: ['Ruthie Panel', 'Genel Bakış'],
        reports: ['Günlük kayıtlar', 'Raporlar'],
        chat: ['Yanıt kontrolü', 'Sohbet Testi'],
        settings: ['Panel kullanımı', 'Ayarlar']
      };

      var els = {
        login: document.getElementById('loginScreen'),
        secretInput: document.getElementById('secretInput'),
        secretInputInline: document.getElementById('secretInputInline'),
        pageKicker: document.getElementById('pageKicker'),
        pageTitle: document.getElementById('pageTitle'),
        sidebar: document.getElementById('sidebar'),
        backdrop: document.getElementById('mobileBackdrop'),
        toast: document.getElementById('toast'),
        chatWindow: document.getElementById('chatWindow'),
        chatMessage: document.getElementById('chatMessage')
      };

      function init() {
        document.querySelectorAll('[data-view-button]').forEach(function (button) {
          button.addEventListener('click', function () { openView(button.getAttribute('data-view-button')); });
        });
        document.getElementById('menuButton').addEventListener('click', openMenu);
        els.backdrop.addEventListener('click', closeMenu);
        document.getElementById('refreshButton').addEventListener('click', loadReport);
        document.getElementById('copyEndpointButton').addEventListener('click', copyEndpoint);
        document.getElementById('downloadReportButton').addEventListener('click', downloadReport);
        document.getElementById('saveSecretButton').addEventListener('click', saveSecretFromLogin);
        document.getElementById('saveSecretInlineButton').addEventListener('click', saveSecretInline);
        document.getElementById('logoutButton').addEventListener('click', logout);
        document.getElementById('sendChatButton').addEventListener('click', sendChat);
        els.secretInput.addEventListener('keydown', function (event) { if (event.key === 'Enter') saveSecretFromLogin(); });
        if ('serviceWorker' in navigator) {
          navigator.serviceWorker.register('/sw.js').catch(function () {});
        }
        if (!state.secret) {
          showLogin();
        } else {
          els.secretInputInline.value = state.secret;
          loadReport();
        }
        openView('dashboard');
      }

      function showLogin() { els.login.classList.add('active'); setTimeout(function () { els.secretInput.focus(); }, 80); }
      function hideLogin() { els.login.classList.remove('active'); }
      function saveSecretFromLogin() {
        var value = els.secretInput.value.trim();
        if (!value) return showToast('Gizli kod gerekli');
        state.secret = value;
        localStorage.setItem('ruthie_owner_secret', value);
        els.secretInputInline.value = value;
        hideLogin();
        loadReport();
      }
      function saveSecretInline() {
        var value = els.secretInputInline.value.trim();
        if (!value) return showToast('Gizli kod gerekli');
        state.secret = value;
        localStorage.setItem('ruthie_owner_secret', value);
        loadReport();
        showToast('Kod kaydedildi');
      }
      function logout() {
        localStorage.removeItem('ruthie_owner_secret');
        state.secret = '';
        showLogin();
      }

      function openMenu() { els.sidebar.classList.add('open'); els.backdrop.classList.add('open'); }
      function closeMenu() { els.sidebar.classList.remove('open'); els.backdrop.classList.remove('open'); }

      function openView(name) {
        if (!name) return;
        state.currentView = name;
        document.querySelectorAll('.view').forEach(function (view) { view.classList.remove('active'); });
        var target = document.getElementById('view-' + name);
        if (target) target.classList.add('active');
        document.querySelectorAll('.nav-button').forEach(function (button) {
          button.classList.toggle('active', button.getAttribute('data-view-button') === name);
        });
        var title = titles[name] || titles.dashboard;
        els.pageKicker.textContent = title[0];
        els.pageTitle.textContent = title[1];
        closeMenu();
      }

      async function loadReport() {
        if (!state.secret) return showLogin();
        try {
          setLoading(true);
          var response = await fetch('/api/admin/report?code=' + encodeURIComponent(state.secret), { cache: 'no-store' });
          var data = await response.json();
          if (!response.ok || !data.ok) {
            showLogin();
            showToast('Kod hatalı olabilir');
            return;
          }
          state.report = data.report;
          renderReport();
        } catch (error) {
          showToast('Rapor yüklenemedi');
        } finally {
          setLoading(false);
        }
      }

      function setLoading(isLoading) {
        document.getElementById('refreshButton').textContent = isLoading ? 'Yükleniyor' : 'Yenile';
      }

      function renderReport() {
        var report = state.report || {};
        var today = report.today || {};
        setText('todayConversationCount', today.conversationCount || 0);
        setText('todayMessageCount', today.messageCount || 0);
        setText('todayImageCount', today.imageCount || 0);
        setText('totalConversationCount', report.totalConversations || 0);
        setText('totalMessageCount', report.totalMessages || 0);
        setText('todayStatusText', today.lastMessageAt ? 'Son görüşme: ' + formatDateTime(today.lastMessageAt) : 'Bugün henüz kayıt yok.');
        renderPeople(today.people || {});
        renderBars(report.days || []);
        renderReportList(report.days || []);
      }

      function renderPeople(peopleMap) {
        var people = Object.values(peopleMap || {}).filter(Boolean);
        var box = document.getElementById('peopleList');
        if (!people.length) {
          box.innerHTML = '<div class="person-item"><div class="avatar">R</div><div class="item-copy"><strong>Henüz görüşme yok</strong><span>Bugünkü kişiler burada görünür.</span></div></div>';
          return;
        }
        box.innerHTML = people.slice(0, 8).map(function (name, index) {
          var initial = String(name || 'R').trim().charAt(0).toUpperCase() || 'R';
          return '<div class="person-item" style="animation-delay:' + (index * 35) + 'ms"><div class="avatar">' + escapeHtml(initial) + '</div><div class="item-copy"><strong>' + escapeHtml(name) + '</strong><span>Bugünkü görüşme</span></div></div>';
        }).join('');
      }

      function renderBars(days) {
        var recent = (days || []).slice(-7);
        var box = document.getElementById('barChart');
        if (!recent.length) {
          box.innerHTML = '<div class="bar-row"><span>Veri yok</span><div class="bar-track"><div class="bar-fill" style="width:0%"></div></div><strong>0</strong></div>';
          return;
        }
        var max = Math.max.apply(null, recent.map(function (item) { return item.conversationCount || 0; }).concat([1]));
        box.innerHTML = recent.map(function (item) {
          var count = item.conversationCount || 0;
          var width = Math.max(5, Math.round((count / max) * 100));
          return '<div class="bar-row"><span>' + escapeHtml(item.date) + '</span><div class="bar-track"><div class="bar-fill" style="width:' + width + '%"></div></div><strong>' + count + '</strong></div>';
        }).join('');
      }

      function renderReportList(days) {
        var box = document.getElementById('reportList');
        var list = (days || []).slice().reverse();
        if (!list.length) {
          box.innerHTML = '<div class="timeline-item"><div class="avatar">R</div><div class="item-copy"><strong>Henüz kayıt yok</strong><span>Sohbet geldikçe burada listelenir.</span></div></div>';
          return;
        }
        box.innerHTML = list.map(function (item, index) {
          var people = (item.people || []).filter(Boolean).slice(0, 3).join(', ') || 'Anonim ziyaretçi';
          return '<div class="timeline-item" style="animation-delay:' + (index * 28) + 'ms"><div class="avatar">' + (index + 1) + '</div><div class="item-copy"><strong>' + escapeHtml(item.date) + ' · ' + (item.conversationCount || 0) + ' görüşme</strong><span>' + (item.messageCount || 0) + ' mesaj · ' + (item.imageCount || 0) + ' fotoğraf · ' + escapeHtml(people) + '</span></div></div>';
        }).join('');
      }

      async function sendChat() {
        var message = els.chatMessage.value.trim();
        if (!message) return showToast('Mesaj yaz');
        addBubble(message, 'user');
        els.chatMessage.value = '';
        try {
          var response = await fetch('/api/chat', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ message: message, sessionId: state.sessionId, visitorName: 'Panel Test', pageTitle: 'Ruthie Panel', pageUrl: '/panel' })
          });
          var data = await response.json();
          addBubble(data.message || 'Yanıt alınamadı.', 'bot');
        } catch (error) {
          addBubble('Test mesajı gönderilemedi.', 'bot');
        }
      }

      function addBubble(text, type) {
        var div = document.createElement('div');
        div.className = 'bubble ' + type;
        div.textContent = text;
        els.chatWindow.appendChild(div);
        els.chatWindow.scrollTop = els.chatWindow.scrollHeight;
      }

      function downloadReport() {
        if (!state.report) return showToast('Rapor yok');
        var blob = new Blob([JSON.stringify(state.report, null, 2)], { type: 'application/json' });
        var url = URL.createObjectURL(blob);
        var a = document.createElement('a');
        a.href = url;
        a.download = 'ruthie-rapor-' + (state.report.todayKey || 'panel') + '.json';
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
      }

      function copyEndpoint() {
        var endpoint = location.origin + '/api/chat';
        navigator.clipboard.writeText(endpoint).then(function () { showToast('Endpoint kopyalandı'); }).catch(function () { showToast(endpoint); });
      }

      function setText(id, value) { var el = document.getElementById(id); if (el) el.textContent = value; }
      function formatDateTime(value) {
        try { return new Intl.DateTimeFormat('tr-TR', { dateStyle: 'short', timeStyle: 'short' }).format(new Date(value)); }
        catch (error) { return value || ''; }
      }
      function escapeHtml(value) {
        return String(value == null ? '' : value).replace(/[&<>'"]/g, function (char) {
          return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[char];
        });
      }
      var toastTimer = null;
      function showToast(message) {
        els.toast.textContent = message;
        els.toast.classList.add('active');
        clearTimeout(toastTimer);
        toastTimer = setTimeout(function () { els.toast.classList.remove('active'); }, 2200);
      }

      init();
    })();
  </script>
</body>
</html>`;
}
