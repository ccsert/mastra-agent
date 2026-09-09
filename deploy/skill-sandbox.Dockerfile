FROM node@sha256:ba849c60be29959425b8734d57b8b4b7d56f98edd9504c9af091d5281095a71e
# Preparation happens only here. Test runs use the resulting immutable image ID.
# Debian repository resolution is recorded, not yet a reproducible snapshot build.
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 bash \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /work /input /skill /output
ENV PYTHONDONTWRITEBYTECODE=1
USER 1000:1000
WORKDIR /work
