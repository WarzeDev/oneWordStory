import { pastelFor } from "./colors";
import {
  clearContributions,
  deleteGuild,
  incrementContribution,
  loadContributions,
  loadGuild,
  saveGuild,
  type GuildRow,
  type StoredWord,
} from "./db";

export type StoryWord = StoredWord;

export interface GuildState {
  guildId: string;
  channelId: string | null;
  messageId: string | null;
  minUsers: number;
  /** The title, one word per entry (each with its own author). Empty until the first title word. */
  titleWords: StoryWord[];
  words: StoryWord[];
  order: string[];
  ended: boolean;
  /** Per-user role color (brightened for dark backgrounds). In-memory only; refreshed from Discord. */
  colors: Map<string, string>;
  /** True once the title has been closed (word ending in ":" or a lone ":"). */
  titleSet: boolean;
}

const cache = new Map<string, GuildState>();

/** The title as plain text (words joined with spaces). */
export function titleText(state: GuildState): string {
  return state.titleWords.map((w) => w.text).join(" ");
}

function parseWords(json: string | null | undefined): StoryWord[] {
  try {
    const parsed = JSON.parse(json || "[]");
    return Array.isArray(parsed) ? (parsed as StoryWord[]) : [];
  } catch {
    return [];
  }
}

function fromRow(row: GuildRow): GuildState {
  const words = JSON.parse(row.words) as StoryWord[];
  const order = JSON.parse(row.order) as string[];

  let titleWords = parseWords(row.title_words);
  let titleSet = row.title_done === 1;

  // Legacy rows: the title was a single multi-word message by one author and
  // was only ever stored once finished. Split it into per-word entries so it
  // renders like a new-style title, and treat it as already closed.
  if (titleWords.length === 0 && row.title) {
    const authorId = row.title_author_id ?? "";
    const authorName = row.title_author_name ?? "";
    const authorAvatar = row.title_author_avatar ?? "";
    titleWords = row.title
      .split(/\s+/)
      .filter(Boolean)
      .map((text) => ({
        text,
        userId: authorId,
        username: authorName,
        avatarUrl: authorAvatar,
      }));
    titleSet = titleWords.length > 0;
  }

  return {
    guildId: row.guild_id,
    channelId: row.channel_id,
    messageId: row.message_id,
    minUsers: row.min_users,
    titleWords,
    words,
    order,
    ended: row.ended === 1,
    colors: new Map(),
    titleSet,
  };
}

function toRow(state: GuildState): GuildRow {
  return {
    guild_id: state.guildId,
    channel_id: state.channelId,
    message_id: state.messageId,
    min_users: state.minUsers,
    // Legacy columns are kept in sync (joined text + first author) so the
    // data stays readable by older versions of the bot.
    title: state.titleWords.length ? titleText(state) : null,
    title_author_id: state.titleWords[0]?.userId ?? null,
    title_author_name: state.titleWords[0]?.username ?? null,
    title_author_avatar: state.titleWords[0]?.avatarUrl ?? null,
    title_words: JSON.stringify(state.titleWords),
    title_done: state.titleSet ? 1 : 0,
    words: JSON.stringify(state.words),
    order: JSON.stringify(state.order),
    ended: state.ended ? 1 : 0,
  };
}

export function getState(guildId: string): GuildState {
  let state = cache.get(guildId);
  if (!state) {
    state = fromRow(loadGuild(guildId));
    cache.set(guildId, state);
  }
  return state;
}

export function persist(state: GuildState): void {
  saveGuild(toRow(state));
}

export function forget(guildId: string): void {
  cache.delete(guildId);
  deleteGuild(guildId);
}

/**
 * The user's role color if we have one, otherwise the seeded pastel
 * (used for users without a colored role, or who have left the server).
 */
export function colorFor(state: GuildState, userId: string): string {
  return state.colors.get(userId) ?? pastelFor(userId);
}

/** Sets (or clears, with null) the role color for a user. */
export function setColor(
  state: GuildState,
  userId: string,
  color: string | null,
): void {
  if (color) state.colors.set(userId, color);
  else state.colors.delete(userId);
}

/**
 * A user may contribute when at least `minUsers` *distinct other* users have
 * written a word since their own last word.
 *
 * Title words count as contributions for the fairness rule: every title
 * word's author is in `order`, just like story words.
 */
export function canContribute(state: GuildState, userId: string): boolean {
  if (state.order.length === 0) return true;

  const last = state.order.lastIndexOf(userId);
  const since = last === -1 ? state.order : state.order.slice(last + 1);
  const others = new Set(since.filter((id) => id !== userId)).size;

  return others >= state.minUsers;
}

/* ------------------------------------------------------------------ */
/* Mutations that persist + update contributions                       */
/* ------------------------------------------------------------------ */

export function recordWord(
  state: GuildState,
  word: StoryWord,
): void {
  state.words.push(word);
  state.order.push(word.userId);
  incrementContribution(
    state.guildId,
    word.userId,
    word.username,
    word.avatarUrl,
  );
  persist(state);
}

/**
 * Adds one word to the title. Title words count as contributions for the
 * fairness rule and the contributor bar, exactly like story words.
 */
export function recordTitleWord(state: GuildState, word: StoryWord): void {
  state.titleWords.push(word);
  state.order.push(word.userId);
  incrementContribution(
    state.guildId,
    word.userId,
    word.username,
    word.avatarUrl,
  );
  persist(state);
}

/** Closes the title; everything written afterwards is the story itself. */
export function endTitle(state: GuildState): void {
  state.titleSet = true;
  persist(state);
}

export function resetStory(state: GuildState): void {
  state.titleWords = [];
  state.titleSet = false;
  state.words = [];
  state.order = [];
  state.messageId = null;
  state.ended = false;
  clearContributions(state.guildId);
  persist(state);
}

export interface ContributorStat {
  userId: string;
  username: string;
  avatarUrl: string;
  wordCount: number;
}

export function getContributors(guildId: string): ContributorStat[] {
  return loadContributions(guildId).map((row) => ({
    userId: row.user_id,
    username: row.username,
    avatarUrl: row.avatar_url,
    wordCount: row.word_count,
  }));
}