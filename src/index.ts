#!/usr/bin/env bun
import { 
  intro, 
  outro, 
  select, 
  text, 
  spinner, 
  note, 
  isCancel, 
  cancel 
} from "@clack/prompts";
import { checkFFmpeg, fileExists, generateOutputFilename, formatBytes } from "./utils";
import { getMediaInfo } from "./ffprobe";

async function main() {
  // 1. Argument validation
  const videoPath = Bun.argv[2];
  if (!videoPath) {
    console.error("\x1b[31mError: Please specify the input video file path.\x1b[0m");
    console.log("Usage: fvthlp <video_file_path>");
    process.exit(1);
  }

  // 2. Check if the file exists
  if (!fileExists(videoPath)) {
    console.error(`\x1b[31mError: Input file does not exist: "${videoPath}"\x1b[0m`);
    process.exit(1);
  }

  // 3. Environment check
  const ffmpegInstalled = await checkFFmpeg();
  if (!ffmpegInstalled) {
    console.error("\x1b[31mError: FFmpeg or FFprobe is not installed or not in your PATH.\x1b[0m");
    console.error("Please install FFmpeg and make sure it is accessible from the command line.");
    process.exit(1);
  }

  // 4. Start Clack workflow
  intro("\x1b[36mfvthlp (FFmpeg Video Transform Helper)\x1b[0m");

  const s = spinner();
  s.start("Reading video metadata...");
  let mediaInfo;
  try {
    mediaInfo = await getMediaInfo(videoPath);
    s.stop("Video metadata read successfully.");
  } catch (error: any) {
    s.stop("Failed to read video metadata.");
    console.error(`\x1b[31mError running ffprobe: ${error.message}\x1b[0m`);
    process.exit(1);
  }

  // Display brief info
  let infoStr = `File: ${mediaInfo.filename}\n`;
  infoStr += `Size: ${formatBytes(mediaInfo.size)}\n`;
  infoStr += `Duration: ${Math.round(mediaInfo.duration)}s\n\n`;

  if (mediaInfo.video) {
    infoStr += `Video: ${mediaInfo.video.codec.toUpperCase()} | ${mediaInfo.video.width}x${mediaInfo.video.height} | ${mediaInfo.video.fps} fps\n`;
  } else {
    infoStr += `Video: None or Undetected\n`;
  }

  if (mediaInfo.audio) {
    const brStr = mediaInfo.audio.bitrateKbps ? `${mediaInfo.audio.bitrateKbps} kbps` : "unknown bitrate";
    infoStr += `Audio: ${mediaInfo.audio.codec.toUpperCase()} | ${brStr} | ${mediaInfo.audio.channels} ch | ${mediaInfo.audio.sampleRate} Hz`;
  } else {
    infoStr += `Audio: None or Undetected`;
  }

  note(infoStr, "Original Media Information");

  // 5. Interactive selections
  
  // Prompt 1: Resolution conversion
  const resolutionChoice = await select({
    message: "Select target resolution:",
    options: [
      { value: "keep", label: "Keep Original", hint: "default" },
      { value: "1080", label: "1080P", hint: "Narrow side to 1080" },
      { value: "720", label: "720P", hint: "Narrow side to 720" },
      { value: "480", label: "480P", hint: "Narrow side to 480" }
    ],
    initialValue: "keep"
  });

  if (isCancel(resolutionChoice)) {
    cancel("Operation cancelled.");
    process.exit(0);
  }

  // Prompt 2: Preset Selection
  const presetChoice = await select({
    message: "Select x264 Preset (Encoding speed/quality balance):",
    options: [
      { value: "ultrafast", label: "ultrafast" },
      { value: "superfast", label: "superfast" },
      { value: "veryfast", label: "veryfast" },
      { value: "faster", label: "faster" },
      { value: "fast", label: "fast" },
      { value: "medium", label: "medium", hint: "default recommendation" },
      { value: "slow", label: "slow" },
      { value: "slower", label: "slower" },
      { value: "veryslow", label: "veryslow" }
    ],
    initialValue: "medium"
  });

  if (isCancel(presetChoice)) {
    cancel("Operation cancelled.");
    process.exit(0);
  }

  // Determine dynamic default CRF based on resolution selection
  let defaultCrf = "23";
  if (resolutionChoice === "720") {
    defaultCrf = "22";
  } else if (resolutionChoice === "480") {
    defaultCrf = "20";
  }

  // Prompt 3: CRF Selection
  const crfChoice = await select({
    message: "Select CRF (Constant Rate Factor, lower is higher quality):",
    options: [
      { value: "18", label: "18", hint: "High quality" },
      { value: "20", label: "20", hint: "Recommended for 480P" },
      { value: "22", label: "22", hint: "Recommended for 720P" },
      { value: "23", label: "23", hint: "Recommended for 1080P / Original" },
      { value: "26", label: "26", hint: "Lower quality / smaller size" },
      { value: "custom", label: "Custom", hint: "Enter manually (0-51)" }
    ],
    initialValue: defaultCrf
  });

  if (isCancel(crfChoice)) {
    cancel("Operation cancelled.");
    process.exit(0);
  }

  let finalCrf = crfChoice;
  if (crfChoice === "custom") {
    const customCrf = await text({
      message: "Enter custom CRF value (0-51):",
      placeholder: "23",
      validate(value) {
        const num = parseInt(value, 10);
        if (isNaN(num) || num < 0 || num > 51) {
          return "Please enter a valid integer between 0 and 51";
        }
      }
    });

    if (isCancel(customCrf)) {
      cancel("Operation cancelled.");
      process.exit(0);
    }
    finalCrf = customCrf;
  }

  // Prompt 4: Audio strategy
  let audioParam = "";
  if (mediaInfo.audio) {
    const isOriginalAac = mediaInfo.audio.codec.toLowerCase() === "aac";
    const isLowBitrate = mediaInfo.audio.bitrateKbps !== null && mediaInfo.audio.bitrateKbps < 150;

    if (isOriginalAac && isLowBitrate) {
      note(
        `Original audio is AAC and bitrate is ${mediaInfo.audio.bitrateKbps}kbps (< 150kbps).\nAutomatically selected 'copy' to preserve quality.`,
        "Audio Transcode"
      );
      audioParam = "-c:a copy";
    } else {
      const audioChoice = await select({
        message: "Select audio processing option:",
        options: [
          { value: "aac-128k", label: "Transcode to AAC (128k)", hint: "Recommended default" },
          { value: "copy", label: "Copy (No re-encoding)" },
          { value: "aac-192k", label: "Transcode to AAC (192k)" }
        ],
        initialValue: "aac-128k"
      });

      if (isCancel(audioChoice)) {
        cancel("Operation cancelled.");
        process.exit(0);
      }

      if (audioChoice === "copy") {
        audioParam = "-c:a copy";
      } else if (audioChoice === "aac-128k") {
        audioParam = "-c:a aac -b:a 128k";
      } else if (audioChoice === "aac-192k") {
        audioParam = "-c:a aac -b:a 192k";
      }
    }
  } else {
    // No audio stream
    audioParam = "-an";
  }

  // 6. Build FFmpeg command parameters
  const args: string[] = ["ffmpeg", "-i", `"${videoPath}"`];

  // Video Codec (Fixed to libx264)
  args.push("-c:v", "libx264");

  // Preset
  args.push("-preset", presetChoice);

  // CRF
  args.push("-crf", finalCrf);

  // Resolution scale filter (narrow side logic)
  if (resolutionChoice !== "keep" && mediaInfo.video) {
    const target = resolutionChoice;
    const w = mediaInfo.video.width;
    const h = mediaInfo.video.height;
    
    if (w <= h) {
      // Portrait or square: narrow side is width. Set width to target, height to scale.
      args.push("-vf", `"scale=${target}:-2"`);
    } else {
      // Landscape: narrow side is height. Set height to target, width to scale.
      args.push("-vf", `"scale=-2:${target}"`);
    }
  }

  // FPS check and downsampling
  if (mediaInfo.video && mediaInfo.video.fps > 30) {
    args.push("-r", "30");
  }

  // Audio param
  if (audioParam) {
    args.push(...audioParam.split(" "));
  }

  // Output filename
  const outputFilename = generateOutputFilename();
  args.push(outputFilename);

  const finalCommand = args.join(" ");

  // 7. Output Result
  note(
    `You can copy and run the following command directly:\n\n\x1b[32m${finalCommand}\x1b[0m`,
    "Generated FFmpeg Command"
  );

  outro("Thank you for using fvthlp! Let's get converting!");
}

main().catch((err) => {
  console.error("An unexpected error occurred:", err);
  process.exit(1);
});
