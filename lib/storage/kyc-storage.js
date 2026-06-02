// lib/storage/kyc-storage.js
// Supabase Storage utility for KYC document uploads (server-side only)

import { createClient } from "@supabase/supabase-js";

// Read env at call-time (not import-time) and trim whitespace — a stray space
// after "KEY=" in an env value otherwise produces an invalid JWT and every
// upload silently fails.
function env(name) {
  const v = process.env[name];
  return v ? v.trim() : v;
}

export const BUCKET_NAME = env("SUPABASE_KYC_BUCKET") || "documents";

function getClient() {
  const supabaseUrl = env("NEXT_PUBLIC_SUPABASE_URL");
  // Prefer service role key (bypasses RLS); fall back to anon key.
  const supabaseKey = env("SUPABASE_SERVICE_ROLE_KEY") || env("NEXT_PUBLIC_SUPABASE_ANON_KEY");

  if (!supabaseUrl || !supabaseKey) {
    throw new Error(
      "Supabase is not configured. Set NEXT_PUBLIC_SUPABASE_URL and " +
      "SUPABASE_SERVICE_ROLE_KEY (or NEXT_PUBLIC_SUPABASE_ANON_KEY)."
    );
  }
  return createClient(supabaseUrl, supabaseKey);
}

/**
 * Create the KYC bucket (private). Returns { ok, error }.
 */
async function createBucket(supabase) {
  const { error } = await supabase.storage.createBucket(BUCKET_NAME, {
    public: false,
    fileSizeLimit: 10 * 1024 * 1024, // 10 MB
  });
  if (error && !/already exists/i.test(error.message)) {
    return { ok: false, error: error.message };
  }
  console.log(`[KYC Storage] Bucket "${BUCKET_NAME}" ready.`);
  return { ok: true };
}

/** True when the configured key is the service-role key (can manage storage). */
function usingServiceKey() {
  return !!env("SUPABASE_SERVICE_ROLE_KEY");
}

/**
 * Upload a KYC document to Supabase Storage.
 * Returns { success, publicUrl?, path?, error? }
 */
export async function uploadKYCDocument(userId, kycId, documentType, file) {
  try {
    if (!userId || !kycId || !documentType || !file) {
      return { success: false, error: "Missing required parameters" };
    }

    if (!usingServiceKey()) {
      // The anon (publishable) key cannot write to a private bucket.
      return {
        success: false,
        error: "SUPABASE_SERVICE_ROLE_KEY is not set in this environment (Vercel). Uploads require the service-role key.",
      };
    }

    const supabase = getClient();

    // Unique filename
    const timestamp    = Date.now();
    const randomId     = Math.random().toString(36).substring(2, 10);
    const originalName = (file.name || "document").replace(/[^a-zA-Z0-9._-]/g, "_").toLowerCase();
    const filename     = `${timestamp}-${randomId}-${originalName}`;
    const storagePath  = `kyc/${userId}/${kycId}/${documentType}/${filename}`;

    const buffer = file instanceof Blob
      ? Buffer.from(await file.arrayBuffer())
      : Buffer.from(file);

    const doUpload = () => supabase.storage
      .from(BUCKET_NAME)
      .upload(storagePath, buffer, {
        contentType: file.type || "application/octet-stream",
        upsert: true,
      });

    let { data, error } = await doUpload();

    // If the bucket doesn't exist yet, try to create it and retry once.
    if (error && /bucket.*not.*found|not found/i.test(error.message)) {
      const created = await createBucket(supabase);
      if (!created.ok) {
        return {
          success: false,
          error: `Storage bucket "${BUCKET_NAME}" does not exist and could not be auto-created (${created.error}). ` +
                 `Create it manually: Supabase Dashboard → Storage → New bucket → name "${BUCKET_NAME}" (private).`,
        };
      }
      ({ data, error } = await doUpload());
    }

    if (error) {
      console.error("[KYC Storage] Upload error:", error.message);
      return { success: false, error: error.message };
    }

    // For private buckets, create a signed URL (1 year expiry); for public use getPublicUrl.
    let publicUrl = null;
    try {
      const { data: signed, error: signErr } = await supabase.storage
        .from(BUCKET_NAME)
        .createSignedUrl(data.path, 60 * 60 * 24 * 365); // 1 year
      if (!signErr && signed?.signedUrl) {
        publicUrl = signed.signedUrl;
      } else {
        // Fallback: public URL (works if bucket is set to public)
        const { data: pub } = supabase.storage.from(BUCKET_NAME).getPublicUrl(data.path);
        publicUrl = pub.publicUrl;
      }
    } catch {
      const { data: pub } = supabase.storage.from(BUCKET_NAME).getPublicUrl(data.path);
      publicUrl = pub.publicUrl;
    }

    console.log(`[KYC Storage] Uploaded: ${storagePath}`);
    return { success: true, publicUrl, path: data.path };

  } catch (err) {
    console.error("[KYC Storage] Unexpected error:", err.message);
    return { success: false, error: err.message };
  }
}

/**
 * Delete a KYC document from Supabase Storage.
 */
export async function deleteKYCDocument(storagePath) {
  try {
    const supabase = getClient();
    const { error } = await supabase.storage.from(BUCKET_NAME).remove([storagePath]);
    if (error) return { success: false, error: error.message };
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

/**
 * Get a signed URL for a stored document (1-hour expiry).
 */
export async function getKYCDocumentUrl(storagePath) {
  try {
    const supabase = getClient();
    const { data, error } = await supabase.storage
      .from(BUCKET_NAME)
      .createSignedUrl(storagePath, 3600);
    if (error) throw error;
    return data.signedUrl;
  } catch {
    // Fall back to public URL
    const supabase = getClient();
    const { data } = supabase.storage.from(BUCKET_NAME).getPublicUrl(storagePath);
    return data.publicUrl;
  }
}
