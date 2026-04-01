import initSqlJs, { Database } from 'sql.js';
import fs from 'fs';
import path from 'path';

const DB_PATH = path.resolve(__dirname, '../scanner.db');

let _db: Database | null = null;

/** Load (or create) the database. Call once at startup. */
export async function openDb(): Promise<void> {
  const SQL = await initSqlJs();
  if (fs.existsSync(DB_PATH)) {
    const buf = fs.readFileSync(DB_PATH);
    _db = new SQL.Database(buf);
  } else {
    _db = new SQL.Database();
  }
  initSchema();
  persist(); // ensure file exists immediately
}

function getDb(): Database {
  if (!_db) throw new Error('Database not initialised — call openDb() first');
  return _db;
}

/** Flush in-memory state to disk. Call after any write. */
function persist(): void {
  const data = getDb().export();
  fs.writeFileSync(DB_PATH, Buffer.from(data));
}

function initSchema(): void {
  getDb().run(`
    CREATE TABLE IF NOT EXISTS scans (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      started_at     TEXT NOT NULL DEFAULT (datetime('now')),
      completed_at   TEXT,
      status         TEXT NOT NULL DEFAULT 'running',
      total_posts    INTEGER NOT NULL DEFAULT 0,
      total_links    INTEGER NOT NULL DEFAULT 0,
      flagged_count  INTEGER NOT NULL DEFAULT 0,
      error          TEXT
    );

    CREATE TABLE IF NOT EXISTS flagged_links (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      scan_id      INTEGER NOT NULL REFERENCES scans(id),
      post_url     TEXT NOT NULL,
      post_title   TEXT,
      link         TEXT NOT NULL,
      link_text    TEXT,
      link_status  TEXT NOT NULL,
      http_status  INTEGER,
      reason       TEXT,
      resolution   TEXT,
      checked_at   TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_flagged_scan   ON flagged_links(scan_id);
    CREATE INDEX IF NOT EXISTS idx_flagged_status ON flagged_links(link_status);
  `);

  const db = getDb();

  // Migrate: add resolution column if it doesn't exist
  const cols = db.exec(`PRAGMA table_info(flagged_links)`);
  const hasResolution = cols[0]?.values.some((row) => row[1] === 'resolution');
  if (!hasResolution) {
    db.run(`ALTER TABLE flagged_links ADD COLUMN resolution TEXT`);
  }

  // Migrate: add link_text column if it doesn't exist
  const hasLinkText = cols[0]?.values.some((row) => row[1] === 'link_text');
  if (!hasLinkText) {
    db.run(`ALTER TABLE flagged_links ADD COLUMN link_text TEXT`);
  }

  // Migrate: enforce UNIQUE(post_url, link, link_status) if not already present.
  // We just delete duplicate rows (keeping the earliest) then add the unique index
  // directly — no table rebuild needed, so no risk of missing future columns.
  const idxCheck = db.exec(
    `SELECT name FROM sqlite_master
     WHERE type='index' AND name='idx_flagged_unique_combo'`
  );
  const hasUniqueIndex = (idxCheck[0]?.values?.length ?? 0) > 0;
  if (!hasUniqueIndex) {
    db.run(`
      DELETE FROM flagged_links WHERE id NOT IN (
        SELECT MIN(id) FROM flagged_links GROUP BY post_url, link, link_status
      );
      CREATE UNIQUE INDEX idx_flagged_unique_combo
        ON flagged_links(post_url, link, link_status);
    `);
  }

  persist();
}

// ── Types ─────────────────────────────────────────────────────────────────────

export interface Scan {
  id: number;
  started_at: string;
  completed_at: string | null;
  status: 'running' | 'completed' | 'failed';
  total_posts: number;
  total_links: number;
  flagged_count: number;
  error: string | null;
}

