FROM postgres:16-alpine@sha256:16bc17c64a573ef34162af9298258d1aec548232985b33ed7b1eac33ba35c229 AS build
RUN apk add --no-cache build-base clang19 llvm19-dev curl
WORKDIR /build
RUN curl -fsSL https://github.com/pgvector/pgvector/archive/refs/tags/v0.8.6.tar.gz -o vector.tar.gz \
    && echo '10bf9938906e5d643bbc4a7eea104b6f57ba4898e5b76b20e60484ea1d5a7f8f  vector.tar.gz' | sha256sum -c - \
    && tar xzf vector.tar.gz --strip-components=1 \
    && make OPTFLAGS='' \
    && make install
FROM postgres:16-alpine@sha256:16bc17c64a573ef34162af9298258d1aec548232985b33ed7b1eac33ba35c229
COPY --from=build /usr/local/lib/postgresql/vector.so /usr/local/lib/postgresql/vector.so
COPY --from=build /usr/local/share/postgresql/extension/vector* /usr/local/share/postgresql/extension/
