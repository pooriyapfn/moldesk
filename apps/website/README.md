# MoleculeDesk website

This Next.js app serves [moleculedesk.com](https://moleculedesk.com/). MoleculeDesk is an open-source package manager and runtime for running molecular AI models locally. The public docs describe the CLI, supported models, and current limitations.

## Run locally

From the repository root:

```bash
pnpm install
pnpm --filter website dev
pnpm --filter website build
```

The site runs at [localhost:3000](http://localhost:3000) during development.

## PostHog analytics

The website uses `posthog-js` from `src/instrumentation-client.ts`. It captures pageviews for the homepage and docs, plus a `cli_command_copied` event when a visitor successfully copies a CLI command. The event has a `source` of `homepage` or `documentation`; documentation copies also include the page path. It does not send the copied command text.

Set these build-time variables in the website deployment and restart/redeploy it:

```shell
NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN=<PostHog project token>
NEXT_PUBLIC_POSTHOG_HOST=https://us.i.posthog.com
```

For local development, put the same values in `apps/website/.env.local` (gitignored). The token comes from PostHog project 629665's manual SDK setup. The host above is for that project's US Cloud region. Without either variable, analytics stays disabled. After deployment, open the site and check PostHog's live events for `$pageview` and `cli_command_copied`.

## Content and discovery

- Edit model and guide content in `content/docs/`; register each page in `src/lib/docs-nav.ts` so it receives a route and appears in the sitemap.
- Keep model status, platform support, commands, and output descriptions aligned with the implementation and root README. Link to upstream methods and source fixtures where useful.
- `src/app/robots.ts` allows crawlers and points to `src/app/sitemap.ts`; `public/llms.txt` is an optional navigation index. None guarantees AI citations.
- Each doc route has a title, description, and canonical URL. Keep visible content and structured data consistent.
- After deployment, check that `/robots.txt`, `/sitemap.xml`, and guide URLs return successfully. Verify any CDN bot rules separately; app files cannot override edge blocks.
