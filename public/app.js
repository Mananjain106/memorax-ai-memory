// MemoraX — Your AI. Your Memory. Anywhere.
// Frontend: chat history store, streaming chat, Edge Memory status + popover,
// automatic cloud-sync on reconnect (no manual button), toasts, right panel,
// memory activity, settings (developer mode), memory browser.
const $ = (id) => document.getElementById(id);
const esc = (s) => window.MemoraXMD.escapeHtml(s);

const appEl = $('app');
const messagesEl = $('messages');
const inputEl = $('input');
const sendBtn = $('send');
const chatTitleEl = $('chat-title');
const chatSubEl = $('chat-sub');
const toastsEl = $('toasts');

// ---------- state ----------
let chats = loadChats(); // [{id, title, createdAt, updatedAt, messages:[{role,content,meta,memories}]}]
let currentChatId = null;
let history = []; // active chat messages [{role, content}]
let sending = false;
let serverOnline = null; // null = unknown
let lastEdge = null; // last /api/memory/edge-status payload
let devMode = localStorage.getItem('memorax.dev') === '1';
let autoOpenEdge = localStorage.getItem('memorax.autoOpenEdge') !== '0'; // default on
let syncWatch = null; // interval handle while watching a sync run
let wasOffline = false;
let activeStreamChatId = null; // chat the in-flight request belongs to
let memoriesRecalledLast = 0; // memories injected into the last answer

const WELCOME_HTML = `
  <div class="welcome">
    <div class="welcome-logo">◆</div>
    <h1>MemoraX</h1>
    <p class="tagline">Your AI. Your Memory. Anywhere.</p>
    <p class="how">How can I help you?</p>
    <div class="suggestions">
      <button class="sug-card" data-suggest="Explain my project"><span class="sug-title">Explain my project</span><span class="sug-sub">Summarize what you are building</span></button>
      <button class="sug-card" data-suggest="Test my memory system"><span class="sug-title">Test my memory system</span><span class="sug-sub">Store and recall a fact</span></button>
      <button class="sug-card" data-suggest="Design an offline architecture"><span class="sug-title">Design an offline architecture</span><span class="sug-sub">Plan an offline-first system</span></button>
      <button class="sug-card" data-suggest="Help me debug my application"><span class="sug-title">Help me debug my application</span><span class="sug-sub">Describe the problem</span></button>
    </div>
  </div>`;

// ---------- tiny utils ----------
function relTime(ts) {
  if (!ts) return '—';
  const d = Date.now() - ts;
  if (d < 45e3) return 'just now';
  if (d < 90e3) return '1 min ago';
  if (d < 3600e3) return Math.round(d / 60e3) + ' min ago';
  if (d < 86400e3) return Math.round(d / 3600e3) + ' h ago';
  return Math.round(d / 86400e3) + ' d ago';
}
function toast(text, kind = 'ok', ms = 3800) {
  const t = document.createElement('div');
  t.className = 'toast ' + kind;
  const icon = kind === 'ok' ? '✓' : kind === 'warn' ? '↻' : '⚠';
  t.innerHTML = `<span>${icon}</span><span>${esc(text)}</span>`;
  toastsEl.appendChild(t);
  setTimeout(() => {
    t.classList.add('leaving');
    setTimeout(() => t.remove(), 350);
  }, ms);
}

// ---------- chat store ----------
function loadChats() {
  try { return JSON.parse(localStorage.getItem('memorax.chats') || '[]'); } catch { return []; }
}
function saveChats() {
  try { localStorage.setItem('memorax.chats', JSON.stringify(chats.slice(0, 60))); } catch {}
}
function currentChat() {
  return chats.find((c) => c.id === currentChatId) || null;
}
function newChat() {
  currentChatId = null;
  history = [];
  messagesEl.innerHTML = WELCOME_HTML;
  chatTitleEl.textContent = 'New chat';
  chatSubEl.textContent = '';
  renderHistory();
  refreshRightPanel();
  inputEl.focus();
}

// group label for a timestamp
function groupOf(ts) {
  const d = Date.now() - ts;
  const day = 86400e3;
  const startOfToday = new Date().setHours(0, 0, 0, 0);
  if (ts >= startOfToday) return 'Today';
  if (ts >= startOfToday - day) return 'Yesterday';
  if (d < 7 * day) return 'Previous 7 days';
  return 'Older';
}
const GROUP_ORDER = ['Today', 'Yesterday', 'Previous 7 days', 'Older'];

