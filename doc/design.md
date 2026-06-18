# fvthlp (FFmpeg Video Transform Helper) 技术方案设计文档

`fvthlp` 是一个基于 **Bun.js** 构建的命令行辅助工具，旨在为用户提供快速、便捷的视频转码参数配置体验。它接收一个视频文件路径作为输入，通过交互式命令行界面（CLI）引导用户配置转码参数（分辨率、视频 preset、CRF、音频转码等），并最终生成一条经过优化的 `ffmpeg` 命令行，供用户直接复制执行。

---

## 1. 技术栈与第三方库选型

为了保证命令行工具的高性能、低延迟、现代化交互体验，我们对关键环节的库进行如下选型推荐：

### 1.1 运行时环境 (Runtime)
* **选型**：**Bun.js**
* **理由**：
  * **极速启动**：Bun 的启动速度远快于 Node.js，非常适合 CLI 工具。
  * **开箱即用**：原生支持 TypeScript，无需配置 `tsconfig.json` 或构建步骤即可直接运行。
  * **高效的子进程 API**：`Bun.$` 或 `Bun.spawn` 提供了现代、类型安全且高效的子进程执行方式，便于调用 `ffmpeg` 和 `ffprobe`。

### 1.2 终端交互库 (Terminal Interactive Library)
我们评估了以下几个流行的终端交互库：

| 库名称 | 界面美观度 | Bun.js 兼容性 | 推荐指数 | 特点 |
| :--- | :--- | :--- | :--- | :--- |
| **`@clack/prompts`** | **优秀 (极佳)** | **良好** | ⭐⭐⭐⭐⭐ **(推荐)** | 现代化的界面设计，漂亮的边框线条和微交互，体积小，无遗留包袱。非常适合现代 CLI 工具（如 Vite, Astro 的初始化脚手架）。 |
| **`inquirer`** | 良好 | 良好 | ⭐⭐⭐⭐ | 行业标准，功能极度丰富，但包体积较大，新版本 ESM 配置有时略显繁琐。 |
| **`prompts`** | 一般 | 良好 | ⭐⭐⭐ | 轻量级，但已基本停止维护。 |

> **推荐使用 `@clack/prompts`**。它的输出版式简洁高级，原生支持 spinners、文本输入、选择菜单等，非常符合现代终端美学。

### 1.3 核心依赖与调用方式
本工具**不推荐**使用 `fluent-ffmpeg` 等臃肿的 Node 包装库，而是直接使用 **Bun 原生子进程** 配合 FFmpeg 原生命令行：
1. **依赖检测**：利用系统的 `which ffmpeg` (macOS/Linux) 或直接尝试执行 `ffmpeg -version` 检测是否安装。
2. **信息读取**：通过 `ffprobe -v error -show_format -show_streams -print_format json <input_file>` 运行，将输出的 JSON 直接解析为 JavaScript 对象。这样能够百分之百保留 FFmpeg 的原始元数据，且无多余依赖。

---

## 2. 核心工作流程与逻辑设计

```mermaid
graph TD
    A[启动脚本并解析参数] --> B{参数中是否有视频文件?}
    B -- 无 --> C[打印使用帮助并终止]
    B -- 有 --> D{系统是否存在 ffmpeg/ffprobe?}
    D -- 否 --> E[提示未安装并终止]
    D -- 是 --> F[执行 ffprobe 获取视频/音频元数据]
    F --> G[打印简要的音视频元数据信息]
    G --> H[交互 1: 选择目标分辨率]
    H --> I[交互 2: 选择 x264 Preset]
    I --> J[交互 3: 选择转码 CRF 值]
    J --> K[交互 4: 决定音频转码策略]
    K --> L[生成随机构建的目标输出文件名]
    L --> M[拼装并输出最终 ffmpeg 命令行]
```

