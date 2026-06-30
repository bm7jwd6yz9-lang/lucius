/* ============================================
   LUCIUS — Podcast Script Generator
   ============================================ */

(function () {
    'use strict';

    const ANTHROPIC_API = 'https://api.anthropic.com/v1/messages';
    const MODEL = 'claude-sonnet-4-6';
    const INPUT_COST_PER_MTOK = 3.00;
    const OUTPUT_COST_PER_MTOK = 15.00;

    const STORAGE_KEYS = {
        apiKey: 'lucius_api_key',
        episodes: 'lucius_episodes',
        costLog: 'lucius_cost_log',
        style: 'lucius_style',
        length: 'lucius_length',
    };

    // ---- State ----
    let currentScript = '';
    let synth = window.speechSynthesis;
    let currentUtterance = null;
    let isPlaying = false;
    let mediaRecorder = null;
    let audioChunks = [];
    let isRecording = false;

    // ---- DOM refs ----
    const $ = (sel) => document.querySelector(sel);
    const $$ = (sel) => document.querySelectorAll(sel);

    // ---- Init ----
    document.addEventListener('DOMContentLoaded', init);

    function init() {
        if (getApiKey()) {
            showApp();
        }
        bindEvents();
        loadVoices();
        loadSettings();
        loadTheme();
        synth.onvoiceschanged = loadVoices;
    }

    // ---- API Key ----
    function getApiKey() {
        return localStorage.getItem(STORAGE_KEYS.apiKey);
    }

    function showApp() {
        $('#apiKeyModal').classList.add('hidden');
        $('#app').classList.remove('hidden');
        updateCostDisplay();
        renderEpisodes();
    }

    // ---- Events ----
    function bindEvents() {
        $('#saveApiKey').addEventListener('click', () => {
            const key = $('#apiKeyInput').value.trim();
            if (key) {
                localStorage.setItem(STORAGE_KEYS.apiKey, key);
                showApp();
            }
        });

        $('#apiKeyInput').addEventListener('keydown', (e) => {
            if (e.key === 'Enter') $('#saveApiKey').click();
        });

        $('#rawInput').addEventListener('input', () => {
            $('#transformBtn').disabled = !$('#rawInput').value.trim();
        });

        $('#transformBtn').addEventListener('click', transformText);
        $('#recordBtn').addEventListener('click', toggleRecording);
        $('#uploadBtn').addEventListener('click', () => $('#audioFileInput').click());
        $('#audioFileInput').addEventListener('change', handleAudioUpload);

        $('#playBtn').addEventListener('click', togglePlay);
        $('#stopBtn').addEventListener('click', stopPlay);
        $('#speedSelect').addEventListener('change', () => {
            if (currentUtterance) currentUtterance.rate = parseFloat($('#speedSelect').value);
        });

        $('#saveEpisodeBtn').addEventListener('click', saveEpisode);
        $('#downloadBtn').addEventListener('click', downloadScript);

        // Tabs
        $$('.tab').forEach(tab => {
            tab.addEventListener('click', () => {
                $$('.tab').forEach(t => t.classList.remove('active'));
                $$('.tab-content').forEach(c => c.classList.remove('active'));
                tab.classList.add('active');
                $(`#${tab.dataset.tab}Tab`).classList.add('active');
            });
        });

        // Settings
        $('#darkModeBtn').addEventListener('click', toggleTheme);

        $('#settingsBtn').addEventListener('click', () => {
            $('#settingsPanel').classList.toggle('hidden');
            $('#costPanel').classList.add('hidden');
            $('#settingsApiKey').value = getApiKey() || '';
        });
        $('#closeSettings').addEventListener('click', () => $('#settingsPanel').classList.add('hidden'));

        $('#updateApiKey').addEventListener('click', () => {
            const key = $('#settingsApiKey').value.trim();
            if (key) {
                localStorage.setItem(STORAGE_KEYS.apiKey, key);
                $('#settingsPanel').classList.add('hidden');
            }
        });

        $('#podcastStyle').addEventListener('change', () => {
            localStorage.setItem(STORAGE_KEYS.style, $('#podcastStyle').value);
        });

        $('#episodeLength').addEventListener('change', () => {
            localStorage.setItem(STORAGE_KEYS.length, $('#episodeLength').value);
        });

        // Cost panel
        $('#costTrackerBtn').addEventListener('click', () => {
            $('#costPanel').classList.toggle('hidden');
            $('#settingsPanel').classList.add('hidden');
            updateCostDisplay();
        });
        $('#closeCost').addEventListener('click', () => $('#costPanel').classList.add('hidden'));
    }

    // ---- Theme ----
    function loadTheme() {
        const theme = localStorage.getItem('lucius_theme') || 'light';
        applyTheme(theme);
    }

    function applyTheme(theme) {
        document.documentElement.setAttribute('data-theme', theme);
        $('#sunIcon').classList.toggle('hidden', theme === 'dark');
        $('#moonIcon').classList.toggle('hidden', theme === 'light');
    }

    function toggleTheme() {
        const current = document.documentElement.getAttribute('data-theme') || 'light';
        const next = current === 'light' ? 'dark' : 'light';
        localStorage.setItem('lucius_theme', next);
        applyTheme(next);
    }

    // ---- Settings ----
    function loadSettings() {
        const style = localStorage.getItem(STORAGE_KEYS.style);
        const length = localStorage.getItem(STORAGE_KEYS.length);
        if (style) $('#podcastStyle').value = style;
        if (length) $('#episodeLength').value = length;
    }

    // ---- Voices ----
    function loadVoices() {
        const voices = synth.getVoices();
        const select = $('#voiceSelect');
        select.innerHTML = '';
        const preferred = voices.filter(v => v.lang.startsWith('en'));
        const list = preferred.length ? preferred : voices;
        list.forEach((voice, i) => {
            const opt = document.createElement('option');
            opt.value = i;
            opt.textContent = `${voice.name} (${voice.lang})`;
            opt.dataset.voiceName = voice.name;
            select.appendChild(opt);
        });
    }

    // ---- Transform ----
    async function transformText() {
        const raw = $('#rawInput').value.trim();
        if (!raw) return;

        const apiKey = getApiKey();
        if (!apiKey) return;

        const style = $('#podcastStyle').value;
        const length = $('#episodeLength').value;

        const lengthGuide = {
            brief: 'Keep it tight — around 150-300 words (1-2 minutes). Only expand on the most important points. Do NOT pad or add filler.',
            short: 'around 300-500 words (2-3 minutes when read aloud). Stay concise.',
            medium: 'around 700-1000 words (5-7 minutes when read aloud)',
            long: 'around 1500-2000 words (10-15 minutes when read aloud)',
        };

        const styleGuide = {
            conversational: 'warm, casual, and conversational — like chatting with a friend over coffee. Use "you" and "we" freely.',
            professional: 'polished and authoritative — like a news anchor or professional broadcaster. Clear, structured, confident.',
            storytelling: 'narrative and immersive — draw the listener in with vivid language, pacing, and a story arc.',
            educational: 'clear and informative — break down concepts step by step, use analogies, make complex ideas accessible.',
        };

        const wordCount = raw.split(/\s+/).length;
        const prompt = `You are a podcast script writer. Transform the following raw notes into a polished, ready-to-read podcast script.

Style: ${styleGuide[style]}
Length: ${lengthGuide[length]}

The raw input is approximately ${wordCount} words. Stay proportional — do NOT inflate short notes into long scripts. If the input is brief, the output should be brief. Only expand where it genuinely adds value.

Rules:
- Write a natural-sounding intro that hooks the listener — keep it short, not a full paragraph
- Organize the content with smooth transitions
- End with a brief, memorable closing — one or two sentences, not a long sign-off
- Do NOT include stage directions, speaker labels, or formatting markers
- Write it exactly as it should be spoken aloud — every word on the page is a word the host says
- Make it sound human, not robotic
- Do NOT add filler, repetition, or unnecessary padding to hit a word count

Raw notes:
${raw}`;

        // Show loading
        $('.btn-text').classList.add('hidden');
        $('.btn-loader').classList.remove('hidden');
        $('#transformBtn').disabled = true;

        try {
            const response = await fetch(ANTHROPIC_API, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'x-api-key': apiKey,
                    'anthropic-version': '2023-06-01',
                    'anthropic-dangerous-direct-browser-access': 'true',
                },
                body: JSON.stringify({
                    model: MODEL,
                    max_tokens: 8192,
                    messages: [{ role: 'user', content: prompt }],
                }),
            });

            if (!response.ok) {
                const err = await response.json().catch(() => ({}));
                throw new Error(err.error?.message || `API error ${response.status}`);
            }

            const data = await response.json();
            currentScript = data.content[0].text;

            const inputTokens = data.usage?.input_tokens || 0;
            const outputTokens = data.usage?.output_tokens || 0;
            const cost = (inputTokens * INPUT_COST_PER_MTOK + outputTokens * OUTPUT_COST_PER_MTOK) / 1_000_000;

            $('#scriptOutput').textContent = currentScript;
            $('#episodeCost').textContent = `$${cost.toFixed(4)}`;
            $('#outputArea').classList.remove('hidden');
            $('#outputArea').dataset.cost = cost;
            $('#outputArea').dataset.inputTokens = inputTokens;
            $('#outputArea').dataset.outputTokens = outputTokens;

        } catch (err) {
            alert(`Error: ${err.message}`);
        } finally {
            $('.btn-text').classList.remove('hidden');
            $('.btn-loader').classList.add('hidden');
            $('#transformBtn').disabled = !$('#rawInput').value.trim();
        }
    }

    function getScript() {
        const el = $('#scriptOutput');
        return el ? el.innerText.trim() : currentScript;
    }

    // ---- Playback ----
    function togglePlay() {
        if (!getScript()) return;

        if (isPlaying) {
            synth.pause();
            isPlaying = false;
            showPlayIcon(true);
            return;
        }

        if (synth.paused) {
            synth.resume();
            isPlaying = true;
            showPlayIcon(false);
            return;
        }

        const utterance = new SpeechSynthesisUtterance(getScript());
        utterance.rate = parseFloat($('#speedSelect').value);

        const voices = synth.getVoices();
        const select = $('#voiceSelect');
        const selectedOpt = select.options[select.selectedIndex];
        if (selectedOpt) {
            const voiceName = selectedOpt.dataset.voiceName;
            const voice = voices.find(v => v.name === voiceName);
            if (voice) utterance.voice = voice;
        }

        utterance.onend = () => {
            isPlaying = false;
            showPlayIcon(true);
            currentUtterance = null;
        };

        currentUtterance = utterance;
        synth.speak(utterance);
        isPlaying = true;
        showPlayIcon(false);
    }

    function stopPlay() {
        synth.cancel();
        isPlaying = false;
        showPlayIcon(true);
        currentUtterance = null;
    }

    function showPlayIcon(showPlay) {
        $('#playIcon').classList.toggle('hidden', !showPlay);
        $('#pauseIcon').classList.toggle('hidden', showPlay);
    }

    // ---- Recording ----
    async function toggleRecording() {
        if (isRecording) {
            mediaRecorder.stop();
            isRecording = false;
            $('#recordBtn').classList.remove('recording');
            $('#recordingIndicator').classList.add('hidden');
            return;
        }

        try {
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            mediaRecorder = new MediaRecorder(stream);
            audioChunks = [];

            mediaRecorder.ondataavailable = (e) => audioChunks.push(e.data);
            mediaRecorder.onstop = () => {
                stream.getTracks().forEach(t => t.stop());
                const blob = new Blob(audioChunks, { type: 'audio/webm' });
                transcribeAudio(blob);
            };

            mediaRecorder.start();
            isRecording = true;
            $('#recordBtn').classList.add('recording');
            $('#recordingIndicator').classList.remove('hidden');
        } catch (err) {
            alert('Could not access microphone. Please allow microphone access.');
        }
    }

    // ---- Audio Upload ----
    function handleAudioUpload(e) {
        const file = e.target.files[0];
        if (!file) return;
        transcribeAudio(file);
        e.target.value = '';
    }

    // ---- Transcription (Web Speech API) ----
    function transcribeAudio(blob) {
        if (!('webkitSpeechRecognition' in window || 'SpeechRecognition' in window)) {
            const reader = new FileReader();
            reader.onload = () => {
                alert('Speech recognition is not supported in this browser. Please try Chrome or Edge.');
            };
            reader.readAsArrayBuffer(blob);
            return;
        }

        $('#transcribingIndicator').classList.remove('hidden');

        const audio = new Audio(URL.createObjectURL(blob));
        const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
        const recognition = new SpeechRecognition();
        recognition.continuous = true;
        recognition.interimResults = false;
        recognition.lang = 'en-US';

        let transcript = '';

        recognition.onresult = (event) => {
            for (let i = event.resultIndex; i < event.results.length; i++) {
                if (event.results[i].isFinal) {
                    transcript += event.results[i][0].transcript + ' ';
                }
            }
        };

        recognition.onend = () => {
            $('#transcribingIndicator').classList.add('hidden');
            if (transcript.trim()) {
                const existing = $('#rawInput').value;
                $('#rawInput').value = existing ? existing + '\n\n' + transcript.trim() : transcript.trim();
                $('#transformBtn').disabled = false;
            } else {
                alert('Could not transcribe audio. Try speaking clearly or typing your notes instead.');
            }
        };

        recognition.onerror = (e) => {
            $('#transcribingIndicator').classList.add('hidden');
            if (e.error === 'not-allowed') {
                alert('Microphone access denied. Please allow it in your browser settings.');
            } else {
                alert('Transcription failed. Try typing your notes instead.');
            }
        };

        recognition.start();
        audio.play();
        audio.onended = () => {
            setTimeout(() => recognition.stop(), 1500);
        };
    }

    // ---- Save Episode ----
    function saveEpisode() {
        const script = getScript();
        if (!script) return;

        const episodes = JSON.parse(localStorage.getItem(STORAGE_KEYS.episodes) || '[]');
        const cost = parseFloat($('#outputArea').dataset.cost || 0);
        const firstLine = script.split('\n')[0].substring(0, 60);

        const episode = {
            id: Date.now(),
            title: firstLine || 'Untitled Episode',
            script: script,
            rawInput: $('#rawInput').value,
            cost: cost,
            date: new Date().toISOString(),
            style: $('#podcastStyle').value,
        };

        episodes.unshift(episode);
        localStorage.setItem(STORAGE_KEYS.episodes, JSON.stringify(episodes));

        // Log cost
        const costLog = JSON.parse(localStorage.getItem(STORAGE_KEYS.costLog) || '[]');
        costLog.unshift({
            id: episode.id,
            title: episode.title,
            cost: cost,
            date: episode.date,
        });
        localStorage.setItem(STORAGE_KEYS.costLog, JSON.stringify(costLog));

        updateCostDisplay();
        renderEpisodes();

        $('#saveEpisodeBtn').textContent = 'Saved ✓';
        setTimeout(() => { $('#saveEpisodeBtn').textContent = 'Save Episode'; }, 2000);
    }

    // ---- Download ----
    function downloadScript() {
        const script = getScript();
        if (!script) return;
        const blob = new Blob([script], { type: 'text/plain' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        const title = script.split('\n')[0].substring(0, 40).replace(/[^a-zA-Z0-9 ]/g, '').trim() || 'episode';
        a.download = `Lucius - ${title}.txt`;
        a.click();
        URL.revokeObjectURL(url);
    }

    // ---- Share ----
    function shareEpisode(ep) {
        const payload = {
            t: ep.title,
            s: ep.script,
            d: ep.date,
        };
        const json = JSON.stringify(payload);
        const encoded = btoa(unescape(encodeURIComponent(json)));

        const basePath = window.location.pathname.replace(/index\.html$/, '');
        const shareUrl = `${window.location.origin}${basePath}view.html#${encoded}`;

        if (navigator.clipboard) {
            navigator.clipboard.writeText(shareUrl).then(() => {
                alert('Link copied! Anyone with this link can listen — it won\'t appear anywhere public.');
            }).catch(() => {
                prompt('Copy this link to share:', shareUrl);
            });
        } else {
            prompt('Copy this link to share:', shareUrl);
        }
    }

    // ---- Cost Display ----
    function updateCostDisplay() {
        const costLog = JSON.parse(localStorage.getItem(STORAGE_KEYS.costLog) || '[]');
        const total = costLog.reduce((sum, e) => sum + e.cost, 0);
        const count = costLog.length;
        const avg = count ? total / count : 0;

        $('#totalCostBadge').textContent = `$${total.toFixed(2)}`;
        $('#totalSpent').textContent = `$${total.toFixed(4)}`;
        $('#totalEpisodes').textContent = count;
        $('#avgCost').textContent = `$${avg.toFixed(4)}`;

        const historyEl = $('#costHistory');
        historyEl.innerHTML = '';
        if (costLog.length === 0) {
            historyEl.innerHTML = '<p style="color: var(--ink-400); font-size: 0.85rem;">No episodes yet.</p>';
        } else {
            costLog.slice(0, 20).forEach(entry => {
                const div = document.createElement('div');
                div.className = 'cost-history-item';
                div.innerHTML = `
                    <span class="episode-name">${escapeHtml(entry.title)}</span>
                    <span class="episode-cost-val">$${entry.cost.toFixed(4)}</span>
                `;
                historyEl.appendChild(div);
            });
        }
    }

    // ---- Episodes List ----
    function renderEpisodes() {
        const episodes = JSON.parse(localStorage.getItem(STORAGE_KEYS.episodes) || '[]');
        const list = $('#episodesList');

        if (episodes.length === 0) {
            list.innerHTML = `
                <div class="empty-state">
                    <div class="empty-icon">
                        <svg viewBox="0 0 48 48" fill="none" stroke="currentColor" stroke-width="1.2">
                            <circle cx="24" cy="24" r="20"/>
                            <path d="M24 14v10l6 4" stroke-linecap="round" stroke-linejoin="round"/>
                        </svg>
                    </div>
                    <p>No episodes yet. Create your first one.</p>
                </div>`;
            return;
        }

        list.innerHTML = '';
        episodes.forEach(ep => {
            const card = document.createElement('div');
            card.className = 'episode-card';

            const date = new Date(ep.date);
            const dateStr = date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
            const preview = ep.script.substring(0, 120) + (ep.script.length > 120 ? '...' : '');

            card.innerHTML = `
                <div class="episode-card-header">
                    <span class="episode-title">${escapeHtml(ep.title)}</span>
                    <span class="episode-date">${dateStr}</span>
                </div>
                <p class="episode-preview">${escapeHtml(preview)}</p>
                <div class="episode-footer">
                    <span class="episode-cost">$${ep.cost.toFixed(4)}</span>
                    <div class="episode-actions">
                        <button class="episode-action-btn play-ep" data-id="${ep.id}">Play</button>
                        <button class="episode-action-btn download-ep" data-id="${ep.id}">Download</button>
                        <button class="episode-action-btn share-ep" data-id="${ep.id}">Share</button>
                        <button class="episode-action-btn delete" data-id="${ep.id}">Delete</button>
                    </div>
                </div>
            `;

            card.querySelector('.play-ep').addEventListener('click', (e) => {
                e.stopPropagation();
                currentScript = ep.script;
                stopPlay();
                togglePlay();
            });

            card.querySelector('.download-ep').addEventListener('click', (e) => {
                e.stopPropagation();
                const blob = new Blob([ep.script], { type: 'text/plain' });
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = `Lucius - ${ep.title.substring(0, 40)}.txt`;
                a.click();
                URL.revokeObjectURL(url);
            });

            card.querySelector('.share-ep').addEventListener('click', (e) => {
                e.stopPropagation();
                shareEpisode(ep);
            });

            card.querySelector('.delete').addEventListener('click', (e) => {
                e.stopPropagation();
                if (confirm('Delete this episode?')) {
                    deleteEpisode(ep.id);
                }
            });

            card.addEventListener('click', () => {
                currentScript = ep.script;
                $('#rawInput').value = ep.rawInput || '';
                $('#scriptOutput').textContent = ep.script;
                $('#episodeCost').textContent = `$${ep.cost.toFixed(4)}`;
                $('#outputArea').classList.remove('hidden');
                $('#transformBtn').disabled = false;
                $$('.tab')[0].click();
            });

            list.appendChild(card);
        });
    }

    function deleteEpisode(id) {
        let episodes = JSON.parse(localStorage.getItem(STORAGE_KEYS.episodes) || '[]');
        episodes = episodes.filter(e => e.id !== id);
        localStorage.setItem(STORAGE_KEYS.episodes, JSON.stringify(episodes));

        let costLog = JSON.parse(localStorage.getItem(STORAGE_KEYS.costLog) || '[]');
        costLog = costLog.filter(e => e.id !== id);
        localStorage.setItem(STORAGE_KEYS.costLog, JSON.stringify(costLog));

        updateCostDisplay();
        renderEpisodes();
    }

    function escapeHtml(str) {
        const div = document.createElement('div');
        div.textContent = str;
        return div.innerHTML;
    }
})();
