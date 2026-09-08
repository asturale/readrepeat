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
    html = html.replace(/!\[([^\]]*)\]\((https?:\/\/[^\s)]+)\)/g, '<img class="md-image" src="$2" alt="$1" loading="lazy">');
    // Readwise convention: __text__ = highlighted (yellow marker), not bold.
    html = html.replace(/__(.+?)__/g, '<mark class="md-mark">$1</mark>');
    html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    html = html.replace(/(?<![*\w])\*(?!\*)(.+?)(?<!\*)\*(?![*\w])/g, '<em>$1</em>');
    return html;
}
