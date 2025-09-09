import { APIContainerComponent, APIMessageTopLevelComponent } from "discord-api-types/v10";
import ky from "ky";

type WebhookComponentsField = APIMessageTopLevelComponent[];

type ContainerComponentsField = Exclude<APIMessageTopLevelComponent, APIContainerComponent>[];

type XUser = { id: string; username: string; name: string; profile_image_url?: string; url?: string };

type GetPostsResponse = {
  data: Array<{
    id: string;
    text: string;
    created_at?: string;
    author_id?: string;
    attachments?: { media_keys?: string[]; poll_ids?: string[] };
    entities?: { mentions?: Array<{ username: string }> };
  }>;
  includes?: {
    users?: Array<XUser>;
    media?: Array<{ media_key: string; url?: string; preview_image_url?: string }>;
    polls?: Array<{
      id: string;
      options: Array<{ label: string; votes: number; position: number }>;
      end_datetime?: string;
    }>;
  };
  meta: { result_count: number; newest_id?: string; oldest_id?: string; next_token?: string };
};

export default {
  async fetch(request, env, _ctx) {
    try {
      let didTheThing = false;
      if (env.WORKER_SECRET && request.headers.get("Authorization") === `Bearer ${env.WORKER_SECRET}`) {
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
    console.log("Set env variables", {
      TARGET_USER_ID: env.TARGET_USER_ID,
      DISCORD_WEBHOOK_ID: env.DISCORD_WEBHOOK_ID ? "set" : "not set",
      DISCORD_WEBHOOK_TOKEN: env.DISCORD_WEBHOOK_TOKEN ? "set" : "not set",
      BEARER_TOKEN: env.BEARER_TOKEN ? "set" : "not set",
    });

    let lastFetchedPostId: string | null = null;
    try {
      const lastFetchedValue = await env.TWITTER_DISCORD_FORWARDER_KV.get("last_fetched_post", {
        type: "text",
      });
      lastFetchedPostId = lastFetchedValue;
    } catch (error) {
      console.info("Failed to get last_fetched from KV store:", error);
    }

    const client = ky.create({
      headers: {
        Authorization: `Bearer ${env.BEARER_TOKEN}`,
      },
      retry: {
        delay: () => 4000,
        limit: 1,
        afterStatusCodes: [413, 500, 502],
      },
      timeout: 5_000,
      hooks: {
        beforeRequest: [
          (req, options) => {
            console.log("Full URL: " + req.url, options);
          },
        ],
        afterResponse: [
          (_req, _options, res) => {
            console.log("Response status:", res.status);
          },
        ],
      },
    });

    let userTimeline: GetPostsResponse;
    try {
      const searchParams = new URLSearchParams({
        "user.fields": "username,name,profile_image_url,url",
        "media.fields": "url,preview_image_url",
        "tweet.fields": "created_at,text,id,attachments,entities",
        "poll.fields": "options,end_datetime",
        expansions: "attachments.media_keys,attachments.poll_ids,author_id",
        exclude: "replies,retweets",
        max_results: "100",
      });
      if (lastFetchedPostId) {
        searchParams.set("since_id", lastFetchedPostId);
      } else {
        // Return the posts of the last month
        searchParams.set("start_time", new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString());
      }
      const response = await client.get<GetPostsResponse>(
        `https://api.x.com/2/users/${env.TARGET_USER_ID}/tweets`,
        {
          searchParams: searchParams,
        },
      );

      if (!response.ok) {
        throw new Error(`Twitter API request failed: ${response.status} ${response.statusText}`);
      }

      userTimeline = await response.json();
      console.log("Fetched user timeline from Twitter", userTimeline.data);
    } catch (error) {
      console.error("Failed to fetch user timeline from Twitter", error);
      return;
    }

    const fetchedTweets = userTimeline.data;
    if (!fetchedTweets || fetchedTweets.length === 0) {
      console.log("No new tweets found");
      return;
    }

    let successfulPosts = 0;
    let latestSuccessfulPost = "";
    let failedPosts = 0;

    const finalTweets = fetchedTweets.sort(
      (a, b) => new Date(a.created_at || 0).getTime() - new Date(b.created_at || 0).getTime(),
    );
    const user = userTimeline.includes?.users?.find((u) => u.username === env.TARGET_USERNAME);
    if (!user) {
      console.error("User data not found in Twitter response");
      return;
    }

    const whClient = ky.create({
      headers: {
        "Content-Type": "application/json",
      },
    });

    for (let i = 0; i < finalTweets.length; i++) {
      const tweet = finalTweets[i];

      try {
        const discordPayload = buildDiscordPayload(userTimeline, tweet, user);
        const response = await whClient.post(buildWebhookUrl(env), { json: discordPayload });

        // Check for Discord rate limit headers
        const remainingRequests = response.headers.get("X-RateLimit-Remaining");
        const resetTime = response.headers.get("X-RateLimit-Reset");
        const resetAfter = response.headers.get("X-RateLimit-Reset-After");

        successfulPosts++;
        latestSuccessfulPost = tweet.id;
        console.log(`Successfully posted tweet ${tweet.id} to Discord`);

        // If we're approaching rate limit, wait before next request
        if (remainingRequests && parseInt(remainingRequests) <= 1 && i < finalTweets.length - 1) {
          let waitTime = 2000; // Default 2 seconds

          if (resetAfter) {
            waitTime = parseInt(resetAfter) * 1000; // Convert to milliseconds
          } else if (resetTime) {
            const resetTimestamp = parseInt(resetTime) * 1000;
            waitTime = Math.max(resetTimestamp - Date.now(), 1000);
          }

          console.log(`Rate limit approaching, waiting ${waitTime}ms...`);
          await new Promise((resolve) => setTimeout(resolve, waitTime));
        }
      } catch (error) {
        failedPosts++;
        console.error(`Error processing tweet ${tweet.id}:`, error);
      }
    }

    console.log(
      `Processed ${fetchedTweets.length} tweets: ${successfulPosts} successful, ${failedPosts} failed`,
    );

    // Only update last_fetched if we processed tweets successfully
    if (successfulPosts > 0 && latestSuccessfulPost) {
      try {
        await env.TWITTER_DISCORD_FORWARDER_KV.put("last_fetched_post", latestSuccessfulPost, {
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

function buildWebhookUrl(env: Env) {
  if (!env.DISCORD_WEBHOOK_ID || !env.DISCORD_WEBHOOK_TOKEN) {
    throw new Error("Discord webhook ID or token is not set in environment variables");
  }
  return `https://discord.com/api/webhooks/${env.DISCORD_WEBHOOK_ID}/${env.DISCORD_WEBHOOK_TOKEN}?with_components=true`;
}

function buildDiscordPayload(timeline: GetPostsResponse, tweet: GetPostsResponse["data"][0], user: XUser) {
  try {
    const description = tweet.text;
    const timestamp = tweet.created_at
      ? new Date(tweet.created_at)
      : new Date("2010-11-06T00:00:00-00:00.000Z");
    const unixTimestamp = Math.floor(timestamp.getTime() / 1000);
    const medias = timeline.includes?.media?.filter((media) =>
      tweet.attachments?.media_keys?.includes(media.media_key),
    );
    const poll = timeline.includes?.polls?.find((p) => tweet.attachments?.poll_ids?.includes(p.id));
    const tweetUrl = `https://x.com/${user.username}/status/${tweet.id}`;

    const containerComps: ContainerComponentsField = [
      {
        type: 10, // Text Display
        content: `### New Tweet from [@${user.username}](https://x.com/${user.username}) <t:${unixTimestamp}:R>`,
      },
      {
        type: 14, // Divider
      },
    ];

    if (description) {
      containerComps.push({
        type: 10,
        content: description,
      });
    }
    if (medias && medias.length > 0) {
      // We assume, a tweet has 10 attachements max
      containerComps.push({
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
      containerComps.push({
        type: 10, // Text Display
        content: ["**Poll:**", ...poll.options.map((option, i) => `${i + 1}. ${option.label}`)].join("\n"),
      });
    }

    const comps: WebhookComponentsField = [
      {
        type: 17, // Container
        accent_color: 2007544, // similar to Twitter blue
        components: containerComps,
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
    ];

    return {
      flags: 1 << 15,
      components: comps,
    };
  } catch (error) {
    console.error("Error building Discord payload:", error);
    return {
      content: `New tweet: https://twitter.com/status/${tweet.id}`,
    };
  }
}
