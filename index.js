#!/usr/bin/env node

// xyplug-whisper
// A Docker-based xyOps Event Plugin powered by whisper.cpp
// Copyright (c) 2026 PixlCore LLC
// MIT License

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');

const XYWP_VERSION = 1;
const DEFAULT_MODEL = process.env.WHISPER_MODEL || 'base';
const DEFAULT_THREADS = Math.max(1, Math.min(4, os.availableParallelism ? os.availableParallelism() : os.cpus().length || 1));
const WHISPER_CLI_PATH = process.env.WHISPER_CLI_PATH || 'whisper-cli';
const WHISPER_MODEL_PATH = process.env.WHISPER_MODEL_PATH || `/opt/whisper/models/ggml-${DEFAULT_MODEL}.bin`;

function emitJson(data) {
	process.stdout.write(JSON.stringify(Object.assign({ xy: XYWP_VERSION }, data)) + "\n");
}

function log(message) {
	process.stdout.write(message.replace(/\r?\n$/, '') + "\n");
}

function normalizeBoolean(value) {
	if (typeof value === 'boolean') return value;
	if (typeof value === 'number') return !!value;
	if (typeof value === 'string') return !!value.match(/^(1|true|yes|on)$/i);
	return false;
}

function normalizeInteger(value, fallback) {
	const num = parseInt(value, 10);
	return Number.isFinite(num) && (num > 0) ? num : fallback;
}

function safeBasename(file) {
	return file.replace(/[^\w.\-]+/g, '_').replace(/^_+/, '').replace(/_+$/, '') || 'transcript';
}

function stripFinalEOL(text) {
	return (text || '').replace(/\r?\n$/, '');
}

function parseProgress(line) {
	const match = line.match(/progress\s*=\s*(\d{1,3})%/i);
	if (!match) return null;
	const percent = Math.max(0, Math.min(100, parseInt(match[1], 10) || 0));
	return percent / 100;
}

function summarizeSegments(json) {
	if (!json || !Array.isArray(json.transcription)) return [];
	return json.transcription.map(function(segment) {
		return {
			start: segment.timestamps ? segment.timestamps.from : '',
			end: segment.timestamps ? segment.timestamps.to : '',
			start_ms: segment.offsets ? segment.offsets.from : 0,
			end_ms: segment.offsets ? segment.offsets.to : 0,
			text: segment.text || ''
		};
	});
}

async function readJob() {
	const chunks = [];
	for await (const chunk of process.stdin) chunks.push(chunk);
	return JSON.parse(Buffer.concat(chunks).toString());
}

async function runWhisper(cliArgs, workDir) {
	return await new Promise(function(resolve, reject) {
		const child = spawn(WHISPER_CLI_PATH, cliArgs, {
			cwd: workDir,
			stdio: ['ignore', 'pipe', 'pipe']
		});

		let stdout = '';
		let stderr = '';
		let stderrBuffer = '';
		let lastProgress = -1;

		child.on('error', reject);

		child.stdout.setEncoding('utf8');
		child.stdout.on('data', function(chunk) {
			stdout += chunk;
			if (chunk.trim()) process.stdout.write(chunk);
		});

		child.stderr.setEncoding('utf8');
		child.stderr.on('data', function(chunk) {
			stderr += chunk;
			stderrBuffer += chunk;
			const parts = stderrBuffer.split(/\r?\n/);
			stderrBuffer = parts.pop() || '';

			parts.filter(Boolean).forEach(function(line) {
				const progress = parseProgress(line);
				if ((progress !== null) && (progress > lastProgress)) {
					lastProgress = progress;
					emitJson({ progress });
					return;
				}
				log(line);
			});
		});

		child.on('close', function(code) {
			if (stderrBuffer.trim()) {
				const progress = parseProgress(stderrBuffer.trim());
				if ((progress !== null) && (progress > lastProgress)) {
					lastProgress = progress;
					emitJson({ progress });
				}
				else {
					log(stderrBuffer.trim());
				}
			}
			resolve({ code: code || 0, stdout, stderr });
		});
	});
}

