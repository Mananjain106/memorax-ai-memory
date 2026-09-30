// MemoraX markdown renderer — escape-first, dependency-free.
// Supports: fenced code blocks (with copy), inline code, bold/italic,
// links, headings, ul/ol lists, blockquotes, paragraphs.
(function () {
  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function renderInline(text) {
    let s = escapeHtml(text);
    // inline code first, protected via placeholder
    const codes = [];
    s = s.replace(/`([^`\n]+)`/g, (_, c) => {
      codes.push('<code class="inline">' + c + '</code>');
      return '\u0000' + (codes.length - 1) + '\u0000';
    });
    // links: [label](url) — only http(s)
    s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
      '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
    s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
    s = s.replace(/(^|[\s(])_([^_\n]+)_/g, '$1<em>$2</em>');
    s = s.replace(/\u0000(\d+)\u0000/g, (_, i) => codes[Number(i)]);
    return s;
  }

  function render(src) {
    const lines = String(src || '').replace(/\r\n/g, '\n').split('\n');
    let html = '';
    let i = 0;

    while (i < lines.length) {
      const line = lines[i];

      // fenced code block
      const fence = line.match(/^```([\w+#-]*)\s*$/);
      if (fence) {
        const lang = fence[1] || 'code';
        const buf = [];
        i++;
        while (i < lines.length && !/^```\s*$/.test(lines[i])) {
          buf.push(lines[i]);
          i++;
        }
        i++; // skip closing fence (or EOF)
        const code = escapeHtml(buf.join('\n'));
        html +=
          '<div class="codeblock">' +
          '<div class="codeblock-head"><span>' + escapeHtml(lang) + '</span>' +
          '<button class="codeblock-copy" type="button">Copy</button></div>' +
          '<pre><code>' + code + '</code></pre></div>';
        continue;
      }

      // headings
      const h = line.match(/^(#{1,3})\s+(.*)$/);
      if (h) {
        const lvl = h[1].length;
        html += '<h' + (lvl + 1) + '>' + renderInline(h[2]) + '</h' + (lvl + 1) + '>';
        i++;
        continue;
      }

      // blockquote
      if (/^>\s?/.test(line)) {
        const buf = [];
        while (i < lines.length && /^>\s?/.test(lines[i])) {
          buf.push(lines[i].replace(/^>\s?/, ''));
          i++;
        }
        html += '<blockquote>' + render(buf.join('\n')) + '</blockquote>';
        continue;
      }

      // lists
      if (/^\s*[-*]\s+/.test(line) || /^\s*\d+\.\s+/.test(line)) {
        const ordered = /^\s*\d+\.\s+/.test(line);
        const items = [];
        while (i < lines.length && (ordered ? /^\s*\d+\.\s+/.test(lines[i]) : /^\s*[-*]\s+/.test(lines[i]))) {
          items.push('<li>' + renderInline(lines[i].replace(/^\s*(?:[-*]|\d+\.)\s+/, '')) + '</li>');
          i++;
        }
        html += ordered ? '<ol>' + items.join('') + '</ol>' : '<ul>' + items.join('') + '</ul>';
        continue;
      }

      // blank line
      if (!line.trim()) {
        i++;
        continue;
      }

      // paragraph: consume until blank / block start
      const buf = [line];
      i++;
      while (
        i < lines.length &&
        lines[i].trim() &&
        !/^```/.test(lines[i]) &&
        !/^(#{1,3})\s+/.test(lines[i]) &&
        !/^>\s?/.test(lines[i]) &&
        !/^\s*[-*]\s+/.test(lines[i]) &&
        !/^\s*\d+\.\s+/.test(lines[i])
      ) {
        buf.push(lines[i]);
        i++;
      }
      html += '<p>' + renderInline(buf.join('\n')) + '</p>';
    }
    return html;
  }

  window.MemoraXMD = { render, escapeHtml };
})();
