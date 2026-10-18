# Exact previously exercised development toolchain image, not a floating tag.
FROM sha256:84e4a248f3c4191d3a03437a5c6f3da91183c47c897de93abc42052b4a6a74fc
COPY types /opt/build-types
RUN mkdir -p /opt/oantuti/artifacts/typescript /opt/oantuti/artifacts/cpp \
 && /opt/node/bin/node /opt/typescript/bin/tsc --target ES2022 --module commonjs --moduleResolution node --types node --typeRoots /opt/build-types --skipLibCheck --strict --outDir /opt/oantuti/artifacts/typescript /opt/oantuti/sdk/typescript/oantuti.ts /opt/oantuti/sdk/typescript/starter_bot.ts \
 && g++-13 -std=c++20 -O2 -I/opt/oantuti/sdk/cpp /opt/oantuti/sdk/cpp/starter_bot.cpp -o /opt/oantuti/artifacts/cpp/starter_bot \
 && rm -rf /opt/build-types
LABEL org.oantuti.purpose="development-compiled-starters"
