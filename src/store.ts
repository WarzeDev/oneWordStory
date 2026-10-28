import { pastelFor } from "./colors";

export interface StoryWord {
  text: string;
  userId: string;
  username: string;
  avatarUrl: string;
}

export interface GuildState {
  /** Channel the story is being written in. */
  channelId: string | null;
  /** How many *other* users must contribute before a user may go again. */
  minUsers: number;
  /** Words of the story, in order. */
  words: StoryWord[];
  /** User IDs in the order they contributed (repeats allowed). */
  order: string[];
  /** Per-user pastel color, assigned lazily. */
  colors: Map<string, string>;
  /** ID of the bot message that displays the rendered story. */
  messageId: string | null;
  /** True once /endstory has been used. */
  ended: boolean;
}

const states = new Map<string, GuildState>();

export function getState(guildId: string): GuildState {
  let state = states.get(guildId);
  if (!state) {
    state = {
      channelId: null,
      minUsers: 0,
      words: [],
      order: [],
      colors: new Map(),
      messageId: null,
      ended: false,
    };
    states.set(guildId, state);
  }
  return state;
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
 * - The very first word of a story is always allowed.
 * - If `minUsers` is 0, the same user can write back-to-back.
 */
export function canContribute(state: GuildState, userId: string): boolean {
  if (state.order.length === 0) return true;

  const last = state.order.lastIndexOf(userId);
  const since = last === -1 ? state.order : state.order.slice(last + 1);
  const others = new Set(since.filter((id) => id !== userId)).size;

  return others >= state.minUsers;
}