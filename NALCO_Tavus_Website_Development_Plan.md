`# NALCO AI Assistant — Website Development Plan (v2)
### (Tavus Conversational Video PAL + Live Transcript + Firebase Hosting + Secure Backend)

**Prepared:** September 10, 2026
**Goal:** Build a working website that embeds the NALCO Tavus PAL (video AI assistant), shows a live/persistent conversation transcript, and deploy it live using Firebase Hosting — with the Tavus API key kept secure on a backend from day one.

---

## 1. What Changed From v1

The original plan called the Tavus API directly from the browser for quick testing, then moved the API key to a backend later (Phase 8). This version does it **securely from the start**: a small **Firebase Cloud Function** acts as the backend, and the React frontend never touches the API key directly. This avoids rework later and matches Tavus's own recommended architecture (frontend → your backend → Tavus API).

---

## 2. Overview

| Item | Detail |
|---|---|
| Frontend framework | React + TypeScript (via Vite) |
| Backend | Firebase Cloud Functions (Node.js) — holds the API key, talks to Tavus |
| Video AI provider | Tavus (Conversational Video Interface / PAL) |
| PAL ID | `p29cbd5433be` |
| Transcript solution | `@tavus/cvi-ui` — `ChatPanel` + `ClosedCaptions` components |
| Hosting | Firebase Hosting (serves the frontend) + Firebase Functions (serves the backend) |

---

## 3. Prerequisites

| Tool | Purpose | Check command |
|---|---|---|
| Node.js 20+ | Runs the frontend and backend | `node -v` |
| npm | Comes with Node.js | `npm -v` |
| Firebase CLI | Deploy hosting + functions | `firebase --version` |
| A Google account | To create a Firebase project | — |
| Tavus API key | Backend uses this to create conversations | From `maker.tavus.io/dev/api-keys` |

Install Firebase CLI (one-time):
```bash
npm install -g firebase-tools
firebase login
```

---

## 4. Project Phases

### Phase 1 — Create the Firebase Project & Local Structure
1. Go to the Firebase console and create a new project (e.g. `nalco-ai-assistant`).
2. In an empty folder, initialize Firebase with both Hosting and Functions together:
   ```bash
   firebase init hosting functions
   ```
   During setup:
   - Select the project you just created
   - Functions language: **TypeScript**
   - Hosting public directory: `dist` (we'll build the frontend into this folder)
   - Configure as a single-page app: **Yes**
   - Use ESLint: your choice

This creates two folders: `functions/` (backend) and the rest of the project (frontend goes here).

**Deliverable:** A Firebase project with `functions/` scaffolding ready.

---

### Phase 2 — Create the React Frontend
1. Inside the same project folder (alongside `functions/`), create the frontend app:
   ```bash
   npm create vite@latest . -- --template react-ts
   npm install
   ```
   (If Vite complains the folder isn't empty, create it in a subfolder like `frontend/` instead and adjust `firebase.json`'s public directory accordingly — either layout works.)
2. Test it runs:
   ```bash
   npm run dev
   ```

**Deliverable:** A blank React app running locally, alongside the `functions/` folder.

---

### Phase 3 — Install Tavus UI Components
```bash
npx @tavus/cvi-ui@latest add cvi-provider
npx @tavus/cvi-ui@latest add chat
npx @tavus/cvi-ui@latest add closed-captions
npx @tavus/cvi-ui@latest add media-controls
```

**Deliverable:** Tavus component files present under `src/components/`.

---

### Phase 4 — Build the Secure Backend (Cloud Function)

1. Store the Tavus API key as a Firebase Functions secret (never in frontend code, never committed to Git):
   ```bash
   firebase functions:secrets:set TAVUS_API_KEY
   ```
   Paste your key when prompted.

2. In `functions/src/index.ts`, write two HTTPS functions:
   - **`createConversation`** — receives a request from the frontend, calls `POST https://tavusapi.com/v2/conversations` with `pal_id: "p29cbd5433be"` and the secret API key attached server-side, and returns the resulting `conversation_url` to the frontend.
   - **`endConversation`** — receives a `conversation_id` from the frontend and calls Tavus's end-conversation endpoint so the room closes cleanly when a user leaves.

   Both functions read `TAVUS_API_KEY` from the Functions secret at runtime — it never appears in any file sent to the browser.

3. Test locally with the Firebase emulator:
   ```bash
   firebase emulators:start
   ```
   This runs your functions on a local URL (e.g. `http://127.0.0.1:5001/...`) so you can test the whole flow before deploying.

**Deliverable:** Two working backend endpoints that hide the API key and can be called safely from the browser.

---

### Phase 5 — Connect the Frontend to the Backend

1. In `src/App.tsx`, build:
   - A "Start Call" screen with a button.
   - On click, `fetch()` your **Cloud Function URL** (not `tavusapi.com` directly) to create a conversation and receive `conversation_url`.
   - Once you have `conversation_url`, wrap the video + transcript UI in `CVIProvider`, `ChatProvider`, and `ClosedCaptionsProvider`, and render the video (via iframe or the CVI components) alongside `ChatPanel`, `ChatButton`, and `ClosedCaptions`.
   - An "End Call" button that calls your `endConversation` function and resets the UI.

