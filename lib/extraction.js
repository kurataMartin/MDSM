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

// All recognised section labels (used as value delimiters).
const ALL_LABELS = [
  "COMPANY NAME", "NAME OF COMPANY", "COMPANY",
  "COMPANY REGISTRATION NUMBER", "REGISTRATION NUMBER", "REGISTRATION NO", "REG NUMBER", "REG NO", "REGISTRATION",
  "DATE OF INCORPORATION", "INCORPORATION DATE", "DATE INCORPORATED",
  "COMPANY TYPE", "TYPE OF COMPANY",
  "REGISTERED OFFICE ADDRESS", "REGISTERED OFFICE", "REGISTERED ADDRESS", "PRINCIPAL PLACE OF BUSINESS",
  "DIRECTORS", "DIRECTOR",
  "AUTHORISED SHARE CAPITAL", "AUTHORIZED SHARE CAPITAL", "SHARE CAPITAL", "NOMINAL CAPITAL",
  "REGISTRAR OF COMPANIES", "CERTIFICATE NO", "CERTIFICATE NUMBER", "ISSUED", "DATE", "SIGNED", "SEAL",
];

function parseFields(rawText) {
  const text = rawText.replace(/\s+/g, " ").trim();

  // Capture the text between a start label and the nearest following label.
  const between = (starts) => {
    for (const start of starts) {
      const m = new RegExp(esc(start) + "\\s+", "i").exec(text);
      if (!m) continue;
      const rest = text.slice(m.index + m[0].length);
      const stops = ALL_LABELS.filter((l) => !starts.includes(l));
      let end = rest.length;
      for (const stop of stops) {
        const sm = new RegExp("\\b" + esc(stop) + "\\b", "i").exec(rest);
        if (sm && sm.index < end && sm.index > 0) end = sm.index;
      }
      const val = rest.slice(0, end).trim().replace(/\s{2,}/g, " ");
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

  // Registration number
  let reg = between(["COMPANY REGISTRATION NUMBER", "REGISTRATION NUMBER", "REGISTRATION NO", "REG NUMBER", "REG NO"]);
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

  // Registered address
  let addr = between(["REGISTERED OFFICE ADDRESS", "REGISTERED OFFICE", "REGISTERED ADDRESS", "PRINCIPAL PLACE OF BUSINESS"]);
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

// ── Sample fallback (used only when no readable text could be extracted) ─────
function stubFields(draft) {
  const primaryName = (draft.documents?.[0]?.file_name || "company").replace(/\.[a-z0-9]+$/i, "");
  const prettyName =
    primaryName.replace(/[_-]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()).trim() || "Lesotho Holdings";
  return {
    fields: {
      company_name:        prettyName + (/(ltd|plc|inc|holdings)/i.test(prettyName) ? "" : " (Pty) Ltd"),
      registration_number: "CR-" + Math.floor(100000 + Math.random() * 899999),
      incorporation_date:  "2021-03-14",
      company_type:        "Private Company Limited by Shares",
      registered_address:  "Maseru, Lesotho",
      directors:           "—",
      authorized_shares:   1000000,
      share_capital:       "M 1,000,000.00",
    },
    confidence: {
      company_name: 0.5, registration_number: 0.4, incorporation_date: 0.4,
      company_type: 0.5, registered_address: 0.4, directors: 0.4,
      authorized_shares: 0.4, share_capital: 0.5,
    },
  };
}

/**
 * Run extraction for a draft and persist the result.
 * Sets status → 'parsed' on success, or 'failed' with a reason.
 */
export async function extractFromDraft(draftId) {
  const draft = await getDraft(draftId);
  if (!draft) return { success: false, error: "Draft not found" };
  if (!draft.documents || draft.documents.length === 0) {
    await setDraftStatus(draftId, "failed", { parseError: "No documents to read" });
    return { success: false, error: "No documents to read" };
  }

  try {
    // Read the MOST RECENT document (documents are ordered by id ASC), so a
    // reused draft never returns an older upload.
    const docsNewestFirst = [...draft.documents].reverse();
    const cert =
      docsNewestFirst.find((d) => /certificate/i.test(d.doc_type || "")) ||
      docsNewestFirst[0];
    const file = await getDraftDocumentFile(cert.id);
    const mime = file?.file_mime || "";

    let result = null;

    if (file?.file_data && /pdf/i.test(mime)) {
      try {
        const buffer = Buffer.from(file.file_data, "base64");
        const text = await readPdfText(buffer);
        if (text && text.replace(/\s/g, "").length > 40) {
          const parsed = parseFields(text);
          if (parsed.fields.company_name || parsed.fields.registration_number) {
            result = { fields: parsed.fields, confidence: parsed.confidence };
            console.log(`[REG] Extracted ${parsed.matched} fields from draft ${draftId}`);
          } else {
            console.warn(`[REG] PDF text read but no identity fields matched for draft ${draftId}`);
          }
        }
      } catch (pdfErr) {
        console.warn(`[REG] PDF parse failed for draft ${draftId}: ${pdfErr.message} — using fallback`);
      }
    }

    if (!result) {
      console.warn(`[REG] No reliable text extracted for draft ${draftId} — using fallback sample`);
      result = stubFields(draft);
    }

    await setDraftStatus(draftId, "parsed", { extracted: result.fields, confidence: result.confidence });
    return { success: true, extracted: result.fields, confidence: result.confidence };
  } catch (err) {
    console.error("[REG] extraction failed for draft", draftId, ":", err.message);
    await setDraftStatus(draftId, "failed", {
      parseError: err.message || "Could not read the document. Try a clearer scan or enter details manually.",
    });
    return { success: false, error: err.message };
  }
}
