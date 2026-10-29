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

export interface TitleInfo {
  text: string;
  authorId: string;
  authorName: string;
  authorAvatar: string;
}

export interface GuildState {
  guildId: string;
  channelId: string | null;
  messageId: string | null;
  minUsers: number;
  title: TitleInfo | null;
  words: StoryWord[];
  order: string[];
  ended: boolean;
  /** Per-user pastel color, assigned lazily (in-memory only — colors are stable). */
  colors: Map<string, string>;
  /** True once a user has set the title for the current story. */
  titleSet: boolean;
}

const cache = new Map<string, GuildState>();

function fromRow(row: GuildRow): GuildState {
  const words = JSON.parse(row.words) as StoryWord[];
  const order = JSON.parse(row.order) as string[];
  const title: TitleInfo | null =
    row.title && row.title_author_id && row.title_author_name && row.title_author_avatar
      ? {
          text: row.title,
          authorId: row.title_author_id,
          authorName: row.title_author_name,
          authorAvatar: row.title_author_avatar,
        }
      : null;

  return {
    guildId: row.guild_id,
    channelId: row.channel_id,
    messageId: row.message_id,
    minUsers: row.min_users,
    title,
    words,
    order,
    ended: row.ended === 1,
    colors: new Map(),
    titleSet: title !== null,
  };
}

function toRow(state: GuildState): GuildRow {
  return {
    guild_id: state.guildId,
    channel_id: state.channelId,
    message_id: state.messageId,
    min_users: state.minUsers,
    title: state.title?.text ?? null,
    title_author_id: state.title?.authorId ?? null,
    title_author_name: state.title?.authorName ?? null,
    title_author_avatar: state.title?.authorAvatar ?? null,
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

export function colorFor(state: GuildState, userId: string): string {
  let color = state.colors.get(userId);
  if (!color) {
    color = pastelFor(userId);
    state.colors.set(userId, color);
  }
  return color;
}

/**
 * A user may contribute when at least `minUsers` *distinct other* users have
 * written a word since their own last word.
 *
 * The title counts as a contribution for the purpose of the fairness rule:
 * once the title is set, the title author is in `order` as well.
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

export function setTitle(state: GuildState, title: TitleInfo): void {
  state.title = title;
  state.titleSet = true;
  // Title author counts as a contributor for the fairness rule and the bar.
  state.order.push(title.authorId);
  incrementContribution(
    state.guildId,
    title.authorId,
    title.authorName,
    title.authorAvatar,
  );
  persist(state);
}

export function resetStory(state: GuildState): void {
  state.title = null;
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