(async function main() {
	const started = Date.now();
	let job = null;

	try {
		job = await readJob();
	}
	catch (err) {
		emitJson({ code: 1, description: `Failed to parse job JSON: ${err.message}` });
		process.exit(0);
	}

	const params = job.params || {};
	const workDir = path.resolve(job.cwd || process.cwd());
	const requestedModel = params.model || DEFAULT_MODEL;
	const language = (params.language || 'auto').toString().trim() || 'auto';
	const threads = normalizeInteger(params.threads, DEFAULT_THREADS);

	if (job.cwd) {
		try { process.chdir(workDir); }
		catch (err) {
			emitJson({ code: 1, description: `Failed to switch to job directory: ${err.message}` });
			process.exit(0);
		}
	}

	if (!job.input || !Array.isArray(job.input.files) || !job.input.files.length) {
		emitJson({ code: 1, description: 'No input files were provided to the job.' });
		process.exit(0);
	}

	const inputFile = job.input.files[0];
	if (!inputFile || !inputFile.filename) {
		emitJson({ code: 1, description: 'Input file metadata is missing a filename.' });
		process.exit(0);
	}

	if (!fs.existsSync(WHISPER_MODEL_PATH)) {
		emitJson({ code: 1, description: `Whisper model file not found: ${WHISPER_MODEL_PATH}` });
		process.exit(0);
	}

	const inputPath = path.resolve(workDir, inputFile.filename);
	if (!fs.existsSync(inputPath)) {
		emitJson({ code: 1, description: `Input file was not found in the job directory: ${inputFile.filename}` });
		process.exit(0);
	}

	const outputDir = path.resolve(workDir, 'output');
	const inputBase = safeBasename(path.parse(inputFile.filename).name || inputFile.filename);
	const outputBase = path.join(outputDir, inputBase);

	fs.mkdirSync(outputDir, { recursive: true });

	const cliArgs = [
		'--no-gpu',
		'--no-prints',
		'--print-progress',
		'--threads', String(threads),
		'--model', WHISPER_MODEL_PATH,
		'--language', language,
		'--output-file', outputBase,
		'--output-txt',
		'--output-json'
	];

	if (normalizeBoolean(params.translate)) cliArgs.push('--translate');
	if (params.prompt && ('' + params.prompt).trim()) {
		cliArgs.push('--prompt', ('' + params.prompt).trim());
	}
	if (normalizeBoolean(params.srt)) cliArgs.push('--output-srt');
	if (normalizeBoolean(params.vtt)) cliArgs.push('--output-vtt');
	if (normalizeBoolean(params.lrc)) cliArgs.push('--output-lrc');

	// The input file goes last, matching whisper.cpp's CLI conventions.
	cliArgs.push(inputPath);

	log(`Starting whisper.cpp for ${inputFile.filename}`);
	if (requestedModel !== DEFAULT_MODEL) {
		log(`Warning: requested model '${requestedModel}' does not match baked image model '${DEFAULT_MODEL}'.`);
	}

	const result = await runWhisper(cliArgs, workDir);
	if (result.code) {
		const errorLine = stripFinalEOL(result.stderr.trim().split(/\r?\n/).filter(Boolean).pop() || '');
		emitJson({
			code: result.code,
			description: errorLine || `whisper.cpp exited with code ${result.code}.`
		});
		process.exit(0);
	}

	const txtPath = `${outputBase}.txt`;
	const jsonPath = `${outputBase}.json`;
	const srtPath = `${outputBase}.srt`;
	const vttPath = `${outputBase}.vtt`;
	const lrcPath = `${outputBase}.lrc`;

	if (!fs.existsSync(txtPath)) {
		emitJson({ code: 1, description: `whisper.cpp completed but did not create the transcript text file: ${path.basename(txtPath)}` });
		process.exit(0);
	}
	if (!fs.existsSync(jsonPath)) {
		emitJson({ code: 1, description: `whisper.cpp completed but did not create the transcript JSON file: ${path.basename(jsonPath)}` });
		process.exit(0);
	}

	const transcript = stripFinalEOL(fs.readFileSync(txtPath, 'utf8'));
	let parsedJson = null;
	try {
		parsedJson = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
	}
	catch (err) {
		log(`Warning: Failed to parse whisper JSON output: ${err.message}`);
	}

	const outputFiles = [];
	const outputInfo = [];

	// TXT is always generated and attached by default, because it is the most useful downstream artifact.
	if (!('text' in params) || normalizeBoolean(params.text)) {
		outputFiles.push(txtPath);
		outputInfo.push({ type: 'txt', filename: path.basename(txtPath) });
	}
	if (normalizeBoolean(params.srt) && fs.existsSync(srtPath)) {
		outputFiles.push(srtPath);
		outputInfo.push({ type: 'srt', filename: path.basename(srtPath) });
	}
	if (normalizeBoolean(params.vtt) && fs.existsSync(vttPath)) {
		outputFiles.push(vttPath);
		outputInfo.push({ type: 'vtt', filename: path.basename(vttPath) });
	}
	if (normalizeBoolean(params.lrc) && fs.existsSync(lrcPath)) {
		outputFiles.push(lrcPath);
		outputInfo.push({ type: 'lrc', filename: path.basename(lrcPath) });
	}
	if (normalizeBoolean(params.json)) {
		outputFiles.push(jsonPath);
		outputInfo.push({ type: 'json', filename: path.basename(jsonPath) });
	}

	const data = {
		model: DEFAULT_MODEL,
		requestedModel,
		requestedLanguage: language,
		detectedLanguage: parsedJson && parsedJson.result ? (parsedJson.result.language || '') : '',
		translate: normalizeBoolean(params.translate),
		input: {
			filename: inputFile.filename,
			size: inputFile.size || 0
		},
		transcript,
		segments: summarizeSegments(parsedJson),
		outputs: outputInfo,
		duration_ms: Date.now() - started
	};

	emitJson({
		code: 0,
		data,
		files: outputFiles
	});
	process.exit(0);
})();
