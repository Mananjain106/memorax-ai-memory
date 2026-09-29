// Frontend logic: status polling, streaming chat, mode display.
const $ = (id) => document.getElementById(id);
const messagesEl = $('messages');
const inputEl = $('input');
const sendBtn = $('send');
const badgeEl = $('mode-badge');
const dotEl = $('mode-dot');
const modeLabelEl = $('mode-label');
const modeDetailEl = $('mode-detail');
const engineInfoEl = $('engine-info');
const memoryInfoEl = $('memory-info');
const chatTitleEl = $('chat-title');

let history = []; // {role, content}
let sending = false;

const WELCOME_HTML = `
  <div class="welcome">
    <h1>AI Memory Assistant</h1>
    <p>Works online via OpenRouter and fully offline via a local model.</p>
    <p class="hint">The badge in the corner always shows the active mode.</p>
  </div>`;

// ---------- status polling ----------
async function pollStatus() {
  try {
    const res = await fetch('/status');
    const s = await res.json();
    const online = s.online;
    badgeEl.textContent = s.mode;
    badgeEl.className = 'badge ' + (online ? 'online' : 'offline');
    dotEl.className = 'dot ' + (online ? 'online' : 'offline');
    modeLabelEl.textContent = s.mode;
    modeDetailEl.textContent = online ? 'cloud models reachable' : 'no network — using local model';
    engineInfoEl.textContent = online ? 'engine: OpenRouter' : 'engine: local LLM';
  } catch {
    badgeEl.textContent = 'SERVER DOWN';
    badgeEl.className = 'badge offline';
    dotEl.className = 'dot offline';
    modeLabelEl.textContent = 'SERVER UNREACHABLE';
    modeDetailEl.textContent = 'backend not responding';
  }
}
pollStatus();
setInterval(pollStatus, 10000);

// ---------- memory info ----------
async function refreshMemoryInfo() {
  try {
    const res = await fetch('/health');
    const h = await res.json();
    const m = h.memory || {};
    memoryInfoEl.textContent = m.vectorSize
      ? `memory: qdrant (${m.vectorSize}-d)`
      : 'memory: unavailable';
  } catch {
    memoryInfoEl.textContent = 'memory: unavailable';
  }
}
refreshMemoryInfo();
setInterval(refreshMemoryInfo, 30000);

// ---------- chat rendering ----------
function addMessage(role, content, meta) {
  const welcome = messagesEl.querySelector('.welcome');
  if (welcome) welcome.remove();

  const wrap = document.createElement('div');
  wrap.className = 'msg ' + role;

  const avatar = document.createElement('div');
  avatar.className = 'avatar';
  avatar.textContent = role === 'user' ? 'Y' : '◆';

  const body = document.createElement('div');
  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  bubble.textContent = content || '';

  body.appendChild(bubble);
  if (meta) {
    const metaEl = document.createElement('div');
    metaEl.className = 'meta';
    metaEl.textContent = meta;
    body.appendChild(metaEl);
  }

  wrap.appendChild(avatar);
  wrap.appendChild(body);
  messagesEl.appendChild(wrap);
  messagesEl.scrollTop = messagesEl.scrollHeight;
  return { wrap, bubble, body };
}

function setSending(on) {
  sending = on;
  sendBtn.disabled = on;
  inputEl.disabled = on;
}

function metaLine(meta, memories) {
  let line = meta;
  if (memories && memories.length) {
    line += ` · 🧠 ${memories.length} memory${memories.length > 1 ? 'ies' : ''} recalled`;
  }
  return line;
}

// ---------- streaming send (SSE over fetch) ----------
async function parseSSE(res, handlers) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n\n')) !== -1) {
      const block = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      let event = 'message';
      let data = '';
      for (const line of block.split('\n')) {
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) data += line.slice(5).trim();
      }
      if (data) {
        try {
          handlers[event] && handlers[event](JSON.parse(data));
        } catch {}
      }
    }
  }
}