### 2.1 依赖环境检查
脚本在执行首个步骤时，需在 PATH 中定位 `ffmpeg` 和 `ffprobe`。
```typescript
import { $ } from "bun";

async function checkFFmpeg() {
  try {
    await $`ffmpeg -version`.quiet();
    await $`ffprobe -version`.quiet();
    return true;
  } catch (e) {
    return false;
  }
}
```
*如果检测失败，输出错误提示并调用 `process.exit(1)`。*

### 2.2 视频信息提取与展示
使用 `ffprobe` 获取媒体元数据。我们可以通过解析 stdout 的 JSON 来快速获取核心信息：
* **视频流信息** (`codec_name`, `width`, `height`, `pix_fmt`)
* **音频流信息** (`codec_name`, `bit_rate`, `sample_rate`, `channels`)
* **简要展示面板效果示例**：
  ```bash
  ┌  fvthlp - 视频信息
  │  文件: input.mp4 (45.2 MB)
  │  视频: h264 | 1920x1080 | 23.97 fps
  │  音频: aac | 128 kbps | 2 ch
  └
  ```

### 2.3 交互参数配置设计

#### 1) 视频分辨率 (Resolution)
* **选项**：
  * `Keep Original` (默认，不调整)
  * `1080P`
  * `720P`
  * `480P`
* **计算与转码规则（自适应移动端竖屏/横屏）**：
  为了确保视频比例不失真且兼容移动端录制的竖屏（Portrait）或横屏（Landscape）视频，工具应动态推导长宽，**保证转换后视频的“窄边”为所选的分辨率值（480, 720, 1080）**，而“宽边”等比例缩放（向下取整为 2 的倍数以符合 x264 规范）：
  * **原视频为竖屏或正方形 ($W \le H$)**：宽度 $W$ 为窄边。将宽度固定为目标分辨率 $T$，高度自适应。
    * **FFmpeg 参数**：`-vf "scale=T:-2"` (例如选择 720P 时，参数为 `-vf "scale=720:-2"`)
  * **原视频为横屏 ($W > H$)**：高度 $H$ 为窄边。将高度固定为目标分辨率 $T$，宽度自适应。
    * **FFmpeg 参数**：`-vf "scale=-2:T"` (例如选择 720P 时，参数为 `-vf "scale=-2:720"`)

#### 2) x264 Preset (编码预设速度)
* **选项**：`ultrafast`, `superfast`, `veryfast`, `faster`, `fast`, `medium` (默认选中), `slow`, `slower`, `veryslow`。
* **核心规则**：CLI 交互中默认将光标定位在 `medium` 上。
* **FFmpeg 参数映射**：`-preset <selected_preset>`。

#### 3) CRF 选取 (质量因子)
* **设计**：提供一组常用推荐值（或允许用户自定义输入 0-51 之间的数字）。为了在保证基本画质的同时使文件体积尽量小，**工具会根据第 1 步所选择的分辨率，动态设定默认的 CRF 推荐值**：
  * 若选择 **Keep Original** 或 **1080P**：默认选中 **`23`**（标准/主流平衡）。
  * 若选择 **720P**：默认选中 **`22`**（稍微调低 CRF 以维持中等分辨率的画质细节）。
  * 若选择 **480P**：默认选中 **`20`**（低分辨率下更低的 CRF 能够有效防止严重的马赛克与色块）。
* **选项列表**：
  * `18` (高画质，文件较大)
  * `20` (480P 推荐)
  * `22` (720P 推荐)
  * `23` (1080P/原画 推荐)
  * `26` (较低画质，超小体积)
  * `自定义` (用户手动输入)
* **FFmpeg 参数映射**：`-crf <crf_value>`。

#### 4) 音频转码策略 (Audio Transcode)
* **核心规则**：
  * 若原音频编码为 `aac` **且** 码率 `< 150 kbps`，则**自动选择** `copy`（参数：`-c:a copy`，无损复制，不重新编码，并跳过或在提示中指出已自动选取 copy）。
  * 若**不满足**上述条件（例如音频不是 `aac`，或者虽然是 `aac` 但码率 $\ge$ 150 kbps），则**交互式提示用户选择音频处理方式，并默认选中/推荐 `Transcode to AAC (128k)`**。