function renderHistory() {
  const q = ($('chat-search').value || '').toLowerCase();
  const wrap = $('chat-history');
  const filtered = chats
    .filter((c) => !q || (c.title || '').toLowerCase().includes(q))
    .sort((a, b) => b.updatedAt - a.updatedAt);
  if (!filtered.length) {
    wrap.innerHTML = `<div class="chat-empty">${q ? 'No chats match “' + esc(q) + '”' : 'No conversations yet. Start chatting — MemoraX remembers the important parts automatically.'}</div>`;
    return;
  }
  const groups = {};
  for (const c of filtered) (groups[groupOf(c.updatedAt)] ||= []).push(c);
  wrap.innerHTML = GROUP_ORDER.filter((g) => groups[g]?.length)
    .map((g) => {
      const items = groups[g]
        .map((c) => {
          const active = c.id === currentChatId ? ' active' : '';
          const time = `<span class="ci-time">${relTime(c.updatedAt)}</span>`;
          return `<div class="chat-item${active}" data-id="${c.id}" role="button" tabindex="0">
            <span class="ci-title">${esc(c.title || 'New chat')}</span>${time}
            <button class="ci-menu" data-menu="${c.id}" title="Options" aria-label="Chat options">⋯</button>
          </div>`;
        })
        .join('');
      return `<div class="group-label">${g}</div>${items}`;
    })
    .join('');
}

