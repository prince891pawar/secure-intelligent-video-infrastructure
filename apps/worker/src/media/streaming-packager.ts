import { mkdir, open, readFile, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, sep } from "node:path";
import type pino from "pino";
import { runMediaCommand, type MediaCommandError, type ProcessResult } from "./ffmpeg.js";

export interface PackagingRendition {
  name: string;
  width: number;
  height: number;
  codec: string;
  fileSizeBytes: number;
  durationSeconds: number;
  path: string;
}

export interface PackagedAsset {
  relativePath: string;
  path: string;
  contentType: string;
  fileSizeBytes: number;
}

export interface PackagedManifest {
  relativePath: string;
  protocol: "hls" | "dash";
  contentType: string;
  fileSizeBytes: number;
}

export interface StreamingPackage {
  assets: PackagedAsset[];
  manifests: PackagedManifest[];
}

export interface StreamingPackagingConfig {
  ffmpegPath: string;
  timeoutMs: number;
  threads: number;
  maxOutputBytes: number;
  logger: pino.Logger;
  videoId: string;
  attempt: number;
}

export async function packageAdaptiveStreaming(
  renditions: PackagingRendition[],
  outputRoot: string,
  config: StreamingPackagingConfig
): Promise<StreamingPackage> {
  if (renditions.length === 0) throw new Error("Cannot package streaming without verified renditions");
  const sorted = [...renditions].sort((a, b) => b.height - a.height);
  const hlsRoot = join(outputRoot, "hls");
  const dashRoot = join(outputRoot, "dash");
  const assets: PackagedAsset[] = [];
  const manifests: PackagedManifest[] = [];

  for (const rendition of sorted) {
    const remaining = config.maxOutputBytes - assets.reduce((sum, asset) => sum + asset.fileSizeBytes, 0);
    if (remaining <= 0) throw new Error("HLS assets exceed the configured total output limit");
    const renditionRoot = join(hlsRoot, rendition.name);
    await mkdir(renditionRoot, { recursive: true });
    const playlistPath = join(renditionRoot, "index.m3u8");
    const segmentPattern = join(renditionRoot, "segment-%05d.ts");
    await runPackagingCommand(config, `hls:${rendition.name}`, [
      "-hide_banner", "-nostdin", "-v", "error",
      "-i", rendition.path,
      "-map", "0:v:0",
      "-map", "0:a?",
      "-c", "copy",
      "-f", "hls",
      "-hls_time", "6",
      "-hls_playlist_type", "vod",
      "-hls_flags", "independent_segments",
      "-hls_segment_filename", segmentPattern,
      "-fs", String(remaining),
      playlistPath
    ], dirname(playlistPath));
    const playlist = await readManifest(playlistPath);
    const segments = await validateHlsMediaPlaylist(playlistPath, playlist);
    config.logger.info({
      videoId: config.videoId,
      attempt: config.attempt,
      protocol: "hls",
      rendition: rendition.name,
      manifestPath: playlistPath,
      segmentCount: segments.length,
      valid: true
    }, "HLS media manifest validated");
    const relativePath = relative(outputRoot, playlistPath).split(sep).join("/");
    assets.push(await makeAsset(outputRoot, playlistPath, "application/vnd.apple.mpegurl"));
    manifests.push(await makeManifest(relativePath, playlistPath, "hls", "application/vnd.apple.mpegurl"));
    for (const segment of segments) assets.push(await makeAsset(outputRoot, segment, "video/mp2t"));
  }

  const masterPath = join(hlsRoot, "master.m3u8");
  const master = generateHlsMasterPlaylist(sorted);
  await writeFile(masterPath, master, "utf8");
  validateHlsMasterPlaylist(master, sorted.map(({ name }) => name));
  config.logger.info({
    videoId: config.videoId,
    attempt: config.attempt,
    protocol: "hls",
    manifestPath: masterPath,
    renditionCount: sorted.length,
    valid: true
  }, "HLS master manifest validated");

  assets.push(await makeAsset(outputRoot, masterPath, "application/vnd.apple.mpegurl"));
  manifests.push(await makeManifest("hls/master.m3u8", masterPath, "hls", "application/vnd.apple.mpegurl"));

  const remainingForDash = config.maxOutputBytes - assets.reduce((sum, asset) => sum + asset.fileSizeBytes, 0);
  if (remainingForDash <= 0) throw new Error("HLS assets exceed the configured total output limit");
  const dashManifest = await createDashPackage(sorted, dashRoot, { ...config, maxOutputBytes: remainingForDash });
  const dashContents = await readManifest(dashManifest);
  const dashAssets = await validateDashManifest(dashManifest, dashContents);
  config.logger.info({
    videoId: config.videoId,
    attempt: config.attempt,
    protocol: "dash",
    manifestPath: dashManifest,
    referencedAssetCount: dashAssets.length,
    valid: true
  }, "DASH manifest validated");
  for (const asset of dashAssets) {
    assets.push(await makeAsset(outputRoot, asset, inferDashAssetContentType(asset)));
  }
  assets.push(await makeAsset(outputRoot, dashManifest, "application/dash+xml"));
  manifests.push(await makeManifest("dash/stream.mpd", dashManifest, "dash", "application/dash+xml"));

  const totalBytes = assets.reduce((sum, asset) => sum + asset.fileSizeBytes, 0);
  if (totalBytes > config.maxOutputBytes) throw new Error("Streaming assets exceed the configured total output limit");
  config.logger.info({
    videoId: config.videoId,
    attempt: config.attempt,
    manifestCount: manifests.length,
    assetCount: assets.length,
    totalBytes
  }, "adaptive streaming package validated");
  return { assets, manifests };
}

