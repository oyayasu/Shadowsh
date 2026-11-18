use regex::Regex;
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    fs,
    io::{BufRead, BufReader, Read, Write},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::{Mutex, OnceLock},
    time::Duration,
};
use tauri::{Emitter, Manager};

const REPO: &str = "https://api.github.com/repos/nyosegawa/speech.cpp/releases/latest";
const US: &str = "https://raw.githubusercontent.com/open-dict-data/ipa-dict/master/data/en_US.txt";
const UK: &str = "https://raw.githubusercontent.com/open-dict-data/ipa-dict/master/data/en_UK.txt";
const MODEL_IDS: [&str; 2] = ["qwen3-tts-0.6b", "qwen3-tts-1.7b"];

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Progress {
    task: String,
    stage: String,
    message: String,
    percent: Option<u8>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ModelStatus {
    id: &'static str,
    installed: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Status {
    engine_installed: bool,
    ipa_installed: bool,
    models: Vec<ModelStatus>,
}

#[derive(Serialize)]
struct Token {
    raw: String,
    pronunciations: Vec<String>,
}

type Dictionary = HashMap<String, Vec<String>>;
static DICTIONARIES: OnceLock<Mutex<HashMap<String, Dictionary>>> = OnceLock::new();

fn data_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_local_data_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

fn emit(app: &tauri::AppHandle, task: &str, stage: &str, message: &str, percent: Option<u8>) {
    let _ = app.emit(
        "shadow-progress",
        Progress {
            task: task.to_owned(),
            stage: stage.to_owned(),
            message: message.to_owned(),
            percent,
        },
    );
}

fn client() -> Result<reqwest::blocking::Client, String> {
    reqwest::blocking::Client::builder()
        .user_agent("Shadowsh/0.1 (https://github.com/oyayasu/Shadowsh)")
        .timeout(Duration::from_secs(1800))
        .build()
        .map_err(|e| e.to_string())
}

fn get_text(client: &reqwest::blocking::Client, url: &str) -> Result<String, String> {
    client
        .get(url)
        .send()
        .and_then(|response| response.error_for_status())
        .and_then(|response| response.text())
        .map_err(|e| format!("Could not fetch {url}: {e}"))
}

fn download(
    client: &reqwest::blocking::Client,
    app: &tauri::AppHandle,
    url: &str,
    dest: &Path,
    task: &str,
    stage: &str,
) -> Result<(), String> {
    let mut response = client
        .get(url)
        .send()
        .and_then(|r| r.error_for_status())
        .map_err(|e| format!("Download failed: {e}"))?;
    let total = response.content_length();
    if let Some(parent) = dest.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let mut file = fs::File::create(dest).map_err(|e| e.to_string())?;
    let mut bytes = 0u64;
    let mut last_percent = None;
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let n = response.read(&mut buffer).map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        file.write_all(&buffer[..n]).map_err(|e| e.to_string())?;
        bytes += n as u64;
        let percent = total
            .filter(|t| *t > 0)
            .map(|t| ((bytes.saturating_mul(100) / t).min(100)) as u8);
        if last_percent != percent || (percent.is_none() && bytes % (1024 * 1024) < 65536) {
            let size = total
                .map(|t| format!("{:.1} / {:.1} MB", bytes as f64 / 1e6, t as f64 / 1e6))
                .unwrap_or_else(|| format!("{:.1} MB received", bytes as f64 / 1e6));
            emit(app, task, stage, &size, percent);
            last_percent = percent;
        }
    }
    file.sync_all().map_err(|e| e.to_string())?;
    if total.is_some_and(|t| t != bytes) {
        return Err("The download ended before all bytes arrived".into());
    }
    Ok(())
}

fn find_binary(dir: &Path, depth: u8) -> Option<PathBuf> {
    if depth == 0 || !dir.exists() {
        return None;
    }
    for entry in fs::read_dir(dir).ok()?.flatten() {
        let path = entry.path();
        if path.is_file()
            && path.file_name().is_some_and(|n| n.to_string_lossy().eq_ignore_ascii_case("speech.exe"))
        {
            return Some(path);
        }
        if path.is_dir() {
            if let Some(found) = find_binary(&path, depth - 1) {
                return Some(found);
            }
        }
    }
    None
}

fn engine(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    find_binary(&data_dir(app)?.join("engine"), 5)
        .ok_or_else(|| "Install the native voice engine in Models first".into())
}

fn hidden_command(program: &Path) -> Command {
    let mut command = Command::new(program);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }
    command
}

