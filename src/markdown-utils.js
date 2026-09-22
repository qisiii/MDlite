const HTML_ENTITIES = {
  amp: "&",
  apos: "'",
  gt: ">",
  lt: "<",
  quot: '"',
  "#39": "'"
};

// Decode exactly one browser-serialization layer. A one-pass replacement is
// intentional: source text such as `&amp;gt;` must become `&gt;`, not `>`.
export function decodeHtmlEntities(value) {
  return value.replace(/&(amp|apos|gt|lt|quot|#39);/gi, (entity, name) => HTML_ENTITIES[name.toLowerCase()] ?? entity);
}