export function generateHlsMasterPlaylist(renditions: PackagingRendition[]): string {
  if (renditions.length === 0) throw new Error("HLS master playlist requires at least one rendition");
  const lines = [...renditions].sort((a, b) => b.height - a.height).flatMap((rendition) => {
    const bandwidth = Math.max(1, Math.round((rendition.fileSizeBytes * 8) / rendition.durationSeconds));
    return [
      `#EXT-X-STREAM-INF:BANDWIDTH=${bandwidth},RESOLUTION=${rendition.width}x${rendition.height}`,
      `${rendition.name}/index.m3u8`
    ];
  });
  return `#EXTM3U\n#EXT-X-VERSION:6\n${lines.join("\n")}\n`;
}

export function validateHlsMasterPlaylist(content: string, expectedRenditions: string[]): void {
  if (!content.startsWith("#EXTM3U\n") || !content.includes("#EXT-X-VERSION:")) {
    throw new Error("HLS master playlist header is invalid");
  }
  const lines = content.split(/\r?\n/);
  const uris = lines.filter((line) => line && !line.startsWith("#"));
  const expected = [...expectedRenditions].sort();
  const actual = uris.map((uri) => {
    if (!/^[A-Za-z0-9_-]+\/index\.m3u8$/.test(uri)) throw new Error("HLS master playlist contains an unsafe URI");
    return uri.split("/")[0]!;
  }).sort();
  if (actual.length !== expected.length || actual.some((item, index) => item !== expected[index])) {
    throw new Error("HLS master playlist references renditions that were not produced");
  }
  if (lines.filter((line) => line.startsWith("#EXT-X-STREAM-INF:")).length !== uris.length) {
    throw new Error("HLS master playlist stream declarations are incomplete");
  }
}

export async function validateHlsMediaPlaylist(path: string, content: string): Promise<string[]> {
  if (!content.startsWith("#EXTM3U\n") || !content.includes("#EXT-X-ENDLIST")) {
    throw new Error("HLS media playlist is incomplete");
  }
  const segments = content.split(/\r?\n/).filter((line) => line && !line.startsWith("#"));
  if (segments.length === 0 || (content.match(/#EXTINF:/g) ?? []).length !== segments.length) {
    throw new Error("HLS media playlist segment metadata is inconsistent");
  }
  const directory = dirname(path);
  const result: string[] = [];
  for (const segment of segments) {
    if (!/^segment-[0-9]{5}\.ts$/.test(segment)) throw new Error("HLS media playlist contains an unsafe segment reference");
    const segmentPath = join(directory, segment);
    if ((await stat(segmentPath)).size <= 0 || !(await hasTransportStreamSignature(segmentPath))) {
      throw new Error("HLS media playlist references an empty or corrupt segment");
    }
    result.push(segmentPath);
  }
  return result;
}

export async function validateDashManifest(path: string, content: string): Promise<string[]> {
  if (!content.includes("<MPD") || !content.includes("</MPD>") || !content.includes('type="static"')) {
    throw new Error("DASH manifest is invalid or not a completed VOD manifest");
  }
  if (/<BaseURL\b/i.test(content)) throw new Error("DASH manifest uses unsupported base URL references");
  const references = new Set<string>();
  const expression = /(?:media|initialization|sourceURL|href)="([^"]+)"/g;
  for (const match of content.matchAll(expression)) {
    const reference = match[1];
    if (!reference || reference.includes("$") || reference.includes("/") || reference.includes("\\") || reference.includes("..")) {
      throw new Error("DASH manifest contains an unresolved or unsafe asset reference");
    }
    references.add(reference);
  }
  if (references.size === 0) throw new Error("DASH manifest has no media asset references");
  const result: string[] = [];
  for (const reference of references) {
    const assetPath = join(dirname(path), reference);
    const isInitialization = reference.startsWith("init-");
    if ((await stat(assetPath)).size <= 0 || !(await hasIsoBmffSignature(assetPath, isInitialization))) {
      throw new Error("DASH manifest references a missing or corrupt segment");
    }
    result.push(assetPath);
  }
  return result;
}