function openChat(id) {
  const c = chats.find((x) => x.id === id);
  if (!c) return;
  currentChatId = id;
  history = c.messages.map((m) => ({ role: m.role, content: m.content }));
  chatTitleEl.textContent = c.title || 'New chat';
  renderHistory();
  renderStoredMessages(c);
  refreshRightPanel();
  closeDrawer();
}
function renderStoredMessages(c) {
  messagesEl.innerHTML = '';
  if (!c.messages.length) { messagesEl.innerHTML = WELCOME_HTML; return; }
  for (const m of c.messages) {
    const ui = addMessage(m.role, m.role === 'user' ? m.content : '');
    if (m.role === 'assistant') {
      ui.bubble.innerHTML = window.MemoraXMD.render(m.content || '');
      attachAssistantTools(ui, m);
    }
    if (m.meta) {
      const metaEl = document.createElement('div');
      metaEl.className = 'meta';
      metaEl.textContent = metaLine(m.meta, m.memories);
      ui.body.appendChild(metaEl);
    }
  }
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

// chat-item click + three-dot menu (rename / delete)
$('chat-history').addEventListener('click', (e) => {
  const menuBtn = e.target.closest('.ci-menu');
  if (menuBtn) {
    e.stopPropagation();
    chatItemMenu(menuBtn.dataset.menu, menuBtn);
    return;
  }
  const item = e.target.closest('.chat-item');
  if (item) openChat(item.dataset.id);
});
function chatItemMenu(id, anchor) {
  const existing = document.querySelector('.ci-dropdown');
  if (existing) existing.remove();
  const dd = document.createElement('div');
  dd.className = 'ci-dropdown';
  dd.innerHTML = `<button data-act="rename">Rename</button><button data-act="delete" class="danger">Delete</button>`;
  document.body.appendChild(dd);
  const r = anchor.getBoundingClientRect();
  dd.style.top = r.bottom + 4 + 'px';
  dd.style.left = Math.min(r.left, window.innerWidth - 150) + 'px';
  const close = () => { dd.remove(); document.removeEventListener('click', close); };
  setTimeout(() => document.addEventListener('click', close), 0);
  dd.addEventListener('click', async (e) => {
    const act = e.target.closest('button')?.dataset.act;
    if (!act) return;
    close();
    const c = chats.find((x) => x.id === id);
    if (!c) return;
    if (act === 'rename') {
      const name = prompt('Rename chat', c.title || '');
      if (name && name.trim()) { c.title = name.trim(); saveChats(); if (id === currentChatId) chatTitleEl.textContent = c.title; renderHistory(); }
    } else if (act === 'delete') {
      // Deleting a chat only removes the conversation — long-term memory is kept.
      chats = chats.filter((x) => x.id !== id);
      saveChats();
      if (id === currentChatId) newChat();
      else renderHistory();
      toast('Chat deleted — long-term memory kept', 'ok');
    }
  });
}
$('chat-search').addEventListener('input', renderHistory);

// ---------- message rendering ----------
function addMessage(role, content) {
  const welcome = messagesEl.querySelector('.welcome');
  if (welcome) welcome.remove();
  const wrap = document.createElement('div');
  wrap.className = 'msg ' + role;
  wrap.innerHTML = `
    <div class="msg-inner">
      <div class="avatar">${role === 'user' ? 'Y' : '◆'}</div>
      <div class="msg-body"></div>
    </div>`;
  const body = wrap.querySelector('.msg-body');
  if (role === 'user') {
    const t = document.createElement('div');
    t.className = 'msg-user-text';
    t.textContent = content || '';
    body.appendChild(t);
  } else {
    const c = document.createElement('div');
    c.className = 'msg-content';
    c.textContent = content || '';
    body.appendChild(c);
  }
  messagesEl.appendChild(wrap);
  messagesEl.scrollTop = messagesEl.scrollHeight;
  return { wrap, body, bubble: body.querySelector('.msg-content') || body.querySelector('.msg-user-text') };
}
function metaLine(meta, memories) {
  let line = meta || '';
  if (memories && memories.length) line += ` · 🧠 ${memories.length} memor${memories.length > 1 ? 'ies' : 'y'} recalled`;
  return line;
}
function nearBottom() {
  return messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < 120;
}

// assistant message tools: copy / regenerate (last only) / edit (user, last only)
function attachAssistantTools(ui, msgObj) {
  const tools = document.createElement('div');
  tools.className = 'msg-tools';
  const isLastAssistant = history.filter((m) => m.role === 'assistant').slice(-1)[0]?.content === (msgObj?.content ?? ui.bubble.textContent);
  tools.innerHTML = `
    <button class="tool-btn" data-tool="copy">⧉ Copy</button>
    ${isLastAssistant ? '<button class="tool-btn" data-tool="regen">↻ Regenerate</button>' : ''}`;
  ui.body.appendChild(tools);
  tools.querySelector('[data-tool="copy"]').addEventListener('click', () => {
    navigator.clipboard.writeText(ui.bubble.textContent).then(() => toast('Copied', 'ok', 1500));
  });
  const regen = tools.querySelector('[data-tool="regen"]');
  if (regen) regen.addEventListener('click', regenerate);
}
function attachUserTools(ui) {
  const tools = document.createElement('div');
  tools.className = 'msg-tools';
  tools.innerHTML = '<button class="tool-btn" data-tool="edit">✎ Edit</button>';
  ui.body.appendChild(tools);
  tools.querySelector('[data-tool="edit"]').addEventListener('click', () => editLastUser(ui));
}

// Provider-error recovery: OpenRouter failed while online (429 quota, outage).
// Nothing retries automatically — this button is the USER re-sending the same
// turn. The failed bubble and the user's message stay in the chat untouched.
function attachRetryTool(ui) {
  const tools = document.createElement('div');
  tools.className = 'msg-tools';
  tools.innerHTML = '<button class="tool-btn retry-btn" data-tool="retry">↻ Retry</button>';
  ui.body.appendChild(tools);
  tools.querySelector('[data-tool="retry"]').addEventListener('click', () => {
    if (sending) return;
    // Drop only the failed assistant bubble; the user's message is preserved.
    if (history.length && history[history.length - 1].role === 'assistant') history.pop();
    const c = currentChat();
    if (c && c.messages.length && c.messages[c.messages.length - 1].role === 'assistant') c.messages.pop();
    renderCurrentChat();
    streamAssistant();
  });
}
function editLastUser(ui) {
  const lastUserIdx = history.map((m) => m.role).lastIndexOf('user');
  if (lastUserIdx < 0 || sending) return;
  const original = history[lastUserIdx].content;
  const box = document.createElement('div');
  box.className = 'edit-box';
  box.innerHTML = `
    <textarea>${esc(original)}</textarea>
    <div class="edit-actions"><button class="ea-send">Send</button><button class="ea-cancel">Cancel</button></div>`;
  ui.body.querySelector('.msg-user-text').replaceWith(box);
  const ta = box.querySelector('textarea');
  ta.focus();
  ta.setSelectionRange(ta.value.length, ta.value.length);
  box.querySelector('.ea-cancel').addEventListener('click', () => renderCurrentChat());
  box.querySelector('.ea-send').addEventListener('click', () => {
    const val = ta.value.trim();
    if (!val) return;
    history = history.slice(0, lastUserIdx);
    history.push({ role: 'user', content: val });
    if (currentChat()) {
      const c = currentChat();
      c.messages = c.messages.slice(0, lastUserIdx);
      c.messages.push({ role: 'user', content: val });
      c.updatedAt = Date.now();
      saveChats();
    }
    streamAssistant(val);
  });
}
function renderCurrentChat() {
  const c = currentChat();
  if (c) renderStoredMessages(c);
}

// ---------- SSE ----------
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
        try { handlers[event] && handlers[event](JSON.parse(data)); } catch {}
      }
    }
  }
}

