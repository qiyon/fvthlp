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
import { $ } from "bun";
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

  // Detect NVIDIA AV1 support
  let hasNvidiaGpu = false;
  let hasNvidiaAv1 = false;
  let hasSvtAv1 = false;
  let av1Encoder = "";

  try {
    const encodersOutput = await $`ffmpeg -encoders`.text();
    hasNvidiaGpu = encodersOutput.includes("h264_nvenc") || encodersOutput.includes("hevc_nvenc");
    if (encodersOutput.includes("av1_nvenc")) {
      // Verify hardware capability
      await $`ffmpeg -f lavfi -i color=c=black:s=64x64 -frames:v 1 -c:v av1_nvenc -f null -`.quiet();
      hasNvidiaAv1 = true;
    }
    hasSvtAv1 = encodersOutput.includes("libsvtav1");
    
    if (hasNvidiaAv1) {
      av1Encoder = "av1_nvenc";
    } else if (hasSvtAv1) {
      av1Encoder = "libsvtav1";
    } else if (encodersOutput.includes("libaom-av1")) {
      av1Encoder = "libaom-av1";
    }
  } catch {
    hasNvidiaAv1 = false;
  }

  // Display brief info
  let infoStr = `File: ${mediaInfo.filename}\n`;
  infoStr += `Size: ${formatBytes(mediaInfo.size)}\n`;
  infoStr += `Duration: ${Math.round(mediaInfo.duration)}s\n\n`;

  if (mediaInfo.video) {
    const vBrStr = mediaInfo.video.bitrateKbps ? ` | ${mediaInfo.video.bitrateKbps} kbps` : "";
    infoStr += `Video: ${mediaInfo.video.codec.toUpperCase()} | ${mediaInfo.video.width}x${mediaInfo.video.height} | ${mediaInfo.video.fps} fps${vBrStr}\n`;
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

  // Prompt 2: Video Codec
  const codecOptions = [
    { value: "h264", label: "H.264 (libx264)", hint: "Standard, highly compatible" }
  ];
  
  // "N卡不支持AV1时，直接不展示" -> if NVIDIA card is present on system but doesn't support AV1, do not show AV1 option at all.
  // Otherwise, if no NVIDIA GPU is present but we have a CPU AV1 encoder, show it.
  const showAv1Option = hasNvidiaAv1 || (!hasNvidiaGpu && !!av1Encoder);

  if (showAv1Option) {
    let encoderLabel = av1Encoder;
    if (av1Encoder === "av1_nvenc") {
      encoderLabel = "av1_nvenc (NVIDIA hardware accelerated)";
      codecOptions.push({ value: "av1", label: "AV1", hint: `encoder: ${encoderLabel}` });
    } else {
      // "如果选择CPU转码AV1，明确提示很慢不推荐" -> Include warning directly in the label/hint of selection
      codecOptions.push({ 
        value: "av1", 
        label: "AV1 (CPU encoder, very slow / not recommended)", 
        hint: `encoder: ${encoderLabel}` 
      });
    }
  }

  const codecChoice = await select({
    message: "Select video codec:",
    options: codecOptions,
    initialValue: "h264"
  });

  if (isCancel(codecChoice)) {
    cancel("Operation cancelled.");
    process.exit(0);
  }

  // Extra warning if CPU AV1 is selected
  if (codecChoice === "av1" && av1Encoder !== "av1_nvenc") {
    note(
      "\x1b[33mWarning: CPU AV1 transcoding (SVT-AV1 / libaom) is extremely slow and not recommended.\nIf speed is important, please cancel and choose H.264 instead.\x1b[0m",
      "Recommendation Warning"
    );
  }

  let presetChoice = "";
  let finalQuality = "";

  if (codecChoice === "h264") {
    // Prompt 3a: Preset Selection for H.264
    const preset = await select({
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

    if (isCancel(preset)) {
      cancel("Operation cancelled.");
      process.exit(0);
    }
    presetChoice = preset;

    // Determine dynamic default CRF based on resolution selection
    let defaultCrf = "23";
    if (resolutionChoice === "720") {
      defaultCrf = "22";
    } else if (resolutionChoice === "480") {
      defaultCrf = "20";
    }

    // Prompt 3b: CRF Selection
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
      finalQuality = customCrf;
    } else {
      finalQuality = crfChoice;
    }

  } else {
    // AV1
    if (av1Encoder === "av1_nvenc") {
      // Prompt 3c: Preset Selection for NVENC AV1
      const preset = await select({
        message: "Select NVIDIA AV1 NVENC Preset (Encoding speed/quality balance):",
        options: [
          { value: "p1", label: "p1 (fastest)" },
          { value: "p2", label: "p2" },
          { value: "p3", label: "p3" },
          { value: "p4", label: "p4" },
          { value: "p5", label: "p5 (medium)", hint: "default recommendation" },
          { value: "p6", label: "p6" },
          { value: "p7", label: "p7 (slowest / highest quality)" }
        ],
        initialValue: "p5"
      });

      if (isCancel(preset)) {
        cancel("Operation cancelled.");
        process.exit(0);
      }
      presetChoice = preset;
    } else {
      // Prompt 3d: Preset Selection for CPU AV1 (libsvtav1 or libaom-av1)
      const preset = await select({
        message: `Select CPU AV1 (${av1Encoder}) Preset (lower is slower/better quality):`,
        options: [
          { value: "4", label: "4 (slow / high quality)" },
          { value: "5", label: "5" },
          { value: "6", label: "6 (medium)", hint: "default recommendation" },
          { value: "7", label: "7" },
          { value: "8", label: "8 (fast / lower efficiency)" }
        ],
        initialValue: "6"
      });

      if (isCancel(preset)) {
        cancel("Operation cancelled.");
        process.exit(0);
      }
      presetChoice = preset;
    }

    // Determine dynamic default CQ/CRF based on resolution selection for AV1
    let defaultQuality = "28";
    if (av1Encoder === "av1_nvenc") {
      // Default cq is 36 for av1_nvenc
      defaultQuality = "36";
      if (resolutionChoice === "720") {
        defaultQuality = "34";
      } else if (resolutionChoice === "480") {
        defaultQuality = "32";
      }
    } else {
      if (resolutionChoice === "720") {
        defaultQuality = "25";
      } else if (resolutionChoice === "480") {
        defaultQuality = "22";
      }
    }

    const qualityLabel = av1Encoder === "av1_nvenc" ? "CQ" : "CRF";
    // Prompt 3e: CQ/CRF selection for AV1
    const qualityChoice = await select({
      message: `Select ${qualityLabel} (Constant Quality factor, lower is higher quality):`,
      options: av1Encoder === "av1_nvenc" ? [
        { value: "30", label: "30", hint: "High quality" },
        { value: "33", label: "33" },
        { value: "36", label: "36", hint: "Recommended default" },
        { value: "38", label: "38" },
        { value: "42", label: "42", hint: "Lower quality / smaller size" },
        { value: "custom", label: "Custom", hint: "Enter manually (0-51)" }
      ] : [
        { value: "20", label: "20", hint: "High quality" },
        { value: "22", label: "22", hint: "Recommended for 480P" },
        { value: "25", label: "25", hint: "Recommended for 720P" },
        { value: "28", label: "28", hint: "Recommended for 1080P / Original" },
        { value: "32", label: "32", hint: "Lower quality / smaller size" },
        { value: "custom", label: "Custom", hint: "Enter manually (0-51)" }
      ],
      initialValue: defaultQuality
    });

    if (isCancel(qualityChoice)) {
      cancel("Operation cancelled.");
      process.exit(0);
    }

    if (qualityChoice === "custom") {
      const customVal = await text({
        message: `Enter custom ${qualityLabel} value (0-51):`,
        placeholder: defaultQuality,
        validate(value) {
          const num = parseInt(value, 10);
          if (isNaN(num) || num < 0 || num > 51) {
            return "Please enter a valid integer between 0 and 51";
          }
        }
      });

      if (isCancel(customVal)) {
        cancel("Operation cancelled.");
        process.exit(0);
      }
      finalQuality = customVal;
    } else {
      finalQuality = qualityChoice;
    }
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
  const args: string[] = ["ffmpeg"];

  // Add hardware acceleration flag if using NVIDIA AV1
  if (codecChoice === "av1" && av1Encoder === "av1_nvenc") {
    args.push("-hwaccel", "cuda");
  }

  args.push("-i", `"${videoPath}"`);

  // Video Codec / Encoder Selection
  if (codecChoice === "h264") {
    args.push("-c:v", "libx264");
    args.push("-preset", presetChoice);
    args.push("-crf", finalQuality);
  } else {
    args.push("-c:v", av1Encoder);
    args.push("-preset", presetChoice);
    if (av1Encoder === "av1_nvenc") {
      args.push("-cq:v", finalQuality, "-tune", "hq", "-b:v", "0");
    } else {
      args.push("-crf", finalQuality);
    }
  }

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
  outro("Thank you for using fvthlp! Let's get converting!");
  console.log(finalCommand);
}

main().catch((err) => {
  console.error("An unexpected error occurred:", err);
  process.exit(1);
});