async function createDashPackage(
  renditions: PackagingRendition[],
  outputDirectory: string,
  config: StreamingPackagingConfig
): Promise<string> {
  await mkdir(outputDirectory, { recursive: true });
  const manifestPath = join(outputDirectory, "stream.mpd");
  const args = ["-hide_banner", "-nostdin", "-v", "error"];
  for (const rendition of renditions) args.push("-i", rendition.path);
  for (let index = 0; index < renditions.length; index++) args.push("-map", `${index}:v:0`);
  args.push(
    "-c:v", "copy",
    "-threads", String(config.threads),
    "-f", "dash",
    "-seg_duration", "6",
    "-use_template", "0",
    "-use_timeline", "0",
    "-init_seg_name", "init-$RepresentationID$.m4s",
    "-media_seg_name", "chunk-$RepresentationID$-$Number$.m4s",
    "-adaptation_sets", "id=0,streams=v",
    "-fs", String(config.maxOutputBytes),
    manifestPath
  );
  await runPackagingCommand(config, "dash", args, outputDirectory);
  return manifestPath;
}

async function runPackagingCommand(
  config: StreamingPackagingConfig,
  operation: string,
  args: string[],
  cwd: string
): Promise<ProcessResult> {
  const context = {
    videoId: config.videoId,
    attempt: config.attempt,
    operation,
    executable: config.ffmpegPath,
    args,
    cwd,
    timeoutMs: config.timeoutMs
  };
  const startedAt = Date.now();
  config.logger.info(context, "starting FFmpeg packaging command");
  try {
    const result = await runMediaCommand(config.ffmpegPath, args, config.timeoutMs, 64 * 1024, { cwd });
    config.logger.info({
      videoId: config.videoId,
      attempt: config.attempt,
      operation,
      durationMs: Date.now() - startedAt,
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr
    }, "FFmpeg packaging command completed");
    return result;
  } catch (error) {
    const commandError = error instanceof Error ? error as MediaCommandError : undefined;
    config.logger.error({
      videoId: config.videoId,
      attempt: config.attempt,
      operation,
      durationMs: Date.now() - startedAt,
      errorType: error instanceof Error ? error.name : "UnknownError",
      message: error instanceof Error ? error.message : String(error),
      ...(commandError ? {
        stdout: commandError.stdout ?? "",
        stderr: commandError.stderr ?? "",
        ...(commandError.exitCode === undefined ? {} : { exitCode: commandError.exitCode })
      } : {})
    }, "FFmpeg packaging command failed");
    throw error;
  }
}

async function readManifest(path: string): Promise<string> {
  const details = await stat(path);
  if (details.size <= 0 || details.size > 2 * 1024 * 1024) throw new Error("Generated streaming manifest size is invalid");
  return readFile(path, "utf8");
}

async function makeAsset(root: string, path: string, contentType: string): Promise<PackagedAsset> {
  return {
    relativePath: relative(root, path).split(sep).join("/"),
    path,
    contentType,
    fileSizeBytes: (await stat(path)).size
  };
}

async function makeManifest(
  relativePath: string,
  path: string,
  protocol: "hls" | "dash",
  contentType: string
): Promise<PackagedManifest> {
  return { relativePath, protocol, contentType, fileSizeBytes: (await stat(path)).size };
}

function inferDashAssetContentType(path: string): string {
  return basename(path).startsWith("init-") ? "video/mp4" : "video/iso.segment";
}

async function hasTransportStreamSignature(path: string): Promise<boolean> {
  const handle = await open(path, "r");
  try {
    const header = Buffer.alloc(1);
    const { bytesRead } = await handle.read(header, 0, header.length, 0);
    return bytesRead === 1 && header[0] === 0x47;
  } finally {
    await handle.close();
  }
}

async function hasIsoBmffSignature(path: string, initialization: boolean): Promise<boolean> {
  const handle = await open(path, "r");
  try {
    const header = Buffer.alloc(8);
    const { bytesRead } = await handle.read(header, 0, header.length, 0);
    if (bytesRead < 8) return false;
    const boxType = header.toString("ascii", 4, 8);
    return initialization ? boxType === "ftyp" || boxType === "moov"
      : boxType === "styp" || boxType === "moof" || boxType === "sidx";
  } finally {
    await handle.close();
  }
}
