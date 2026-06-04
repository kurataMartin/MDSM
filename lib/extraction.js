// lib/extraction.js
// Document field extraction for the company-registration draft flow.
//
// Phase 3 = STUB implementation: returns realistic sample fields with per-field
// confidence scores (some intentionally < 0.8 to exercise the "verify" UI).
//
// To go live later, replace ONLY the body of `extractFields()` with a real
// pipeline: (1) pull text from the draft's PDFs/images (pdf-parse / OCR), then
// (2) call the Claude API to return the same { fields, confidence } shape.
// Nothing else in the app needs to change.

import { getDraft, setDraftStatus } from "@/lib/registration";

// ── STUB extractor ──────────────────────────────────────────────────────────
// Produces a structured payload + confidence map. Uses the uploaded file names
// to make the sample feel connected to the actual upload.
async function extractFields(draft) {
  const docs = draft.documents || [];
  const primaryName = (docs[0]?.file_name || "company").replace(/\.[a-z0-9]+$/i, "");

  // Derive a plausible company name from the first document's filename
  const prettyName =
    primaryName.replace(/[_-]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()).trim() ||
    "Lesotho Holdings";

  const fields = {
    company_name:        prettyName + (/(ltd|plc|inc|holdings)/i.test(prettyName) ? "" : " (Pty) Ltd"),
    registration_number: "CR-" + Math.floor(100000 + Math.random() * 899999),
    incorporation_date:  "2021-03-14",
    company_type:        "Private Company Limited by Shares",
    registered_address:  "Kingsway Road, Maseru 100, Lesotho",
    directors:           "T. Mokhesi, L. Nthunya",
    authorized_shares:   1000000,
    share_capital:       "M 5,000,000.00",
    contact_email:       "info@" + prettyName.toLowerCase().replace(/[^a-z0-9]+/g, "") + ".co.ls",
  };

  // Confidence per field — values < 0.8 will be highlighted for manual review.
  const confidence = {
    company_name:        0.96,
    registration_number: 0.71,   // low → verify
    incorporation_date:  0.88,
    company_type:        0.63,   // low → verify
    registered_address:  0.82,
    directors:           0.74,   // low → verify
    authorized_shares:   0.69,   // low → verify
    share_capital:       0.91,
    contact_email:       0.58,   // low → verify
  };

  return { fields, confidence };
}

/**
 * Run extraction for a draft and persist the result.
 * Sets status → 'parsed' on success, or 'failed' with a reason.
 * Returns { success, extracted?, confidence?, error? }.
 */
export async function extractFromDraft(draftId) {
  const draft = await getDraft(draftId);
  if (!draft) return { success: false, error: "Draft not found" };
  if (!draft.documents || draft.documents.length === 0) {
    await setDraftStatus(draftId, "failed", { parseError: "No documents to read" });
    return { success: false, error: "No documents to read" };
  }

  try {
    // Simulate processing latency so the UI's "Reading documents…" state is visible.
    await new Promise((r) => setTimeout(r, 1200));

    const { fields, confidence } = await extractFields(draft);

    await setDraftStatus(draftId, "parsed", { extracted: fields, confidence });
    return { success: true, extracted: fields, confidence };
  } catch (err) {
    console.error("[REG] extraction failed for draft", draftId, ":", err.message);
    await setDraftStatus(draftId, "failed", {
      parseError: err.message || "Could not read the document. Try a clearer scan.",
    });
    return { success: false, error: err.message };
  }
}
