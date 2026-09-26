This is a [Next.js](https://nextjs.org) project bootstrapped with [`create-next-app`](https://nextjs.org/docs/app/api-reference/cli/create-next-app).

## Getting Started

First, run the development server:

```bash
npm run dev
# or
yarn dev
# or
pnpm dev
# or
bun dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

You can start editing the page by modifying `app/page.tsx`. The page auto-updates as you edit the file.

This project uses [`next/font`](https://nextjs.org/docs/app/building-your-application/optimizing/fonts) to automatically optimize and load [Geist](https://vercel.com/font), a new font family for Vercel.

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome!

## Deploy on Vercel

The easiest way to deploy your Next.js app is to use the [Vercel Platform](https://vercel.com/new?utm_medium=default-template&filter=next.js&utm_source=create-next-app&utm_campaign=create-next-app-readme) from the creators of Next.js.

Check out our [Next.js deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying) for more details.

## PostHog analytics

The site initializes `posthog-js` in `src/instrumentation-client.ts` for pageviews and autocaptured interactions. Copying a CLI command emits `cli_command_copied` with a `source` of `homepage` or `documentation`; documentation copies also include the page path. Command text is not sent.

Set these build-time variables for the website deployment:

```shell
NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN=<PostHog project token>
NEXT_PUBLIC_POSTHOG_HOST=https://us.i.posthog.com
```

For local development, put them in the gitignored `apps/website/.env.local`. The live project is PostHog US Cloud project 629665. Analytics is disabled when either variable is missing. Redeploy after changing Vercel environment variables.