* **选项**：
  * `Transcode to AAC (128k)` (默认勾选/推荐，参数：`-c:a aac -b:a 128k`)
  * `Copy` (参数：`-c:a copy`)
  * `Transcode to AAC (192k)` (参数：`-c:a aac -b:a 192k`)

#### 5) 帧率调整策略 (FPS Adjustment)
* **核心规则**：
  * **原视频帧率 $\le 30$ fps**：自动保持不变，在生成的 `ffmpeg` 转码指令中**不指定** `-r` 参数。
  * **原视频帧率 $> 30$ fps**（如 60 fps）：为减小体积并提升全终端兼容性，**自动将其降低至 30 fps**，在生成的转码指令中增加 `-r 30` 参数。

### 2.4 输出文件名生成算法
文件名要求使用：`当前分钟时间 (yyMMddHHmm) + 4位随机字符` 组合。
* **当前分钟时间生成**：
  ```typescript
  // 原生实现举例：
  const now = new Date();
  const yy = String(now.getFullYear()).slice(-2);
  const MM = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  const HH = String(now.getHours()).padStart(2, '0');
  const mm = String(now.getMinutes()).padStart(2, '0');
  const timeStr = `${yy}${MM}${dd}${HH}${mm}`;
  ```
* **4位随机字符**：
  ```typescript
  const chars = "abcdefghijklmnopqrstuvwxyz";
  const randomStr = Array.from({ length: 4 }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
  ```
* **完整输出文件名示例**：`2606181741_abyx.mp4`。

---

## 3. 生成的 FFmpeg 命令行规范

脚本根据用户的选择拼装参数，最终拼装出的命令行样例如下：

* **原视频为横屏（如 1920x1080），转码为 720P，原视频帧率 60 fps，音频不满足 copy 条件需转码：**
  ```bash
  ffmpeg -i input.mp4 -c:v libx264 -preset medium -crf 22 -vf "scale=-2:720" -r 30 -c:a aac -b:a 128k 2606181741_abyx.mp4
  ```

* **原视频为移动端竖屏（如 1080x1920），转码为 720P，原视频帧率 25 fps，音频自动 copy：**
  ```bash
  ffmpeg -i input.mp4 -c:v libx264 -preset medium -crf 22 -vf "scale=720:-2" -c:a copy 2606181741_abyx.mp4
  ```

* **原视频帧率 24 fps（帧率 $\le 30$ 不指定 `-r`，原分辨率保持不变），音频转码为 128k：**
  ```bash
  ffmpeg -i input.mp4 -c:v libx264 -preset fast -crf 23 -c:a aac -b:a 128k 2606181741_abyx.mp4
  ```

> **注意**：转码的视频编码固定使用 `libx264`，音频重编码使用 `aac`。

---

## 4. 目录结构设计

项目初始化后的标准目录结构如下：

```text
fvthlp/
├── package.json         # 项目依赖管理
├── bun.lockb            # Bun 锁文件
├── doc/
│   └── design.md        # 技术方案设计文档 (本文档)
└── src/
    ├── index.ts         # 入口文件 (命令行解析与交互主流程)
    ├── ffprobe.ts       # 负责封装 ffprobe 音视频流信息解析
    └── utils.ts         # 辅助函数 (时间格式化、随机字符生成、参数校验)
```

---

## 5. 开发路线图 (Roadmap)

1. **Step 1**: 初始化 `package.json` 并安装 `@clack/prompts`。
2. **Step 2**: 编写 `src/utils.ts` 实现依赖项检测、时间戳生成及随机字符生成。
3. **Step 3**: 编写 `src/ffprobe.ts` 实现获取视频格式、分辨率、音频流码率等解析。
4. **Step 4**: 编写 `src/index.ts`，基于 `@clack/prompts` 搭建问答交互流，并计算出 FFmpeg 拼接指令输出。
5. **Step 5**: 在本地测试各种参数输入，确认输出文件名及 ffmpeg 转码参数拼装完全无误。
