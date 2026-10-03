// Offline LLM runtimes. No internet required at inference time.
// Runtime "transformers": node-native ONNX via @huggingface/transformers (weights cached on disk)
// Runtime "ollama": local Ollama HTTP server (if user installs it later)
const config = require('../config');

// ---- transformers.js runtime ----
let generatorPromise = null;

async function getGenerator() {
  if (!generatorPromise) {
    generatorPromise = (async () => {
      const { pipeline, env } = await import('@huggingface/transformers');
      // Weights live in ./models (gitignored). If already present, nothing is downloaded.
      env.cacheDir = './models';
      env.allowLocalModels = true;
      console.log(`[local-llm] loading "${config.local.model}" (CPU/ONNX)...`);
      const generator = await pipeline('text2text-generation', config.local.model, {
        dtype: 'fp32',
      });
      console.log('[local-llm] model ready');
      return generator;
    })();
    generatorPromise.catch(() => {
      generatorPromise = null; // allow retry on next call
    });
  }
  return generatorPromise;
}

async function chatTransformers(messages) {
  const generator = await getGenerator();

  // Flatten chat into one instruction prompt (LaMini-Flan-T5 is instruction-tuned).
  // A system message, when present, leads the prompt so the model actually
  // follows the answer instructions instead of treating them as user input.
  const lastUser = [...messages].reverse().find((m) => m.role === 'user');
  const system = messages.find((m) => m.role === 'system');
  const question = lastUser ? lastUser.content : messages.filter((m) => m.role !== 'system').map((m) => m.content).join('\n');
  const prompt = system && system.content ? `${system.content}\n\nQuestion: ${question}\nAnswer:` : question;

  const out = await generator(prompt, {
    max_new_tokens: config.local.maxTokens,
    do_sample: false,
    // Small models loop on greedy decoding; penalize repeats so answers stay clean.
    repetition_penalty: 1.1,
    no_repeat_ngram_size: 3,
  });

  const text = Array.isArray(out) ? out[0]?.generated_text : out?.generated_text;
  if (!text || !String(text).trim()) throw new Error('local model produced empty output');
  return String(text).trim();
}

// ---- ollama runtime ----
async function chatOllama(messages) {
  const res = await fetch(`${config.local.url}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: config.local.model, messages, stream: false }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Ollama HTTP ${res.status}: ${text.slice(0, 200)}`);
  }
  const data = await res.json();
  const content = data.message?.content;
  if (!content) throw new Error('Ollama returned no content');
  return content.trim();
}

async function chatLocal(messages) {
  if (config.local.runtime === 'ollama') return chatOllama(messages);
  return chatTransformers(messages);
}

// ---- OFFLINE answer context (shared by chat.js and stream-chat.js) ----
// The local store also contains raw past questions (earlier test runs stored
// them). Echoing those back confuses the small model, so question-like items
// are filtered out of the prompt context — this only shapes what the LOCAL
// model sees; recall and the decision engine are untouched.
function isQuestionLike(text) {
  const s = String(text || '').trim();
  if (!s) return true;
  if (s.endsWith('?')) return true;
  return /^(what|why|how|when|where|who|which|whats|what's|explain|summarize|give me|tell me|can you|do you|is there|are there)\b/i.test(s);
}

async function offlineRecall(query) {
  if (!query) return [];
  const { recallLocalOnly } = require('./memory');
  let hits = [];
  try {
    hits = await recallLocalOnly(query, 8, { minRelevance: 0.15 });
  } catch {
    return [];
  }
  let kept = hits.filter((h) => h && h.text && !isQuestionLike(h.text));
  // Meta-questions ("what do you remember about me?") often retrieve only
  // other questions. One extra LOCAL recall with a generic query recovers
  // real facts — an embedding lookup, no extra LLM call.
  if (!kept.length) {
    try {
      const extra = await recallLocalOnly('the user', 5, { minRelevance: 0.15 });
      kept = extra.filter((h) => h && h.text && !isQuestionLike(h.text));
    } catch {}
  }
  const seen = new Set();
  const out = [];
  for (const h of kept) {
    const key = String(h.text).trim().toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(h);
    if (out.length >= 5) break;
  }
  return out;
}

// One short system prompt + a small, clean memory block. Small models get
// confused by long or noisy context, so memories are deduped and
// length-capped. Format tuned offline against LaMini-Flan-T5: memories first,
// instruction after; chatTransformers wraps the question as "Question:/Answer:".
function buildLocalSystemPrompt(recalled) {
  let sys = '';
  const seen = new Set();
  const lines = [];
  for (const r of recalled) {
    const t = String(r.text || '').trim().replace(/\s+/g, ' ').slice(0, 160);
    if (!t || seen.has(t.toLowerCase())) continue;
    seen.add(t.toLowerCase());
    lines.push(`- ${t}`);
    if (lines.length >= 5) break;
  }
  if (lines.length) sys += `Memories about the user:\n${lines.join('\n')}\n\n`;
  sys +=
    'You know the user only through the memories above. ' +
    'Answer every question directly and concisely as their assistant. ' +
    'When asked what you remember, list the memories as facts about them. ' +
    'If the memories do not contain the answer, say the information is not available. Do not invent facts.';
  return sys;
}

function localRuntimeLabel() {
  return config.local.runtime === 'ollama'
    ? `ollama:${config.local.model}`
    : `transformers:${config.local.model}`;
}

module.exports = { chatLocal, localRuntimeLabel, offlineRecall, buildLocalSystemPrompt };
