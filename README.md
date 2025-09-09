# TwitterXForwarder

Forwards Tweets (from X) to Discord Webhooks

## Setup

1. Clone the repository
2. Install dependencies with `pnpm install`.
   Note: You need to have `pnpm` installed. If you don't have it, you can install it via npm with `npm install -g pnpm`.
3. Create a `.env` file with `cp .env.example .env` and fill in the placeholders.

4. Add the following variables as a secret to your Cloudflare Worker:
   - `BEARER_TOKEN`: Your Twitter API Bearer Token
   - `DISCORD_WEBHOOK_ID`: Your Discord Webhook ID
   - `DISCORD_WEBHOOK_TOKEN`: Your Discord Webhook Token
   - `WORKER_SECRET`: A random string to secure your endpoint (for manual triggering) If not set, manual triggering will be disabled.

5. Login with Wrangler using `npx wrangler login`.
6. Deploy the Worker with `pnpm run deploy`.

## License

MIT License. See [LICENSE](./LICENSE) file for details.