export interface FlaggedLink {
  id: number;
  scan_id: number;
  post_url: string;
  post_title: string | null;
  link: string;
  link_text: string | null;
  link_status: 'broken' | 'takeover_risk' | 'unclear';
  http_status: number | null;
  reason: string | null;
  resolution: 'resolved' | 'invalid' | null;
  checked_at: string;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function rowToObj(stmt: ReturnType<Database['prepare']>): Record<string, unknown> {
  const cols = stmt.getColumnNames();
  const row  = stmt.get() as unknown[];
  const obj: Record<string, unknown> = {};
  cols.forEach((c, i) => { obj[c] = row[i]; });
  return obj;
}

function allRows(stmt: ReturnType<Database['prepare']>): Record<string, unknown>[] {
  const rows: Record<string, unknown>[] = [];
  const cols = stmt.getColumnNames();
  while (stmt.step()) {
    const row = stmt.get() as unknown[];
    const obj: Record<string, unknown> = {};
    cols.forEach((c, i) => { obj[c] = row[i]; });
    rows.push(obj);
  }
  stmt.free();
  return rows;
}

// ── Queries ───────────────────────────────────────────────────────────────────

export const dbQueries = {
  createScan(): number {
    const db = getDb();
    db.run(`INSERT INTO scans(started_at) VALUES (datetime('now'))`);
    const stmt = db.prepare(`SELECT last_insert_rowid() AS id`);
    stmt.step();
    const id = (stmt.get() as [number])[0];
    stmt.free();
    persist();
    return id;
  },

  updateScan(id: number, patch: Partial<Omit<Scan, 'id'>>): void {
    const keys = Object.keys(patch);
    if (keys.length === 0) return;
    const sets = keys.map((k) => `${k} = :${k}`).join(', ');
    const params: Record<string, import('sql.js').SqlValue> = { ':id': id };
    keys.forEach((k) => {
      params[`:${k}`] = (patch as Record<string, import('sql.js').SqlValue>)[k];
    });
    getDb().run(`UPDATE scans SET ${sets} WHERE id = :id`, params);
    persist();
  },

  getScan(id: number): Scan | undefined {
    const stmt = getDb().prepare('SELECT * FROM scans WHERE id = :id');
    stmt.bind({ ':id': id });
    if (!stmt.step()) { stmt.free(); return undefined; }
    const obj = rowToObj(stmt);
    stmt.free();
    return obj as unknown as Scan;
  },

  listScans(limit = 20): Scan[] {
    const stmt = getDb().prepare('SELECT * FROM scans ORDER BY id DESC LIMIT :lim');
    stmt.bind({ ':lim': limit });
    return allRows(stmt) as unknown as Scan[];
  },

  insertFlaggedLink(data: Omit<FlaggedLink, 'id' | 'checked_at' | 'resolution'>): void {
    getDb().run(
      `INSERT OR IGNORE INTO flagged_links
         (scan_id, post_url, post_title, link, link_text, link_status, http_status, reason)
       VALUES
         (:scan_id, :post_url, :post_title, :link, :link_text, :link_status, :http_status, :reason)`,
      {
        ':scan_id':     data.scan_id,
        ':post_url':    data.post_url,
        ':post_title':  data.post_title ?? null,
        ':link':        data.link,
        ':link_text':   data.link_text ?? null,
        ':link_status': data.link_status,
        ':http_status': data.http_status ?? null,
        ':reason':      data.reason ?? null,
      }
    );
    persist();
  },

  getFlaggedLinks(scanId: number): FlaggedLink[] {
    const stmt = getDb().prepare(
      'SELECT * FROM flagged_links WHERE scan_id = :id ORDER BY id'
    );
    stmt.bind({ ':id': scanId });
    return allRows(stmt) as unknown as FlaggedLink[];
  },

  getAllFlaggedLinks(): FlaggedLink[] {
    const stmt = getDb().prepare(
      'SELECT * FROM flagged_links ORDER BY id DESC'
    );
    return allRows(stmt) as unknown as FlaggedLink[];
  },

  getFlaggedLink(id: number): FlaggedLink | undefined {
    const stmt = getDb().prepare('SELECT * FROM flagged_links WHERE id = :id');
    stmt.bind({ ':id': id });
    if (!stmt.step()) { stmt.free(); return undefined; }
    const obj = rowToObj(stmt);
    stmt.free();
    return obj as unknown as FlaggedLink;
  },

  setResolution(id: number, resolution: 'resolved' | 'invalid' | null): void {
    getDb().run(
      `UPDATE flagged_links SET resolution = :resolution WHERE id = :id`,
      { ':resolution': resolution, ':id': id }
    );
    persist();
  },
};
