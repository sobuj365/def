# Data Extractor & Formatter (secure, with backend)

This repository hosts:
- Frontend (static site) published via GitHub Pages at your custom domain def.aurtho.com
- Backend (Cloudflare Worker) that securely uses Gemini API keys as secrets and exposes:
  - POST /api/ocr — Gemini OCR
  - GET /api/hex?color=...&bypassCache=0|1 — Hex lookup using cache + Gemini

Frontend
- UI unchanged.
- Tesseract OCR runs locally in the browser (free, no keys).
- Gemini OCR is requested from the backend (keys are never exposed).
- Hex lookup priority: Internal DB -> browser cache -> backend (Gemini).
- Manual Search button forces a fresh backend lookup and updates cache.

Backend (Cloudflare Workers)
- Stores Gemini API keys as a single secret GEMINI_KEYS (JSON array).
- Manages key rotation, 30-day cooldowns on 429, marks permanent fails on 400/403.
- Uses KV:
  - KEY_STATE: tracks currentIndex, cooldowns, permanentFails
  - HEX_CACHE: stores color hex results with a 30-day expiry

Deployment steps (short)
1) Deploy backend:
   - Create Cloudflare account (free), install Wrangler, login.
   - Create KV namespaces and set secrets.
   - Deploy the Worker (wrangler deploy).
2) Configure frontend:
   - Put the Worker URL into frontend/config.js (BASE_API_URL).
   - Commit and push. GitHub Pages workflow deploys automatically to def.aurtho.com.

Security notes
- No API keys in frontend or repository.
- CORS on backend can be tightened to your domain if you want later.
