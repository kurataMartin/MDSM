// lib/extraction.js
// FREE document field extraction for the company-registration draft flow.

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

// ── Main parseFields function with direct extraction ────────────────────────
function parseFields(rawText) {
  // Keep original text with line breaks for better pattern matching
  const text = rawText;
  
  const fields = {};
  const confidence = {};
  
  const set = (key, val, conf) => {
    if (val === null || val === undefined || val === "") return;
    fields[key] = typeof val === "string" ? val.trim() : val;
    confidence[key] = conf;
  };

  // Debug: Log the text to see what we're working with
  console.log("[REG] Text preview:", text.substring(0, 300));

  // ── COMPANY NAME EXTRACTION ──────────────────────────────────────────────
  // Method 1: Direct pattern for "COMPANY NAME Maluti Highlands Energy (Pty) Ltd"
  let companyNameMatch = text.match(/COMPANY\s+NAME\s+([A-Z][A-Za-z0-9&.,'\-\s]{3,150}?(?:\(Pty\)\s+Ltd|Limited|Ltd|PLC|Inc))/i);
  
  // Method 2: With colon "COMPANY NAME: Maluti Highlands Energy (Pty) Ltd"
  if (!companyNameMatch) {
    companyNameMatch = text.match(/COMPANY\s+NAME\s*:\s*([A-Z][A-Za-z0-9&.,'\-\s]{3,150}?(?:\(Pty\)\s+Ltd|Limited|Ltd|PLC|Inc))/i);
  }
  
  // Method 3: At line start after newline
  if (!companyNameMatch) {
    companyNameMatch = text.match(/\n\s*COMPANY\s+NAME\s+([^\n]+)/i);
  }
  
  if (companyNameMatch && companyNameMatch[1]) {
    let name = companyNameMatch[1].trim();
    // Clean up any trailing spaces or punctuation
    name = name.replace(/\s+/g, " ").replace(/[;:,]$/, "");
    console.log("[REG] Extracted company name:", name);
    set("company_name", name, 0.95);
  } else {
    console.log("[REG] Company name not found with direct patterns");
  }

  // ── REGISTRATION NUMBER EXTRACTION ───────────────────────────────────────
  let regMatch = text.match(/COMPANY\s+REGISTRATION\s+NUMBER\s+(CR[-\s]?\d{2,4}\/?\d{2,6})/i);
  if (!regMatch) {
    regMatch = text.match(/COMPANY\s+REGISTRATION\s+NUMBER\s*:\s*(CR[-\s]?\d{2,4}\/?\d{2,6})/i);
  }
  if (!regMatch) {
    regMatch = text.match(/\n\s*COMPANY\s+REGISTRATION\s+NUMBER\s+([^\n]+)/i);
  }
  if (!regMatch) {
    regMatch = text.match(/\bCR[-\s]?\d{2,4}\/?\d{2,6}\b/i);
  }
  
  if (regMatch) {
    let reg = regMatch[1] || regMatch[0];
    reg = reg.trim();
    console.log("[REG] Extracted registration number:", reg);
    set("registration_number", reg, 0.92);
  }

  // ── DATE OF INCORPORATION EXTRACTION ─────────────────────────────────────
  let dateMatch = text.match(/DATE\s+OF\s+INCORPORATION\s+(\d{1,2}\s+(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{4})/i);
  if (!dateMatch) {
    dateMatch = text.match(/DATE\s+OF\s+INCORPORATION\s*:\s*(\d{1,2}\s+(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{4})/i);
  }
  if (!dateMatch) {
    dateMatch = text.match(/\n\s*DATE\s+OF\s+INCORPORATION\s+([^\n]+)/i);
  }
  if (!dateMatch) {
    dateMatch = text.match(/\b\d{1,2}\s+(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{4}\b/i);
  }
  
  if (dateMatch) {
    let date = dateMatch[1] || dateMatch[0];
    date = date.trim();
    console.log("[REG] Extracted incorporation date:", date);
    set("incorporation_date", date, 0.92);
  }

  // ── COMPANY TYPE EXTRACTION ─────────────────────────────────────────────
  let typeMatch = text.match(/COMPANY\s+TYPE\s+(Private Company Limited by Shares|Public Company|Company Limited by Guarantee)/i);
  if (!typeMatch) {
    typeMatch = text.match(/COMPANY\s+TYPE\s*:\s*(Private Company Limited by Shares|Public Company|Company Limited by Guarantee)/i);
  }
  if (!typeMatch) {
    typeMatch = text.match(/\n\s*COMPANY\s+TYPE\s+([^\n]+)/i);
  }
  if (!typeMatch) {
    typeMatch = text.match(/Private Company Limited by Shares|Public Company|Company Limited by Guarantee/i);
  }
  
  if (typeMatch) {
    let type = typeMatch[1] || typeMatch[0];
    type = type.trim();
    console.log("[REG] Extracted company type:", type);
    set("company_type", type, 0.9);
  }

  // ── REGISTERED ADDRESS EXTRACTION ───────────────────────────────────────
  let addressMatch = text.match(/REGISTERED\s+OFFICE\s+ADDRESS\s+([^\n]+(?:Road|Street|Avenue|Box)[^\n]*)/i);
  if (!addressMatch) {
    addressMatch = text.match(/REGISTERED\s+OFFICE\s+ADDRESS\s*:\s*([^\n]+(?:Road|Street|Avenue|Box)[^\n]*)/i);
  }
  if (!addressMatch) {
    addressMatch = text.match(/\n\s*REGISTERED\s+OFFICE\s+ADDRESS\s+([^\n]+)/i);
  }
  if (!addressMatch) {
    addressMatch = text.match(/\b([A-Z][A-Za-z]+(?:\s+[A-Z][A-Za-z]+)*\s+Road,\s*[A-Za-z]+\s*\d+,?\s*Lesotho)/i);
  }
  
  if (addressMatch) {
    let address = addressMatch[1] || addressMatch[0];
    address = address.trim();
    console.log("[REG] Extracted registered address:", address);
    set("registered_address", address, 0.88);
  }

  // ── DIRECTORS EXTRACTION ─────────────────────────────────────────────────
  let directorsMatch = text.match(/DIRECTORS\s+([^\n]+(?:;|,)[^\n]*)/i);
  if (!directorsMatch) {
    directorsMatch = text.match(/DIRECTORS\s*:\s*([^\n]+(?:;|,)[^\n]*)/i);
  }
  if (!directorsMatch) {
    directorsMatch = text.match(/\n\s*DIRECTORS\s+([^\n]+)/i);
  }
  
  if (directorsMatch && directorsMatch[1]) {
    let directors = directorsMatch[1].trim();
    directors = directors.replace(/;/g, ", ");
    console.log("[REG] Extracted directors:", directors);
    set("directors", directors, 0.85);
  }

  // ── SHARE CAPITAL EXTRACTION ────────────────────────────────────────────
  let capitalMatch = text.match(/AUTHORISED\s+SHARE\s+CAPITAL\s+(M\s*[\d,]+(?:\.\d{2})?\s*\([^)]+shares[^)]+\))/i);
  if (!capitalMatch) {
    capitalMatch = text.match(/AUTHORISED\s+SHARE\s+CAPITAL\s*:\s*(M\s*[\d,]+(?:\.\d{2})?\s*\([^)]+shares[^)]+\))/i);
  }
  if (!capitalMatch) {
    capitalMatch = text.match(/\n\s*AUTHORISED\s+SHARE\s+CAPITAL\s+([^\n]+)/i);
  }
  if (!capitalMatch) {
    capitalMatch = text.match(/M\s*[\d,]+(?:\.\d{2})?\s*\(\s*[\d,]+[^)]*shares[^)]*\)/i);
  }
  
  if (capitalMatch) {
    let capital = capitalMatch[1] || capitalMatch[0];
    capital = capital.trim();
    console.log("[REG] Extracted share capital:", capital);
    set("share_capital", capital, 0.88);
    
    // Extract authorized shares
    const sharesMatch = capital.match(/([\d,]{4,})\s*(?:ordinary\s+)?shares/i);
    if (sharesMatch) {
      const shares = Number(sharesMatch[1].replace(/,/g, ""));
      console.log("[REG] Extracted authorized shares:", shares);
      set("authorized_shares", shares, 0.85);
    }
    
    // Extract price per share
    const priceMatch = capital.match(/of\s*M?\s*([\d,]+(?:\.\d+)?)\s*(?:each|per\s+share)/i) ||
                       capital.match(/M\s*([\d,]+(?:\.\d+)?)\s*(?:each|per\s+share)/i);
    if (priceMatch) {
      const price = Number(priceMatch[1].replace(/,/g, ""));
      console.log("[REG] Extracted price per share:", price);
      set("price_per_share", price, 0.85);
    }
  }

  // Contact email if present
  const email = text.match(/[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}/);
  if (email) set("contact_email", email[0], 0.6);

  console.log("[REG] Final extracted fields:", Object.keys(fields));
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
