# Shadowsh

Desktop English pronunciation practice for Windows, built with Tauri 2 and a pastel interface inspired by Studysh.

## Initial desktop scope

- Paste a text: **each non-empty line becomes a practice unit** (no automatic punctuation-based splitting).
- Choose **General American** or **Standard British / RP-style** dictionary IPA, or compare both. Dictionary transcription is **not** a phonetic transcript of connected speech; multiple pronunciations can be selected.
- Generate local neural reference audio with **Qwen3-TTS CustomVoice** through the open-source `speech.cpp` engine (Vulkan/CPU), using the built-in Aiden and Ryan speakers.
- Playback with speed/pitch preservation, repeat and microphone recording for manual comparison.
- Install the native engine, IPA dictionaries and Qwen3-TTS models in-app. Engine/models need internet only for setup; practice then runs offline.
- Audio voices and IPA are independently controlled. **Switching to British IPA does not magically change the Qwen speaker's accent.**

## Windows development

Prerequisites: Node.js 22+, Rust stable, MSVC C++ build tools, WebView2 and WebView2 SDK on Windows.

```powershell
npm install
npm run icon
npm run tauri dev
```

Create an installer with `npm run build:windows`. A GitHub Actions workflow builds a Windows NSIS installer and uploads an artifact, so building locally is optional.

## License and third parties

This application source is MIT licensed. It does not redistribute Qwen weights, `speech.cpp`, or IPA data in the Git repository. The optional in-app downloads come from their respective upstream publishers and retain their own licenses. See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## Status

First implementation / Windows MVP; it has **not yet been validated on a Windows GPU or against every Tauri/WebView2 configuration**. See the README implementation notes and CI build before treating the app as production-ready.

## Download the Windows installer

Open [Actions → Windows desktop](https://github.com/oyayasu/Shadowsh/actions/workflows/windows.yml), open a **successful** run, and download the **Shadowsh-Windows-Installer** artifact. Extract the ZIP and launch the NSIS `.exe` on Windows. In the app's **Models & voices** page: install the engine, install the US/UK IPA dictionaries, and download Qwen3-TTS 0.6B (recommended). Internet is only needed for those downloads; no system Python is required.

**Hardware note:** The native Windows speech.cpp build uses Vulkan. Make sure the graphics driver supplies `vulkan-1.dll`; AMD Radeon cards generally provide it via the current GPU driver. UK IPA comparison is not equivalent to a guaranteed British voice. Neural pronunciation scoring is not included in this version.
