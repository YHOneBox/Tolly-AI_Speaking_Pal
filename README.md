# Tolly

A portable Tauri 2 desktop app for talking with someone who sounds like a person. You speak, Groq Whisper transcribes, Groq replies in a casual voice and may wander onto an ordinary topic, and Cartesia Sonic speaks the reply. Quieter phrasing notes stay on screen. A speaking-skill score for the current conversation sits in the top corner.

API keys are yours. Nothing is read from a `.env` file.

## Layout

- React (TypeScript, Tailwind) keeps grammar notes in the main view, with one talk button and a Settings modal.
- Rust owns the Groq and Cartesia HTTP calls. Cartesia audio still streams. The chat model returns one JSON object at a time, because a streamed JSON reply was coming back empty on the next turn.
- A `data` folder next to the executable holds everything Tolly saves. API keys are in an encrypted snapshot there. Preferences and the daily token ledger are in `settings.json`. Nothing is written to the system keychain or to AppData.

The model is instructed to return only:

```json
{
  "spoken_reply": "Short conversational response",
  "visual_feedback": ["Correction 1", "Correction 2"],
  "skill_rating": 75
}
```

The main view is Tolly: a tech-style circle in the center. The window icon still comes from `logo.png`, and that picture is not drawn inside the circle. Tap the circle to listen, hold it while you speak, and talk over Tolly to cut in. Grammar notes from `visual_feedback` appear under the circle, or on the left in the split layout. `spoken_reply` is what Cartesia says. Settings can change the voice, speaking speed, speaking volume, font size, and layout, and can download a newer release from GitHub. Speaking volume is the playback level, from 0% to 100%. A `429` from Groq or Cartesia is shown as a rate-limit notice. Calls stop once today's token budget is spent.

## Portable builds

Bundled targets are `.app`, `.dmg`, and `.AppImage` only. MSI and NSIS are not configured.

```bash
npm install
npm run icons
npm run desktop
```

`npm run icons` builds the window and taskbar icons from `logo.png`.

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

This copy is 1.0.0. Push `main` to [YHOneBox/Tolly-AI_Speaking_Pal](https://github.com/YHOneBox/Tolly-AI_Speaking_Pal), then push a version tag. The tag must match `src-tauri/tauri.conf.json`, and the same version in `package.json` and `src-tauri/Cargo.toml`. The in-app updater only accepts files from that repository.

```bash
git push origin main
git tag v1.0.0
git push origin v1.0.0
```

The workflow publishes:

- `Tolly-v1.0.0-windows-x64.exe`
- `Tolly-v1.0.0-macos.dmg` and a zipped `.app`
- `Tolly-v1.0.0-linux-x64.AppImage`

It does not build an MSI or an NSIS setup.

## Settings

Open Settings and paste a Groq key and a Cartesia key. The Groq key loads the chat and Whisper models that key can use. The Cartesia key loads voices from `GET /voices`. Spoken audio uses Cartesia `sonic-3.5` over `POST /tts/sse`.
