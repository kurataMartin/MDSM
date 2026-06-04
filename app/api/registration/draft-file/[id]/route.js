// app/api/registration/draft-file/[id]/route.js
// Serves a draft registration document stored as base64 in Postgres.

import { NextResponse } from "next/server";
import { getDraftDocumentFile } from "@/lib/registration";

export const dynamic = "force-dynamic";

export async function GET(_request, { params }) {
  try {
    const { id } = await params;
    const docId = Number(id);
    if (!docId || Number.isNaN(docId)) {
      return NextResponse.json({ error: "Invalid document id" }, { status: 400 });
    }

    const row = await getDraftDocumentFile(docId);
    if (!row || !row.file_data) {
      return NextResponse.json({ error: "Document not found" }, { status: 404 });
    }

    const buffer = Buffer.from(row.file_data, "base64");
    return new NextResponse(buffer, {
      headers: {
        "Content-Type": row.file_mime || "application/octet-stream",
        "Content-Disposition": `inline; filename="${row.file_name || `document-${docId}`}"`,
        "Cache-Control": "private, max-age=3600",
      },
    });
  } catch (err) {
    console.error("[REG draft-file] Error:", err);
    return NextResponse.json({ error: "Failed to load document" }, { status: 500 });
  }
}