// ---------- streaming send ----------
function ensureChat() {
  if (currentChat()) return currentChat();
  const c = {
    id: 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    title: 'New chat',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    messages: [],
  };
  chats.unshift(c);
  currentChatId = c.id;
  return c;
}

async function send() {
  const text = inputEl.value.trim();
  if (!text || sending) return;
  inputEl.value = '';
  inputEl.style.height = 'auto';

  const c0 = ensureChat();
  if (c0.title === 'New chat') {
    c0.title = text.slice(0, 42) + (text.length > 42 ? '…' : '');
    chatTitleEl.textContent = c0.title;
  }
  history.push({ role: 'user', content: text });
  c0.messages.push({ role: 'user', content: text });
  c0.updatedAt = Date.now();
  saveChats();

  const ui = addMessage('user', text);
  attachUserTools(ui);
  renderHistory();
  streamAssistant(text);
}

async function streamAssistant() {
  sending = true;
  sendBtn.disabled = true;
  activeStreamChatId = currentChatId; // remember which chat this stream belongs to
  inputEl.placeholder = 'MemoraX is thinking…';

  const ui = addMessage('assistant', '');
  ui.bubble.innerHTML = '<div class="bubble-loading"><span></span><span></span><span></span></div>';
  let lastRender = 0;
  const renderStream = (force) => {
    const now = Date.now();
    if (!force && now - lastRender < 60) return;
    lastRender = now;
    ui.bubble.innerHTML = window.MemoraXMD.render(streamText || '');
    if (nearBottom()) messagesEl.scrollTop = messagesEl.scrollHeight;
  };

  let streamText = '';
  let meta = '';
  let memories = null;
  let providerError = null; // typed SSE error payload {message, retryable, error_type}

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
    await parseSSE(res, {
      meta: (m) => {
        memories = m.memories || null;
        meta = `${m.model} · ${m.engine === 'local' || m.engine === 'local-fallback' ? 'OFFLINE · local' : m.engine}`;
      },
      delta: (d) => { streamText += d.text; renderStream(false); },
      error: (e) => {
        providerError = e || null; // no automatic retry happens anywhere
        streamText += (streamText ? '\n\n' : '') + `⚠️ ${e.message}`;
        renderStream(true);
      },
      done: (d) => { meta = `${d.model} · ${d.engine === 'local' || d.engine === 'local-fallback' ? 'OFFLINE · local' : d.engine}`; },
    });
    if (!streamText.trim()) streamText = '(empty response)';
    renderStream(true);

    const metaEl = document.createElement('div');
    metaEl.className = 'meta';
    metaEl.textContent = metaLine(meta, memories);
    if (memories && memories.length) metaEl.title = memories.map((m) => m.text).join('\n---\n');
    ui.body.appendChild(metaEl);

    history.push({ role: 'assistant', content: streamText });
    // persist into the chat the stream was STARTED in (user may have switched)
    const c = chats.find((x) => x.id === activeStreamChatId) || currentChat();
    if (c) {
      c.messages.push({ role: 'assistant', content: streamText, meta, memories });
      c.updatedAt = Date.now();
      saveChats();
    }
    memoriesRecalledLast = memories ? memories.length : 0;
    attachAssistantTools({ body: ui.body, bubble: ui.bubble }, { content: streamText });
    if (providerError) attachRetryTool(ui); // user-initiated retry only
    refreshRightPanel();
  } catch (e) {
    ui.bubble.innerHTML = window.MemoraXMD.render(`⚠️ ${e.message}`);
    history.push({ role: 'assistant', content: `⚠️ ${e.message}` });
    const c = chats.find((x) => x.id === activeStreamChatId) || currentChat();
    if (c) c.messages.push({ role: 'assistant', content: `⚠️ ${e.message}` });
    saveChats();
  } finally {
    sending = false;
    sendBtn.disabled = false;
    inputEl.placeholder = serverOnline ? 'Message MemoraX...' : 'Message MemoraX offline...';
    inputEl.focus();
  }
}

