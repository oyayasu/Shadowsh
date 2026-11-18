# Third-party components and data

Shadowsh's application code is MIT-licensed. The Windows program downloads these components at the user's request; their licensing remains separate.

- [Qwen3-TTS](https://github.com/QwenLM/Qwen3-TTS) by the Qwen team. The GGUF model files, licenses, acceptable-use terms, and provenance belong to their original authors/publishers.
- [speech.cpp](https://github.com/nyosegawa/speech.cpp), an independently maintained native GGML runner. Engine archives are downloaded from its GitHub Releases; SHA256SUMS are checked before extraction.
- [ipa-dict](https://github.com/open-dict-data/ipa-dict), MIT licensed pronunciation dictionaries: `data/en_US.txt` (General American) and `data/en_UK.txt` (Received Pronunciation style). Copyright (c) 2016 dohliam and other respective contributors, licensed under the MIT license (see upstream LICENSE).
- [Tauri](https://tauri.app/) and Rust/npm dependencies each retain their own licenses.

IPA dictionaries express dictionary pronunciations, not the exact connected-speech acoustics of TTS output.
