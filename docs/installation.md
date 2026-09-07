# Installation

## npm (recommended)

```bash
npm install -g moldesk
moldesk --version
moldesk doctor
```

## Docker

```bash
docker run --rm moldesk/moldesk:latest doctor
```

## From source

```bash
git clone https://github.com/pooriyapfn/moldesk.git
cd moldesk
pnpm install
pnpm --filter @moldesk/cli dev -- doctor
```
