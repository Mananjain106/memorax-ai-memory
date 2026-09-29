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

  // Flatten chat into an instruction prompt (LaMini-Flan-T5 is instruction-tuned)
  const lastUser = [...messages].reverse().find((m) => m.role === 'user');
  const question = lastUser ? lastUser.content : messages.map((m) => m.content).join('\n');

  const out = await generator(question, {
    max_new_tokens: config.local.maxTokens,
    do_sample: false,
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

function localRuntimeLabel() {
  return config.local.runtime === 'ollama'
    ? `ollama:${config.local.model}`
    : `transformers:${config.local.model}`;
}

module.exports = { chatLocal, localRuntimeLabel };
