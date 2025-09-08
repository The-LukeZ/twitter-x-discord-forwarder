import { TwitterApi, type TweetV2, type TweetUserTimelineV2Paginator, UserV2 } from "twitter-api-v2";
import { WebhookClient, type WebhookMessageCreateOptions } from "discord.js";
import { TwitterSnowflake } from "@sapphire/snowflake";

export default {
  async fetch(_req, env, _ctx) {
    try {
      await doTheThing(env);
      return new Response("The thing is running.");
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
      compression: "brotli",
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
      const lastFetchedValue = await env.TWITTER_DISCORD_FORWARDER_KV.get("last_fetched");
      lastFetched = lastFetchedValue || TwitterSnowflake.generate({ timestamp: new Date(0) }).toString();
    } catch (error) {
      console.info("Failed to get last_fetched from KV store:", error);
      lastFetched = TwitterSnowflake.generate({ timestamp: new Date(0) }).toString();
    }

    let userTimeline: TweetUserTimelineV2Paginator;
    try {
      userTimeline = await client.v2.userTimeline(env.TARGET_USER_ID, {
        since_id: lastFetched,
        "user.fields": ["username", "name", "profile_image_url", "url"],
        "media.fields": ["url", "preview_image_url"],
        "tweet.fields": ["created_at", "text", "id", "attachments", "entities"],
        "poll.fields": ["options", "end_datetime"],
        expansions: ["attachments.media_keys", "attachments.poll_ids", "author_id"],
        exclude: ["replies", "retweets"],
      });
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
        const discordPayload = buildDiscordPayload(tweet, user);
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
        await env.TWITTER_DISCORD_FORWARDER_KV.put("last_fetched", new Date().toISOString());
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

function buildDiscordPayload(tweet: TweetV2, user: UserV2): WebhookMessageCreateOptions {
  try {
    const description = tweet.text || "No content available";
    const timestamp = tweet.created_at ? new Date(tweet.created_at).toISOString() : new Date().toISOString();

    return {
      content: `New tweet from ${user.username}: https://twitter.com/${user.username}/status/${tweet.id}`,
      embeds: [
        {
          author: {
            name: user.name || "Unknown User",
            url: `https://twitter.com/${user.username}`,
            icon_url: user.profile_image_url,
          },
          description: description,
          timestamp: timestamp,
        },
      ],
    };
  } catch (error) {
    console.error("Error building Discord payload:", error);
    return {
      content: `New tweet: https://twitter.com/status/${tweet.id}`,
      embeds: [],
    };
  }
}
