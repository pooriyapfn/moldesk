# Docker image

Builds a minimal image running the `moldesk` CLI.

```bash
docker build -f docker/Dockerfile -t moldesk/moldesk:0.0.1 -t moldesk/moldesk:latest .
docker run --rm moldesk/moldesk:0.0.1 --version
docker run --rm moldesk/moldesk:0.0.1 doctor
```
