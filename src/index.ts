import {
  AttachmentBuilder,
  ChannelType,
  Client,
  Events,
  GatewayIntentBits,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
  type GuildMember,
  type Message,
  type TextChannel,
} from "discord.js";

import { brightenRoleColor } from "./colors";
import {
  canContribute,
  colorFor,
  forget,
  getContributors,
  endTitle,
  getState,
  persist,
  recordTitleWord,
  recordWord,
  resetStory,
  setColor,
  titleText,
  type GuildState,
  type StoryWord,
} from "./store";
import {
  renderBookImage,
  renderStoryImage,
  type RenderContributor,
  type RenderTitle,
  type RenderWord,
} from "./render";

const TOKEN = process.env.TOKEN;
if (!TOKEN) {
  console.error("Missing TOKEN. Copy .env.example to .env and set your bot token.");
  process.exit(1);
}

const MAX_WORD_LENGTH = 50;
const MAX_TITLE_LENGTH = 80; // total characters across all title words
const NOTICE_TTL_MS = 6_000;
const WORD_COOLDOWN_MS = 3_000; // 3 seconds cooldown

// Track the last word timestamp per guild in memory (or store it in GuildState if supported)
const lastWordTimestamps = new Map<string, number>();

// How long a user's role color is trusted before it is re-fetched from Discord.
const COLOR_TTL_MS = 10 * 60_000;
const colorCheckedAt = new Map<string, number>();

/* ------------------------------------------------------------------ */
/* Client                                                              */
/* ------------------------------------------------------------------ */

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

/* ------------------------------------------------------------------ */
/* Slash commands                                                      */
/* ------------------------------------------------------------------ */

const commandData = [
  new SlashCommandBuilder()
    .setName("setminusers")
    .setDescription("How many other users must add a word before the same user can go again")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addIntegerOption((opt) =>
      opt
        .setName("num")
        .setDescription("Number of other users (0 = no restriction)")
        .setRequired(true)
        .setMinValue(0)
        .setMaxValue(50),
    ),

  new SlashCommandBuilder()
    .setName("setchannel")
    .setDescription("Choose the channel where the story is written")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addChannelOption((opt) =>
      opt
        .setName("channel")
        .setDescription("The story channel")
        .setRequired(true)
        .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement),
    ),

  new SlashCommandBuilder()
    .setName("endstory")
    .setDescription("Finish the story and render it as a book (contributors only)"),

  new SlashCommandBuilder()
    .setName("help")
    .setDescription("How to use Story Bot"),
].map((command) => command.toJSON());

/* ------------------------------------------------------------------ */
/* Serialization: one render at a time per guild                       */
/* ------------------------------------------------------------------ */

const queues = new Map<string, Promise<unknown>>();

function enqueue(guildId: string, task: () => Promise<void>): void {
  const previous = queues.get(guildId) ?? Promise.resolve();
  const next = previous.then(task, task);
  queues.set(guildId, next.then(() => undefined, () => undefined));
}

/* ------------------------------------------------------------------ */
/* Rendering helpers                                                   */
/* ------------------------------------------------------------------ */

/** Brightened color of the member's highest role that has a color, or null. */
function roleColorOf(member: GuildMember): string | null {
  const color = member.roles.color?.color; // highest colored role; 0/undefined = none
  return color ? brightenRoleColor(color) : null;
}

function applyMemberColor(guildState: GuildState, member: GuildMember): void {
  setColor(guildState, member.id, roleColorOf(member));
  colorCheckedAt.set(`${guildState.guildId}:${member.id}`, Date.now());
}

/** Makes sure role colors are fresh for the given users before rendering. */
async function refreshColors(
  guildState: GuildState,
  userIds: string[],
): Promise<void> {
  const guild = client.guilds.cache.get(guildState.guildId);
  if (!guild) return;

  const now = Date.now();
  await Promise.all(
    [...new Set(userIds)].map(async (id) => {
      const key = `${guildState.guildId}:${id}`;
      if (now - (colorCheckedAt.get(key) ?? 0) < COLOR_TTL_MS) return;
      colorCheckedAt.set(key, now);
      const member = await guild.members
        .fetch({ user: id, force: true })
        .catch(() => null);
      // Members who left keep whatever color they had (or the pastel fallback).
      if (member) setColor(guildState, id, roleColorOf(member));
    }),
  );
}

function storyUserIds(guildState: GuildState): string[] {
  return [
    ...guildState.titleWords.map((w) => w.userId),
    ...guildState.words.map((w) => w.userId),
  ];
}

