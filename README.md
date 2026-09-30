# Tolly

A portable Tauri 2 desktop app for talking with someone who sounds like a person. You speak, Groq Whisper transcribes, Groq replies in a casual voice and may wander onto an ordinary topic, and Cartesia Sonic speaks the reply. Quieter phrasing notes stay on screen. A speaking-skill score for the current conversation sits in the top corner.

API keys are yours. Nothing is read from a `.env` file.

## Layout

- React (TypeScript, Tailwind) renders the chat, microphone, and Settings modal.
- Rust owns the Groq and Cartesia HTTP calls, including streamed Llama tokens and Cartesia SSE audio.
- A `data` folder next to the executable holds everything Tolly saves. API keys are in an encrypted snapshot there. Preferences and the daily token ledger are in `settings.json`. Nothing is written to the system keychain or to AppData.

The model is instructed to return only:

```json
{
  "spoken_reply": "Short conversational response",
  "visual_feedback": ["Correction 1", "Correction 2"],
  "skill_rating": 75
}
```

The UI parses that JSON, plays `spoken_reply` through Cartesia, and renders `visual_feedback` under the reply. A `429` from Groq or Cartesia is shown as a rate-limit notice. Calls stop once today's token budget is spent.

## Portable builds

Bundled targets are `.app`, `.dmg`, and `.AppImage` only. MSI and NSIS are not configured.

```bash
npm install
npm run icons
npm run desktop
```

Windows portable executable (a single `.exe`, no setup wizard):

```bash
npm run build:portable
```

The binary is `src-tauri/target/release/ai-speaking-pal.exe`. Copy that file anywhere and run it. Windows 11 already includes WebView2. A Windows 10 machine needs the WebView2 runtime installed separately because this build does not embed a setup wizard.

macOS `.app` and `.dmg`:

```bash
npm run build:macos
```

Linux `.AppImage`:

```bash
npm run build:linux
```

Rust 1.77 or newer and Node 20 or newer are required. Tolly keeps its `data` folder beside the executable, so you can move that folder with the app.

## GitHub release

Pushing a version tag builds the portable files and attaches them to a GitHub Release. The tag must match `src-tauri/tauri.conf.json`, and the same version in `package.json` and `src-tauri/Cargo.toml`.

```bash
git tag v0.1.0
git push origin v0.1.0
```

The workflow publishes:

- `Tolly-v0.1.0-windows-x64.exe`
- `Tolly-v0.1.0-macos.dmg` and a zipped `.app`
- `Tolly-v0.1.0-linux-x64.AppImage`

It does not build an MSI or an NSIS setup.

## Settings

Open Settings and paste a Groq key and a Cartesia key. The Groq key loads the chat and Whisper models that key can use. The Cartesia key loads voices from `GET /voices`. Spoken audio uses Cartesia `sonic-3.5` over `POST /tts/sse`.