async function send() {
  const text = inputEl.value.trim();
  if (!text || sending) return;

  addMessage('user', text);
  history.push({ role: 'user', content: text });
  inputEl.value = '';
  inputEl.style.height = 'auto';
  chatTitleEl.textContent = text.slice(0, 30) + (text.length > 30 ? '…' : '');

  setSending(true);
  const ui = addMessage('assistant', '…');

  try {
    const res = await fetch('/api/chat/stream', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: history }),
    });
    if (!res.ok || !res.body) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || `HTTP ${res.status}`);
    }

    let answer = '';
    let meta = '';
    let memories = null;
    let firstToken = true;

    await parseSSE(res, {
      meta: (m) => {
        memories = m.memories || null;
        meta = `${m.model} · ${m.engine === 'local' ? 'OFFLINE · local' : m.engine}`;
      },
      delta: (d) => {
        if (firstToken) {
          firstToken = false;
          ui.bubble.textContent = '';
        }
        answer += d.text;
        ui.bubble.textContent = answer;
        messagesEl.scrollTop = messagesEl.scrollHeight;
      },
      error: (e) => {
        ui.bubble.textContent = (answer || '') + `\n⚠️ ${e.message}`;
      },
      done: (d) => {
        meta = metaLine(`${d.model} · ${d.engine === 'local' ? 'OFFLINE · local' : d.engine}`, memories);
      },
    });

    if (firstToken) ui.bubble.textContent = answer || '(empty response)';
    const metaEl = document.createElement('div');
    metaEl.className = 'meta';
    metaEl.textContent = metaLine(meta, memories);
    if (memories && memories.length) metaEl.title = memories.map((m) => m.text).join('\n---\n');
    ui.body.appendChild(metaEl);

    history.push({ role: 'assistant', content: answer });
  } catch (e) {
    ui.bubble.textContent = `⚠️ ${e.message}`;
    history.push({ role: 'assistant', content: `⚠️ ${e.message}` });
  } finally {
    setSending(false);
    inputEl.focus();
  }
}

$('composer').addEventListener('submit', (e) => {
  e.preventDefault();
  send();
});

inputEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    send();
  }
});

inputEl.addEventListener('input', () => {
  inputEl.style.height = 'auto';
  inputEl.style.height = Math.min(inputEl.scrollHeight, 160) + 'px';
});

$('new-chat').addEventListener('click', () => {
  history = [];
  messagesEl.innerHTML = WELCOME_HTML;
  chatTitleEl.textContent = 'New chat';
});

// ---------- memory browser ----------
const memoryPanel = $('memory-panel');
const memoryListEl = $('memory-list');
const memoryStatsEl = $('memory-stats');

function esc(s) {
  const d = document.createElement('div');
  d.textContent = s == null ? '' : String(s);
  return d.innerHTML;
}

async function refreshMemoryBrowser() {
  try {
    const res = await fetch('/api/memory/list?limit=100');
    const data = await res.json();
    memoryStatsEl.textContent = `${data.total} memor${data.total === 1 ? 'y' : 'ies'} stored · ${data.pending} pending cloud sync`;
    if (!data.points.length) {
      memoryListEl.innerHTML = '<div class="memory-item"><div class="mem-text">No memories yet. Chat to create some.</div></div>';
      return;
    }
    memoryListEl.innerHTML = data.points
      .map((p) => {
        const when = p.payload?.ts ? new Date(p.payload.ts).toLocaleString() : '';
        const badge = p.synced
          ? '<span class="mem-badge synced">SYNCED</span>'
          : '<span class="mem-badge pending">PENDING</span>';
        return `<div class="memory-item" data-id="${esc(p.id)}">
          <div class="mem-text">${esc(p.payload?.text)}</div>
          <div class="mem-meta">${badge}<span>${esc(when)}</span><span>· ${p.dims}-d</span>
            <button class="mem-del" data-id="${esc(p.id)}" title="Delete memory">Delete</button>
          </div>
        </div>`;
      })
      .join('');
  } catch (e) {
    memoryStatsEl.textContent = 'Failed to load memories';
  }
}

memoryListEl.addEventListener('click', async (e) => {
  const btn = e.target.closest('.mem-del');
  if (!btn) return;
  const id = btn.dataset.id;
  btn.disabled = true;
  try {
    await fetch(`/api/memory/points/${encodeURIComponent(id)}`, { method: 'DELETE' });
  } catch {}
  refreshMemoryBrowser();
  refreshMemoryInfo();
});

$('memory-toggle').addEventListener('click', () => {
  memoryPanel.classList.toggle('hidden');
  if (!memoryPanel.classList.contains('hidden')) refreshMemoryBrowser();
});
$('memory-close').addEventListener('click', () => memoryPanel.classList.add('hidden'));

$('memory-sync').addEventListener('click', async (e) => {
  const btn = e.currentTarget;
  btn.disabled = true;
  btn.textContent = '⟳ Syncing…';
  try {
    const res = await fetch('/api/memory/sync', { method: 'POST' });
    const r = await res.json();
    if (r.skipped) memoryStatsEl.textContent = 'Sync already running…';
  } catch {}
  btn.disabled = false;
  btn.textContent = '⟳ Sync';
  refreshMemoryBrowser();
});

$('memory-clear').addEventListener('click', async () => {
  if (!confirm('Delete ALL stored memories (local + Qdrant)? This cannot be undone.')) return;
  await fetch('/api/memory/clear', { method: 'POST' }).catch(() => {});
  refreshMemoryBrowser();
  refreshMemoryInfo();
});
