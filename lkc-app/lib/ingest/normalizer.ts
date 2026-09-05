// Text normalization (INGESTION.md §4.1/§4.2, §3.3).
// Deterministic, side-effect free: collapses Arabic orthographic variants and
// canonicalizes whitespace so identical content always hashes identically.

export function normalizeText(text: string): string {
  return text
    .normalize("NFC")
    // Arabic orthographic variants → canonical forms.
    .replace(/[\u064B-\u0652]/g, "") // strip tashkeel (diacritics)
    .replace(/[\u0622\u0623\u0625]/g, "\u0627") // آ أ إ → ا
    .replace(/\u0649/g, "\u064A") // ى → ي
    .replace(/\u06C0/g, "\u0647") // ۀ → ة-adjacent halmaz (conservative)
    // Canonical separators/punctuation.
    .replace(/[،؛؛\u060C\u061B]/g, ",")
    .replace(/\u201C|\u201D/g, "\u0022")
    .replace(/\u2018|\u2019/g, "\u0027")
    // Whitespace: any run → single space.
    .replace(/[\t\n\r\u00A0]+/g, " ")
    .replace(/[ ]{2,}/g, " ")
    .trim();
}

export function normalizeBlock(text: string): string {
  return text
    .split(/\r?\n/)
    .filter((l) => l.trim().length > 0)
    .map((l) => normalizeText(l))
    .join("\n");
}

// Rough language detection (INGESTION.md §4.2): higher Arabic-letter ratio
// ⇒ 'ar', otherwise 'en'. Used with `meta.language` as a consistency check.
export function detectLanguage(text: string): "ar" | "en" {
  const arabic = (text.match(/[\u0600-\u06FF]/g) || []).length;
  const latin = (text.match(/[A-Za-z]/g) || []).length;
  return arabic > latin ? "ar" : "en";
}