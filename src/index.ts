import { TwitterApi, type TweetV2, type TweetUserTimelineV2Paginator, UserV2 } from "twitter-api-v2";
import {
  ActionRowData,
  APIMessageTopLevelComponent,
  JSONEncodable,
  MessageActionRowComponentBuilder,
  MessageActionRowComponentData,
  TopLevelComponentData,
  WebhookClient,
  type WebhookMessageCreateOptions,
} from "discord.js";

type WebhookComponentsField = (
  | APIMessageTopLevelComponent
  | JSONEncodable<APIMessageTopLevelComponent>
  | TopLevelComponentData
  | ActionRowData<MessageActionRowComponentData | MessageActionRowComponentBuilder>
)[];

export default {
  async fetch(request, env, _ctx) {
    try {
      let didTheThing = false;
      if (request.headers.get("Authorization") === `Bearer ${env.WORKER_SECRET}`) {
        await doTheThing(env);
        didTheThing = true;
      }
      return new Response("The thing is running." + (didTheThing ? " Did the thing." : ""), { status: 200 });
    } catch (error) {
      console.error("Error in fetch handler:", error);
      return new Response("Internal Server Error", { status: 500 });
    }
  },

  async scheduled(_controller, env, _ctx) {
    await doTheThing(env);
  },
} satisfies ExportedHandler<Env>;

async function doTheThing(env: Env) {
  try {
    console.log("Set env variables:", {
      TARGET_USER_ID: env.TARGET_USER_ID,
      DISCORD_WEBHOOK_ID: env.DISCORD_WEBHOOK_ID ? "set" : "not set",
      DISCORD_WEBHOOK_TOKEN: env.DISCORD_WEBHOOK_TOKEN ? "set" : "not set",
      BEARER_TOKEN: env.BEARER_TOKEN ? "set" : "not set",
    });
    const XClient = new TwitterApi(env.BEARER_TOKEN, {
      plugins: [
        {
          onRequestError: (error) => console.error("Twitter API request error", error),
          onResponseError: (error) => console.error("Twitter API response error", error),
        },
      ],
    });
    const client = XClient.readOnly;

    let lastFetched: string;
    try {
      const lastFetchedValue = await env.TWITTER_DISCORD_FORWARDER_KV.get("last_fetched", { type: "text" });
      lastFetched = lastFetchedValue || "2010-11-06T00:00:00.000Z";
    } catch (error) {
      console.info("Failed to get last_fetched from KV store:", error);
      lastFetched = "2010-11-06T00:00:00.000Z";
    }

    let userTimeline: TweetUserTimelineV2Paginator;
    try {
      userTimeline = await client.v2.userTimeline(env.TARGET_USER_ID, {
        start_time: lastFetched,
        "user.fields": ["username", "name", "profile_image_url", "url"],
        "media.fields": ["url", "preview_image_url"],
        "tweet.fields": ["created_at", "text", "id", "attachments", "entities"],
        "poll.fields": ["options", "end_datetime"],
        expansions: ["attachments.media_keys", "attachments.poll_ids", "author_id"],
        exclude: ["replies", "retweets"],
      });
      console.log("Fetched user timeline from Twitter", userTimeline.data);
    } catch (error) {
      console.error("Failed to fetch user timeline from Twitter", error);
      return;
    }

    const fetchedTweets = userTimeline.tweets;
    if (!fetchedTweets || fetchedTweets.length === 0) {
      console.log("No new tweets found");
      return;
    }

    let successfulPosts = 0;
    let failedPosts = 0;

    const finalTweets = fetchedTweets.sort(
      (a, b) => new Date(a.created_at || 0).getTime() - new Date(b.created_at || 0).getTime(),
    );
    const user = userTimeline.includes.users?.find((u) => u.username === env.TARGET_USERNAME);
    if (!user) {
      console.error("User data not found in Twitter response");
      return;
    }
    for (const tweet of finalTweets) {
      try {
        const discordPayload = buildDiscordPayload(userTimeline, tweet, user);
        await new WebhookClient({
          id: env.DISCORD_WEBHOOK_ID,
          token: env.DISCORD_WEBHOOK_TOKEN,
        }).send(discordPayload);
        successfulPosts++;
        console.log(`Successfully posted tweet ${tweet.id} to Discord`);
      } catch (error) {
        failedPosts++;
        console.error(`Error processing tweet ${tweet.id}:`, error);
        failedPosts++;
      }
    }

    console.log(
      `Processed ${fetchedTweets.length} tweets: ${successfulPosts} successful, ${failedPosts} failed`,
    );

    // Only update last_fetched if we processed tweets successfully
    if (successfulPosts > 0) {
      try {
        await env.TWITTER_DISCORD_FORWARDER_KV.put("last_fetched", new Date().toISOString(), {
          metadata: { updatedBy: "worker" },
        });
      } catch (error) {
        console.error("Failed to update last_fetched in KV store:", error);
      }
    }

    return;
  } catch (error) {
    console.error("Unexpected error in scheduled function:", error);
    return;
  }
}

function buildDiscordPayload(
  timeline: TweetUserTimelineV2Paginator,
  tweet: TweetV2,
  user: UserV2,
): WebhookMessageCreateOptions {
  try {
    const description = tweet.text;
    const timestamp = tweet.created_at
      ? new Date(tweet.created_at)
      : new Date("2010-11-06T00:00:00-00:00.000Z");
    const unixTimestamp = Math.floor(timestamp.getTime() / 1000);
    const medias = timeline.includes.medias(tweet);
    const poll = timeline.includes.poll(tweet);
    const tweetUrl = `https://x.com/${user.username}/status/${tweet.id}`;

    const comps: WebhookComponentsField = [
      {
        type: 17, // Container
        accent_color: 2007544, // similar to Twitter blue
        components: [
          {
            type: 10, // Text Display
            content: `### New Tweet from [@${user.username}](https://x.com/${user.username}) <t:${unixTimestamp}:R>`,
          },
          {
            type: 14, // Divider
          },
        ],
      },
    ];

    if (description) {
      comps.push({
        type: 10,
        content: description,
      });
    }
    if (medias && medias.length > 0) {
      // We assume, a tweet has 10 attachements max
      comps.push({
        type: 12, // Media Gallery
        items: medias // Media Gallery Items
          .filter((media) => Boolean(media.url || media.preview_image_url))
          .slice(0, 10)
          .map((media) => ({
            // Unfurled Media Item
            media: {
              url: media.url! || media.preview_image_url!,
            },
          })),
      });
    }
    if (poll) {
      comps.push({
        type: 10, // Text Display
        content: ["**Poll:**", ...poll.options.map((option, i) => `${i + 1}. ${option.label}`)].join("\n"),
      });
    }

    comps.push(
      {
        type: 14, // Divider
      },
      {
        type: 1, // Action Row
        components: [
          {
            type: 2, // Button
            style: 5,
            label: "View Tweet",
            url: tweetUrl,
          },
        ],
      },
    );

    return {
      flags: 1 << 15,
      withComponents: true,
      components: comps,
    };
  } catch (error) {
    console.error("Error building Discord payload:", error);
    return {
      content: `New tweet: https://twitter.com/status/${tweet.id}`,
      embeds: [],
    };
  }
}