function regenerate() {
  if (sending) return;
  // drop the trailing assistant message, re-run on the same user turn
  if (history.length && history[history.length - 1].role === 'assistant') history.pop();
  const c = currentChat();
  if (c && c.messages.length && c.messages[c.messages.length - 1].role === 'assistant') c.messages.pop();
  renderCurrentChat();
  streamAssistant();
}

// ---------- composer ----------
$('composer').addEventListener('submit', (e) => { e.preventDefault(); send(); });
inputEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
});
inputEl.addEventListener('input', () => {
  inputEl.style.height = 'auto';
  inputEl.style.height = Math.min(inputEl.scrollHeight, 180) + 'px';
});
$('new-chat').addEventListener('click', newChat);
messagesEl.addEventListener('click', (e) => {
  const sug = e.target.closest('.sug-card');
  if (sug) { inputEl.value = sug.dataset.suggest; send(); }
});

// ---------- status + edge memory ----------
function applyConnectivity(online) {
  serverOnline = online;
  const dot = $('net-dot');
  dot.className = 'pill-dot ' + (online ? 'online' : 'offline');
  // STRICT ROUTING labels: online = OpenRouter, offline = Local AI. The
  // provider is determined by connectivity only — never by failures.
  $('net-label').textContent = online ? 'Online · OpenRouter' : 'Offline · Local AI';
  $('pop-net-dot').className = 'dot ' + (online ? 'ok' : 'warn');
  $('pop-net').textContent = online ? 'Online' : 'Offline';
  if (!sending) inputEl.placeholder = online ? 'Message MemoraX...' : 'Message MemoraX offline...';
  const note = $('composer-note');
  if (online) {
    note.textContent = 'MemoraX remembers automatically. It runs online or fully offline.';
    note.classList.remove('offline-hint');
  } else {
    note.textContent = 'Offline — running on your device. Memories sync automatically when you are back online.';
    note.classList.add('offline-hint');
  }
  $('foot-engine-note').textContent = online ? '◆ OpenRouter + Qdrant Cloud' : '◆ Local model + Qdrant Edge';
}

async function pollStatus() {
  try {
    const res = await fetch('/status');
    const s = await res.json();
    const prev = serverOnline;
    applyConnectivity(Boolean(s.online));
    if (prev === false && s.online && wasOffline) {
      wasOffline = false;
      onReconnect();
    }
    if (!s.online) wasOffline = true;
  } catch {
    applyConnectivity(false);
    wasOffline = true;
  }
}

async function pollEdge(deep = false) {
  try {
    const res = await fetch('/api/memory/edge-status' + (deep ? '?deep=1' : ''));
    const s = await res.json();
    if (!s.ok) return;
    lastEdge = s;
    $('pop-local-count').textContent = s.localMemory.count;
    $('pop-pending').textContent = s.pendingSync;
    $('pop-last-sync').textContent = relTime(s.lastSyncAt);
    const cloudEl = $('pop-cloud');
    if (!s.online) {
      cloudEl.innerHTML = '<span class="dot idle"></span> Waiting for connection';
    } else if (s.cloud.connected) {
      cloudEl.innerHTML = '<span class="dot ok"></span> Connected';
    } else {
      cloudEl.innerHTML = '<span class="dot err"></span> Unavailable';
    }
    $('pop-offline-note').classList.toggle('hidden', Boolean(s.online));
    refreshRightPanel();
    refreshDevGrid();
  } catch {}
}

// popover open/close
$('edge-pill').addEventListener('click', (e) => {
  e.stopPropagation();
  $('edge-pop').classList.toggle('hidden');
  if (!$('edge-pop').classList.contains('hidden')) pollEdge(true);
});
document.addEventListener('click', (e) => {
  if (!e.target.closest('#edge-wrap')) $('edge-pop').classList.add('hidden');
});

// ---------- AUTOMATIC cloud sync on reconnect ----------
// The user never clicks "Sync now". When connectivity returns we trigger the
// backend drain once, then watch the queue until it is drained and report.
function onReconnect() {
  toast('Back online' + (lastEdge && lastEdge.pendingSync ? ` — syncing ${lastEdge.pendingSync} memor${lastEdge.pendingSync === 1 ? 'y' : 'ies'}...` : ' — checking sync queue...'), 'ok', 4200);
  if (autoOpenEdge) $('edge-pop').classList.remove('hidden');
  // fire the backend worker once (it is idempotent + safe while offline)
  fetch('/api/memory/sync', { method: 'POST' }).catch(() => {});
  watchSync();
}

