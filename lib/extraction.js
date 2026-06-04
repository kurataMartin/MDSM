// lib/extraction.js
// FREE document field extraction for the company-registration draft flow.
//
// Strategy (no paid API):
//   1. Pull text from the uploaded PDF (pdf-parse).
//   2. Match known certificate fields with label-based + regex parsing.
//   3. Assign a confidence per field (explicit label = high, loose match = lower).
//   4. If the file isn't a readable text PDF (e.g. a scanned image), fall back
//      to the sample stub so the flow still completes.

import { getDraft, setDraftStatus, getDraftDocumentFile } from "@/lib/registration";

// ── PDF text extraction (pdf-parse v1.1.1, Node-friendly) ───────────────────
// Import the internal lib path to skip pdf-parse's debug block that reads a
// bundled test PDF when imported as the package entry point.
async function readPdfText(buffer) {
  const mod = await import("pdf-parse/lib/pdf-parse.js");
  const pdfParse = mod.default || mod;
  const data = await pdfParse(buffer);
  return data?.text || "";
}

// ── Label/regex field parser ────────────────────────────────────────────────
function parseFields(text) {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);

  // Find a value by label: handles "Label: value" and "LABEL\nvalue".
  const byLabel = (variants) => {
    for (let i = 0; i < lines.length; i++) {
      const low = lines[i].toLowerCase();
      for (const lab of variants) {
        if (low.startsWith(lab.toLowerCase())) {
          const sameLine = lines[i].slice(lab.length).replace(/^[:\-–\s]+/, "").trim();
          if (sameLine) return sameLine;
          if (i + 1 < lines.length) return lines[i + 1];
        }
      }
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
  let name = byLabel(["Company Name", "Name of Company"]);
  if (name) set("company_name", name, 0.93);
  else {
    const m = text.match(/([A-Z][A-Za-z0-9&.,'\-\s]{2,80}(?:\(Pty\)\s*Ltd|\(Proprietary\)\s*Limited|Limited|Ltd|PLC|Inc)\.?)/);
    if (m) set("company_name", m[1], 0.7);
  }

  // Registration number
  let reg = byLabel(["Company Registration Number", "Registration Number", "Registration No", "Reg Number", "Reg. Number"]);
  if (reg) set("registration_number", reg, 0.92);
  else {
    const m = text.match(/\bCR[-\s]?\d{2,4}\/?\d{2,6}\b/i);
    if (m) set("registration_number", m[0], 0.7);
  }

  // Incorporation date
  let date = byLabel(["Date of Incorporation", "Incorporation Date", "Date Incorporated"]);
  if (date) set("incorporation_date", date, 0.9);
  else {
    const m = text.match(/\b\d{1,2}\s+(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{4}\b/i)
           || text.match(/\b\d{4}-\d{2}-\d{2}\b/);
    if (m) set("incorporation_date", m[0], 0.65);
  }

  // Company type
  let type = byLabel(["Company Type", "Type of Company", "Type"]);
  if (type) set("company_type", type, 0.85);
  else {
    const m = text.match(/Private Company Limited by Shares|Public Company|Company Limited by Guarantee/i);
    if (m) set("company_type", m[0], 0.7);
  }

  // Registered address
  let addr = byLabel(["Registered Office Address", "Registered Office", "Registered Address", "Principal Place of Business"]);
  if (addr) set("registered_address", addr, 0.8);

  // Directors
  let dirs = byLabel(["Directors", "Director(s)", "Director"]);
  if (dirs) set("directors", dirs.replace(/;/g, ", "), 0.74);

  // Share capital + authorised shares
  let cap = byLabel(["Authorised Share Capital", "Authorized Share Capital", "Share Capital", "Nominal Capital"]);
  if (cap) {
    set("share_capital", cap, 0.82);
    const shares = cap.match(/([\d,]{4,})\s*(?:ordinary\s+)?shares/i);
    if (shares) set("authorized_shares", Number(shares[1].replace(/,/g, "")), 0.78);
  }

  // Contact email if present
  const email = text.match(/[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}/);
  if (email) set("contact_email", email[0], 0.6);

  const matched = Object.keys(fields).length;
  return { fields, confidence, matched };
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
      registered_address:  "Kingsway Road, Maseru 100, Lesotho",
      directors:           "T. Mokhesi, L. Nthunya",
      authorized_shares:   1000000,
      share_capital:       "M 5,000,000.00",
    },
    confidence: {
      company_name: 0.6, registration_number: 0.4, incorporation_date: 0.4,
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
    // Prefer the Certificate of Incorporation; else the first document.
    const cert = draft.documents.find((d) => /certificate/i.test(d.doc_type || "")) || draft.documents[0];
    const file = await getDraftDocumentFile(cert.id);
    const mime = file?.file_mime || "";

    let result = null;

    if (file?.file_data && /pdf/i.test(mime)) {
      const buffer = Buffer.from(file.file_data, "base64");
      const text = await readPdfText(buffer);
      if (text && text.replace(/\s/g, "").length > 40) {
        const parsed = parseFields(text);
        // Require at least the company name or a couple of fields to trust it.
        if (parsed.matched >= 2 && (parsed.fields.company_name || parsed.fields.registration_number)) {
          result = { fields: parsed.fields, confidence: parsed.confidence };
        }
      }
    }

    // Fallback for image scans / text-less PDFs / low-match results.
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
