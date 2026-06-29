# Ruthie Backend + Panel

Render ayarlari:

- Runtime: Node
- Build Command: `npm install`
- Start Command: `npm start`

Panel adresleri:

- `/panel`
- `/admin`
- `/`

Panel gizli kodu Render ortam degiskeninden gelir:

- `RUTHIE_OWNER_SECRET`

Telefon kullanimi:

- Safari'de panel linkini ac
- Paylas butonuna bas
- Ana Ekrana Ekle sec
- Panel uygulama gibi acilir

Environment Variables:

- `OPENAI_API_KEY`: OpenAI API anahtari
- `OPENAI_MODEL`: `gpt-4o-mini` (OpenAI kurum dogrulamasi yapildiysa `gpt-5-mini` de kullanilabilir)
- `OPENAI_VISION_MODEL`: fotograf yorumlama icin `gpt-4o-mini`; bos birakirsan `OPENAI_MODEL` kullanilir
- `RUTHIE_MAX_IMAGE_UPLOAD_BYTES`: opsiyonel fotograf limiti; varsayilan `6000000`
- `RUTHIE_OWNER_SECURITY_ANSWER`: `enes`
- `RUTHIE_OWNER_SECRET`: panel ve patron raporu icin gizli kod
- `IKAS_STORE_DOMAIN`: ikas admin alan adin, ornek `magaza-adin.myikas.com`
- `IKAS_CLIENT_ID`: ikas ozel uygulama Client ID
- `IKAS_CLIENT_SECRET`: ikas ozel uygulama Client Secret
- `IKAS_SITE_URL`: magaza site adresin, ornek `https://ruthistanbul.com`

Render linki olusunca site sohbet baloncugundaki backend adresi su formatta olacak:

`https://SENIN-RENDER-LINKIN.onrender.com/api/chat`
