# fvthlp · FFmpeg Video Transform Helper

[![Bun](https://img.shields.io/badge/Bun-≥1.0-000?logo=bun)](https://bun.sh)

**fvthlp** 是一个基于 Bun.js 构建的命令行交互工具，帮助你快速生成经过优化的 FFmpeg 转码命令。只需提供一个视频文件路径，通过交互式问答即可配置分辨率、编码器、质量等参数，**不会直接执行转码**，而是输出一条完整的 `ffmpeg` 命令行供你复制使用。

## 特性

- **交互式引导** — 基于 `@clack/prompts` 的现代化 CLI 交互，步骤清晰
- **智能参数推荐** — 根据分辨率自动推荐 CRF/CQ 默认值，音频码率自动判断是否可 copy
- **自适应分辨率缩放** — 自动识别横屏/竖屏，等比例缩放至目标分辨率
- **多编码器支持** — H.264 (`libx264`)、NVIDIA AV1 (`av1_nvenc`)、CPU AV1 (`libsvtav1`)
- **帧率自动优化** — 高帧率（>30fps）自动降至 30fps，平衡体积与兼容性
- **零依赖注入** — 直接调用系统 `ffmpeg`/`ffprobe`，无多余包装库

## 安装

### 前置条件

- [Bun](https://bun.sh) ≥ 1.0
- [FFmpeg](https://ffmpeg.org)（包含 `ffprobe`），需在 PATH 中可用

### 安装方式

```bash
bun install -g github:qiyon/fvthlp
```

安装后即可全局使用 `fvthlp` 命令。

## 使用

```bash
fvthlp <video_file>
```

### 示例

```bash
fvthlp ./input.mp4
```

工具会依次引导你完成以下配置：

1. **选择目标分辨率** — Keep Original / 1080P / 720P / 480P
2. **选择视频编码器** — H.264 (libx264) / NVIDIA AV1 (av1_nvenc) / CPU AV1 (libsvtav1)
3. **选择编码预设** — 根据编码器提供对应的 preset 选项
4. **选择质量因子** — CRF（libx264/libsvtav1）或 CQ（av1_nvenc）
5. **选择音频转码策略** — AAC 128k / AAC 192k / Copy

最终生成类似如下的 FFmpeg 命令：

```bash
ffmpeg -i input.mp4 -c:v libx264 -preset medium -crf 22 -vf "scale=-2:720" -r 30 -c:a aac -b:a 128k 2606181741_abyx.mp4
```

## 工作原理

```text
输入视频 → ffprobe 解析元数据 → 交互式问答配置参数
                                      ↓
                             输出 FFmpeg 命令行
```

工具仅输出转码命令，**不会实际执行转码**。你可以检查命令无误后再手动执行。

## 项目结构

```text
fvthlp/
├── package.json          # 项目依赖管理
├── doc/
│   └── design.md         # 技术方案设计文档
└── src/
    ├── index.ts          # 入口文件 (主流程)
    ├── ffprobe.ts        # ffprobe 视频元数据解析
    └── utils.ts          # 辅助函数
```