function toRenderWordList(
  guildState: GuildState,
  list: StoryWord[],
): RenderWord[] {
  return list.map((word) => ({
    text: word.text,
    color: colorFor(guildState, word.userId),
    avatarUrl: word.avatarUrl,
  }));
}

function toRenderWords(guildState: GuildState): RenderWord[] {
  return toRenderWordList(guildState, guildState.words);
}

function toRenderTitle(guildState: GuildState): RenderTitle | null {
  if (guildState.titleWords.length === 0) return null;
  return {
    text: titleText(guildState),
    words: toRenderWordList(guildState, guildState.titleWords),
  };
}

function toRenderContributors(guildState: GuildState): RenderContributor[] {
  return getContributors(guildState.guildId).map((c) => ({
    color: colorFor(guildState, c.userId),
    avatarUrl: c.avatarUrl,
    wordCount: c.wordCount,
  }));
}

async function resolveStoryChannel(
  guildState: GuildState,
): Promise<TextChannel | null> {
  if (!guildState.channelId) return null;
  const channel = (await client.channels
    .fetch(guildState.channelId)
    .catch(() => null)) as TextChannel | null;
  if (!channel || !channel.isTextBased()) return null;
  return channel;
}

async function updateStoryMessage(guildState: GuildState): Promise<void> {
  const channel = await resolveStoryChannel(guildState);
  if (!channel) return;

  await refreshColors(guildState, storyUserIds(guildState));

  const buffer = await renderStoryImage(
    toRenderTitle(guildState),
    toRenderWords(guildState),
  );
  const attachment = new AttachmentBuilder(buffer, { name: "story.png" });

  const content = guildState.titleSet
    ? "Add **one word** at a time!"
    : guildState.titleWords.length === 0
      ? "The next words will form the **title**, **one word** per message. End it with a word ending in `:` or send a lone `:`."
      : "Keep writing the **title**, **one word** at a time. End it with a word ending in `:` or send a lone `:`.";

  if (guildState.messageId) {
    try {
      const existing = await channel.messages.fetch(guildState.messageId);
      await existing.edit({ content, files: [attachment] });
      return;
    } catch {
      guildState.messageId = null;
      persist(guildState);
    }
  }

  const posted = await channel.send({ content, files: [attachment] });
  guildState.messageId = posted.id;
  persist(guildState);
}

async function announceTitlePrompt(channel: TextChannel): Promise<void> {
  await notify(
    channel,
    "**A new story begins!** The next words in this channel form the book's **title**, **one word per message**. End the title with a word ending in `:` (like `Dragons:`) or by sending a lone `:` - after that, the story itself begins.",
    15_000,
  );
}

async function finishStory(guildState: GuildState): Promise<void> {
  const channel = await resolveStoryChannel(guildState);
  if (!channel) return;

  await refreshColors(guildState, [
    ...storyUserIds(guildState),
    ...getContributors(guildState.guildId).map((c) => c.userId),
  ]);

  const title = toRenderTitle(guildState);
  const words = toRenderWords(guildState);
  const contributors = toRenderContributors(guildState);

  if (guildState.messageId) {
    try {
      const existing = await channel.messages.fetch(guildState.messageId);
      await existing.delete();
    } catch {
      /* already gone */
    }
    guildState.messageId = null;
    persist(guildState);
  }

  const book = await renderBookImage(title, words, contributors);
  const message = await channel.send({
    content: title
      ? `**${title.text}** - the next word starts the title of a new story!`
      : "**The End** - the next word starts the title of a new story!",
    files: [new AttachmentBuilder(book, { name: "story-book.png" })],
  });

  try {
    await message.pin("Story completed");
  } catch (error) {
    console.warn(
      `Could not pin story in guild ${guildState.guildId}:`,
      (error as Error).message,
    );
  }

  resetStory(guildState);
  lastWordTimestamps.delete(guildState.guildId); // Reset cooldown on story finish
  await announceTitlePrompt(channel);
}

async function notify(
  channel: TextChannel,
  text: string,
  ttl = NOTICE_TTL_MS,
): Promise<void> {
  try {
    const notice = await channel.send(text);
    setTimeout(() => {
      notice.delete().catch(() => {});
    }, ttl);
  } catch {
    /* ignore */
  }
}

client.once(Events.ClientReady, async (readyClient) => {
  console.log(`✔ Logged in as ${readyClient.user.tag}`);
  try {
    await readyClient.application.commands.set(commandData);
    console.log("✔ Slash commands registered");
  } catch (error) {
    console.error("✖ Failed to register slash commands:", error);
  }
});

