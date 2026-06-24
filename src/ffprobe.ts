import { $ } from "bun";

export interface MediaInfo {
  filename: string;
  duration: number; // in seconds
  size: number; // in bytes
  video: {
    codec: string;
    width: number;
    height: number;
    fps: number;
    bitrateKbps: number | null; // in kbps
  } | null;
  audio: {
    codec: string;
    bitrateKbps: number | null; // in kbps
    channels: number;
    sampleRate: number;
  } | null;
}

export async function getMediaInfo(filePath: string): Promise<MediaInfo> {
  const result = await $`ffprobe -v error -show_format -show_streams -print_format json ${filePath}`.text();
  const data = JSON.parse(result);

  const duration = parseFloat(data.format?.duration || "0");
  const size = parseInt(data.format?.size || "0", 10);
  const filename = data.format?.filename || filePath;

  let videoInfo = null;
  let audioInfo = null;

  if (Array.isArray(data.streams)) {
    const videoStream = data.streams.find((s: any) => s.codec_type === "video");
    const audioStream = data.streams.find((s: any) => s.codec_type === "audio");

    if (videoStream) {
      let fps = 0;
      if (videoStream.r_frame_rate) {
        const parts = videoStream.r_frame_rate.split("/");
        if (parts.length === 2) {
          const num = parseFloat(parts[0]);
          const den = parseFloat(parts[1]);
          if (den !== 0) fps = num / den;
        } else {
          fps = parseFloat(videoStream.r_frame_rate);
        }
      }
      
      // rounding to 2 decimal places
      fps = Math.round(fps * 100) / 100;

      let bitrateKbps = null;
      if (videoStream.bit_rate) {
        bitrateKbps = Math.round(parseInt(videoStream.bit_rate, 10) / 1000);
      } else if (data.format && data.format.bit_rate) {
        const formatBitrate = parseInt(data.format.bit_rate, 10);
        let audioBitrate = 0;
        if (audioStream && audioStream.bit_rate) {
          audioBitrate = parseInt(audioStream.bit_rate, 10);
        }
        bitrateKbps = Math.max(0, Math.round((formatBitrate - audioBitrate) / 1000));
      }

      videoInfo = {
        codec: videoStream.codec_name || "unknown",
        width: parseInt(videoStream.width || "0", 10),
        height: parseInt(videoStream.height || "0", 10),
        fps,
        bitrateKbps,
      };
    }

    if (audioStream) {
      let bitrateKbps = null;
      if (audioStream.bit_rate) {
        bitrateKbps = Math.round(parseInt(audioStream.bit_rate, 10) / 1000);
      }

      audioInfo = {
        codec: audioStream.codec_name || "unknown",
        bitrateKbps,
        channels: parseInt(audioStream.channels || "0", 10),
        sampleRate: parseInt(audioStream.sample_rate || "0", 10),
      };
    }
  }

  return {
    filename,
    duration,
    size,
    video: videoInfo,
    audio: audioInfo,
  };
}
