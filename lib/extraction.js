// lib/extraction.js
// FREE document field extraction for the company-registration draft flow.
//
// Pipeline:
//   1. Extract text from the uploaded PDF with `unpdf` (serverless-native,
//      no DOM dependency — handles PDFs that pdf-parse rejects).
//   2. PDF text comes out as a flat stream, so each value is captured as the
//      text BETWEEN its label and the next known label.
//   3. Assign a confidence per field. Fall back to a sample only when no text
//      could be read (e.g. an image scan).

import { getDraft, setDraftStatus, getDraftDocumentFile } from "@/lib/registration";

// ── PDF text extraction (unpdf) ─────────────────────────────────────────────
async function readPdfText(buffer) {
  const { getDocumentProxy, extractText } = await import("unpdf");
  const pdf = await getDocumentProxy(new Uint8Array(buffer));
  const { text } = await extractText(pdf, { mergePages: true });
  return text || "";
}

// ── Label-delimited field parser ────────────────────────────────────────────
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// All recognised section labels (used as value delimiters). Only specific,
// multi-word labels — never generic single words like "COMPANY" which would
// wrongly truncate values such as "Private Company Limited by Shares".
const ALL_LABELS = [
  "COMPANY NAME", "NAME OF COMPANY",
  "COMPANY REGISTRATION NUMBER", "REGISTRATION NUMBER", "REGISTRATION NO", "REG NUMBER", "REG NO",
  "COMPANY NUMBER", "COMPANY NO",
  "COMPANY STATUS", "PREVIOUS STATUSES",
  "DATE OF INCORPORATION", "INCORPORATION DATE", "DATE INCORPORATED",
  "COMPANY TYPE", "TYPE OF COMPANY",
  "TRADE NAME",
  "SINGLE OR MULTIPLE SHAREHOLDERS", "SHAREHOLDERS",
  "ANNUAL FILING MONTH", "ANNUAL FILING DAY",
  "BUSINESS ACTIVITIES",
  "REGISTERED OFFICE ADDRESS", "REGISTERED OFFICE", "REGISTERED ADDRESS", "PRINCIPAL PLACE OF BUSINESS",
  "PHYSICAL ADDRESS", "POSTAL ADDRESS",
  "LOCATION OF COMPANY REGISTERS", "MAIN BUSINESS ADDRESS", "ADDRESSES", "GENERAL DETAILS",
  "DIRECTORS", "DIRECTOR",
  "AUTHORISED SHARE CAPITAL", "AUTHORIZED SHARE CAPITAL", "SHARE CAPITAL", "NOMINAL CAPITAL",
  "REGISTRAR OF COMPANIES", "CERTIFICATE NO", "CERTIFICATE NUMBER",
];

function parseFields(rawText) {
  const text = rawText.replace(/\s+/g, " ").trim();

  // Capture the text between a start label and the nearest following label.
  // Tolerates a trailing colon (OCR'd docs use "Label: value").
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
      if (val) return val;
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

  // Company name
  let name = between(["COMPANY NAME", "NAME OF COMPANY"]);
  if (name) set("company_name", name, 0.93);
  else {
    const m = text.match(/([A-Z][A-Za-z0-9&.,'\-\s]{2,80}(?:\(Pty\)\s*Ltd|\(Proprietary\)\s*Limited|Limited|Ltd|PLC|Inc)\.?)/);
    if (m) set("company_name", m[1], 0.7);
  }

  // Registration number ("Company Number" on a Company Extract)
  let reg = between(["COMPANY REGISTRATION NUMBER", "REGISTRATION NUMBER", "REGISTRATION NO", "REG NUMBER", "REG NO", "COMPANY NUMBER", "COMPANY NO"]);
  if (reg && /[A-Za-z0-9]/.test(reg)) set("registration_number", reg, 0.92);
  else {
    const m = text.match(/\bCR[-\s]?\d{2,4}\/?\d{2,6}\b/i);
    if (m) set("registration_number", m[0], 0.7);
  }

  // Incorporation date
  let date = between(["DATE OF INCORPORATION", "INCORPORATION DATE", "DATE INCORPORATED"]);
  if (date) set("incorporation_date", date, 0.9);
  else {
    const m = text.match(/\b\d{1,2}\s+(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{4}\b/i)
           || text.match(/\b\d{4}-\d{2}-\d{2}\b/);
    if (m) set("incorporation_date", m[0], 0.65);
  }

  // Company type
  let type = between(["COMPANY TYPE", "TYPE OF COMPANY"]);
  if (type) set("company_type", type, 0.88);
  else {
    const m = text.match(/Private Company Limited by Shares|Public Company|Company Limited by Guarantee/i);
    if (m) set("company_type", m[0], 0.7);
  }

  // Registered address — on a Company Extract the value sits under
  // "Physical Address", so try that first; on a Certificate it's directly
  // under "Registered Office Address".
  let addr = between(["PHYSICAL ADDRESS", "REGISTERED OFFICE ADDRESS", "REGISTERED OFFICE", "REGISTERED ADDRESS", "PRINCIPAL PLACE OF BUSINESS"]);
  if (addr) set("registered_address", addr, 0.85);

  // Directors
  let dirs = between(["DIRECTORS", "DIRECTOR"]);
  if (dirs) set("directors", dirs.replace(/;/g, ", "), 0.8);

  // Share capital + authorised shares
  let cap = between(["AUTHORISED SHARE CAPITAL", "AUTHORIZED SHARE CAPITAL", "SHARE CAPITAL", "NOMINAL CAPITAL"]);
  if (cap) {
    set("share_capital", cap, 0.85);
    const shares = cap.match(/([\d,]{4,})\s*(?:ordinary\s+)?shares/i);
    if (shares) set("authorized_shares", Number(shares[1].replace(/,/g, "")), 0.82);
  }

  // Contact email if present
  const email = text.match(/[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}/);
  if (email) set("contact_email", email[0], 0.6);

  return { fields, confidence, matched: Object.keys(fields).length };
}

// Fields we attempt to read from a certificate. Anything not found is reported
// back as "missing" so the issuer can fill it in — never fabricated.
export const EXPECTED_FIELDS = [
  "company_name",
  "registration_number",
  "incorporation_date",
  "company_type",
  "registered_address",
  "directors",
  "share_capital",
];

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
 *   - missing:  expected fields not detected (for user feedback)
 *   - readable: whether any text could be read from the document at all
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

    if (file?.file_data && /pdf/i.test(mime)) {
      try {
        const buffer = Buffer.from(file.file_data, "base64");
        const text = await readPdfText(buffer);
        if (text && text.replace(/\s/g, "").length > 40) {
          readable = true;
          const parsed = parseFields(text);
          fields = parsed.fields;
          confidence = parsed.confidence;
          console.log(`[REG] Extracted ${parsed.matched} fields from draft ${draftId}`);
        }
      } catch (pdfErr) {
        console.warn(`[REG] PDF parse failed for draft ${draftId}: ${pdfErr.message}`);
      }
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
