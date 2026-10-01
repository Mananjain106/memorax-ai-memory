// Shared LLM output sanitizer. Some chat-template models (Qwen family and
// friends) occasionally leak internal tool-call markup into the visible
// assistant content, e.g.
//   <|tool_call_start|>[query(prompt='...', note='...')]<|tool_call_end|>
// plus stray special tokens. MemoraX sends NO tools/tool_choice and defines NO
// query tool, so tool-call syntax in the content is a model-side artifact that
// must never reach the UI.
//
// Rules:
//   1. drop entire tool-call blocks (pipe-style AND <tool_call> XML-style)
//   2. drop any leftover <|...|> special token
//   3. if the ENTIRE message is a bare function-call array (e.g.
//      "[query(prompt='...', note='...')]") or a JSON tool-call payload,
//      treat it as an artifact too (fenced code does not match, so code
//      samples are never affected)
// Markdown, code fences and normal prose pass through untouched.
//
// NOTE: marker strings are BUILT at runtime (concatenation) instead of written
// literally so this source file never contains special-token sequences.
const PIPE = '<|';
const TC_START = PIPE + 'tool_call_start' + '|>';
const TC_END = PIPE + 'tool_call_end' + '|>';
const XML_START = '<tool_call>';
const XML_END = '</tool_call>';

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const TOOL_BLOCK_RE = new RegExp(
  escapeRe(TC_START) + '[\\s\\S]*?(?:' + escapeRe(TC_END) + '|$)',
  'g'
);
const XML_BLOCK_RE = new RegExp(
  escapeRe(XML_START) + '[\\s\\S]*?(?:' + escapeRe(XML_END) + '|$)',
  'gi'
);
const SPECIAL_TOKEN_RE = /<\|[^|<>]{0,64}\|>/g;

// Whole-message bare tool-call: identifier( ... ) with at most one nesting
// level, wrapped in [ ]. Requires an identifier right after '[', so plain
// arrays / markdown links / code fences never match.
const BARE_CALL_RE = /^\s*\[\s*[A-Za-z_]\w*\s*\((?:[^()]|\([^()]*\))*\)\s*\]\s*$/;
const BARE_CALLS_RE = new RegExp(
  '^\\s*\\[\\s*[A-Za-z_]\\w*\\s*\\((?:[^()]|\\([^()]*\\))*\\)' +
    '(?:\\s*,\\s*[A-Za-z_]\\w*\\s*\\((?:[^()]|\\([^()]*\\))*\\))*\\s*\\]\\s*$'
);

// Whole-message JSON tool-call payload: {"name":...,"arguments":...} (object
// or array of such objects).
function isJsonToolCall(text) {
  if (!/^\s*[[{]/.test(text)) return false;
  try {
    const v = JSON.parse(text);
    const objs = Array.isArray(v) ? v : [v];
    return (
      objs.length > 0 &&
      objs.every(
        (o) =>
          o &&
          typeof o === 'object' &&
          typeof o.name === 'string' &&
          (o.arguments !== undefined || o.parameters !== undefined || o.arguments_json !== undefined)
      )
    );
  } catch {
    return false;
  }
}

function stripTokens(text) {
  return text.replace(TOOL_BLOCK_RE, '').replace(XML_BLOCK_RE, '').replace(SPECIAL_TOKEN_RE, '');
}

// One-shot: sanitize a complete assistant message.
function sanitizeText(text) {
  if (!text) return '';
  let out = stripTokens(String(text));
  const trimmed = out.trim();
  if (trimmed && (BARE_CALL_RE.test(out) || BARE_CALLS_RE.test(out) || isJsonToolCall(out))) {
    return ''; // whole message is a tool-call artifact
  }
  return trimmed;
}

// Streaming: a stateful filter. push(delta) returns the text that is safe to
// emit NOW; flush() returns whatever is left once the stream ended. Tool-call
// blocks are suppressed entirely — including when the stream ends inside one.
// Holds back the last MAX_HOLD chars in normal mode so a marker split across
// two SSE deltas is always caught inside the buffer before emitting.
const MAX_HOLD = TC_START.length - 1; // longest marker, minus one
const START_MARKERS = [TC_START, XML_START];
const END_MARKERS = [TC_END, XML_END];

function earliestOf(text, markers) {
  let best = -1;
  let len = 0;
  for (const m of markers) {
    const i = text.indexOf(m);
    if (i !== -1 && (best === -1 || i < best)) {
      best = i;
      len = m.length;
    }
  }
  return best === -1 ? null : { idx: best, len };
}

function createStreamSanitizer() {
  let suppressed = false; // inside a tool-call block: drop everything
  let buf = '';

  function push(delta) {
    buf += delta || '';
    let out = '';
    for (;;) {
      if (suppressed) {
        const end = earliestOf(buf, END_MARKERS);
        if (!end) {
          buf = buf.slice(-MAX_HOLD); // keep only a possible split end-marker
          return out;
        }
        buf = buf.slice(end.idx + end.len);
        suppressed = false;
        continue;
      }
      // Earliest complete special token anywhere in the buffer: a generic
      // <|...|> token (covers tool_call_start/end AND stray tokens like
      // <|im_end|>) or the XML-style <tool_call> opener.
      const gen = buf.match(/<\|[^|<>]{0,64}\|>/);
      let idx = gen ? gen.index : -1;
      let len = gen ? gen[0].length : 0;
      let isStart = !!(gen && gen[0] === TC_START);
      const xml = buf.indexOf(XML_START);
      if (xml !== -1 && (idx === -1 || xml < idx)) {
        idx = xml;
        len = XML_START.length;
        isStart = true;
      }
      if (idx === -1) {
        // No complete token: emit all but the last MAX_HOLD chars (they may
        // still become a marker split across deltas).
        if (buf.length > MAX_HOLD) {
          out += buf.slice(0, buf.length - MAX_HOLD);
          buf = buf.slice(-MAX_HOLD);
        }
        return out;
      }
      out += buf.slice(0, idx);
      buf = buf.slice(idx + len);
      if (isStart) suppressed = true; // drop everything until the end marker
      // else: stray/end token outside a block — silently dropped
    }
  }

  function flush() {
    if (suppressed) {
      buf = '';
      return ''; // stream ended inside a tool block: drop everything left
    }
    let out = stripTokens(buf);
    buf = '';
    // Drop a trailing PARTIAL marker (e.g. '<|tool_call_sta' split across the
    // final deltas and never completed).
    for (let l = Math.min(out.length, TC_START.length - 1); l >= 2; l--) {
      const tail = out.slice(out.length - l);
      if (tail[0] !== '<') continue;
      if (START_MARKERS.some((m) => m.startsWith(tail))) {
        out = out.slice(0, out.length - l);
        break;
      }
    }
    return out;
  }

  return { push, flush };
}

module.exports = { sanitizeText, createStreamSanitizer };
