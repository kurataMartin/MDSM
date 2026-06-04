// lib/registration.js
// Server-only helpers for the issuer "Register New Public Company" draft flow.
// Documents are stored as base64 directly in Postgres (no external bucket),
// consistent with the KYC document storage.

import { query, getRow, getRows } from "@/lib/db";
import { randomUUID } from "crypto";

// ── Lazy schema setup (runs once per process) ──────────────────────────────
let _tablesEnsured = false;
async function ensureTables() {
  if (_tablesEnsured) return;
  _tablesEnsured = true;

  await query(`
    CREATE TABLE IF NOT EXISTS company_registration_drafts (
      id          text PRIMARY KEY,
      issuer_id   integer,
      status      text NOT NULL DEFAULT 'draft',   -- draft|processing|parsed|failed|pending_review|approved
      extracted   jsonb,                            -- { company_name, registration_number, ... }
      confidence  jsonb,                            -- { field: 0..1 }
      parse_error text,
      created_at  timestamptz NOT NULL DEFAULT now(),
      updated_at  timestamptz NOT NULL DEFAULT now()
    )
  `).catch((e) => console.warn("[REG] drafts table:", e.message));

  await query(`
    CREATE TABLE IF NOT EXISTS draft_documents (
      id         serial PRIMARY KEY,
      draft_id   text REFERENCES company_registration_drafts(id) ON DELETE CASCADE,
      doc_type   text,
      file_name  text,
      file_mime  text,
      file_data  text,                              -- base64
      created_at timestamptz NOT NULL DEFAULT now()
    )
  `).catch((e) => console.warn("[REG] draft_documents table:", e.message));
}

// ── Draft lifecycle ─────────────────────────────────────────────────────────

export async function createDraft(issuerId) {
  await ensureTables();
  const id = randomUUID();
  await query(
    `INSERT INTO company_registration_drafts (id, issuer_id, status) VALUES ($1, $2, 'draft')`,
    [id, issuerId ?? null]
  );
  return { id, status: "draft" };
}

export async function addDraftDocument(draftId, { docType, fileName, fileMime, fileData }) {
  await ensureTables();
  const ins = await query(
    `INSERT INTO draft_documents (draft_id, doc_type, file_name, file_mime, file_data)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [draftId, docType ?? "document", fileName ?? "document",
     fileMime ?? "application/octet-stream", fileData ?? null]
  );
  return ins.rows[0]?.id;
}

export async function setDraftStatus(draftId, status, { extracted, confidence, parseError } = {}) {
  await ensureTables();
  await query(
    `UPDATE company_registration_drafts
       SET status      = $2,
           extracted   = COALESCE($3::jsonb, extracted),
           confidence  = COALESCE($4::jsonb, confidence),
           parse_error = $5,
           updated_at  = now()
     WHERE id = $1`,
    [
      draftId,
      status,
      extracted  ? JSON.stringify(extracted)  : null,
      confidence ? JSON.stringify(confidence) : null,
      parseError ?? null,
    ]
  );
}

export async function getDraft(draftId) {
  await ensureTables();
  const draft = await getRow(
    `SELECT id, issuer_id, status, extracted, confidence, parse_error, created_at, updated_at
       FROM company_registration_drafts WHERE id = $1`,
    [draftId]
  );
  if (!draft) return null;
  const documents = await getRows(
    `SELECT id, doc_type, file_name, file_mime, created_at
       FROM draft_documents WHERE draft_id = $1 ORDER BY id`,
    [draftId]
  );
  return { ...draft, documents };
}

// Returns the raw base64 + mime for one draft document (used by the file route).
export async function getDraftDocumentFile(docId) {
  await ensureTables();
  return getRow(
    `SELECT file_data, file_mime, file_name FROM draft_documents WHERE id = $1`,
    [docId]
  );
}
