import { createClient } from '@supabase/supabase-js';

// Lazy singleton — not created at module-import time so Vercel builds
// succeed even when env vars are injected only at runtime.
let _supabase = null;

function getSupabase() {
  if (_supabase) return _supabase;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) {
    throw new Error(
      'Missing Supabase env vars. Set NEXT_PUBLIC_SUPABASE_URL and ' +
      'NEXT_PUBLIC_SUPABASE_ANON_KEY in Vercel → Settings → Environment Variables.'
    );
  }
  _supabase = createClient(url, key);
  return _supabase;
}

// Proxy so existing `import { supabase }` call-sites keep working unchanged.
export const supabase = new Proxy({}, {
  get(_t, prop) { return getSupabase()[prop]; },
});
