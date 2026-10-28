import {
  AttachmentBuilder,
  ChannelType,
  Client,
  Events,
  GatewayIntentBits,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
  type Message,
  type TextChannel,
} from "discord.js";

import { canContribute, colorFor, getState, type GuildState } from "./store";
import { renderBookImage, renderStoryImage, type RenderWord } from "./render";

const TOKEN = process.env.TOKEN;
if (!TOKEN) {
  console.error("✖ Missing TOKEN. Copy .env.example to .env and set your bot token.");
  process.exit(1);
}

const MAX_WORD_LENGTH = 50;
const NOTICE_TTL_MS = 6_000;

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
    .setDescription(
      "How many other users must add a word before the same user can go again",
    )
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
].map((command) => command.toJSON());

/* ------------------------------------------------------------------ */
/* Serialization: one render at a time per guild                       */
/* ------------------------------------------------------------------ */

const queues = new Map<string, Promise<unknown>>();

function enqueue(guildId: string, task: () => Promise<void>): void {
  const previous = queues.get(guildId) ?? Promise.resolve();
  const next = previous.then(task, task);
  queues.set(guildId, next.then(
    () => undefined,
    () => undefined,
  ));
}

/* ------------------------------------------------------------------ */
/* Rendering the bot's story message                                   */
/* ------------------------------------------------------------------ */

function toRenderWords(guildState: GuildState): RenderWord[] {
  return guildState.words.map((word) => ({
    text: word.text,
    color: colorFor(guildState, word.userId),
    avatarUrl: word.avatarUrl,
  }));
}

/**
 * Updates (or posts) the live story card in the configured channel.
 */
async function updateStoryMessage(guildState: GuildState): Promise<void> {
  if (!guildState.channelId) return;

  const channel = (await client.channels
    .fetch(guildState.channelId)
    .catch(() => null)) as TextChannel | null;

  if (!channel || !channel.isTextBased()) return;

  const buffer = await renderStoryImage(toRenderWords(guildState));
  const attachment = new AttachmentBuilder(buffer, { name: "story.png" });

  if (guildState.messageId) {
    try {
      const existing = await channel.messages.fetch(guildState.messageId);
      await existing.edit({ files: [attachment] });
      return;
    } catch {
      guildState.messageId = null; // message was deleted — repost below
    }
  }

  const posted = await channel.send({ files: [attachment] });
  guildState.messageId = posted.id;
}

/**
 * Renders the finished book as a *standalone* message so it is not
 * overwritten when the next story begins, then resets the story state
 * so users can start writing a new one right away.
 */
async function finishStory(guildState: GuildState): Promise<void> {
  if (!guildState.channelId) return;

  const channel = (await client.channels
    .fetch(guildState.channelId)
    .catch(() => null)) as TextChannel | null;

  if (!channel || !channel.isTextBased()) return;

  // 1. Delete the live story card — it's about to be replaced by the
  //    permanent book message, and the old card would otherwise linger
  //    as an orphaned preview of a story that no longer exists.
  if (guildState.messageId) {
    try {
      const existing = await channel.messages.fetch(guildState.messageId);
      await existing.delete();
    } catch {
      /* already gone — fine */
    }
    guildState.messageId = null;
  }

  // 2. Post the finished book as its own message.
  const book = renderBookImage(toRenderWords(guildState));
  await channel.send({
    files: [new AttachmentBuilder(book, { name: "story-book.png" })],
  });

  // 3. Reset everything except the channel + settings.
  guildState.words = [];
  guildState.order = [];
  guildState.ended = false;
  // colors stay cached — they're per-user, not per-story
}

/* ------------------------------------------------------------------ */
/* Small self-deleting notices                                         */
/* ------------------------------------------------------------------ */

async function notify(channel: TextChannel, text: string): Promise<void> {
  try {
    const notice = await channel.send(text);
    setTimeout(() => {
      notice.delete().catch(() => {});
    }, NOTICE_TTL_MS);
  } catch {
    /* the channel may be read-only — ignore */
  }
}

/* ------------------------------------------------------------------ */
/* Ready                                                               */
/* ------------------------------------------------------------------ */

client.once(Events.ClientReady, async (readyClient) => {
  console.log(`✔ Logged in as ${readyClient.user.tag}`);
  try {
    await readyClient.application.commands.set(commandData);
    console.log("✔ Slash commands registered");
  } catch (error) {
    console.error("✖ Failed to register slash commands:", error);
  }
});

/* ------------------------------------------------------------------ */
/* Interactions                                                        */
/* ------------------------------------------------------------------ */

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand() || !interaction.guildId) return;

  const guildState = getState(interaction.guildId);
  const isAdmin = interaction.memberPermissions?.has(
    PermissionFlagsBits.ManageGuild,
  );

  try {
    switch (interaction.commandName) {
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

        await interaction.reply({
          content:
            num === 0
              ? "✅ Minimum users set to **0** - users can now write back-to-back."
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
        guildState.channelId = channel.id;
        guildState.messageId = null; // post a fresh story card in the new channel

        await interaction.reply({
          content: `✅ Story channel set to <#${channel.id}>.`,
          flags: MessageFlags.Ephemeral,
        });
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

        if (guildState.words.length === 0) {
          await interaction.reply({
            content: "The story is empty.",
            flags: MessageFlags.Ephemeral,
          });
          return;
        }

        const contributed = guildState.words.some(
          (word) => word.userId === interaction.user.id,
        );
        if (!contributed) {
          await interaction.reply({
            content: "You haven't added a word to this story yet.",
            flags: MessageFlags.Ephemeral,
          });
          return;
        }

        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        guildState.ended = true;

        await new Promise<void>((resolve) => {
          enqueue(interaction.guildId!, async () => {
            await finishStory(guildState);
            resolve();
          });
        });

        await interaction.editReply(
          "You have ended the story.",
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
/* Word collection                                                     */
/* ------------------------------------------------------------------ */

client.on(Events.MessageCreate, async (message: Message) => {
  if (!message.inGuild() || message.author.bot) return;

  const guildState = getState(message.guild.id);
  if (!guildState.channelId) return;
  if (message.channelId !== guildState.channelId) return;
  // Note: no `ended` guard here — the story auto-restarts after /endstory.

  const channel = message.channel as TextChannel;
  const raw = message.content.trim();
  const parts = raw.split(/\s+/).filter(Boolean);

  // Attachments / empty messages: silently clear them out.
  if (parts.length === 0) {
    await message.delete().catch(() => {});
    return;
  }

  const isSingleWord = parts.length === 1 && raw.length <= MAX_WORD_LENGTH;
  const userId = message.author.id;

  // The story channel is a canvas, not a chat — always remove the message.
  await message.delete().catch(() => {});

  enqueue(message.guild.id, async () => {
    if (!isSingleWord) {
      await notify(
        channel,
        parts.length > 1
          ? "✍️ One word at a time, please!"
          : `✍️ Words can be at most ${MAX_WORD_LENGTH} characters.`,
      );
      return;
    }

    if (!canContribute(guildState, userId)) {
      await notify(
        channel,
        `⏳ Wait for **${guildState.minUsers}** other user${
          guildState.minUsers === 1 ? "" : "s"
        } to add a word before yours.`,
      );
      return;
    }

    guildState.words.push({
      text: parts[0],
      userId,
      username: message.author.username,
      avatarUrl: message.author.displayAvatarURL({ size: 64, extension: "png" }),
    });
    guildState.order.push(userId);

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