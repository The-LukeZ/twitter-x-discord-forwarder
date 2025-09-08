# TwitterXForwarder

Forwards Tweets (from X) to Discord Webhooks

## Setup

1. Clone the repository
2. Install dependencies with `pnpm install`.
   Note: You need to have `pnpm` installed. If you don't have it, you can install it via npm with `npm install -g pnpm`.
3. Create a `.env` file with `cp .env.example .env` and fill in the placeholders.

?? (Create a Cloudflare Worker and KV Namespace, and add the bindings in the `wrangler.jsonc` file. But You also have to add the variables in the `.env` file to the Secret. Use `npx wrangler secret put VARIABLE_NAME` to do so.)

4. Login with Wrangler using `npx wrangler login`.
5. Deploy the Worker with `pnpm run deploy`.

## License

MIT License. See [LICENSE](./LICENSE) file for details.
