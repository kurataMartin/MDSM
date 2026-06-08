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

// ── Helper functions ────────────────────────────────────────────────────────
const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// All recognised section labels
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

function startsWithLabel(v) {
  const s = v.trim();
  return ALL_LABELS.some((l) => new RegExp("^" + escapeRegex(l) + "\\b", "i").test(s));
}

// ── Company Name Extraction (Improved) ──────────────────────────────────────
function extractCompanyName(text, between) {
  // First try label-based extraction
  let name = between(["COMPANY NAME", "NAME OF COMPANY"]);
  if (name) {
    return { name, confidence: 0.93 };
  }

  // Company suffix patterns (ordered by specificity)
  const suffixPatterns = [
    // Pattern 1: (Pty) Ltd or (Proprietary) Limited
    { regex: /([A-Z][A-Za-z0-9&.,'\-\s]{3,100}?)\s+\(Pty\)\s+Ltd/i, confidence: 0.85 },
    { regex: /([A-Z][A-Za-z0-9&.,'\-\s]{3,100}?)\s+\(Proprietary\)\s+Limited/i, confidence: 0.85 },
    // Pattern 2: Limited or Ltd
    { regex: /([A-Z][A-Za-z0-9&.,'\-\s]{3,100}?)\s+Limited\b/i, confidence: 0.8 },
    { regex: /([A-Z][A-Za-z0-9&.,'\-\s]{3,100}?)\s+Ltd\b/i, confidence: 0.8 },
    // Pattern 3: PLC, Inc, Corporation
    { regex: /([A-Z][A-Za-z0-9&.,'\-\s]{3,100}?)\s+PLC\b/i, confidence: 0.75 },
    { regex: /([A-Z][A-Za-z0-9&.,'\-\s]{3,100}?)\s+Inc\b/i, confidence: 0.75 },
    { regex: /([A-Z][A-Za-z0-9&.,'\-\s]{3,100}?)\s+Corporation\b/i, confidence: 0.75 },
    { regex: /([A-Z][A-Za-z0-9&.,'\-\s]{3,100}?)\s+Corp\b/i, confidence: 0.75 },
  ];

  // Try each suffix pattern
  for (const pattern of suffixPatterns) {
    const match = text.match(pattern.regex);
    if (match && match[1]) {
      let name = match[1].trim();
      name = name.replace(/\s+/g, " ").replace(/[:;,\-–]\s*$/, "");
      if (name.length > 3) {
        return { name, confidence: pattern.confidence };
      }
    }
  }

  // Try label-based patterns (e.g., "Company Name: XYZ Ltd")
  const labelPatterns = [
    { regex: /(?:company\s+name|name\s+of\s+company|entity\s+name)\s*:?\s*([A-Z][A-Za-z0-9&.,'\-\s]{5,100}?)(?=\s+(?:\(Pty\)|Limited|Ltd|PLC|Inc|\d|Company\s+Registration))/i, confidence: 0.8 },
    { regex: /(?:^|\n|\r|:)\s*([A-Z][A-Za-z0-9&.,\-\s]{3,100}?)\s+(?:\(Pty\)\s*Ltd|\(Proprietary\)\s*Limited|Limited\b|Ltd\b|PLC\b|Inc\b)/i, confidence: 0.75 },
  ];

  for (const pattern of labelPatterns) {
    const match = text.match(pattern.regex);
    if (match && match[1]) {
      let name = match[1].trim();
      name = name.replace(/\s+/g, " ").replace(/[:;,\-–]\s*$/, "");
      if (name.length > 3) {
        return { name, confidence: pattern.confidence };
      }
    }
  }

  // Try certificate header pattern
  const headerPatterns = [
    { regex: /CERTIFICATE\s+OF\s+INCORPORATION\s+(?:FOR\s+)?([A-Z][A-Za-z0-9&.,\-\s]{5,80}?)(?:\s+\(Pty\)|\s+Ltd|\s+Limited)/i, confidence: 0.7 },
    { regex: /CERTIFICATE\s+OF\s+REGISTRATION\s+(?:FOR\s+)?([A-Z][A-Za-z0-9&.,\-\s]{5,80}?)(?:\s+\(Pty\)|\s+Ltd|\s+Limited)/i, confidence: 0.7 },
  ];

  for (const pattern of headerPatterns) {
    const match = text.match(pattern.regex);
    if (match && match[1]) {
      let name = match[1].trim();
      name = name.replace(/\s+/g, " ").replace(/[:;,\-–]\s*$/, "");
      if (name.length > 3) {
        return { name, confidence: pattern.confidence };
      }
    }
  }

  // Try with registration number context
  const regContextMatch = text.match(/([A-Z][A-Za-z0-9&.,\-\s]{5,80}?)\s+(?:\(Pty\)\s*Ltd|Limited|Ltd)\s+(?:CR[-\s]?\d+)/i);
  if (regContextMatch && regContextMatch[1]) {
    let name = regContextMatch[1].trim();
    name = name.replace(/\s+/g, " ").replace(/[:;,\-–]\s*$/, "");
    if (name.length > 3) {
      return { name, confidence: 0.7 };
    }
  }

  return null;
}

// ── Registration Number Extraction ──────────────────────────────────────────
function extractRegistrationNumber(text, between) {
  let reg = between(["COMPANY REGISTRATION NUMBER", "REGISTRATION NUMBER", "REGISTRATION NO", "REG NUMBER", "REG NO", "COMPANY NUMBER", "COMPANY NO"]);
  if (reg && /[A-Za-z0-9]/.test(reg)) {
    return { value: reg, confidence: 0.92 };
  }
  
  const match = text.match(/\bCR[-\s]?\d{2,4}\/?\d{2,6}\b/i);
  if (match) {
    return { value: match[0], confidence: 0.7 };
  }
  
  return null;
}

// ── Date Extraction ─────────────────────────────────────────────────────────
function extractDate(text, between) {
  let date = between(["DATE OF INCORPORATION", "INCORPORATION DATE", "DATE INCORPORATED"]);
  if (date) {
    return { value: date, confidence: 0.9 };
  }
  
  const patterns = [
    text.match(/\b\d{1,2}\s+(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{4}\b/i),
    text.match(/\b\d{4}-\d{2}-\d{2}\b/),
    text.match(/\b\d{1,2}\/\d{1,2}\/\d{4}\b/),
    text.match(/\b\d{1,2}-\d{1,2}-\d{4}\b/)
  ];
  
  for (const match of patterns) {
    if (match) {
      return { value: match[0], confidence: 0.65 };
    }
  }
  
  return null;
}

// ── Company Type Extraction ─────────────────────────────────────────────────
function extractCompanyType(text, between) {
  let type = between(["COMPANY TYPE", "TYPE OF COMPANY"]);
  if (type) {
    return { value: type, confidence: 0.88 };
  }
  
  const match = text.match(/Private Company Limited by Shares|Public Company|Company Limited by Guarantee/i);
  if (match) {
    return { value: match[0], confidence: 0.7 };
  }
  
  return null;
}

// ── Address Extraction ──────────────────────────────────────────────────────
function extractAddress(text, between) {
  // Try content-based patterns first
  let addr = text.match(/\b([A-Z][A-Za-z]+(?:\s+[A-Z][A-Za-z]+)*\s+Road,\s*[A-Za-z]+\s*\d+,?\s*Lesotho)/i)?.[1] ||
             text.match(/\b(P\.?\s*O\.?\s*Box\s*\d+,\s*[A-Za-z]+\s*\d+,?\s*Lesotho)/i)?.[1];
  
  if (addr && !startsWithLabel(addr)) {
    return { value: addr, confidence: 0.85 };
  }
  
  // Fall back to label-based extraction
  addr = between(["PHYSICAL ADDRESS", "REGISTERED OFFICE ADDRESS", "REGISTERED OFFICE", "REGISTERED ADDRESS", "PRINCIPAL PLACE OF BUSINESS"]);
  if (addr && !startsWithLabel(addr)) {
    return { value: addr, confidence: 0.85 };
  }
  
  return null;
}

// ── Directors Extraction ────────────────────────────────────────────────────
function extractDirectors(text, between) {
  let dirs = between(["DIRECTORS", "DIRECTOR"]);
  if (dirs) {
    return { value: dirs.replace(/;/g, ", "), confidence: 0.8 };
  }
  return null;
}

// ── Share Capital Extraction ────────────────────────────────────────────────
function extractShareCapital(text, between) {
  // Try content pattern first
  let cap = text.match(/M\s*[\d,]+(?:\.\d{2})?\s*\(\s*[\d,]+[^)]*shares[^)]*\)/i)?.[0];
  
  if (!cap) {
    cap = between(["AUTHORISED SHARE CAPITAL", "AUTHORIZED SHARE CAPITAL", "SHARE CAPITAL", "NOMINAL CAPITAL"]);
  }
  
  if (cap && !startsWithLabel(cap)) {
    const result = { share_capital: cap.trim(), confidence: 0.85 };
    
    // Extract authorized shares
    const shares = cap.match(/([\d,]{4,})\s*(?:ordinary\s+)?shares/i);
    if (shares) {
      result.authorized_shares = Number(shares[1].replace(/,/g, ""));
      result.authorized_shares_confidence = 0.82;
    }
    
    // Extract price per share
    const price = cap.match(/of\s*M?\s*([\d,]+(?:\.\d+)?)\s*(?:each|per\s+share)/i) ||
                  cap.match(/M\s*([\d,]+(?:\.\d+)?)\s*(?:each|per\s+share)/i);
    if (price) {
      result.price_per_share = Number(price[1].replace(/,/g, ""));
      result.price_per_share_confidence = 0.8;
    }
    
    return result;
  }
  
  return null;
}

// ── Main parseFields function ───────────────────────────────────────────────
function parseFields(rawText) {
  const text = rawText.replace(/\s+/g, " ").trim();

  // Label-based value extractor
  const between = (starts) => {
    for (const start of starts) {
      const m = new RegExp("\\b" + escapeRegex(start) + "\\s*:?\\s*", "i").exec(text);
      if (!m) continue;
      const rest = text.slice(m.index + m[0].length);
      const stops = ALL_LABELS.filter((l) => !starts.includes(l));
      let end = rest.length;
      for (const stop of stops) {
        const sm = new RegExp("\\b" + escapeRegex(stop) + "\\b", "i").exec(rest);
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

  // Extract each field using dedicated functions
  const companyName = extractCompanyName(text, between);
  if (companyName) set("company_name", companyName.name, companyName.confidence);

  const registrationNumber = extractRegistrationNumber(text, between);
  if (registrationNumber) set("registration_number", registrationNumber.value, registrationNumber.confidence);

  const date = extractDate(text, between);
  if (date) set("incorporation_date", date.value, date.confidence);

  const companyType = extractCompanyType(text, between);
  if (companyType) set("company_type", companyType.value, companyType.confidence);

  const address = extractAddress(text, between);
  if (address) set("registered_address", address.value, address.confidence);

  const directors = extractDirectors(text, between);
  if (directors) set("directors", directors.value, directors.confidence);

  const shareCapital = extractShareCapital(text, between);
  if (shareCapital) {
    set("share_capital", shareCapital.share_capital, shareCapital.confidence);
    if (shareCapital.authorized_shares) set("authorized_shares", shareCapital.authorized_shares, shareCapital.authorized_shares_confidence);
    if (shareCapital.price_per_share) set("price_per_share", shareCapital.price_per_share, shareCapital.price_per_share_confidence);
  }

  // Contact email if present
  const email = text.match(/[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}/);
  if (email) set("contact_email", email[0], 0.6);

  return { fields, confidence, matched: Object.keys(fields).length };
}

// Fields we attempt to read from a certificate
export const EXPECTED_FIELDS = [
  "company_name",
  "registration_number",
  "incorporation_date",
  "company_type",
  "registered_address",
  "directors",
  "share_capital",
];

// ── Public API Functions ────────────────────────────────────────────────────

/**
 * One-shot scan: take raw document bytes (base64) + mime, read the text
 * (PDF via unpdf, image via OCR), parse the fields, and return them.
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
 * persist the result.
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
 *   - missing: expected fields not detected (for user feedback)
 *   - readable: whether any text could be read from the document at all
 */
export async function extractFromDraft(draftId) {
  const draft = await getDraft(draftId);
  if (!draft) return { success: false, error: "Draft not found" };
  if (!draft.documents || draft.documents.length === 0) {
    await setDraftStatus(draftId, "failed", { parseError: "No documents to read" });
    return { success: false, error: "No documents to read" };
  }

  try {
    const docsNewestFirst = [...draft.documents].reverse();
    const cert = docsNewestFirst.find((d) => /certificate/i.test(d.doc_type || "")) || docsNewestFirst[0];
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
