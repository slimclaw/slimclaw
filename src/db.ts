import Database from "better-sqlite3";

/**
 * Initialize the SQLite database with WAL mode and create the sessions table.
 */
export function initDatabase(dbPath: string): Database.Database {
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");

  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      created_at INTEGER DEFAULT (unixepoch()),
      last_active INTEGER DEFAULT (unixepoch()),
      title TEXT
    );
  `);

  return db;
}