function watchSync() {
  if (syncWatch) return;
  let ticks = 0;
  const startPending = lastEdge ? lastEdge.pendingSync : null;
  syncWatch = setInterval(async () => {
    ticks++;
    try {
      const res = await fetch('/api/memory/edge-status');
      const s = await res.json();
      if (!s.ok) return;
      lastEdge = s;
      if (!s.online) { clearInterval(syncWatch); syncWatch = null; return; }
      if (s.pendingSync === 0) {
        clearInterval(syncWatch);
        syncWatch = null;
        const synced = startPending != null ? startPending : 0;
        toast(synced > 0 ? `${synced} memor${synced === 1 ? 'y' : 'ies'} synced` : 'Back online — nothing to sync', 'ok', 3600);
        pollEdge(true);
      } else if (ticks > 40) { // ~2 min guard
        clearInterval(syncWatch);
        syncWatch = null;
      }
    } catch { clearInterval(syncWatch); syncWatch = null; }
  }, 3000);
}

// ---------- right panel ----------
async function refreshRightPanel() {
  const c = currentChat();
  $('rp-created').textContent = c ? new Date(c.createdAt).toLocaleString() : '—';
  $('rp-last').textContent = c ? relTime(c.updatedAt) : '—';
  $('rp-msgs').textContent = c ? c.messages.length : 0;

  // memory activity (recent decisions)
  const memEl = $('rp-memory');
  const rows = [];
  if (memoriesRecalledLast) {
    rows.push(`<div class="rp-item"><span class="ic-emoji">✓</span><span>Retrieved ${memoriesRecalledLast} relevant memor${memoriesRecalledLast === 1 ? 'y' : 'ies'}</span></div>`);
  }
  try {
    const res = await fetch('/api/memory/decisions?limit=8');
    const d = await res.json();
    for (const dec of (d.decisions || []).slice(0, 6)) {
      const decision = dec.decision || '';
      const action = dec.outcome?.action || '';
      if (decision === 'DISCARD') {
        rows.push(`<div class="rp-item dim"><span class="ic-emoji">·</span><span>Discarded (not worth remembering)</span></div>`);
      } else if (decision === 'CONFLICT' || action === 'conflict-flagged') {
        rows.push(`<div class="rp-item"><span class="ic-emoji">⚠</span><span>Conflict flagged — needs review</span></div>`);
      } else if (action === 'merged' || decision === 'MERGE') {
        rows.push(`<div class="rp-item"><span class="ic-emoji">↻</span><span>Merged duplicate memory</span></div>`);
      } else if (action === 'stored' || decision === 'LOCAL_ONLY' || decision === 'LOCAL_AND_CLOUD' || decision === 'TEMPORARY_LOCAL') {
        const where = decision === 'LOCAL_ONLY' ? 'locally (private)' : decision === 'TEMPORARY_LOCAL' ? 'locally (temporary)' : 'locally + cloud queued';
        rows.push(`<div class="rp-item"><span class="ic-emoji">✓</span><span>Memory saved ${where}</span></div>`);
      }
    }
  } catch {}
  memEl.innerHTML = rows.length ? rows.join('') : '<div class="rp-empty">No memory activity yet. Just chat — MemoraX decides automatically what to remember.</div>';

  // sync activity
  const syncEl = $('rp-sync');
  const srows = [];
  try {
    const res = await fetch('/api/sync/queue');
    const q = await res.json();
    const counts = q.counts || {};
    if ((counts.PENDING || 0) + (counts.SYNCING || 0) > 0) {
      srows.push(`<div class="rp-item"><span class="ic-emoji">↻</span><span>${(counts.PENDING || 0) + (counts.SYNCING || 0)} waiting for cloud sync</span></div>`);
    }
    if (counts.SYNCED) srows.push(`<div class="rp-item"><span class="ic-emoji">✓</span><span>${counts.SYNCED} synced</span></div>`);
    if (counts.FAILED) srows.push(`<div class="rp-item"><span class="ic-emoji">⚠</span><span>${counts.FAILED} failed — will retry</span></div>`);
    const cres = await fetch('/api/conflicts');
    const cf = await cres.json();
    const open = (cf.conflicts || []).filter((x) => x.status === 'REQUIRES_REVIEW').length;
    if (open) srows.push(`<div class="rp-item"><span class="ic-emoji">⚠</span><span>${open} conflict${open > 1 ? 's' : ''} need review</span></div>`);
    if (!srows.length) srows.push('<div class="rp-empty">Queue is clear — everything is synced.</div>');
  } catch {
    srows.push('<div class="rp-empty">Sync status unavailable.</div>');
  }
  syncEl.innerHTML = srows.join('');
}

