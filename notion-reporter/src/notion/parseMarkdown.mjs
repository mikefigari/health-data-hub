/**
 * parseMarkdown.mjs
 *
 * Converts a Claude markdown response into an array of Notion block objects.
 *
 * Supported block types:
 *   ## Header      → heading_2
 *   ### Header     → heading_3
 *   - bullet       → bulleted_list_item
 *   * bullet       → bulleted_list_item
 *   paragraph      → paragraph (consecutive non-blank lines are joined)
 *
 * Inline formatting:  **bold**, *italic*, `code`
 * Notion rich_text content is chunked to ≤ 2000 chars per segment.
 */

const MAX_CHUNK = 2000;

// ── Inline parser ─────────────────────────────────────────────────────────

/**
 * Parse an inline markdown string into an array of Notion rich_text segments.
 */
function parseInline(text) {
  const segments = [];
  let remaining  = text;

  while (remaining.length > 0) {
    // **bold**
    const bold = remaining.match(/^\*\*(.+?)\*\*/s);
    if (bold) {
      segments.push(richText(bold[1], { bold: true }));
      remaining = remaining.slice(bold[0].length);
      continue;
    }
    // *italic*
    const italic = remaining.match(/^\*(.+?)\*/s);
    if (italic) {
      segments.push(richText(italic[1], { italic: true }));
      remaining = remaining.slice(italic[0].length);
      continue;
    }
    // `code`
    const code = remaining.match(/^`(.+?)`/s);
    if (code) {
      segments.push(richText(code[1], { code: true }));
      remaining = remaining.slice(code[0].length);
      continue;
    }
    // Plain text up to the next special character
    const plain = remaining.match(/^[^*`]+/s);
    if (plain) {
      segments.push(richText(plain[0]));
      remaining = remaining.slice(plain[0].length);
      continue;
    }
    // Single unmatched special character
    segments.push(richText(remaining[0]));
    remaining = remaining.slice(1);
  }

  // Chunk each segment to ≤ 2000 chars
  const chunked = [];
  for (const seg of segments) {
    let content = seg.text.content;
    while (content.length > MAX_CHUNK) {
      chunked.push({ ...seg, text: { ...seg.text, content: content.slice(0, MAX_CHUNK) } });
      content = content.slice(MAX_CHUNK);
    }
    if (content.length > 0) {
      chunked.push({ ...seg, text: { ...seg.text, content } });
    }
  }

  return chunked.length > 0 ? chunked : [richText(text)];
}

function richText(content, annotations = {}) {
  return {
    type: 'text',
    text: { content },
    annotations: {
      bold:          annotations.bold          ?? false,
      italic:        annotations.italic        ?? false,
      code:          annotations.code          ?? false,
      strikethrough: annotations.strikethrough ?? false,
      underline:     annotations.underline     ?? false,
      color:         annotations.color         ?? 'default',
    },
  };
}

// ── Block builders ────────────────────────────────────────────────────────

function heading2Block(text) {
  return { object: 'block', type: 'heading_2', heading_2: { rich_text: parseInline(text) } };
}

function heading3Block(text) {
  return { object: 'block', type: 'heading_3', heading_3: { rich_text: parseInline(text) } };
}

function bulletBlock(text) {
  return {
    object: 'block',
    type: 'bulleted_list_item',
    bulleted_list_item: { rich_text: parseInline(text) },
  };
}

function paragraphBlock(text) {
  return { object: 'block', type: 'paragraph', paragraph: { rich_text: parseInline(text) } };
}

// ── Main parser ───────────────────────────────────────────────────────────

/**
 * Convert a markdown string to an array of Notion block objects.
 */
export function parseMarkdownToBlocks(markdown) {
  const blocks          = [];
  const lines           = markdown.split('\n');
  let   paragraphBuffer = [];

  function flushParagraph() {
    if (paragraphBuffer.length === 0) return;
    const text = paragraphBuffer.join('\n').trim();
    if (text) blocks.push(paragraphBlock(text));
    paragraphBuffer = [];
  }

  for (const line of lines) {
    if (line.startsWith('### ')) {
      flushParagraph();
      blocks.push(heading3Block(line.slice(4).trim()));
    } else if (line.startsWith('## ')) {
      flushParagraph();
      blocks.push(heading2Block(line.slice(3).trim()));
    } else if (/^[-*] /.test(line)) {
      flushParagraph();
      blocks.push(bulletBlock(line.slice(2).trim()));
    } else if (line.trim() === '') {
      flushParagraph();
    } else {
      paragraphBuffer.push(line);
    }
  }

  flushParagraph();
  return blocks;
}
