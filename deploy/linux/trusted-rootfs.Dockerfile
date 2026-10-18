FROM ubuntu@sha256:f610ab94648195aa356059f5b41d6085c9d4d903c072430cdd1af7bdb646106b
RUN apt-get update && apt-get install -y --no-install-recommends python3.12=3.12.3-1ubuntu0.17 g++-13=13.3.0-6ubuntu2~24.04.1 xz-utils ca-certificates && rm -rf /var/lib/apt/lists/*
COPY node.tar.xz /opt/node.tar.xz
RUN mkdir -p /opt/node && tar -xJf /opt/node.tar.xz -C /opt/node --strip-components=1 && rm /opt/node.tar.xz
COPY typescript /opt/typescript
COPY sdk /opt/oantuti/sdk
RUN /opt/node/bin/node --version && /opt/node/bin/node /opt/typescript/bin/tsc --version && python3.12 --version && g++-13 --version
ENV PATH="/opt/node/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
LABEL org.oantuti.purpose="development-trusted-fixtures-only"
