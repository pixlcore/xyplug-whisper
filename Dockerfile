ARG NODE_IMAGE=node:22-bookworm-slim
ARG WHISPER_MODEL=base
ARG WHISPER_CPP_ARCHIVE_URL=https://github.com/ggml-org/whisper.cpp/archive/refs/heads/master.zip

FROM ${NODE_IMAGE} AS build

ARG WHISPER_MODEL
ARG WHISPER_CPP_ARCHIVE_URL

WORKDIR /build

RUN apt-get update && \
	apt-get install -y --no-install-recommends \
		build-essential \
		ca-certificates \
		cmake \
		curl \
		pkg-config \
		unzip && \
	rm -rf /var/lib/apt/lists/*

RUN curl -L "${WHISPER_CPP_ARCHIVE_URL}" -o /tmp/whisper.cpp.zip && \
	unzip -q /tmp/whisper.cpp.zip -d /build && \
	mv /build/whisper.cpp-master /build/whisper.cpp && \
	rm -f /tmp/whisper.cpp.zip

WORKDIR /build/whisper.cpp

# Build a static whisper-cli so the runtime image only needs Node.js + the baked model file.
RUN if [ "$(dpkg --print-architecture)" = "arm64" ]; then \
		export EXTRA_CMAKE_FLAGS="-DGGML_NATIVE=OFF -DGGML_CPU_ARM_ARCH=armv8-a"; \
	else \
		export EXTRA_CMAKE_FLAGS=""; \
	fi && \
	cmake -B build \
		-DBUILD_SHARED_LIBS=OFF \
		-DWHISPER_BUILD_TESTS=OFF \
		-DWHISPER_BUILD_SERVER=OFF \
		${EXTRA_CMAKE_FLAGS} && \
	cmake --build build -j"$(nproc)" --config Release --target whisper-cli && \
	./models/download-ggml-model.sh "${WHISPER_MODEL}" ./models

FROM ${NODE_IMAGE} AS runtime

ARG WHISPER_MODEL

ENV WHISPER_MODEL=${WHISPER_MODEL}
ENV WHISPER_CLI_PATH=/opt/whisper/bin/whisper-cli
ENV WHISPER_MODEL_PATH=/opt/whisper/models/ggml-${WHISPER_MODEL}.bin

WORKDIR /app

RUN apt-get update && \
	apt-get install -y --no-install-recommends ca-certificates libgomp1 procps lsof iproute2 && \
	npm install -g @pixlcore/xyrun && \
	rm -rf /var/lib/apt/lists/*

COPY --from=build /build/whisper.cpp/build/bin/whisper-cli /opt/whisper/bin/whisper-cli
COPY --from=build /build/whisper.cpp/models/ggml-${WHISPER_MODEL}.bin /opt/whisper/models/ggml-${WHISPER_MODEL}.bin

COPY index.js package.json /app/

CMD ["xyrun", "node", "index.js"]