// panel toggle
$('panel-toggle').addEventListener('click', () => {
  appEl.classList.toggle('panel-open');
  if (appEl.classList.contains('panel-open')) refreshRightPanel();
});
$('panel-close').addEventListener('click', () => appEl.classList.remove('panel-open'));

// ---------- modals ----------
function openModal(id) { $(id).classList.remove('hidden'); }
function closeModal(id) { $(id).classList.add('hidden'); }
document.addEventListener('click', (e) => {
  const closer = e.target.closest('[data-close]');
  if (closer) closeModal(closer.dataset.close);
  if (e.target.classList.contains('modal')) e.target.classList.add('hidden');
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    document.querySelectorAll('.modal:not(.hidden)').forEach((m) => m.classList.add('hidden'));
    $('edge-pop').classList.add('hidden');
  }
});

// memory activity modal
$('open-activity').addEventListener('click', () => {
  $('edge-pop').classList.add('hidden');
  openModal('activity-modal');
  loadActivity();
});
async function loadActivity() {
  const list = $('activity-list');
  list.innerHTML = '<div class="rp-empty">Loading…</div>';
  try {
    const [dRes, qRes, cRes] = await Promise.all([
      fetch('/api/memory/decisions?limit=40'),
      fetch('/api/sync/queue'),
      fetch('/api/conflicts'),
    ]);
    const d = await dRes.json();
    const q = await qRes.json();
    const cf = await cRes.json();
    const rows = [];
    for (const dec of d.decisions || []) {
      const decision = dec.decision || '';
      const action = dec.outcome?.action || '';
      let badge = '', cls = '', icon = '·', text = dec.extract || dec.message || '';
      if (decision === 'DISCARD') { badge = 'DISCARDED'; cls = 'discarded'; icon = '·'; }
      else if (decision === 'CONFLICT' || action === 'conflict-flagged') { badge = 'CONFLICT'; cls = 'conflict'; icon = '⚠'; }
      else if (action === 'merged' || decision === 'MERGE') { badge = 'MERGED'; cls = 'merged'; icon = '↻'; }
      else if (action === 'stored') {
        if (dec.outcome?.queued || dec.outcome?.cloud === 'queued') { badge = 'SAVED · PENDING SYNC'; cls = 'queued'; icon = '↻'; }
        else if (dec.outcome?.cloud === 'synced') { badge = 'SAVED · SYNCED'; cls = 'stored'; icon = '✓'; }
        else { badge = 'SAVED LOCALLY'; cls = 'stored'; icon = '✓'; }
      } else { badge = decision.toUpperCase(); cls = 'discarded'; icon = '·'; }
      const when = dec.at ? new Date(dec.at).toLocaleString() : '';
      rows.push(`<div class="activity-row">
        <span class="act-ic">${icon}</span>
        <div class="act-main">
          <div class="act-text">${esc(String(text).slice(0, 160))}</div>
          <div class="act-sub">${esc(when)} · importance ${dec.scores?.importance ?? '–'} · ${esc(dec.reason || '')}</div>
        </div>
        <span class="act-badge ${cls}">${badge}</span>
      </div>`);
    }
    const openConflicts = (cf.conflicts || []).filter((x) => x.status === 'REQUIRES_REVIEW');
    for (const c of openConflicts) {
      rows.unshift(`<div class="activity-row">
        <span class="act-ic">⚠</span>
        <div class="act-main">
          <div class="act-text">Conflict: local vs cloud versions differ</div>
          <div class="act-sub">local v${c.versions?.local ?? '–'} · cloud v${c.versions?.cloud ?? '–'} · ${esc(c.reason || '')}</div>
        </div>
        <span class="act-badge conflict">CONFLICT</span>
      </div>`);
    }
    list.innerHTML = rows.length ? rows.join('') : '<div class="rp-empty">No memory decisions yet. Chat with MemoraX — it will remember the important things automatically.</div>';
  } catch {
    list.innerHTML = '<div class="rp-empty">Could not load memory activity.</div>';
  }
}