fn speech_command(app: &tauri::AppHandle) -> Result<Command, String> {
    let mut cmd = hidden_command(&engine(app)?);
    cmd.env("SPEECH_MODEL_DIR", data_dir(app)?.join("models"));
    cmd.env("SPEECH_NO_UPDATE_CHECK", "1");
    cmd.env("NO_COLOR", "1");
    Ok(cmd)
}

fn available_models(app: &tauri::AppHandle) -> Vec<ModelStatus> {
    let installed = speech_command(app)
        .ok()
        .and_then(|mut c| c.args(["models", "--json"]).output().ok())
        .filter(|o| o.status.success())
        .and_then(|o| serde_json::from_slice::<serde_json::Value>(&o.stdout).ok());
    MODEL_IDS
        .iter()
        .map(|&id| {
            let found = installed
                .as_ref()
                .and_then(|catalog| catalog.get("models"))
                .and_then(|models| models.as_array())
                .is_some_and(|models| {
                    models.iter().any(|model| {
                        model["name"].as_str() == Some(id)
                            && model["files"].as_array().is_some_and(|files| {
                                files.iter().any(|file| {
                                    file["type"].as_str() == Some("q8_0")
                                        && file["fetched"].as_bool() == Some(true)
                                })
                            })
                    })
                });
            ModelStatus { id, installed: found }
        })
        .collect()
}

fn status(app: &tauri::AppHandle) -> Result<Status, String> {
    let dir = data_dir(app)?;
    Ok(Status {
        engine_installed: engine(app).is_ok(),
        ipa_installed: dir.join("ipa/en_US.txt").exists() && dir.join("ipa/en_UK.txt").exists(),
        models: available_models(app),
    })
}

#[tauri::command]
async fn get_status(app: tauri::AppHandle) -> Result<Status, String> {
    tauri::async_runtime::spawn_blocking(move || status(&app))
        .await
        .map_err(|e| e.to_string())?
}