client.on(Events.GuildDelete, (guild) => {
  forget(guild.id);
  lastWordTimestamps.delete(guild.id);
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand() || !interaction.guildId) return;

  const guildState = getState(interaction.guildId);
  const isAdmin = interaction.memberPermissions?.has(
    PermissionFlagsBits.ManageGuild,
  );

  try {
    switch (interaction.commandName) {
      case "help": {
        await interaction.reply({
          flags: MessageFlags.Ephemeral,
          content:
            "**📖 book.Warze.org**\n" +
            "A collaborative story written one word per message.\n\n" +
            "**Admin setup**\n" +
            "• `/setchannel <channel>` — choose the story channel\n" +
            "• `/setminusers <num>` — how many *other* users must write before a user can go again (`0` = no restriction)\n\n" +
            "**How to write**\n" +
            "• The story starts with the **title**, written **one word per message**.\n" +
            "• End the title with a word ending in `:` (like `Dragons:`) or by sending just `:`.\n" +
            "• After that, the story itself: **one word per message** with a **3-second cooldown** between words.\n" +
            "• Your messages are deleted and folded into the story image.\n\n" +
            "**Finish**\n" +
            "• `/endstory` — anyone who contributed can close the book. The finished book is pinned; the next message starts a new story.",
        });
        return;
      }

      case "setminusers": {
        if (!isAdmin) {
          await interaction.reply({
            content: "You need the **Manage Server** permission to use this.",
            flags: MessageFlags.Ephemeral,
          });
          return;
        }

        const num = interaction.options.getInteger("num", true);
        guildState.minUsers = num;
        persist(guildState);

        await interaction.reply({
          content:
            num === 0
              ? "✅ Minimum users set to **0** — users can now write back-to-back."
              : `✅ Each user must wait for **${num}** other user${
                  num === 1 ? "" : "s"
                } to write before adding another word.`,
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      case "setchannel": {
        if (!isAdmin) {
          await interaction.reply({
            content: "You need the **Manage Server** permission to use this.",
            flags: MessageFlags.Ephemeral,
          });
          return;
        }

        const channel = interaction.options.getChannel("channel", true);
        const target = (await client.channels
          .fetch(channel.id)
          .catch(() => null)) as TextChannel | null;

        if (!target || !target.isTextBased()) {
          await interaction.reply({
            content: "That channel isn't a text channel I can see.",
            flags: MessageFlags.Ephemeral,
          });
          return;
        }

        const me = interaction.guild?.members.me;
        const perms = me ? target.permissionsFor(me) : null;
        if (
          !perms?.has(PermissionFlagsBits.SendMessages) ||
          !perms?.has(PermissionFlagsBits.AttachFiles) ||
          !perms?.has(PermissionFlagsBits.ManageMessages)
        ) {
          await interaction.reply({
            content:
              "I need **Send Messages**, **Attach Files**, and **Manage Messages** in that channel.",
            flags: MessageFlags.Ephemeral,
          });
          return;
        }

        guildState.channelId = channel.id;
        guildState.messageId = null;
        persist(guildState);

        await interaction.reply({
          content: `✅ Story channel set to <#${channel.id}>.`,
          flags: MessageFlags.Ephemeral,
        });
        await announceTitlePrompt(target);
        return;
      }

      case "endstory": {
        if (guildState.ended) {
          await interaction.reply({
            content: "This story has already ended.",
            flags: MessageFlags.Ephemeral,
          });
          return;
        }

        if (guildState.words.length === 0 && guildState.titleWords.length === 0) {
          await interaction.reply({
            content: "The story is empty.",
            flags: MessageFlags.Ephemeral,
          });
          return;
        }

        if (!guildState.titleSet) {
          await interaction.reply({
            content:
              "The title isn't finished yet. End it with a word ending in `:` or send a lone `:`, then write the story.",
            flags: MessageFlags.Ephemeral,
          });
          return;
        }

        const contributed =
          guildState.titleWords.some((w) => w.userId === interaction.user.id) ||
          guildState.words.some((w) => w.userId === interaction.user.id);
        if (!contributed) {
          await interaction.reply({
            content: "You haven't added a word to this story yet.",
            flags: MessageFlags.Ephemeral,
          });
          return;
        }

        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        let alreadyEnded = false;
        await new Promise<void>((resolve) => {
          enqueue(interaction.guildId!, async () => {
            if (guildState.ended) {
              alreadyEnded = true;
              resolve();
              return;
            }
            guildState.ended = true;
            persist(guildState);
            await finishStory(guildState);
            resolve();
          });
        });

        if (alreadyEnded) {
          await interaction.editReply("This story has already ended.");
          return;
        }

        await interaction.editReply(
          "The story has been bound into a book and pinned. The next words will form the **title** of a new story.",
        );
        return;
      }
    }
  } catch (error) {
    console.error(`Error handling /${interaction.commandName}:`, error);
    if (!interaction.replied && !interaction.deferred) {
      await interaction
        .reply({
          content: "Something went wrong. Check the bot logs.",
          flags: MessageFlags.Ephemeral,
        })
        .catch(() => {});
    }
  }
});

/* ------------------------------------------------------------------ */
/* Word collection (title words, then story words)                     */
/* ------------------------------------------------------------------ */

client.on(Events.MessageCreate, async (message: Message) => {
  if (!message.inGuild() || message.author.bot) return;

  const guildState = getState(message.guild.id);
  if (!guildState.channelId) return;
  if (message.channelId !== guildState.channelId) return;
  if (guildState.ended) return;

  const channel = message.channel as TextChannel;
  const raw = message.content.trim();
  const parts = raw.split(/\s+/).filter(Boolean);
  const userId = message.author.id;

  // The message carries fresh member data, so use it for this user's color.
  if (message.member) applyMemberColor(guildState, message.member);

  if (parts.length === 0) {
    await message.delete().catch(() => {});
    return;
  }

  await message.delete().catch(() => {});

  enqueue(message.guild.id, async () => {
    if (guildState.ended) return;

    // ---- Cooldown check (title words and story words alike) ----
    const now = Date.now();
    const lastTime = lastWordTimestamps.get(message.guild.id) ?? 0;
    const elapsed = now - lastTime;

    if (elapsed < WORD_COOLDOWN_MS) {
      const remainingSecs = ((WORD_COOLDOWN_MS - elapsed) / 1000).toFixed(1);
      await notify(
        channel,
        `Please wait **${remainingSecs}s** before adding another word.`,
      );
      return;
    }

    // ---- One word only ----
    const isSingleWord = parts.length === 1 && raw.length <= MAX_WORD_LENGTH;
    if (!isSingleWord) {
      await notify(
        channel,
        parts.length > 1
          ? "One word at a time."
          : `Words can be at most ${MAX_WORD_LENGTH} characters.`,
      );
      return;
    }

    const token = parts[0]!;
    const inTitlePhase = !guildState.titleSet;

    // In the title phase, ":" closes the title: either a word ending in ":"
    // (the colon is dropped from the word) or a lone ":" message.
    const closesTitle = inTitlePhase && token.endsWith(":");
    const wordText = inTitlePhase ? token.replace(/:+$/, "") : token;
    const isBareColon = closesTitle && wordText.length === 0;

    if (isBareColon && guildState.titleWords.length === 0) {
      await notify(
        channel,
        "The title needs at least one word before you can close it with `:`.",
      );
      return;
    }

    if (inTitlePhase && !isBareColon) {
      const currentLength = titleText(guildState).length;
      const newLength =
        currentLength + (currentLength > 0 ? 1 : 0) + wordText.length;
      if (newLength > MAX_TITLE_LENGTH) {
        await notify(
          channel,
          `Titles can be at most ${MAX_TITLE_LENGTH} characters. Send a lone \`:\` to end the title here.`,
        );
        return;
      }
    }

    // ---- Fairness rule (applies to title words and the closing ":" too) ----
    if (!canContribute(guildState, userId)) {
      await notify(
        channel,
        `Wait for **${guildState.minUsers}** other user${
          guildState.minUsers === 1 ? "" : "s"
        } to add a word before yours.`,
      );
      return;
    }

    // Update last word timestamp successfully
    lastWordTimestamps.set(message.guild.id, Date.now());

    const avatarUrl = message.author.displayAvatarURL({
      size: 64,
      extension: "png",
    });

    // ---- Title phase ----
    if (inTitlePhase) {
      if (!isBareColon) {
        recordTitleWord(guildState, {
          text: wordText,
          userId,
          username: message.author.username,
          avatarUrl,
        });
      }
      if (closesTitle) endTitle(guildState);

      await updateStoryMessage(guildState);
      return;
    }

    // ---- Story phase ----
    const word: StoryWord = {
      text: token,
      userId,
      username: message.author.username,
      avatarUrl,
    };
    recordWord(guildState, word);

    await updateStoryMessage(guildState);
  });
});

/* ------------------------------------------------------------------ */
/* Go                                                                  */
/* ------------------------------------------------------------------ */

client.login(TOKEN).catch((error) => {
  console.error("✖ Login failed:", error);
  process.exit(1);
});