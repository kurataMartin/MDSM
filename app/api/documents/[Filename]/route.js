// app/api/documents/[filename]/route.js
// Serves KYC documents from Supabase Storage

import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

// Must match the upload bucket (lib/storage/kyc-storage.js → SUPABASE_KYC_BUCKET).
const BUCKET_NAME = (process.env.SUPABASE_KYC_BUCKET || "documents").trim();

// Lazy client — created on first request, not at build time.
// Prefer the service-role key so private buckets are readable server-side.
function getSupabase() {
  const url = (process.env.NEXT_PUBLIC_SUPABASE_URL || "").trim();
  const key = (process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "").trim();
  if (!url || !key) {
    throw new Error(
      "Missing Supabase environment variables. " +
      "Set NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in Vercel."
    );
  }
  return createClient(url, key);
}

export async function GET(request, { params }) {
  try {
    const { filename } = await params;

    if (!filename) {
      return NextResponse.json(
        { error: "Filename is required" },
        { status: 400 }
      );
    }

    const { searchParams } = new URL(request.url);
    const userId = searchParams.get("userId");
    const kycId  = searchParams.get("kycId");

    const storagePath = `kyc/${userId}/${kycId}/${filename}`;
    console.log(`[Documents API] Retrieving: ${storagePath}`);

    const supabase = getSupabase();
    const { data, error } = await supabase.storage
      .from(BUCKET_NAME)
      .download(storagePath);

    if (error) {
      console.error(`[Documents API] Download error: ${storagePath}`, error);
      return NextResponse.json({ error: "Document not found" }, { status: 404 });
    }

    const ext = filename.split(".").pop()?.toLowerCase() || "";
    const contentTypes = {
      pdf:  "application/pdf",
      jpg:  "image/jpeg",
      jpeg: "image/jpeg",
      png:  "image/png",
      gif:  "image/gif",
      webp: "image/webp",
      doc:  "application/msword",
      docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      xls:  "application/vnd.ms-excel",
      xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    };

    return new NextResponse(data, {
      headers: {
        "Content-Type":        contentTypes[ext] || "application/octet-stream",
        "Content-Disposition": `inline; filename="${filename}"`,
        "Cache-Control":       "private, max-age=3600",
      },
    });
  } catch (error) {
    console.error("[Documents API] Error:", error);
    return NextResponse.json({ error: "Failed to retrieve document" }, { status: 500 });
  }
}
