import { spawn } from "node:child_process";

export interface ProcessResult {
  stdout: string;
  stderr: string;
}

export interface MediaCommandError extends Error {
  stderr?: string;
}

export interface MediaExecutablePaths {
  ffmpegPath: string;
  ffprobePath: string;
}

export interface MediaCommandOptions {
  signal?: AbortSignal;
  cwd?: string;
}

export function resolveMediaExecutablePaths(
  environment: NodeJS.ProcessEnv = process.env
): MediaExecutablePaths {
  return {
    ffmpegPath: environment.FFMPEG_PATH || "ffmpeg",
    ffprobePath: environment.FFPROBE_PATH || "ffprobe"
  };
}

export function runMediaCommand(
  executable: string,
  args: string[],
  timeoutMs: number,
  maxOutputBytes: number,
  options: MediaCommandOptions = {}
): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const process = spawn(executable, args, {
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      ...(options.cwd ? { cwd: options.cwd } : {}),
      signal: options.signal
    });
    let stdout = "";
    let stderr = "";
    let stdoutBytes = 0;
    let settled = false;
    const timeout = setTimeout(() => {
      process.kill();
      finish(createMediaCommandError("Media command timed out", stderr));
    }, timeoutMs);

    const appendBounded = (current: string, chunk: Buffer, isStdout: boolean): string => {
      if (isStdout) {
        stdoutBytes += chunk.length;
        if (stdoutBytes > maxOutputBytes) {
          process.kill();
          finish(createMediaCommandError("Media command output exceeded its configured limit", stderr));
          return current;
        }
      }
      return (current + chunk.toString("utf8")).slice(-maxOutputBytes);
    };

    process.stdout.on("data", (chunk: Buffer) => { stdout = appendBounded(stdout, chunk, true); });
    process.stderr.on("data", (chunk: Buffer) => { stderr = appendBounded(stderr, chunk, false); });
    process.once("error", (error) => {
      attachMediaStderr(error, stderr);
      finish(error);
    });
    process.once("close", (code) => {
      if (code === 0) finish(undefined, { stdout, stderr });
      else finish(createMediaCommandError(
        `Media command exited with code ${String(code)}: ${stderr.slice(-4000)}`,
        stderr
      ));
    });

    function finish(error?: Error, result?: ProcessResult) {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (error) reject(error);
      else resolve(result ?? { stdout, stderr });
    }
  });
}

function attachMediaStderr(error: Error, stderr: string): void {
  if (stderr) (error as MediaCommandError).stderr = stderr.slice(-4000);
}

function createMediaCommandError(message: string, stderr: string): MediaCommandError {
  const error: MediaCommandError = new Error(message);
  if (stderr) error.stderr = stderr.slice(-4000);
  return error;
}

export interface ProbeMetadata {
  durationSeconds: number;
  width: number;
  height: number;
  videoCodec: string;
}

export async function probeMedia(
  ffprobePath: string,
  filePath: string,
  timeoutMs: number
): Promise<ProbeMetadata> {
  const result = await runMediaCommand(ffprobePath, [
    "-v", "error",
    "-show_entries", "format=duration:stream=codec_type,codec_name,width,height",
    "-of", "json",
    filePath
  ], timeoutMs, 1024 * 1024);
  try {
    return parseProbeMetadata(result.stdout);
  } catch (error) {
    if (error instanceof Error) attachMediaStderr(error, result.stderr);
    throw error;
  }
}

export function parseProbeMetadata(stdout: string): ProbeMetadata {
  const parsed = JSON.parse(stdout) as {
    format?: { duration?: string };
    streams?: Array<{ codec_type?: string; codec_name?: string; width?: number; height?: number }>;
  };
  const video = parsed.streams?.find((stream) => stream.codec_type === "video");
  const durationSeconds = Number(parsed.format?.duration);
  if (!video?.codec_name || !Number.isInteger(video.width) || !Number.isInteger(video.height)
    || !video.width || !video.height || video.width > 16384 || video.height > 16384
    || !Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    throw new Error("Media probe found no valid video stream, dimensions, or duration");
  }
  return {
    durationSeconds,
    width: video.width,
    height: video.height,
    videoCodec: video.codec_name
  };
}
