// Readwise "Action Tags" (https://docs.readwise.io/readwise/guides/action-tags):
// a highlight note starting with "." is a structural marker, not literal
// note text.
//   .h1 / .h2 / .h3  -> heading tag (part/chapter/section title)
//   .c1 / .c2 / ...  -> concatenation tag (combine with adjacent highlights)
//   .word            -> inline tag (single word/abbreviation, no spaces)
export function parseActionTag(note) {
    if (typeof note !== 'string') return { type: 'none' };
    const trimmed = note.trim();
    if (!trimmed.startsWith('.')) return { type: 'none' };

    const heading = trimmed.match(/^\.h([123])$/);
    if (heading) return { type: 'heading', level: Number(heading[1]) };

    const concat = trimmed.match(/^\.c(\d+)$/);
    if (concat) return { type: 'concat', index: Number(concat[1]) };

    const inline = trimmed.match(/^\.(\S+)$/);
    if (inline) return { type: 'tag', tag: inline[1] };

    return { type: 'none' };
}
