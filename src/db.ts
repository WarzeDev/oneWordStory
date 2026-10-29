import { Database } from "bun:sqlite";

/**
 * SQLite persistence layer.
 *
 * One row in `guilds` per guild we've ever configured.
 * One row in `contributions` per (guild, user) — records how many words
 * each user wrote so we can render the contributor bar without re-scanning
 * the words array on every render.
 *
 * The `words` and `order` arrays for the *current* story are stored as a
 * JSON blob on the guild row. This keeps the write path a single UPDATE
 * per word while still letting us atomically reset on /endstory.
 */

export interface StoredWord {
  text: string;
  userId: string;
  username: string;
  avatarUrl: string;
}

export interface GuildRow {
  guild_id: string;
  channel_id: string | null;
  message_id: string | null;
  min_users: number;
  title: string | null;
  title_author_id: string | null;
  title_author_name: string | null;
  title_author_avatar: string | null;
  /** JSON-encoded StoredWord[]. */
  words: string;
  /** JSON-encoded string[]. */
  order: string;
  ended: number;
}

export interface ContributionRow {
  guild_id: string;
  user_id: string;
  username: string;
  avatar_url: string;
  word_count: number;
}

const db = new Database("story.db", { create: true });
db.exec("PRAGMA journal_mode = WAL;");
db.exec("PRAGMA synchronous = NORMAL;");
db.exec("PRAGMA foreign_keys = ON;");

db.exec(`
  CREATE TABLE IF NOT EXISTS guilds (
    guild_id            TEXT PRIMARY KEY,
    channel_id          TEXT,
    message_id          TEXT,
    min_users           INTEGER NOT NULL DEFAULT 0,
    title               TEXT,
    title_author_id     TEXT,
    title_author_name   TEXT,
    title_author_avatar TEXT,
    words               TEXT NOT NULL DEFAULT '[]',
    "order"             TEXT NOT NULL DEFAULT '[]',
    ended               INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS contributions (
    guild_id   TEXT NOT NULL,
    user_id    TEXT NOT NULL,
    username   TEXT NOT NULL,
    avatar_url TEXT NOT NULL,
    word_count INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (guild_id, user_id)
  );
`);

/* ------------------------------------------------------------------ */
/* Guilds                                                              */
/* ------------------------------------------------------------------ */

const selectGuild = db.query<GuildRow, [string]>(
  `SELECT * FROM guilds WHERE guild_id = ?`,
);

const insertGuild = db.query(
  `INSERT OR IGNORE INTO guilds (guild_id) VALUES (?)`,
);

export function loadGuild(guildId: string): GuildRow {
  insertGuild.run(guildId);
  return selectGuild.get(guildId)!;
}

export function saveGuild(row: GuildRow): void {
  db.query(
    `UPDATE guilds SET
       channel_id = ?, message_id = ?, min_users = ?,
       title = ?, title_author_id = ?, title_author_name = ?, title_author_avatar = ?,
       words = ?, "order" = ?, ended = ?
     WHERE guild_id = ?`,
  ).run(
    row.channel_id,
    row.message_id,
    row.min_users,
    row.title,
    row.title_author_id,
    row.title_author_name,
    row.title_author_avatar,
    row.words,
    row.order,
    row.ended,
    row.guild_id,
  );
}

export function deleteGuild(guildId: string): void {
  db.query(`DELETE FROM guilds WHERE guild_id = ?`).run(guildId);
  db.query(`DELETE FROM contributions WHERE guild_id = ?`).run(guildId);
}

/* ------------------------------------------------------------------ */
/* Contributions                                                       */
/* ------------------------------------------------------------------ */

const selectContributions = db.query<ContributionRow, [string]>(
  `SELECT * FROM contributions WHERE guild_id = ? ORDER BY word_count DESC`,
);

export function loadContributions(guildId: string): ContributionRow[] {
  return selectContributions.all(guildId);
}

export function incrementContribution(
  guildId: string,
  userId: string,
  username: string,
  avatarUrl: string,
): void {
  db.query(
    `INSERT INTO contributions (guild_id, user_id, username, avatar_url, word_count)
     VALUES (?, ?, ?, ?, 1)
     ON CONFLICT(guild_id, user_id) DO UPDATE SET
       word_count = word_count + 1,
       username   = excluded.username,
       avatar_url = excluded.avatar_url`,
  ).run(guildId, userId, username, avatarUrl);
}

export function clearContributions(guildId: string): void {
  db.query(`DELETE FROM contributions WHERE guild_id = ?`).run(guildId);
}