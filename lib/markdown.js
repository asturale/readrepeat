// Minimal, safe inline-markdown renderer for highlight text/notes -- NOT a
// full markdown library (avoids pulling in a large dependency + its own
// security surface for what's really just a handful of inline patterns).
//
// CRITICAL ordering: escape the raw text to HTML entities FIRST, then apply
// regex substitutions that introduce a small, fixed set of safe tags on top
// of the ALREADY-ESCAPED text. Never markdown-ify raw text and output it
// unescaped -- that would let literal HTML in a highlight's text execute.
function escapeHtml(s) {
    return String(s ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

export function renderInlineMarkdown(text) {
    let html = escapeHtml(text);
    // Some Readwise article-clip highlights are literally an embedded
    // image (![alt](url)) rather than text -- render those as an actual
    // <img>. The URL must start with http(s):// (checked against the
    // ALREADY-escaped text, which is fine: only &<>"' get entity-escaped,
    // never the scheme/colon/slashes) so a scheme like javascript:/data:
    // simply fails to match and is left as harmless literal text instead
    // of becoming an <img src>.
    // onerror fallback: a broken/dead image URL (common -- these are old
    // scraped article images) otherwise renders as literally nothing (no
    // width/height, empty alt collapses to zero visible space in most
    // browsers), making the whole highlight look blank with no clue why.
    // Unquoted attribute value on purpose: sidesteps quote-nesting inside
    // an already-double-quoted HTML attribute (valid HTML5 as long as it
    // has no whitespace/quotes, which a bare CSS class name never does).
    html = html.replace(
        /!\[([^\]]*)\]\((https?:\/\/[^\s)]+)\)/g,
        "<img class=\"md-image\" src=\"$2\" alt=\"$1\" loading=\"lazy\" onerror=\"this.outerHTML='<span class=md-image-broken>🖼️ afbeelding niet beschikbaar</span>'\">"
    );
    // Readwise convention: __text__ = highlighted (yellow marker), not bold.
    html = html.replace(/__(.+?)__/g, '<mark class="md-mark">$1</mark>');
    html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    html = html.replace(/(?<![*\w])\*(?!\*)(.+?)(?<!\*)\*(?![*\w])/g, '<em>$1</em>');
    return html;
}

// Block-level renderer for longer AI-generated text (the recommendations
// feature) -- still not a real markdown library, just paragraphs + a simple
// "- " bullet list on top of the same safe inline renderer above. Every
// line goes through renderInlineMarkdown first (escape-then-markup), so
// this inherits the same XSS-safety, it just adds structure around it.
export function renderBlockMarkdown(text) {
    const lines = String(text ?? '').split(/\r?\n/);
    const blocks = [];
    let listBuffer = [];

    const flushList = () => {
        if (listBuffer.length > 0) {
            blocks.push('<ul>' + listBuffer.map((l) => `<li>${l}</li>`).join('') + '</ul>');
            listBuffer = [];
        }
    };

    for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line) {
            flushList();
            continue;
        }
        const bullet = line.match(/^[-*]\s+(.*)/);
        if (bullet) {
            listBuffer.push(renderInlineMarkdown(bullet[1]));
        } else {
            flushList();
            blocks.push(`<p>${renderInlineMarkdown(line)}</p>`);
        }
    }
    flushList();
    return blocks.join('\n');
}

// Plain-text version for contexts that can't render markup at all (the
// shareable highlight image, drawn as raw text via sharp/SVG) -- strips
// the syntax but keeps the wrapped content, and drops embedded images
// entirely (a picture reference makes no sense inside a text-quote image).
export function stripMarkdown(text) {
    let plain = String(text ?? '');
    plain = plain.replace(/!\[([^\]]*)\]\((https?:\/\/[^\s)]+)\)/g, '');
    plain = plain.replace(/__(.+?)__/g, '$1');
    plain = plain.replace(/\*\*(.+?)\*\*/g, '$1');
    plain = plain.replace(/(?<![*\w])\*(?!\*)(.+?)(?<!\*)\*(?![*\w])/g, '$1');
    return plain.trim();
}
