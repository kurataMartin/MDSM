// app/api/kyc-file/[id]/route.js
// Serves a KYC document stored directly in Postgres (base64 in kyc_documents.file_data).
// No external object storage required.

import { NextResponse } from "next/server";
import { getRow } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function GET(_request, { params }) {
  try {
    const { id } = await params;
    const docId = Number(id);
    if (!docId || Number.isNaN(docId)) {
      return NextResponse.json({ error: "Invalid document id" }, { status: 400 });
    }

    const row = await getRow(
      `SELECT file_data, file_mime, document_number
         FROM kyc_documents
        WHERE id = $1`,
      [docId]
    );

    if (!row || !row.file_data) {
      return NextResponse.json({ error: "Document not found" }, { status: 404 });
    }

    const buffer = Buffer.from(row.file_data, "base64");
    const mime = row.file_mime || "application/octet-stream";
    const filename = row.document_number || `document-${docId}`;

    return new NextResponse(buffer, {
      headers: {
        "Content-Type": mime,
        "Content-Disposition": `inline; filename="${filename}"`,
        "Cache-Control": "private, max-age=3600",
      },
    });
  } catch (err) {
    console.error("[kyc-file] Error:", err);
    return NextResponse.json({ error: "Failed to load document" }, { status: 500 });
  }
}
