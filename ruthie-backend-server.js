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
  const messageText = sanitizeCustomerMessage(cleaned || "Bu konu icin sizi WhatsApp destek ekibimize yonlendirmem en dogrusu.");

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
    "Kesin bilmedigin fiyat, siparis durumu, kargo hareketi veya kisisel veri iceren konularda asla uydurma.",
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
    .replace(/\bstok[a-z]*/gi, "urun uygunlugu")
    .replace(/\bsto\u011f[a-z]*/gi, "urun uygunlugu")
    .replace(/\bstock[a-z]*/gi, "product availability")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
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
  const shouldHandleProduct = isProductInfoRequest(message, page) || pendingProductSessions.has(sessionId);
  if (!shouldHandleProduct) return null;

  if (!isIkasConfigured()) {
    return {
      handoff: true,
      message: "Urun paneli baglantisi henuz hazir gorunmuyor. WhatsApp destek ekibimiz urun bilgisini hemen kontrol edebilir."
    };
  }

  const term = extractProductSearchTerm(message, page);
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
    return {
      message: formatProductAnswer(products)
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

    return products.map((product) => formatProductContext(product)).join("\n---\n").slice(0, 10000);
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
        `Fiyat: ${getProductPriceText(product)}`,
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

function formatProductContext(product) {
  const variants = (product.variants || []).slice(0, 6).map((variant) => {
    const price = variant.prices?.[0] || {};
    const sale = price.discountPrice && price.discountPrice < price.sellPrice
      ? `${price.discountPrice} ${price.currencySymbol || price.currencyCode || ""} indirimli`
      : "";
    return [
      `SKU: ${variant.sku || "yok"}`,
      `fiyat: ${price.sellPrice || "belirsiz"} ${price.currencySymbol || price.currencyCode || ""}`,
      sale
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

function formatProductAnswer(products) {
  const visible = products.slice(0, 5);

  if (visible.length === 1) {
    const product = visible[0];
    return [
      `${product.name} urununu panelde buldum.`,
      `Fiyat: ${getProductPriceText(product)}.`,
      buildProductUrl(product) ? `Urun linki: ${buildProductUrl(product)}` : "",
      "Bu urun hakkinda hangi bilgiyi merak ediyorsunuz?"
    ].filter(Boolean).join("\n");
  }

  return [
    "Panelde birden fazla eslesen urun buldum:",
    ...visible.map((product, index) => `${index + 1}. ${product.name} - fiyat: ${getProductPriceText(product)}`),
    "Hangisini soruyorsunuz? Urun adini biraz daha net yazabilir veya urun linkini gonderebilirsiniz."
  ].join("\n");
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
  const text = normalize(`${message || ""} ${page?.pageTitle || ""} ${page?.pageUrl || ""}`);
  return /(urun|kolye|bileklik|yuzuk|kupe|stok|fiyat|beden|olcu|necklace|ring|bracelet|earring)/.test(text);
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
    "necklace", "ring", "bracelet", "earring", "jewelry", "jewellery", "model"
  ]);
  const words = normalize(source)
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length > 2 && !ignored.has(word));
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

