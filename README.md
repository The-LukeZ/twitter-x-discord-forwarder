# TwitterXForwarder

Forwards Tweets (from X) to Discord Webhooks

## Setup

### Prerequisites

- Have nodejs and pnpm installed (v20+ recommended)
- Have a Cloudflare account
- Have a Twitter Developer account with access to the Twitter API v2 and a Bearer Token
- Have a webhook in the channel you want to forward tweets to

## Steps

1. Clone the repository
2. Install dependencies with `pnpm install`.
   Note: You need to have `pnpm` installed. If you don't have it, you can install it via npm with `npm install -g pnpm`.
3. Create a `.env` file with `cp .env.example .env` and fill in the placeholders.

4. Add the following variables as a secret to your Cloudflare Worker:
   - `BEARER_TOKEN`: Your Twitter API Bearer Token
   - `DISCORD_WEBHOOK_ID`: Your Discord Webhook ID
   - `DISCORD_WEBHOOK_TOKEN`: Your Discord Webhook Token
   - `DISCORD_WEBHOOK_THREAD_ID`: (Optional) Your Discord Webhook Thread ID if you want to post in a specific thread/post.
   - `WORKER_SECRET`: A random string to secure your endpoint (for manual triggering) If not set, manual triggering will be disabled.

5. Create a KV namespace in Cloudflare and bind it to the Worker in `wrangler.jsonc` as `TWITTER_DISCORD_FORWARDER_KV`.

6. Fill in the other placeholders in `wrangler.jsonc`.

7. Login with Wrangler using `pnpx wrangler login`.

8. Run `pnpm cf-typegen` to generate the types for the environment variables. (Important for TypeScript to recognize the env variables)

9. Deploy the Worker with `pnpm run deploy`.

## License

MIT License. See [LICENSE](./LICENSE) file for details.
