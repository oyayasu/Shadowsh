
import { splitPracticeLines, STARTER_TEXT, VOICES, MODEL_CHOICES } from './core.js';

const invoke = window.__TAURI__?.core?.invoke;
const listen = window.__TAURI__?.event?.listen;
const storageKey = 'shadowsh.desktop.v1';
const remembered = (() => {
  try { return JSON.parse(localStorage.getItem(storageKey) || '{}'); } catch { return {}; }
})();
const state = {
  view: 'practice',
  text: remembered.text ?? STARTER_TEXT,
  lines: splitPracticeLines(remembered.text ?? STARTER_TEXT),
  index: 0,
  accent: remembered.accent === 'uk' ? 'uk' : 'us',
  compare: remembered.compare === true,
  model: MODEL_CHOICES.some(x => x.id === remembered.model) ? remembered.model : 'qwen3-tts-0.6b',
  voice: VOICES.some(x => x[0] === remembered.voice) ? remembered.voice : 'aiden',
  speed: Math.max(.6, Math.min(1.25, Number(remembered.speed) || .9)),
  repeat: remembered.repeat === true,
  status: null,
  busy: '',
  progress: null,
  logs: [],
  recording: false,
  recordingUrl: null,
  playing: false,
  generating: false
};
let requestVersion = 0, toastTimer, loopTimer, recorder, recordingStream, playingKey = null;
const playback = new Audio();
const savedAudio = new Map();
const icons = {
  waves: '<path d="M2 10v4m4-8v12m4-16v20m4-16v12m4-8v4m4-7v10"/>',
  headphones: '<path d="M3 14v-3a9 9 0 0 1 18 0v3"/><rect x="2" y="13" width="5" height="8" rx="2"/><rect x="17" y="13" width="5" height="8" rx="2"/>',
  list: '<rect x="3" y="4" width="18" height="16" rx="3"/><path d="M8 9h8M8 13h8M8 17h5"/>',
  box: '<rect x="3" y="3" width="18" height="18" rx="4"/><path d="m3 9 9 4 9-4M12 13v8"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5m0-8h.01"/>',
  play: '<path d="m8 5 11 7-11 7z" fill="currentColor" stroke="none"/>',
  pause: '<rect x="7" y="5" width="3.5" height="14" rx="1" fill="currentColor" stroke="none"/><rect x="13.5" y="5" width="3.5" height="14" rx="1" fill="currentColor" stroke="none"/>',
  mic: '<rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 10a7 7 0 0 0 14 0m-7 7v5m-4 0h8"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor" stroke="none"/>',
  rotate: '<path d="M3 11a9 9 0 1 1 2 6"/><path d="M3 4v7h7"/>',
  download: '<path d="M12 3v13m-5-5 5 5 5-5M4 18v3h16v-3"/>',
  check: '<path d="m4 12 5 5L20 6"/>',
  trash: '<path d="M4 7h16M9 7V4h6v3m-9 0 1 14h10l1-14M10 11v7m4-7v7"/>',
  chevron: '<path d="m9 6 6 6-6 6"/>',
  speaker: '<path d="M3 9v6h4l5 4V5L7 9H3Zm13-1a6 6 0 0 1 0 8m3-11a10 10 0 0 1 0 14"/>',
  keyboard: '<rect x="2" y="4" width="20" height="16" rx="3"/><path d="M6 8h.01M10 8h.01M14 8h.01M18 8h.01M6 12h.01M10 12h.01M14 12h.01M18 12h.01M7 16h10"/>',
  arrow: '<path d="M4 12h16m-6-6 6 6-6 6"/>'
};
const icon = (name, size = 20) => `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[name] || icons.info}</svg>`;
const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function store() {
  localStorage.setItem(storageKey, JSON.stringify({ text: state.text, accent: state.accent, compare: state.compare, voice: state.voice, model: state.model, speed: state.speed, repeat: state.repeat }));
}
function tell(message) {
  const toast = document.getElementById('toast');
  if (!toast) return;
  toast.textContent = message; toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('show'), 4600);
}
const line = () => state.lines[state.index] || null;
const modelReady = model => state.status?.models?.some(m => m.id === model && m.installed) === true;
function nav(view, symbol, label) {
  return `<button class="nav-item ${state.view === view ? 'active' : ''}" data-view="${view}">${icon(symbol)}<span>${label}</span></button>`;
}
function layout(content, title) {
  document.getElementById('app').innerHTML = `
  <div class="shell">
    <aside class="sidebar">
      <div class="brand"><div class="brand-icon">${icon('waves',24)}</div><div class="brand-text"><strong>Shadowsh</strong><small>PRONUNCIATION STUDIO</small></div></div>
      <div class="section-caption">WORKSPACE</div>
      <nav class="nav" aria-label="Pages">
        ${nav('practice','headphones','Practice')}
        ${nav('models','box','Models & voices')}
        ${nav('about','info','About')}
      </nav>
      <div class="sidebar-bottom"><span class="online-dot"></span><span class="caption-text">Local-first pronunciation</span></div>
    </aside>
    <main class="main">
      <header class="topbar"><span class="crumb">${escape(title)}</span><div class="right-meta"><span class="offline-pill">${icon('check',13)} Local practice</span></div></header>
      <div class="body"><div class="content">${content}</div></div>
    </main>
  </div>`;
  document.querySelectorAll('[data-view]').forEach(button => button.addEventListener('click', () => {
    if (state.view === button.dataset.view) return;
    state.view = button.dataset.view; render();
  }));
}
function heading(kicker, title, subtitle) {
  return `<div class="page-header"><div class="eyebrow">${kicker}</div><h1>${title}</h1><p>${subtitle}</p></div>`;
}
function practicePage() {
  const current = line();
  const queue = state.lines.map((value, i) => `
    <button class="line-item ${i === state.index ? 'active' : ''}" data-line="${i}" aria-pressed="${i === state.index}">
      <span class="line-index">${String(i+1).padStart(2,'0')}</span>
      <span class="line-title">${escape(value)}</span>${i === state.index ? icon('chevron',15) : ''}
    </button>`).join('');
  const exercise = !current ? `<div class="empty"><div class="empty-icon">${icon('headphones',27)}</div><h2>No practice lines yet</h2><p>Paste your text and create a practice queue.</p></div>` : `
    <div class="row spread wrap">
      <span class="practice-label">PRACTICE LINE ${state.index+1} / ${state.lines.length}</span>
      <span class="status-badge">${state.status?.engine_installed && modelReady(state.model) ? 'Local audio ready' : 'Voice model not ready'}</span>
    </div>
    <div class="sentence">${escape(current)}</div>
    <div class="panel-soft">
      <div class="variant-bar">
        <span class="field" style="margin:0">WORD-BY-WORD IPA</span>
        <div class="variant-group" role="group" aria-label="Pronunciation variant">
          <button class="seg-btn ${state.accent === 'us' && !state.compare ? 'active' : ''}" data-accent="us">US</button>
          <button class="seg-btn ${state.accent === 'uk' && !state.compare ? 'active' : ''}" data-accent="uk">UK</button>
          <button class="seg-btn ${state.compare ? 'active' : ''}" data-accent="compare">Compare</button>
        </div>
      </div>
      <div id="phonetics" aria-live="polite"><div class="phonetic-note">Loading IPA…</div></div>
      <div class="phonetic-note">Dictionary IPA, not a connected-speech transcript. Click a word to cycle available pronunciations.</div>
    </div>
    <div class="player-panel">
      <div class="selects">
        <div><label class="field" for="voice">QWEN VOICE</label><select class="select" id="voice">
          ${VOICES.map(([id,name,desc]) => `<option value="${id}" ${state.voice === id ? 'selected' : ''} title="${escape(desc)}">${escape(name)}</option>`).join('')}
        </select></div>
        <div><label class="field" for="model">NEURAL MODEL</label><select class="select" id="model">
          ${MODEL_CHOICES.map(m => `<option value="${m.id}" ${state.model === m.id ? 'selected' : ''}>${m.name}</option>`).join('')}
        </select></div>
      </div>
      <div class="player-controls">
        <button class="btn outline" id="toggle-repeat" aria-label="Repeat reference" title="Repeat reference" aria-pressed="${state.repeat}">${icon('rotate')}</button>
        <button class="btn primary circle" id="play-reference" aria-label="${state.playing ? 'Pause' : 'Play'}" ${state.generating ? 'disabled' : ''}>${icon(state.playing ? 'pause' : 'play',23)}</button>
        <button class="btn outline" id="save-reference" aria-label="Save reference WAV" title="Save reference WAV">${icon('download')}</button>
      </div>
      <div class="control-hint" id="player-hint">${state.generating ? 'Generating reference audio locally…' : 'Listen and repeat to match the speaker’s rhythm and sounds.'}</div>
      <div class="speed-bar"><span class="small muted">Playback speed</span>
        <input type="range" min=".6" max="1.25" step=".05" value="${state.speed}" id="speed" aria-label="Playback speed">
        <span class="speed-value" id="speed-value">${state.speed.toFixed(2)}×</span>
      </div>
    </div>
    <div class="divider"></div>
    <div class="record">
      <div class="row"><div class="empty-icon" style="width:45px;height:45px;border-radius:15px;margin:0">${icon('mic')}</div>
        <div><strong>Your pronunciation</strong><p class="subtle">Record yourself and compare to the reference.</p></div>
      </div>
      <div class="row wrap">
        ${state.recordingUrl ? `<button class="btn outline tiny-btn" id="play-recording">${icon('play',15)} Listen</button>` : ''}
        <button class="btn ${state.recording ? 'danger' : 'soft'} tiny-btn" id="record">${icon(state.recording ? 'stop':'mic',16)} ${state.recording ? 'Stop':'Record'}</button>
      </div>
    </div>
    <div class="phonetic-note" style="margin-top:13px">Aiden is an American voice. Switching to UK IPA does not change the speaker’s accent.</div>`;
  layout(`
    ${heading('PERSONAL PRACTICE','Listen. Repeat. Improve.','Turn any text into focused English pronunciation exercises, locally.')}
    <div class="layout">
      <div class="left-stack">
        <section class="card">
          <div class="row spread"><h2>Your text</h2><span class="status-badge">Editable</span></div>
          <p class="muted small" style="margin:0 0 13px">Each line break creates an independent practice line.</p>
          <textarea id="source-text" class="textarea" spellcheck="true" aria-label="Practice text">${escape(state.text)}</textarea>
          <div class="row spread wrap row-gap"><span class="small muted" id="text-count">${splitPracticeLines(state.text).length} lines</span>
            <button class="btn primary" id="create-lines">${icon('arrow',16)} Create practice</button>
          </div>
        </section>
        <section class="card"><div class="row spread"><h2>Practice queue</h2><span class="status-badge">${state.lines.length} lines</span></div>
          <div class="line-list">${queue || '<p class="muted small">No lines yet.</p>'}</div></section>
      </div>
      <section class="card practice-card">${exercise}</section>
    </div>
  `,'Practice / Shadowsh');
  document.getElementById('source-text').addEventListener('input', event => {
    state.text = event.target.value;
    document.getElementById('text-count').textContent = `${splitPracticeLines(state.text).length} lines`;
    store();
  });
  document.getElementById('create-lines').addEventListener('click', () => {
    const parsed = splitPracticeLines(state.text);
    if (!parsed.length) return tell('Paste at least one line of English text.');
    state.lines = parsed; state.index = 0; stopAudio(); store(); render();
  });
  document.querySelectorAll('[data-line]').forEach(button => button.addEventListener('click', () => {
    const next = Number(button.dataset.line);
    if (next === state.index) return;
    state.index = next; stopAudio(); render();
  }));
  if (!current) return;
  document.querySelectorAll('[data-accent]').forEach(button => button.addEventListener('click', () => {
    if (button.dataset.accent === 'compare') state.compare = true;
    else { state.compare = false; state.accent = button.dataset.accent; }
    store(); render();
  }));
  document.getElementById('voice').addEventListener('change', e => { state.voice=e.target.value; stopAudio(); store(); render(); });
  document.getElementById('model').addEventListener('change', e => { state.model=e.target.value; stopAudio(); store(); render(); });
  document.getElementById('speed').addEventListener('input', e => {
    state.speed = Number(e.target.value);
    playback.playbackRate = state.speed; playback.preservesPitch = true;
    document.getElementById('speed-value').textContent = state.speed.toFixed(2) + '×';
    store();
  });
  document.getElementById('toggle-repeat').addEventListener('click', e => {
    state.repeat = !state.repeat;
    e.currentTarget.setAttribute('aria-pressed',String(state.repeat));
    if (!state.repeat) clearTimeout(loopTimer);
    store();
  });
  document.getElementById('play-reference').addEventListener('click', playReference);
  document.getElementById('save-reference').addEventListener('click', saveReference);
  document.getElementById('record').addEventListener('click', toggleRecording);
  document.getElementById('play-recording')?.addEventListener('click', () => {
    if (state.recordingUrl) new Audio(state.recordingUrl).play().catch(e => tell(String(e)));
  });
  refreshPhonetics();
}
function renderTokens(target, tokens, accent) {
  const panel = document.createElement('div');
  panel.className = 'phonetic-block';
  const label = document.createElement('div');
  label.className = 'phonetic-label';
  label.textContent = accent === 'us' ? 'AMERICAN ENGLISH' : 'BRITISH ENGLISH';
  panel.append(label);
  const row = document.createElement('div');
  row.className = 'phonetic-line';
  tokens.forEach(token => {
    if (!token.pronunciations?.length && !/^[A-Za-z]/.test(token.raw)) {
      if (token.raw.trim()) {
        const punct = document.createElement('span');
        punct.className = 'punct'; punct.textContent = token.raw.trim(); row.append(punct);
      }
      return;
    }
    const button = document.createElement('button');
    button.className = 'word';
    button.title = token.pronunciations?.length > 1 ? 'Select another pronunciation' : 'Dictionary pronunciation';
    const term = document.createElement('span');
    term.className = 'plain'; term.textContent = token.raw;
    const ipa = document.createElement('span');
    ipa.className = 'ipa';
    if (!token.pronunciations?.length) ipa.classList.add('missing');
    let current = 0;
    const update = () => ipa.textContent = token.pronunciations?.[current] || '—';
    update();
    if (token.pronunciations?.length > 1) button.addEventListener('click', () => { current = (current+1) % token.pronunciations.length; update(); });
    else button.disabled = true;
    button.append(term,ipa); row.append(button);
  });
  panel.append(row); target.append(panel);
}
async function refreshPhonetics() {
  const target = document.getElementById('phonetics');
  const current = line();
  if (!target || !current) return;
  const version = ++requestVersion;
  target.replaceChildren();
  if (!invoke) { target.textContent = 'IPA is available when running the desktop application.'; return; }
  if (!state.status?.ipa_installed) {
    target.textContent = 'Download US and UK IPA dictionaries in Models & voices to display transcription.';
    return;
  }
  const accents = state.compare ? ['us','uk'] : [state.accent];
  try {
    const data = await Promise.all(accents.map(variant => invoke('phonetics',{text:current,variant})));
    if (version !== requestVersion || !document.getElementById('phonetics')) return;
    accents.forEach((accent,i) => renderTokens(target,data[i],accent));
  } catch (error) { target.textContent = 'IPA error: ' + String(error); }
}
const audioKey = () => [state.model,state.voice,line()].join('\u0001');
function stopAudio() {
  clearTimeout(loopTimer); playback.pause(); playback.currentTime=0; state.playing=false; playingKey=null;
}
function updatePlaybackButton() {
  const button = document.getElementById('play-reference');
  if (!button) return;
  button.innerHTML = icon(state.playing?'pause':'play',23);
  button.setAttribute('aria-label',state.playing?'Pause':'Play');
}
playback.addEventListener('ended', () => {
  state.playing = false; updatePlaybackButton();
  const finished = playingKey;
  if (state.repeat) loopTimer = setTimeout(() => {
    if (!state.repeat || audioKey() !== finished) return;
    playback.currentTime=0;
    playback.play().then(() => { state.playing=true; updatePlaybackButton(); }).catch(e => tell(String(e)));
  },1100);
});
async function getAudioUrl() {
  if (!invoke) throw new Error('Audio generation requires the Windows desktop application.');
  if (!state.status?.engine_installed || !modelReady(state.model)) throw new Error('Install the engine and selected model in Models & voices first.');
  const key = audioKey();
  if (savedAudio.has(key)) return {key,url:savedAudio.get(key)};
  state.generating = true;
  document.getElementById('player-hint')?.replaceChildren(document.createTextNode('Generating neural speech locally…'));
  document.getElementById('play-reference')?.setAttribute('disabled','');
  try {
    const result = await invoke('generate_audio',{text:line(),model:state.model,voice:state.voice});
    const bytes = result instanceof ArrayBuffer ? result : new Uint8Array(result);
    const url = URL.createObjectURL(new Blob([bytes],{type:'audio/wav'}));
    savedAudio.set(key,url);
    return {key,url};
  } finally {
    state.generating = false;
    document.getElementById('play-reference')?.removeAttribute('disabled');
    const hint = document.getElementById('player-hint');
    if (hint) hint.textContent = 'Audio ready — listen and repeat.';
  }
}
async function playReference() {
  if (state.playing && playingKey === audioKey()) {
    playback.pause(); state.playing=false; updatePlaybackButton(); return;
  }
  if (playingKey === audioKey() && playback.paused && playback.currentTime > 0) {
    await playback.play().catch(e=>tell(String(e)));
    state.playing=!playback.paused; updatePlaybackButton(); return;
  }
  try {
    const {key,url} = await getAudioUrl();
    stopAudio(); playingKey=key;
    playback.src=url; playback.playbackRate=state.speed; playback.preservesPitch=true;
    await playback.play(); state.playing=true; updatePlaybackButton();
  } catch (error) { tell(String(error)); }
}
async function saveReference() {
  try {
    const {url} = await getAudioUrl();
    const a = document.createElement('a');
    a.href=url; a.download=`shadowsh-line-${state.index+1}.wav`;
    document.body.append(a); a.click(); a.remove();
  } catch (error) { tell(String(error)); }
}
async function toggleRecording() {
  if (state.recording && recorder) {
    recorder.stop();
    recordingStream?.getTracks().forEach(track=>track.stop());
    state.recording=false; render(); return;
  }
  if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
    tell('Microphone capture is unavailable in this WebView.'); return;
  }
  try {
    recordingStream = await navigator.mediaDevices.getUserMedia({audio:true});
    const format='audio/webm;codecs=opus';
    recorder = new MediaRecorder(recordingStream,MediaRecorder.isTypeSupported(format)?{mimeType:format}:undefined);
    const parts=[];
    recorder.ondataavailable=e=>{if(e.data.size)parts.push(e.data);};
    recorder.onstop=()=>{
      if(state.recordingUrl)URL.revokeObjectURL(state.recordingUrl);
      state.recordingUrl=URL.createObjectURL(new Blob(parts,{type:recorder.mimeType||'audio/webm'}));
      state.recording=false;render();
    };
    recorder.onerror=()=>tell('Microphone recording failed.');
    recorder.start();state.recording=true;render();
  } catch (error) {
    recordingStream?.getTracks().forEach(t=>t.stop());
    tell('Microphone error: '+String(error));
  }
}
function modelsPage() {
  const engine=!!state.status?.engine_installed;
  const ipa=!!state.status?.ipa_installed;
  const badge=ready=>`<span class="status-badge ${ready?'ready':''}">${ready?'Installed':'Not installed'}</span>`;
  const items=MODEL_CHOICES.map(item=>{
    const installed=modelReady(item.id);
    return `<section class="card">
      <div class="model-header"><div><div class="eyebrow">CUSTOMVOICE · Q8_0</div><h2 style="margin-top:8px">${item.name}</h2></div>${badge(installed)}</div>
      <p class="muted small">${item.detail}</p>
      <div class="models-box"><div class="row spread"><span class="small bold">Model download</span><span class="muted small">${item.size}</span></div></div>
      ${installed?`<button class="btn danger tiny-btn" data-remove-model="${item.id}" ${state.busy?'disabled':''}>${icon('trash',15)} Remove model</button>`:
      `<button class="btn primary tiny-btn" data-install-model="${item.id}" ${state.busy||!engine?'disabled':''}>${icon('download',16)} Download model</button>`}
    </section>`;
  }).join('');
  layout(`
    ${heading('LOCAL AI','Models & voices','Download once, then use your voice models and IPA without an internet connection.')}
    <div class="models-list">
      <section class="card">
        <div class="model-header"><div><div class="eyebrow">STEP 01 · REQUIRED</div><h2 style="margin-top:8px">Native voice engine</h2></div>${badge(engine)}</div>
        <p class="muted small">speech.cpp for Windows x64 (Vulkan). No Python installation or visible console windows.</p>
        <div class="models-box"><div class="row spread"><span class="small bold">Verified engine archive</span><span class="muted small">~30 MB</span></div><div class="subtle">Downloaded from GitHub Releases and checked against SHA-256.</div></div>
        <button class="btn ${engine?'soft':'primary'} tiny-btn" id="install-engine" ${state.busy||!invoke?'disabled':''}>${icon('download',16)} ${engine?'Reinstall engine':'Install engine'}</button>
      </section>
      <section class="card">
        <div class="model-header"><div><div class="eyebrow">STEP 02 · REQUIRED</div><h2 style="margin-top:8px">IPA dictionaries</h2></div>${badge(ipa)}</div>
        <p class="muted small">American and British dictionary IPA. The two variants are kept separate.</p>
        <div class="models-box"><div class="row spread"><span class="small bold">US (General American) + UK (RP-style)</span><span class="muted small">Text data</span></div><div class="subtle">From open-dict-data/ipa-dict (MIT license).</div></div>
        <button class="btn ${ipa?'soft':'primary'} tiny-btn" id="install-ipa" ${state.busy||!invoke?'disabled':''}>${icon('download',16)} ${ipa?'Refresh dictionaries':'Download IPA'}</button>
      </section>
      ${items}
    </div>
    <div class="notice">A single model contains nine speaker identities. Aiden is American; changing IPA to UK does not make the Qwen voice British.</div>
    <section class="card model-progress">
      <div class="row spread"><h2>Installation progress</h2><span class="status-badge ${state.busy?'pending':''}">${state.busy||'Idle'}</span></div>
      <p class="small muted" id="task-message">Choose an installation action above.</p>
      <div class="progress-track" role="progressbar" aria-label="Installation progress" id="progress-track"><div id="progress-fill" class="progress-fill" style="width:0%"></div></div>
      <details class="log-details"><summary>Installation details & diagnostics</summary><pre id="install-log"></pre></details>
    </section>
  `,'Settings / Models & voices');
  document.getElementById('install-engine')?.addEventListener('click',()=>runInstall('install_engine',{},'engine'));
  document.getElementById('install-ipa')?.addEventListener('click',()=>runInstall('install_ipa',{},'ipa'));
  document.querySelectorAll('[data-install-model]').forEach(btn=>btn.addEventListener('click',()=>runInstall('install_model',{model:btn.dataset.installModel},'model')));
  document.querySelectorAll('[data-remove-model]').forEach(btn=>btn.addEventListener('click',()=>runInstall('remove_model',{model:btn.dataset.removeModel},'remove-model')));
  updateProgress();
}
async function runInstall(command,args,task) {
  if (!invoke || state.busy) return;
  state.busy=task;
  state.progress={task,stage:'starting',message:'Starting operation…',percent:null};
  state.logs.push(`[${task}] Starting`);render();
  try {
    state.status=await invoke(command,args);
    state.progress={task,stage:'done',message:'Completed successfully',percent:100};
    state.logs.push(`[${task}] Completed successfully`);
    tell('Operation completed successfully.');
  } catch(error) {
    state.logs.push(`[${task}] ERROR: ${error}`);
    state.progress={task,stage:'error',message:String(error),percent:null};
    tell('Installation error: '+String(error));
  } finally { state.busy='';render(); }
}
function updateProgress() {
  const p=state.progress;
  const message=document.getElementById('task-message');
  const bar=document.getElementById('progress-fill');
  const track=document.getElementById('progress-track');
  if(message)message.textContent=p?`${p.stage}: ${p.message}`:'Choose an installation action above.';
  if(bar) {
    bar.classList.toggle('indeterminate',!!p && p.percent===null && p.stage!=='error');
    bar.style.width=p?.percent!==null && Number.isFinite(p?.percent)?`${p.percent}%`:(p?.stage==='error'?'0%':'30%');
  }
  if(track) {
    const known=p&&Number.isFinite(p.percent);
    track.setAttribute('aria-valuetext',known?`${p.percent}%`:'Progress not measurable');
    if(known)track.setAttribute('aria-valuenow',String(p.percent));
    else track.removeAttribute('aria-valuenow');
  }
  const log=document.getElementById('install-log');
  if(log){log.textContent=state.logs.slice(-120).join('\n')||'No logs yet.';log.scrollTop=log.scrollHeight;}
}
function aboutPage() {
  layout(`
    ${heading('THE IDEA','About Shadowsh','A focused, offline-first pronunciation studio.')}
    <div class="models-list">
      <section class="card"><div class="empty-icon" style="margin:0 0 16px">${icon('keyboard',25)}</div><h2>1. Prepare your text</h2><p class="muted">Paste one spoken line per line break. Empty lines are ignored; punctuation will not split your practice units.</p></section>
      <section class="card"><div class="empty-icon" style="margin:0 0 16px">${icon('speaker',25)}</div><h2>2. Listen and repeat</h2><p class="muted">Use neural audio, speed adjustment, repeat and the microphone to practice your pronunciation.</p></section>
      <section class="card"><h2>IPA and context</h2><p class="muted">The US and UK dictionaries can show alternative word pronunciations. The first dictionary option may not fit the context. Natural reductions are not automatically transcribed.</p></section>
      <section class="card"><h2>Offline by design</h2><p class="muted">After downloading the voice engine, model and IPA dictionaries, your audio synthesis and practice happen locally without an account.</p></section>
    </div>
    <div class="callout" style="margin-top:20px"><strong>Limitations</strong><p class="small">Automatic accent scoring is not yet included. Neural accents do not automatically follow the dictionary selection. Microphone access depends on Windows WebView2 permissions.</p></div>
  `,'About / Shadowsh');
}
function render(){
  if(state.view==='models')modelsPage();
  else if(state.view==='about')aboutPage();
  else practicePage();
}
async function boot(){
  render();
  if(listen) {
    try {
      await listen('shadow-progress',event=>{
        const p=event.payload;state.progress=p;
        state.logs.push(`[${p.task}/${p.stage}] ${p.message}${p.percent===null?'':` (${p.percent}%)`}`);
        if(state.logs.length>500)state.logs.splice(0,state.logs.length-500);
        updateProgress();
      });
    } catch(error) {console.warn('Progress event connection failed',error);}
  }
  if(invoke) {
    try {state.status=await invoke('get_status');}
    catch(error){tell('Could not check installed components: '+String(error));}
    render();
  } else tell('Browser preview: desktop-only IPA and speech features require Tauri.');
}
boot();
