// lib/db.js
// Shared server-only database utilities.  Do NOT import in client components.

import pg from 'pg';
import bcrypt from 'bcryptjs';

const { Pool } = pg;

// ── Lazy pool singleton ───────────────────────────────────────────────────────
let _pool = null;

function createPool(dbUrl) {
  const isSupabase   = dbUrl.includes('supabase.co') || dbUrl.includes('pooler.supabase');
  const isServerless = process.env.VERCEL === '1' || !!process.env.AWS_LAMBDA_FUNCTION_NAME;

  // On Vercel, dashboard refreshes fire 7 concurrent server actions (Promise.all).
  // max:1 serialises all 7 behind one connection; if the cold-start handshake is
  // slow, queries 6-7 exceed connectionTimeoutMillis. max:5 lets them connect in
  // parallel, matching Supabase's Supavisor transaction-mode model.
  const maxConns = isServerless ? 5 : (isSupabase ? 5 : 10);

  const p = new Pool({
    connectionString: dbUrl,
    ssl:                     isSupabase ? { rejectUnauthorized: false } : false,
    max:                     maxConns,
    min:                     0,
    idleTimeoutMillis:       30_000,   // keep connections alive longer between polls
    connectionTimeoutMillis: 30_000,   // generous budget for TLS handshake on cold start
    keepAlive:               isSupabase, // keepalive pings keep the Supavisor session open
    keepAliveInitialDelayMillis: 10_000,
    allowExitOnIdle:         false,    // don't destroy the pool between auto-refresh ticks
  });

  p.on('error', (err) => {
    console.error('[DB] Pool background error:', err.message);
    // Destroy the pool so the next query recreates it fresh
    _pool = null;
    try { p.end(); } catch {}
  });

  return p;
}

function getPool() {
  if (_pool) return _pool;

  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) {
    throw new Error(
      'DATABASE_URL is not set. ' +
      'Add it in Vercel → Settings → Environment Variables.'
    );
  }

  _pool = createPool(dbUrl);
  return _pool;
}

// Proxy so `import { pool } from '@/lib/db'` keeps working unchanged.
export const pool = new Proxy({}, {
  get(_t, prop) { return getPool()[prop]; },
});

// ── Core query helpers ────────────────────────────────────────────────────────

/**
 * Execute a parameterised SQL query with one automatic retry on connection error.
 * The retry resets the pool so the next attempt creates a fresh TCP connection —
 * handles the case where a cold-start SSL handshake silently fails.
 */
export async function query(sql, params = []) {
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      return await getPool().query(sql, params);
    } catch (err) {
      const msg = err.message || '';
      const isConnErr =
        msg.includes('timeout') ||
        msg.includes('ETIMEDOUT') ||
        msg.includes('ECONNREFUSED') ||
        msg.includes('Connection terminated') ||
        err.code === 'ECONNRESET';

      if (attempt === 1 && isConnErr) {
        // Reset pool and retry once — the next getPool() call recreates it
        console.warn(`[DB] Connection error on attempt 1, resetting pool and retrying…`);
        try { _pool?.end(); } catch {}
        _pool = null;
        await new Promise((r) => setTimeout(r, 300)); // brief pause before retry
        continue;
      }

      console.error('[DB] Query error:', {
        sql:    sql.substring(0, 200),
        params: params.length,
        error:  msg,
      });

      if (isConnErr) {
        throw new Error(
          'The database is temporarily unavailable. Please try again in a moment.'
        );
      }
      throw new Error(`Database operation failed: ${msg}`);
    }
  }
}

/** Returns all rows as an array. */
export async function getRows(sql, params = []) {
  const res = await query(sql, params);
  return res.rows;
}

/** Returns the first row or null. */
export async function getRow(sql, params = []) {
  const res = await query(sql, params);
  return res.rows[0] ?? null;
}

/**
 * Execute a callback inside a BEGIN / COMMIT / ROLLBACK transaction.
 */
export async function withTransaction(callback) {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[DB] Transaction rolled back:', err.message);
    throw err;
  } finally {
    client.release();
  }
}

/** Liveness probe — call from /api/health only. */
export async function healthCheck() {
  try {
    const row = await getRow('SELECT NOW() AS time, current_database() AS db');
    return { status: 'healthy', database: row?.db, time: row?.time };
  } catch (err) {
    return { status: 'unhealthy', error: err.message };
  }
}

// ── User registration ─────────────────────────────────────────────────────────

export async function register(userData) {
  return withTransaction(async (client) => {
    const role = (userData.role || 'investor').trim().toLowerCase();

    const existing = await client.query(
      'SELECT id FROM users WHERE email = $1',
      [userData.email]
    );
    if (existing.rowCount > 0) return { error: 'Email already registered' };

    const passwordHash = await bcrypt.hash(userData.password, 12);

    const userRes = await client.query(
      `INSERT INTO users (email, password_hash, role, name, status, created_at)
       VALUES ($1,$2,$3,$4,'pending',NOW())
       RETURNING id, email, role, name, status, created_at`,
      [userData.email, passwordHash, role, userData.name ?? null]
    );

    const newUser = userRes.rows[0];
    let extraData = null;

    if (role === 'issuer') {
      const issuerRes = await client.query(
        `INSERT INTO issuers (user_id, company_name, company_reg_number, status, approved, created_at)
         VALUES ($1,$2,$3,'pending',false,NOW())
         RETURNING id, company_name, company_reg_number`,
        [newUser.id, userData.companyName ?? null, userData.registrationNumber ?? null]
      );
      const row = issuerRes.rows[0];
      extraData = {
        issuerId: row.id,
        companyName: row.company_name,
        companyRegNumber: row.company_reg_number,
      };
    }

    return {
      id:        newUser.id,
      email:     newUser.email,
      role:      newUser.role,
      name:      newUser.name,
      status:    newUser.status,
      createdAt: newUser.created_at,
      ...extraData,
    };
  });
}

// ── Convenience helpers ───────────────────────────────────────────────────────

export async function getPendingOrders() {
  try {
    return await getRows(
      `SELECT id, investor_id, security_id, quantity, price, payment_method,
              status, created_at, type, total
         FROM orders
        WHERE status = 'pending' OR status IS NULL
        ORDER BY created_at DESC`
    );
  } catch (err) {
    console.error('[DB] getPendingOrders failed:', err.message);
    return [];
  }
}

/** Graceful shutdown — call during SIGTERM. */
export async function closePool() {
  if (_pool) {
    await _pool.end();
    _pool = null;
  }
  console.log('[DB] Pool closed');
}
