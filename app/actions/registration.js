"use server";

// Server actions for the issuer "Register New Public Company" draft flow.
// Phase 2: draft lifecycle + document upload (extraction added in Phase 3).

import { createDraft, addDraftDocument, setDraftStatus, getDraft } from "@/lib/registration";
import { extractFromDraft, extractFromText, scanBytes } from "@/lib/extraction";

// One-shot scan: receives the file directly, reads + parses it, returns the
// fields. No DB round-trips, so it can't hang on large uploads.
export async function scanDocument(formData) {
  try {
    if (!formData || typeof formData.get !== "function") return { success: false, error: "Invalid form data" };
    const file = formData.get("file");
    if (!file || typeof file.arrayBuffer !== "function" || file.size === 0) {
      return { success: false, error: "No file provided" };
    }
    if (file.size > 8 * 1024 * 1024) return { success: false, error: "File exceeds 8 MB" };
    const mime = file.type || "";
    const base64 = Buffer.from(await file.arrayBuffer()).toString("base64");
    return await scanBytes(base64, mime);
  } catch (err) {
    console.error("[REG] scanDocument failed:", err.message);
    return { success: false, error: err.message };
  }
}

const MAX_FILE_BYTES = 8 * 1024 * 1024; // 8 MB

// Event 1 — REGISTRATION_STARTED
export async function startDraft(issuerId) {
  try {
    const draft = await createDraft(issuerId ? Number(issuerId) : null);
    return { success: true, draftId: draft.id, status: draft.status };
  } catch (err) {
    console.error("[REG] startDraft failed:", err.message);
    return { success: false, error: err.message };
  }
}

// Event 2 — DOCUMENT_UPLOADED
// Accepts a FormData with `draftId` + one or more named file fields.
export async function uploadDraftDocuments(formData) {
  try {
    if (!formData || typeof formData.get !== "function") {
      return { success: false, error: "Invalid form data" };
    }
    const draftId = formData.get("draftId")?.toString();
    if (!draftId) return { success: false, error: "Missing draftId" };

    const fileFields = [
      "certificateOfIncorporation",
      "financials",
      "memorandum",
      "directorsRegister",
      "other",
    ];

    let count = 0;
    for (const field of fileFields) {
      const file = formData.get(field);
      if (!file || typeof file.arrayBuffer !== "function" || file.size === 0) continue;

      // Validate type + size
      const mime = file.type || "application/octet-stream";
      const okType = /pdf|png|jpe?g/i.test(mime) || /\.(pdf|png|jpe?g)$/i.test(file.name || "");
      if (!okType) {
        return { success: false, error: `Unsupported file type for ${field} (use PDF, PNG or JPG)` };
      }
      if (file.size > MAX_FILE_BYTES) {
        return { success: false, error: `${field} exceeds the 8 MB limit` };
      }

      const buffer = Buffer.from(await file.arrayBuffer());
      await addDraftDocument(draftId, {
        docType:  field,
        fileName: file.name || `${field}`,
        fileMime: mime,
        fileData: buffer.toString("base64"),
      });
      count++;
    }

    if (count === 0) return { success: false, error: "No valid files were uploaded" };

    // Move to 'processing'. Phase 3 will run OCR/LLM extraction and flip this to
    // 'parsed' (or 'failed'); until then it remains 'processing'.
    await setDraftStatus(draftId, "processing");

    return { success: true, draftId, count };
  } catch (err) {
    console.error("[REG] uploadDraftDocuments failed:", err.message);
    return { success: false, error: err.message };
  }
}

// Event 3 — EXTRACTION_PROCESSING
// Called by the client immediately after a successful upload. Runs OCR/LLM
// extraction (Phase 3 = stub) and flips the draft to 'parsed' or 'failed'.
// Kept as its own short request so it stays within serverless limits and works
// unchanged when the real (slower) Claude pipeline is dropped in.
export async function processDraftExtraction(draftId) {
  try {
    if (!draftId) return { success: false, error: "Missing draftId" };
    const result = await extractFromDraft(draftId);
    return result;
  } catch (err) {
    console.error("[REG] processDraftExtraction failed:", err.message);
    return { success: false, error: err.message };
  }
}

// Event 3b — extraction from OCR text (images are OCR'd client-side, then the
// recognized text is parsed here). Keeps heavy OCR off the serverless function.
export async function processDraftText(draftId, text) {
  try {
    if (!draftId) return { success: false, error: "Missing draftId" };
    return await extractFromText(draftId, text || "");
  } catch (err) {
    console.error("[REG] processDraftText failed:", err.message);
    return { success: false, error: err.message };
  }
}

// Event 4 — polled by the frontend for status + extracted fields
export async function getDraftStatus(draftId) {
  try {
    if (!draftId) return { success: false, error: "Missing draftId" };
    const draft = await getDraft(draftId);
    if (!draft) return { success: false, error: "Draft not found" };
    return { success: true, draft };
  } catch (err) {
    console.error("[REG] getDraftStatus failed:", err.message);
    return { success: false, error: err.message };
  }
}
