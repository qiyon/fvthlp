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

  // Detect encoder availability
  let hasNvidiaAv1 = false; // local hw av1_nvenc works
  let cpuAv1Encoder = "";   // best available CPU AV1 encoder name

  try {
    const encodersOutput = await $`ffmpeg -encoders`.text();
    if (encodersOutput.includes("av1_nvenc")) {
      try {
        await $`ffmpeg -f lavfi -i color=c=black:s=64x64 -frames:v 1 -c:v av1_nvenc -f null -`.quiet();
        hasNvidiaAv1 = true;
      } catch { /* av1_nvenc listed but hw not available */ }
    }
    if (encodersOutput.includes("libsvtav1")) {
      cpuAv1Encoder = "libsvtav1";
    }
  } catch { /* ignore encoder detection errors */ }

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
  // Always show all three options; warn post-selection if not locally supported.
  const codecOptions = [
    { value: "h264",     label: "H.264 (libx264)",              hint: "Standard, highly compatible" },
    { value: "av1_nvenc", label: "AV1 - NVIDIA (av1_nvenc)",    hint: hasNvidiaAv1 ? "Hardware accelerated" : "Not detected locally — command still generated" },
    { value: "av1_cpu",  label: "AV1 - CPU (libsvtav1)",        hint: cpuAv1Encoder ? "SVT-AV1, preset 1-13" : "Very slow, not recommended" },
  ];

  const codecChoice = await select({
    message: "Select video codec:",
    options: codecOptions,
    initialValue: "h264"
  });

  if (isCancel(codecChoice)) {
    cancel("Operation cancelled.");
    process.exit(0);
  }

  // Post-selection warnings
  if (codecChoice === "av1_nvenc" && !hasNvidiaAv1) {
    note(
      "NVIDIA av1_nvenc is not available on this machine.\nThe FFmpeg command will still be generated — copy it to a machine with an NVIDIA GPU.",
      "Local Compatibility Warning"
    );
  }
  if (codecChoice === "av1_cpu") {
    note(
      "Warning: CPU AV1 transcoding is extremely slow and not recommended.\nConsider H.264 instead unless you specifically need AV1.",
      "Performance Warning"
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

  } else if (codecChoice === "av1_nvenc") {
    // Prompt 3c: Preset Selection for NVIDIA AV1 (p1-p7)
    const preset = await select({
      message: "Select NVIDIA AV1 (av1_nvenc) Preset:",
      options: [
        { value: "p1", label: "p1  — fastest" },
        { value: "p2", label: "p2" },
        { value: "p3", label: "p3" },
        { value: "p4", label: "p4" },
        { value: "p5", label: "p5  — medium", hint: "default recommendation" },
        { value: "p6", label: "p6" },
        { value: "p7", label: "p7  — highest quality" },
      ],
      initialValue: "p5"
    });
    if (isCancel(preset)) { cancel("Operation cancelled."); process.exit(0); }
    presetChoice = preset;

    // CQ (Constant Quality) for av1_nvenc
    let defaultCq = "36";
    if (resolutionChoice === "720") defaultCq = "34";
    else if (resolutionChoice === "480") defaultCq = "32";

    const cqChoice = await select({
      message: "Select CQ (lower = higher quality):",
      options: [
        { value: "30", label: "30", hint: "High quality" },
        { value: "33", label: "33" },
        { value: "36", label: "36", hint: "Recommended default" },
        { value: "38", label: "38" },
        { value: "42", label: "42", hint: "Lower quality / smaller file" },
        { value: "custom", label: "Custom", hint: "Enter manually (0-51)" },
      ],
      initialValue: defaultCq
    });
    if (isCancel(cqChoice)) { cancel("Operation cancelled."); process.exit(0); }

    if (cqChoice === "custom") {
      const customCq = await text({
        message: "Enter custom CQ value (0-51):",
        placeholder: defaultCq,
        validate(v) {
          const n = parseInt(v, 10);
          if (isNaN(n) || n < 0 || n > 51) return "Please enter a valid integer between 0 and 51";
        }
      });
      if (isCancel(customCq)) { cancel("Operation cancelled."); process.exit(0); }
      finalQuality = customCq;
    } else {
      finalQuality = cqChoice;
    }

  } else {
    // Prompt 3d: Preset for CPU AV1 (libsvtav1) — numeric 1-13 (1=slowest/best, 13=fastest)
    const preset = await select({
      message: `Select SVT-AV1 Preset (1=slowest/best quality, 13=fastest):`,
      options: [
        { value: "1",  label: "1   — slowest / highest quality" },
        { value: "2",  label: "2" },
        { value: "3",  label: "3" },
        { value: "4",  label: "4" },
        { value: "5",  label: "5" },
        { value: "6",  label: "6" },
        { value: "7",  label: "7" },
        { value: "8",  label: "8",  hint: "default recommendation" },
        { value: "9",  label: "9" },
        { value: "10", label: "10" },
        { value: "11", label: "11" },
        { value: "12", label: "12" },
        { value: "13", label: "13  — fastest / lowest quality" },
      ],
      initialValue: "8"
    });
    if (isCancel(preset)) { cancel("Operation cancelled."); process.exit(0); }
    presetChoice = preset;

    // CRF for CPU AV1
    let defaultCrf = "28";
    if (resolutionChoice === "720") defaultCrf = "25";
    else if (resolutionChoice === "480") defaultCrf = "22";

    const crfChoice = await select({
      message: "Select CRF (lower = higher quality):",
      options: [
        { value: "20", label: "20", hint: "High quality" },
        { value: "22", label: "22", hint: "Recommended for 480P" },
        { value: "25", label: "25", hint: "Recommended for 720P" },
        { value: "28", label: "28", hint: "Recommended for 1080P / Original" },
        { value: "32", label: "32", hint: "Lower quality / smaller file" },
        { value: "custom", label: "Custom", hint: "Enter manually (0-51)" },
      ],
      initialValue: defaultCrf
    });
    if (isCancel(crfChoice)) { cancel("Operation cancelled."); process.exit(0); }

    if (crfChoice === "custom") {
      const customCrf = await text({
        message: "Enter custom CRF value (0-51):",
        placeholder: defaultCrf,
        validate(v) {
          const n = parseInt(v, 10);
          if (isNaN(n) || n < 0 || n > 51) return "Please enter a valid integer between 0 and 51";
        }
      });
      if (isCancel(customCrf)) { cancel("Operation cancelled."); process.exit(0); }
      finalQuality = customCrf;
    } else {
      finalQuality = crfChoice;
    }
  }

  // Prompt 4: Audio strategy
  let audioParam = "";
  if (mediaInfo.audio) {
    const isOriginalAac = mediaInfo.audio.codec.toLowerCase() === "aac";
    const isLowBitrate = mediaInfo.audio.bitrateKbps !== null && mediaInfo.audio.bitrateKbps < 150;

    if (isOriginalAac && isLowBitrate) {
      note(
        `Original audio is AAC and bitrate is ${mediaInfo.audio.bitrateKbps}kbps (< 150kbps). Defaulting to 'copy' to preserve quality.`,
        "Audio Transcode"
      );
    }

    const audioDefault = isOriginalAac && isLowBitrate ? "copy" : "aac-128k";
    const audioChoice = await select({
      message: "Select audio processing option:",
      options: [
        { value: "aac-128k", label: "Transcode to AAC (128k)", hint: "Recommended default" },
        { value: "copy", label: "Copy (No re-encoding)" },
        { value: "aac-192k", label: "Transcode to AAC (192k)" }
      ],
      initialValue: audioDefault
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
  } else {
    // No audio stream
    audioParam = "-an";
  }

  // Prompt 5: FPS adjustment
  let fpsParam = "";
  if (mediaInfo.video) {
    const autoDown = mediaInfo.video.fps > 30;
    if (autoDown) {
      note(
        `Original video is ${mediaInfo.video.fps} fps (> 30). Defaulting to 30 fps to reduce file size.\nYou can also keep the original frame rate below.`,
        "FPS Adjustment"
      );
    }
    const fpsOptions = [
      { value: "keep", label: "Keep Original", hint: `${mediaInfo.video.fps} fps` },
      { value: "30", label: "30 fps", hint: "Standard, widely compatible" },
      { value: "24", label: "24 fps", hint: "Cinematic" },
      { value: "custom", label: "Custom", hint: "Enter manually" },
    ];
    const fpsChoice = await select({
      message: "Select target frame rate:",
      options: fpsOptions,
      initialValue: autoDown ? "30" : "keep",
    });
    if (isCancel(fpsChoice)) { cancel("Operation cancelled."); process.exit(0); }

    if (fpsChoice === "custom") {
      const customFps = await text({
        message: "Enter custom frame rate (e.g. 30, 60, or a fraction like 30000/1001):",
        placeholder: autoDown ? "30" : String(mediaInfo.video.fps),
        validate(v) {
          if (!v.trim()) return "Please enter a frame rate value";
          const n = parseFloat(v);
          if (isNaN(n) || n <= 0) return "Please enter a valid positive number";
        }
      });
      if (isCancel(customFps)) { cancel("Operation cancelled."); process.exit(0); }
      fpsParam = customFps;
    } else if (fpsChoice !== "keep") {
      fpsParam = fpsChoice;
    }
  }

  // 6. Build FFmpeg command parameters
  const args: string[] = ["ffmpeg"];

  // NVIDIA AV1: prepend hardware acceleration
  if (codecChoice === "av1_nvenc") {
    args.push("-hwaccel", "cuda");
  }

  args.push("-i", `"${videoPath}"`);

  // Video codec args
  if (codecChoice === "h264") {
    args.push("-c:v", "libx264", "-preset", presetChoice, "-crf", finalQuality);
  } else if (codecChoice === "av1_nvenc") {
    args.push("-c:v", "av1_nvenc", "-preset", presetChoice, "-cq:v", finalQuality, "-tune", "hq", "-b:v", "0");
  } else {
    // av1_cpu — always use libsvtav1
    args.push("-c:v", "libsvtav1", "-preset", presetChoice, "-crf", finalQuality);
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

  // FPS adjustment
  if (fpsParam) {
    args.push("-r", fpsParam);
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
