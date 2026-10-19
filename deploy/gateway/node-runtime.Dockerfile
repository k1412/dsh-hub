# syntax=docker/dockerfile:1.7
# Supply the reviewed previous node image by immutable digest when building.
ARG BASE_IMAGE
FROM ${BASE_IMAGE}
ARG DSH_VERSION=0.2.1-rc.2
RUN npm install --global --ignore-scripts --no-audit --no-fund "@deepseek-ai/dsh@${DSH_VERSION}" \
    && test "$(dsh --version)" = "${DSH_VERSION}"