fn install_engine_impl(app: tauri::AppHandle) -> Result<Status, String> {
    let root = data_dir(&app)?;
    let http = client()?;
    emit(&app, "engine", "release", "Checking the latest native Windows release", None);
    let release: serde_json::Value = serde_json::from_str(&get_text(&http, REPO)?)
        .map_err(|e| format!("Invalid release metadata: {e}"))?;
    let assets = release["assets"].as_array().ok_or("Release has no downloadable assets")?;
    let archive = assets
        .iter()
        .find(|asset| asset["name"].as_str().is_some_and(|s| s.ends_with("-windows-x64-vulkan.zip")))
        .ok_or("No Vulkan Windows x64 release is available")?;
    let file_name = archive["name"].as_str().ok_or("Missing archive name")?;
    let url = archive["browser_download_url"].as_str().ok_or("Missing archive URL")?;
    let checksums = assets
        .iter()
        .find(|asset| asset["name"] == "SHA256SUMS")
        .and_then(|asset| asset["browser_download_url"].as_str())
        .ok_or("This release does not publish SHA256SUMS")?;
    let checksum_text = get_text(&http, checksums)?;
    let expected = checksum_text
        .lines()
        .filter_map(|line| {
            let mut parts = line.split_whitespace();
            let hash = parts.next()?;
            let name = parts.next()?.trim_start_matches('*');
            (name == file_name).then_some(hash.to_ascii_lowercase())
        })
        .next()
        .ok_or("The Windows archive is absent from SHA256SUMS")?;

    let archive_path = root.join("speech-download.zip");
    emit(&app, "engine", "download", "Downloading speech.cpp for Windows", Some(0));
    download(&http, &app, url, &archive_path, "engine", "download")?;
    emit(&app, "engine", "verify", "Checking the SHA-256 archive fingerprint", None);
    let mut hasher = Sha256::new();
    let mut file = fs::File::open(&archive_path).map_err(|e| e.to_string())?;
    std::io::copy(&mut file, &mut hasher).map_err(|e| e.to_string())?;
    let actual = hex::encode(hasher.finalize());
    if actual != expected {
        let _ = fs::remove_file(&archive_path);
        return Err("Archive SHA-256 mismatch. No executable was installed".into());
    }

    let staging = root.join("engine-staging");
    if staging.exists() {
        fs::remove_dir_all(&staging).map_err(|e| e.to_string())?;
    }
    fs::create_dir_all(&staging).map_err(|e| e.to_string())?;
    emit(&app, "engine", "extract", "Extracting the verified native engine", None);
    let mut zip = zip::ZipArchive::new(fs::File::open(&archive_path).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    for i in 0..zip.len() {
        let mut entry = zip.by_index(i).map_err(|e| e.to_string())?;
        let relative = entry.enclosed_name().ok_or("Unsafe path in engine archive")?;
        let out = staging.join(relative);
        if entry.is_dir() {
            fs::create_dir_all(&out).map_err(|e| e.to_string())?;
        } else {
            if let Some(parent) = out.parent() {
                fs::create_dir_all(parent).map_err(|e| e.to_string())?;
            }
            let mut output = fs::File::create(&out).map_err(|e| e.to_string())?;
            std::io::copy(&mut entry, &mut output).map_err(|e| e.to_string())?;
        }
    }
    if find_binary(&staging, 5).is_none() {
        return Err("Downloaded archive has no speech.exe".into());
    }
    let dest = root.join("engine");
    let backup = root.join("engine-previous");
    if backup.exists() {
        fs::remove_dir_all(&backup).map_err(|e| e.to_string())?;
    }
    if dest.exists() {
        fs::rename(&dest, &backup).map_err(|e| e.to_string())?;
    }
    if let Err(error) = fs::rename(&staging, &dest) {
        if backup.exists() {
            let _ = fs::rename(&backup, &dest);
        }
        return Err(error.to_string());
    }
    if backup.exists() {
        let _ = fs::remove_dir_all(backup);
    }
    let _ = fs::remove_file(archive_path);
    emit(&app, "engine", "done", "Native voice engine installed successfully", Some(100));
    status(&app)
}

#[tauri::command]
async fn install_engine(app: tauri::AppHandle) -> Result<Status, String> {
    tauri::async_runtime::spawn_blocking(move || install_engine_impl(app))
        .await
        .map_err(|e| e.to_string())?
}

fn install_ipa_impl(app: tauri::AppHandle) -> Result<Status, String> {
    let root = data_dir(&app)?.join("ipa");
    fs::create_dir_all(&root).map_err(|e| e.to_string())?;
    let http = client()?;
    for (name, url) in [("en_US.txt", US), ("en_UK.txt", UK)] {
        emit(&app, "ipa", "download", &format!("Downloading {name} pronunciations"), Some(0));
        let tmp = root.join(format!("{name}.part"));
        download(&http, &app, url, &tmp, "ipa", "download")?;
        let validation = fs::read_to_string(&tmp).map_err(|e| e.to_string())?;
        if validation.lines().filter(|line| line.contains('\t') && line.contains('/')).count() < 10000 {
            return Err(format!("{name} failed dictionary validation"));
        }
        fs::rename(tmp, root.join(name)).map_err(|e| e.to_string())?;
    }
    if let Some(cache) = DICTIONARIES.get() {
        cache.lock().map_err(|e| e.to_string())?.clear();
    }
    emit(&app, "ipa", "done", "American and British IPA dictionaries installed", Some(100));
    status(&app)
}

#[tauri::command]
async fn install_ipa(app: tauri::AppHandle) -> Result<Status, String> {
    tauri::async_runtime::spawn_blocking(move || install_ipa_impl(app))
        .await
        .map_err(|e| e.to_string())?
}

fn run_model_operation(app: tauri::AppHandle, model: String, remove: bool) -> Result<Status, String> {
    if !MODEL_IDS.contains(&model.as_str()) {
        return Err("Unknown model name".into());
    }
    let task = if remove { "remove-model" } else { "model" };
    let stage = if remove { "delete" } else { "download" };
    emit(&app, task, stage, &format!("{} {model}", if remove { "Removing" } else { "Fetching" }), None);
    let mut child = speech_command(&app)?
        .args([if remove { "rm" } else { "pull" }, &model])
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Could not start the native engine: {e}"))?;
    let stderr = child.stderr.take().ok_or("No diagnostics from voice engine")?;
    let percentage = Regex::new(r"(?<!\d)\d{1,3}%").unwrap_or_else(|_| Regex::new(r"\d{1,3}%").unwrap());
    let mut last_lines = Vec::new();
    for line in BufReader::new(stderr).lines() {
        let line = line.map_err(|e| e.to_string())?;
        if line.trim().is_empty() {
            continue;
        }
        last_lines.push(line.clone());
        if last_lines.len() > 8 {
            last_lines.remove(0);
        }
        let percent = percentage
            .find(&line)
            .and_then(|m| m.as_str().trim_end_matches('%').parse::<u8>().ok())
            .filter(|v| *v <= 100);
        emit(&app, task, stage, &line, percent);
    }
    let result = child.wait().map_err(|e| e.to_string())?;
    if !result.success() {
        return Err(format!("Native model operation failed (exit {:?}): {}", result.code(), last_lines.join(" | ")));
    }
    emit(&app, task, "done", "Model operation completed and verified by speech.cpp", Some(100));
    status(&app)
}

#[tauri::command]
async fn install_model(app: tauri::AppHandle, model: String) -> Result<Status, String> {
    tauri::async_runtime::spawn_blocking(move || run_model_operation(app, model, false))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn remove_model(app: tauri::AppHandle, model: String) -> Result<Status, String> {
    tauri::async_runtime::spawn_blocking(move || run_model_operation(app, model, true))
        .await
        .map_err(|e| e.to_string())?
}

fn dictionary_for(app: &tauri::AppHandle, variant: &str) -> Result<Dictionary, String> {
    let file = match variant {
        "us" => "en_US.txt",
        "uk" => "en_UK.txt",
        _ => return Err("Variant must be us or uk".into()),
    };
    let text = fs::read_to_string(data_dir(app)?.join("ipa").join(file))
        .map_err(|_| "Download the IPA dictionaries in Models first".to_string())?;
    let mut dict = HashMap::new();
    for line in text.lines() {
        if let Some((word, raw)) = line.split_once('\t') {
            let choices = raw.split(", ").map(str::trim).filter(|v| v.starts_with('/')).map(str::to_owned).collect::<Vec<_>>();
            if !choices.is_empty() {
                dict.insert(word.to_ascii_lowercase(), choices);
            }
        }
    }
    Ok(dict)
}

#[tauri::command]
fn phonetics(app: tauri::AppHandle, text: String, variant: String) -> Result<Vec<Token>, String> {
    if text.len() > 10_000 {
        return Err("Practice line is too long (10,000 bytes maximum)".into());
    }
    let cache = DICTIONARIES.get_or_init(|| Mutex::new(HashMap::new()));
    let mut guard = cache.lock().map_err(|e| e.to_string())?;
    if !guard.contains_key(&variant) {
        guard.insert(variant.clone(), dictionary_for(&app, &variant)?);
    }
    let dict = guard.get(&variant).ok_or("Dictionary unavailable")?;
    let regex = Regex::new(r"(?i)[a-z]+(?:['’][a-z]+)*|[^a-z]+").map_err(|e| e.to_string())?;
    Ok(regex
        .find_iter(&text)
        .map(|part| {
            let raw = part.as_str().to_string();
            let pronunciations = if raw.chars().next().is_some_and(|c| c.is_ascii_alphabetic()) {
                dict.get(&raw.to_ascii_lowercase().replace('’', "'"))
                    .cloned()
                    .unwrap_or_default()
            } else {
                Vec::new()
            };
            Token { raw, pronunciations }
        })
        .collect())
}

#[tauri::command]
async fn generate_audio(
    app: tauri::AppHandle,
    text: String,
    model: String,
    voice: String,
) -> Result<tauri::ipc::Response, String> {
    tauri::async_runtime::spawn_blocking(move || {
        if !MODEL_IDS.contains(&model.as_str()) {
            return Err("Invalid voice model".into());
        }
        if !["aiden", "ryan", "serena", "vivian", "dylan", "eric", "sohee", "ono_anna", "uncle_fu"].contains(&voice.as_str()) {
            return Err("Invalid speaker".into());
        }
        if text.trim().is_empty() || text.chars().count() > 1200 {
            return Err("Choose a line between 1 and 1,200 characters".into());
        }
        if !available_models(&app).iter().any(|entry| entry.id == model && entry.installed) {
            return Err("Download the selected voice model in Models first".into());
        }
        let mut hash = Sha256::new();
        hash.update(format!("{model}|{voice}|{text}"));
        let file_name = format!("{}.wav", hex::encode(hash.finalize()));
        let cache = data_dir(&app)?.join("audio");
        fs::create_dir_all(&cache).map_err(|e| e.to_string())?;
        let file = cache.join(file_name);
        if !file.exists() {
            emit(&app, "generation", "synthesize", "Generating natural reference audio locally", None);
            let result = speech_command(&app)?
                .args(["tts", &model, "--voice", &voice, "--language", "en", "--device", "auto", "-o"])
                .arg(&file)
                .arg("--")
                .arg(&text)
                .output()
                .map_err(|e| format!("Voice generation could not start: {e}"))?;
            if !result.status.success() {
                let _ = fs::remove_file(&file);
                return Err(format!("Qwen3-TTS failed: {}", String::from_utf8_lossy(&result.stderr)));
            }
            emit(&app, "generation", "done", "Reference audio ready", Some(100));
        }
        let bytes = fs::read(&file).map_err(|e| e.to_string())?;
        Ok(tauri::ipc::Response::new(bytes))
    })
    .await
    .map_err(|e| e.to_string())?
}

pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            get_status,
            install_engine,
            install_ipa,
            install_model,
            remove_model,
            phonetics,
            generate_audio
        ])
        .run(tauri::generate_context!())
        .expect("error running Shadowsh");
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_non_windows_models() {
        assert!(!MODEL_IDS.contains(&"qwen3-tts-other"));
    }
}