// ---------- settings ----------
$('open-settings').addEventListener('click', () => {
  $('set-devmode').checked = devMode;
  $('set-auto-open').checked = autoOpenEdge;
  openModal('settings-modal');
  refreshDevGrid();
});
$('set-devmode').addEventListener('change', (e) => {
  devMode = e.target.checked;
  localStorage.setItem('memorax.dev', devMode ? '1' : '0');
  $('dev-section').classList.toggle('hidden', !devMode);
});
$('set-auto-open').addEventListener('change', (e) => {
  autoOpenEdge = e.target.checked;
  localStorage.setItem('memorax.autoOpenEdge', autoOpenEdge ? '1' : '0');
});
$('dev-sync-now').addEventListener('click', async (e) => {
  e.target.disabled = true;
  try { await fetch('/api/memory/sync', { method: 'POST' }); toast('Diagnostic sync finished', 'ok'); } catch {}
  e.target.disabled = false;
  pollEdge(true);
});
$('dev-memory-browser').addEventListener('click', () => {
  closeModal('settings-modal');
  openModal('memory-modal');
  refreshMemoryBrowser();
});

async function refreshDevGrid() {
  if (!devMode) return;
  try {
    const res = await fetch('/health');
    const h = await res.json();
    const m = h.memory || {};
    const rows = [
      ['Mode', h.mode],
      ['Engine', h.openrouter?.configured ? `OpenRouter (${h.openrouter?.model})` : 'not configured'],
      ['Local LLM', `${h.local?.model} (${h.local?.runtime})`],
      ['Qdrant', m.configured ? `${m.collection} · ${m.vectorSize || '?'}-d` : 'not configured'],
      ['Local memories', `${m.local?.count ?? 0} (${m.local?.pending ?? 0} pending)`],
      ['Uptime', Math.round(h.uptime || 0) + 's'],
    ];
    $('dev-grid').innerHTML = rows
      .map(([k, v]) => `<div class="kv"><span>${esc(k)}</span><b>${esc(v)}</b></div>`)
      .join('');
  } catch {}
}

// ---------- memory browser (developer) ----------
async function refreshMemoryBrowser() {
  const listEl = $('memory-list');
  const statsEl = $('memory-stats');
  try {
    const res = await fetch('/api/memory/list?limit=100');
    const data = await res.json();
    statsEl.textContent = `${data.total} memor${data.total === 1 ? 'y' : 'ies'} stored · ${data.pending} pending cloud sync`;
    if (!data.points.length) {
      listEl.innerHTML = '<div class="rp-empty">No memories yet. Chat to create some — MemoraX saves them automatically.</div>';
      return;
    }
    listEl.innerHTML = data.points
      .map((p) => {
        const when = p.payload?.ts ? new Date(p.payload.ts).toLocaleString() : '';
        const badge = p.synced ? '<span class="mem-badge synced">SYNCED</span>' : '<span class="mem-badge pending">PENDING</span>';
        return `<div class="memory-item" data-id="${esc(p.id)}">
          <div class="mem-text">${esc(p.payload?.text)}</div>
          <div class="mem-meta">${badge}<span>${esc(when)}</span><span>· ${p.payload?.category || 'other'}</span>
            <button class="mem-del" data-id="${esc(p.id)}" title="Delete memory">Delete</button>
          </div>
        </div>`;
      })
      .join('');
  } catch {
    statsEl.textContent = 'Failed to load memories';
  }
}
$('memory-list').addEventListener('click', async (e) => {
  const btn = e.target.closest('.mem-del');
  if (!btn) return;
  btn.disabled = true;
  try { await fetch(`/api/memory/points/${encodeURIComponent(btn.dataset.id)}`, { method: 'DELETE' }); } catch {}
  refreshMemoryBrowser();
  pollEdge();
});

// ---------- mobile drawer ----------
$('sidebar-open').addEventListener('click', () => {
  appEl.classList.add('nav-open');
  $('scrim').classList.remove('hidden');
});
function closeDrawer() {
  appEl.classList.remove('nav-open');
  $('scrim').classList.add('hidden');
}
$('sidebar-close').addEventListener('click', closeDrawer);
$('scrim').addEventListener('click', closeDrawer);

// ---------- boot ----------
messagesEl.innerHTML = WELCOME_HTML;
renderHistory();
pollStatus();
pollEdge();
setInterval(pollStatus, 5000);
setInterval(() => pollEdge(false), 10000);
setInterval(refreshRightPanel, 15000);
if (devMode) $('dev-section').classList.remove('hidden');
