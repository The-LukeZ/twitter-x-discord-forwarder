import { type TweetV1, TwitterApi, type UserTimelineV1Paginator } from "twitter-api-v2";
import type { RESTPostAPIChannelMessageJSONBody } from "discord-api-types/v10";

export default {
  async fetch(req) {
    try {
      return new Response("The thing is running.");
    } catch (error) {
      console.error("Error in fetch handler:", error);
      return new Response("Internal Server Error", { status: 500 });
    }
  },

  async scheduled(controller, env, ctx) {
    try {
      const twitterClient = new TwitterApi(env.BEARER_TOKEN);
      const client = twitterClient.readOnly;

      let lastFetched: string;
      try {
        const lastFetchedValue = await env.TWITTER_DISCORD_FORWARDER_KV.get("last_fetched");
        lastFetched = lastFetchedValue || new Date(0).toISOString();
      } catch (error) {
        console.info("Failed to get last_fetched from KV store:", error);
        lastFetched = new Date(0).toISOString();
      }

      let userTimeline: UserTimelineV1Paginator;
      try {
        userTimeline = await client.v1.userTimelineByUsername(env.TARGET_USER, {
          since_id: lastFetched,
        });
      } catch (error) {
        console.error("Failed to fetch user timeline from Twitter:", error);
        return;
      }

      const fetchedTweets = userTimeline.tweets;
      if (!fetchedTweets || fetchedTweets.length === 0) {
        console.log("No new tweets found");
        return;
      }

      let successfulPosts = 0;
      let failedPosts = 0;

      for (const tweet of fetchedTweets.reverse()) {
        try {
          const discordPayload = buildDiscordPayload(tweet);
          const response = await fetch(env.DISCORD_WEBHOOK_URL, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
            },
            body: JSON.stringify(discordPayload),
          });

          if (!response.ok) {
            const errorText = await response.text();
            console.error(
              `Failed to send Discord message for tweet ${tweet.id_str}:`,
              response.status,
              errorText,
            );
            failedPosts++;
          } else {
            successfulPosts++;
            console.log(`Successfully posted tweet ${tweet.id_str} to Discord`);
          }
        } catch (error) {
          console.error(`Error processing tweet ${tweet.id_str}:`, error);
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
  },
} satisfies ExportedHandler<Env>;

function buildDiscordPayload(tweet: TweetV1) {
  try {
    // Validate required tweet data
    if (!tweet.user) {
      throw new Error("Tweet missing user data");
    }
    if (!tweet.id_str) {
      throw new Error("Tweet missing ID");
    }

    const description = tweet.full_text || tweet.text || "No content available";
    const timestamp = tweet.created_at ? new Date(tweet.created_at).toISOString() : new Date().toISOString();

    return {
      content: `New tweet from ${tweet.user.screen_name}: https://twitter.com/${tweet.user.screen_name}/status/${tweet.id_str}`,
      embeds: [
        {
          author: {
            name: tweet.user.name || tweet.user.screen_name || "Unknown User",
            url: `https://twitter.com/${tweet.user.screen_name}`,
            icon_url: tweet.user.profile_image_url_https || undefined,
          },
          description: description,
          timestamp: timestamp,
        },
      ],
    } as RESTPostAPIChannelMessageJSONBody;
  } catch (error) {
    console.error("Error building Discord payload:", error);
    // Return a fallback payload
    return {
      content: `New tweet: https://twitter.com/status/${tweet.id_str || "unknown"}`,
      embeds: [],
    } as RESTPostAPIChannelMessageJSONBody;
  }
}
