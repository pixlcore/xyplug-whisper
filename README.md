<p align="center"><img src="https://raw.githubusercontent.com/pixlcore/xyplug-whisper/refs/heads/main/logo.png" height="128" alt="Whisper"/></p>
<h1 align="center">Whisper Transcription Plugin</h1>

An [xyOps](https://xyops.io) Marketplace Event Plugin that transcribes audio files with [OpenAI Whisper](https://github.com/openai/whisper) via the local, offline [whisper.cpp](https://github.com/ggml-org/whisper.cpp) runtime.

This Plugin is designed for workflows and event runs where a single audio file is passed in as job input. It launches a Docker container, runs `whisper-cli`, streams progress back into xyOps, and returns both structured transcript data and optional transcript files.

## Highlights

- Uses `whisper.cpp`, not a hosted API
- Runs fully inside Docker on your xyOps worker
- Ships separate prebuilt images for `tiny`, `base`, `small`, `medium`, and `large-v3`
- Builds both `linux/amd64` and `linux/arm64` images with GitHub Actions
- Bakes one Whisper model directly into each image, so jobs do not download models at runtime
- Works with xyRun for remote file download/upload handling inside Docker
- Emits live progress updates back to xyOps

## Requirements

- `docker`

## Environment Variables

None.  This Plugin does not require any API key, token, or secret vault configuration.

## Data Collection

This Plugin does not collect analytics, telemetry, or usage metrics.

The actual job transcription runs locally inside your Docker container using the baked-in Whisper model. No audio is sent to OpenAI or any other hosted inference service by this Plugin.

## Supported Input

This Plugin processes the first input file only.

The underlying `whisper-cli` example in `whisper.cpp` documents support for:

- `.mp3`
- `.wav`
- `.ogg`
- `.flac`

## Output

The Plugin always returns structured job data, including:

- `transcript`: the plain text transcript
- `segments`: timestamped transcript segments
- `detectedLanguage`: the detected language from Whisper
- `outputs`: any attached file artifacts

Depending on the selected parameters, it can also attach:

- `.txt`
- `.srt`
- `.vtt`
- `.lrc`
- `.json`

## Model Variants

The available image variants are:

- `tiny`
- `base`
- `small`
- `medium`
- `large-v3`

As a rough rule:

- `tiny` is fastest and lightest
- `base` is a good general default
- `small` and `medium` trade more CPU and RAM for better accuracy
- `large-v3` is the heaviest but usually the most accurate

## Example Job Output

Example structured job output:

```json
{
  "model": "base",
  "requestedModel": "base",
  "requestedLanguage": "auto",
  "detectedLanguage": "en",
  "translate": false,
  "input": {
    "filename": "meeting.mp3",
    "size": 1234567
  },
  "transcript": "And so my fellow Americans ask not what your country can do for you...",
  "segments": [
    {
      "start": "00:00:00,000",
      "end": "00:00:03,210",
      "start_ms": 0,
      "end_ms": 3210,
      "text": " And so my fellow Americans..."
    }
  ],
  "outputs": [
    { "type": "txt", "filename": "meeting.txt" },
    { "type": "srt", "filename": "meeting.srt" }
  ]
}
```

## Local Testing

### 1. Download and build `whisper.cpp` locally

If you want to run the wrapper directly on your machine instead of inside Docker, first download and build `whisper.cpp` from upstream:

```sh
curl -L https://github.com/ggml-org/whisper.cpp/archive/refs/heads/master.zip -o /tmp/whisper.cpp.zip
unzip /tmp/whisper.cpp.zip -d /tmp
cd /tmp/whisper.cpp-master
cmake -B build -DBUILD_SHARED_LIBS=OFF -DWHISPER_BUILD_TESTS=OFF -DWHISPER_BUILD_SERVER=OFF
cmake --build build -j --config Release --target whisper-cli
./models/download-ggml-model.sh base ./models
```

### 2. Run the plugin wrapper directly

From the repo root, point the wrapper at the local CLI and model:

```sh
printf '%s\n' '{"xy":1,"cwd":"'"$PWD"'","params":{"model":"base","language":"auto","text":true,"srt":true},"input":{"files":[{"filename":"/tmp/whisper.cpp-master/samples/jfk.mp3"}]}}' | \
WHISPER_CLI_PATH="/tmp/whisper.cpp-master/build/bin/whisper-cli" \
WHISPER_MODEL=base \
WHISPER_MODEL_PATH="/tmp/whisper.cpp-master/models/ggml-base.bin" \
node index.js
```

The wrapper writes any generated transcript files into `./output/` under the selected working directory.

### 3. Build a Docker image locally

Example for the `base` model:

```sh
docker build --build-arg WHISPER_MODEL=base -t xyplug-whisper-base:test .
```

Then do a direct wrapper smoke test inside the container by bypassing `xyrun`:

```sh
mkdir -p /tmp/xyplug-whisper-test
curl -L https://github.com/ggml-org/whisper.cpp/raw/master/samples/jfk.mp3 -o /tmp/xyplug-whisper-test/sample.mp3

printf '%s\n' '{"xy":1,"cwd":"/work","params":{"model":"base","language":"auto","text":true,"srt":true},"input":{"files":[{"filename":"sample.mp3"}]}}' | \
docker run -i --rm \
  -v /tmp/xyplug-whisper-test:/work \
  --entrypoint node \
  xyplug-whisper-base:test /app/index.js
```

For a full end-to-end xyOps run, keep the default container command so `xyrun` can handle the real job file downloads and uploads.

## GitHub Actions

The repository includes a workflow at `.github/workflows/docker.yml` that:

- builds one image per model size
- builds `linux/amd64` and `linux/arm64`
- publishes to GHCR on semver tag pushes such as `v1.0.0`

This produces images like:

- `ghcr.io/pixlcore/xyplug-whisper-tiny:v1.0.0`
- `ghcr.io/pixlcore/xyplug-whisper-base:v1.0.0`
- `ghcr.io/pixlcore/xyplug-whisper-small:v1.0.0`
- `ghcr.io/pixlcore/xyplug-whisper-medium:v1.0.0`
- `ghcr.io/pixlcore/xyplug-whisper-large-v3:v1.0.0`

## License

MIT