2. Store your local Cloud Function URL in a `.env` file for development convenience:
   ```
   VITE_API_BASE_URL=http://127.0.0.1:5001/nalco-ai-assistant/us-central1
   ```
   After deployment (Phase 8), this gets swapped for your live Functions URL — no API key involved here at all, so this file is safe even if committed (though `.gitignore` is still good practice).

**Deliverable:** Clicking "Start Call" launches the NALCO PAL video with a working, persistent transcript panel and captions toggle — all without the API key ever reaching the browser.

---

### Phase 6 — NALCO Branding & Styling
1. Add NALCO logo, brand colors (maroon/red `#7a1f1f`), and a simple header.
2. Style the transcript panel to match the site.
3. Add bilingual (Hindi/English) interface labels for buttons and headings.
4. Make the layout responsive (mobile: video on top, transcript as a drawer or below).

**Deliverable:** A branded, mobile-friendly page.

---

### Phase 7 — Local Testing Checklist

- [ ] Start Call button successfully creates a conversation via the Cloud Function
- [ ] Video loads and the PAL responds to voice
- [ ] Hindi and English speech are both understood
- [ ] Closed captions toggle works and shows live subtitles
- [ ] Chat panel shows a running, scrollable transcript of both user and PAL turns
- [ ] Guardrails behave as expected
- [ ] Tools fire correctly if attached
- [ ] End Call cleanly ends the conversation (check the Tavus dashboard that it shows "ended", not left running)
- [ ] No API key visible anywhere in browser DevTools → Network tab or page source
- [ ] Page works on both desktop and mobile browser widths

**Deliverable:** A locally verified, secure, working demo.

---

### Phase 8 — Deploy to Firebase (Hosting + Functions)

1. Build the frontend:
   ```bash
   npm run build
   ```
2. Deploy both hosting and functions together:
   ```bash
   firebase deploy
   ```
3. Firebase will output:
   - A live site URL (e.g. `https://nalco-ai-assistant.web.app`)
   - Live Functions URLs for `createConversation` and `endConversation`
4. Update `VITE_API_BASE_URL` in your frontend to point to the **live** Functions URLs, then rebuild and redeploy:
   ```bash
   npm run build
   firebase deploy --only hosting
   ```
5. Repeat the Phase 7 checklist on the live site.

**Deliverable:** A publicly accessible, secure, live NALCO AI Assistant.

---

### Phase 9 — Optional Enhancements (Later)
- Post-call transcript logging via the `application.transcription_ready` webhook, received by another Cloud Function and stored (e.g. in Firestore)
- Basic analytics on common questions
- Rate-limiting / abuse protection on the `createConversation` function (e.g. Firebase App Check)
- Custom domain (e.g. `assistant.nalcoindia.com`) via Firebase Hosting custom domain settings
- A/B testing different guardrails or greetings

---

## 5. Suggested Folder Structure

```
nalco-ai-assistant/
├── src/                      (frontend)
│   ├── components/
│   │   ├── cvi-provider/
│   │   ├── chat/
│   │   ├── closed-captions/
│   │   └── media-controls/
│   ├── App.tsx
│   ├── main.tsx
│   └── styles/
├── functions/                (backend)
│   ├── src/
│   │   └── index.ts          (createConversation, endConversation)
│   └── package.json
├── .env                      (VITE_API_BASE_URL only — no secrets)
├── .gitignore
├── firebase.json
├── package.json
└── dist/                     (generated by build, not committed)
```

---

## 6. Rough Timeline (Solo Developer, Part-Time)

| Phase | Estimated Time |
|---|---|
| 1 — Firebase project + structure | 20–30 min |
| 2 — Frontend setup | 15–30 min |
| 3 — Install components | 15 min |
| 4 — Secure backend (Cloud Function) | 1–2 hours |
| 5 — Connect frontend to backend | 1–2 hours |
| 6 — Branding/styling | 1–2 hours |
| 7 — Local testing | 30–60 min |
| 8 — Firebase deploy | 30–45 min |
| 9 — Enhancements | Ongoing |

**Total to a secure, live test link (Phases 1–8): roughly one full day**, depending on familiarity with React and Firebase Functions. This is a bit longer than the v1 plan, but avoids the rework of bolting on security later.

---

## 7. Key Reference Links

- Tavus CVI App Quickstart: `docs.tavus.io/sections/conversational-video-interface/quickstart/cvi-app-quickstart`
- Tavus CVI Components: `docs.tavus.io/sections/conversational-video-interface/component-library/components`
- Tavus Hooks: `docs.tavus.io/sections/conversational-video-interface/component-library/hooks`
- Tavus API Keys: `maker.tavus.io/dev/api-keys`
- Firebase Hosting docs: `firebase.google.com/docs/hosting`
- Firebase Functions docs: `firebase.google.com/docs/functions`
- Firebase Functions Secrets: `firebase.google.com/docs/functions/config-env#secret-manager`

---

*End of Plan*
