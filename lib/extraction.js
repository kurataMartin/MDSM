// lib/extraction.js
// Extracts ONLY the four fields required to list a security:
//   company_name  → listing name
//   company_type  → sector
//   authorized_shares → totalTokens  (derived from share_capital)
//   price_per_share   → initialPrice (derived from share_capital)
//
// All other fields (registration number, incorporation date, directors,
// address, contact email) are not needed for listing and are not extracted.

import { getDraft, setDraftStatus, getDraftDocumentFile } from "@/lib/registration";

// ── PDF text extraction (unpdf) ─────────────────────────────────────────────
async function readPdfText(buffer) {
  const { getDocumentProxy, extractText } = await import("unpdf");
  const pdf = await getDocumentProxy(new Uint8Array(buffer));
  const { text } = await extractText(pdf, { mergePages: true });
  return text || "";
}

// ── Image OCR via OCR.space (server-side, free) ──────────────────────────────
async function readImageText(base64, mime) {
  const apiKey = (process.env.OCR_SPACE_API_KEY || "helloworld").trim();
  const body = new URLSearchParams();
  body.set("base64Image", `data:${mime || "image/png"};base64,${base64}`);
  body.set("language", "eng");
  body.set("isOverlayRequired", "false");
  body.set("OCREngine", "2");
  body.set("scale", "true");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  let res;
  try {
    res = await fetch("https://api.ocr.space/parse/image", {
      method: "POST",
      headers: { apikey: apiKey, "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
  const json = await res.json();
  if (json.IsErroredOnProcessing) {
    const msg = Array.isArray(json.ErrorMessage) ? json.ErrorMessage.join("; ") : (json.ErrorMessage || "OCR failed");
    throw new Error(msg);
  }
  return (json.ParsedResults || []).map((r) => r.ParsedText || "").join("\n");
}

// ── Label-delimited field parser ─────────────────────────────────────────────
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Only the labels needed to locate the 3 fields we care about.
const ALL_LABELS = [
  "COMPANY NAME", "NAME OF COMPANY",
  "COMPANY TYPE", "TYPE OF COMPANY",
  "AUTHORISED SHARE CAPITAL", "AUTHORIZED SHARE CAPITAL", "SHARE CAPITAL", "NOMINAL CAPITAL",
];

function startsWithLabel(v) {
  const s = v.trim();
  return ALL_LABELS.some((l) => new RegExp("^" + esc(l) + "\\b", "i").test(s));
}

function parseFields(rawText) {
  const text = rawText.replace(/\s+/g, " ").trim();

  const between = (starts) => {
    for (const start of starts) {
      const m = new RegExp("\\b" + esc(start) + "\\s*:?\\s*", "i").exec(text);
      if (!m) continue;
      const rest = text.slice(m.index + m[0].length);
      const stops = ALL_LABELS.filter((l) => !starts.includes(l));
      let end = rest.length;
      for (const stop of stops) {
        const sm = new RegExp("\\b" + esc(stop) + "\\b", "i").exec(rest);
        if (sm && sm.index < end && sm.index > 0) end = sm.index;
      }
      const val = rest.slice(0, end).trim().replace(/[:\-–]\s*$/, "").replace(/\s{2,}/g, " ");
      if (val && !startsWithLabel(val)) return val;
    }
    return null;
  };

  const fields = {};
  const confidence = {};
  const set = (key, val, conf) => {
    if (val === null || val === undefined || val === "") return;
    fields[key] = typeof val === "string" ? val.trim() : val;
    confidence[key] = conf;
  };

  // ── 1. Company name ────────────────────────────────────────────────────────
  const nameLabel = between(["COMPANY NAME", "NAME OF COMPANY"]);
  if (nameLabel) {
    set("company_name", nameLabel, 0.93);
  } else {
    const m = text.match(/([A-Z][A-Za-z0-9&.,'\-\s]{2,80}(?:\(Pty\)\s*Ltd|\(Proprietary\)\s*Limited|Limited|Ltd|PLC|Inc)\.?)/);
    if (m) set("company_name", m[1], 0.70);
  }

  // ── 2. Company type → sector ───────────────────────────────────────────────
  const typeLabel = between(["COMPANY TYPE", "TYPE OF COMPANY"]);
  if (typeLabel) {
    set("company_type", typeLabel, 0.88);
  } else {
    const m = text.match(/Private Company Limited by Shares|Public Company|Company Limited by Guarantee/i);
    if (m) set("company_type", m[0], 0.70);
  }

  // ── 3. Share capital → authorized_shares + price_per_share ────────────────
  // Prefer the distinctive "M N (N ordinary shares of M X each)" pattern;
  // fall back to label-based capture.
  const cap =
    text.match(/M\s*[\d,]+(?:\.\d{2})?\s*\(\s*[\d,]+[^)]*shares[^)]*\)/i)?.[0] ||
    between(["AUTHORISED SHARE CAPITAL", "AUTHORIZED SHARE CAPITAL", "SHARE CAPITAL", "NOMINAL CAPITAL"]);

  if (cap && !startsWithLabel(cap)) {
    set("share_capital", cap.trim(), 0.85);

    const toNum = (s) => Number(String(s).replace(/,/g, ""));

    // Total share capital — the first monetary amount in the string.
    const capitalM = cap.match(/([\d,]{4,}(?:\.\d+)?)/);
    const capitalAmount = capitalM ? toNum(capitalM[1]) : null;

    // Total shares issued — must be explicitly stated as "N shares".
    // Do NOT fall back to capitalAmount: the formula
    //   Initial Share Price = Total Share Capital ÷ Total Shares Issued
    // requires two DISTINCT values.
    const sharesM = cap.match(/([\d,]{4,})\s*(?:ordinary\s+|preference\s+)?shares/i);
    const shareCount = sharesM ? toNum(sharesM[1]) : null;

    // authorized_shares: explicit count preferred; capital amount as last resort.
    const totalShares = shareCount ?? capitalAmount;
    if (totalShares != null) set("authorized_shares", totalShares, shareCount ? 0.85 : 0.70);

    // price_per_share:
    //   Priority 1 — explicit "of M X each" / "M X per share" on the document.
    //   Priority 2 — formula: capitalAmount ÷ shareCount (only when both are distinct).
    const perShareM =
      cap.match(/of\s*M?\s*([\d,]+(?:\.\d+)?)\s*(?:each|per\s+share)/i) ||
      cap.match(/M\s*([\d,]+(?:\.\d+)?)\s*(?:each|per\s+share)/i);
    let price = perShareM ? toNum(perShareM[1]) : null;

    if (price == null && capitalAmount != null && shareCount != null && shareCount !== capitalAmount) {
      price = Math.round((capitalAmount / shareCount) * 10000) / 10000;
    }

    if (price != null && isFinite(price) && price > 0) {
      set("price_per_share", price, perShareM ? 0.90 : 0.82);
    }
  }

  return { fields, confidence, matched: Object.keys(fields).length };
}

// The four fields required for a listing. "missing" feedback is shown only for these.
export const EXPECTED_FIELDS = [
  "company_name",
  "company_type",
  "authorized_shares",
  "price_per_share",
];
/**
 * One-shot scan: take raw document bytes (base64) + mime, read the text
 * (PDF via unpdf, image via OCR), parse the fields, and return them.
 * No database, no draft — pure and fast, so the scan step can't hang on DB I/O.
 */
export async function scanBytes(base64, mime) {
  let text = "";
  try {
    if (/pdf/i.test(mime)) {
      text = await readPdfText(Buffer.from(base64, "base64"));
    } else if (/image|png|jpe?g|webp|gif|bmp/i.test(mime)) {
      text = await readImageText(base64, mime);
    }
  } catch (e) {
    console.warn("[REG] scanBytes read failed:", e.message);
  }
  const readable = !!(text && text.replace(/\s/g, "").length > 40);
  const parsed = readable ? parseFields(text) : { fields: {}, confidence: {} };
  const missing = EXPECTED_FIELDS.filter((k) => !(k in parsed.fields));
  return { success: true, extracted: parsed.fields, confidence: parsed.confidence, missing, readable };
}
/**
 * Parse already-extracted text (e.g. from client-side OCR of an image) and
 * persist the result. Same contract as extractFromDraft.
 */
export async function extractFromText(draftId, rawText) {
  try {
    const draft = await getDraft(draftId);
    if (!draft) return { success: false, error: "Draft not found" };
    const readable = !!(rawText && rawText.replace(/\s/g, "").length > 40);
    const parsed = readable ? parseFields(rawText) : { fields: {}, confidence: {} };
    const missing = EXPECTED_FIELDS.filter((k) => !(k in parsed.fields));
    await setDraftStatus(draftId, "parsed", { extracted: parsed.fields, confidence: parsed.confidence });
    return { success: true, extracted: parsed.fields, confidence: parsed.confidence, missing, readable };
  } catch (err) {
    console.error("[REG] extractFromText failed:", err.message);
    return { success: false, error: err.message };
  }
}
/**
 * Run extraction for a draft and persist the result.
 * Returns ONLY the fields genuinely found on the document plus:
 * - missing: expected fields not detected (for user feedback)
 * - readable: whether any text could be read from the document at all
 * Never invents values.
 */
export async function extractFromDraft(draftId) {
  const draft = await getDraft(draftId);
  if (!draft) return { success: false, error: "Draft not found" };
  if (!draft.documents || draft.documents.length === 0) {
    await setDraftStatus(draftId, "failed", { parseError: "No documents to read" });
    return { success: false, error: "No documents to read" };
  }
  try {
    // Read the MOST RECENT document so a reused draft never returns an older upload.
    const docsNewestFirst = [...draft.documents].reverse();
    const cert =
      docsNewestFirst.find((d) => /certificate/i.test(d.doc_type || "")) ||
      docsNewestFirst[0];
    const file = await getDraftDocumentFile(cert.id);
    const mime = file?.file_mime || "";
    let fields = {};
    let confidence = {};
    let readable = false;
    let text = "";
    if (file?.file_data) {
      try {
        if (/pdf/i.test(mime)) {
          text = await readPdfText(Buffer.from(file.file_data, "base64"));
        } else if (/image|png|jpe?g|webp|gif|bmp/i.test(mime)) {
          text = await readImageText(file.file_data, mime);
        }
      } catch (readErr) {
        console.warn(`[REG] Text/OCR read failed for draft ${draftId}: ${readErr.message}`);
      }
    }
    if (text && text.replace(/\s/g, "").length > 40) {
      readable = true;
      const parsed = parseFields(text);
      fields = parsed.fields;
      confidence = parsed.confidence;
      console.log(`[REG] Extracted ${parsed.matched} fields from draft ${draftId}`);
    }
    // Fields we expected but did NOT find — reported, never guessed.
    const missing = EXPECTED_FIELDS.filter((k) => !(k in fields));
    await setDraftStatus(draftId, "parsed", { extracted: fields, confidence });
    return { success: true, extracted: fields, confidence, missing, readable };
  } catch (err) {
    console.error("[REG] extraction failed for draft", draftId, ":", err.message);
    await setDraftStatus(draftId, "failed", {
      parseError: err.message || "Could not read the document. Enter details manually.",
    });
    return { success: false, error: err.message };
  }
}
