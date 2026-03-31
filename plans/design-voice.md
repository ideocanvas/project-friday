# Voice Skill Design (STT/TTS)

## Overview

The Voice skill handles voice-to-text (STT) and text-to-voice (TTS) conversion using MLX-Audio optimized for Apple Silicon (M-series chips). This enables Friday to understand voice messages and respond with audio.

## Type

- **Built-in Skill** (Python + MLX)
- **Language:** Python (executed via `child_process.spawn`)
- **PM2 Integration:** Runs via Scheduler or Gateway

---

## Core Responsibilities

### STT (Speech-to-Text)

1. **Receive** - Get audio file path (WhatsApp voice note)
2. **Convert** - Transcribe using MLX Whisper
3. **Return** - Send text to LLM for processing

### TTS (Text-to-Speech)

1. **Receive** - Get text from LLM response
2. **Generate** - Convert to audio using MLX TTS
3. **Send** - Return audio file path for WhatsApp sending

---

## Directory Structure

```
/skills/builtin/
├── voice/
│   ├── index.py             # Main skill entry point
│   ├── stt.py              # Speech-to-Text (MLX Whisper)
│   ├── tts.py              # Text-to-Speech (MLX TTS)
│   └── models.py           # Model loading & caching
├── temp/                    # Temporary audio files
│   └── voice/              # Incoming voice notes
└── output/                  # Generated audio files
    └── tts/                # TTS output
```

---

## MLX-Audio Setup

### Requirements

- macOS with Apple Silicon (M1/M2/M3/M4)
- Python 3.10+
- Conda environment: `friday-skills`

### Installation

```bash
# Create conda environment
conda create -n friday-skills python=3.11
conda activate friday-skills

# Install MLX (requires macOS)
pip install mlx-audio

# Verify Metal acceleration
python -c "import mlx.core as mlx; print(mlx.metal.is_available())"
```

### Models (STT)

| Model                | Size   | Speed   | Accuracy |
| -------------------- | ------ | ------- | -------- |
| `mlx-whisper-base`   | 74MB   | Fastest | Good     |
| `mlx-whisper-small`  | 244MB  | Fast    | Better   |
| `mlx-whisper-medium` | 769MB  | Medium  | Best     |
| `mlx-whisper-large`  | 1550MB | Slow    | Best     |

**Recommended:** `mlx-whisper-small` for balance of speed/accuracy

### Models (TTS)

| Model         | Quality                |
| ------------- | ---------------------- |
| `qwen2.5-tts` | Good (recommended)     |
| `ming-omni`   | Better (multi-lingual) |

**Recommended:** `qwen2.5-tts` for English/Chinese

---

## Available Actions

### 1. transcribe(audio_path)

Convert voice note to text.

```python
# Input: /temp/voice/abc123.ogg
# Output: "What's the gold price today?"

result = await voice.transcribe('/temp/voice/abc123.ogg')
# Returns: { "text": "...", "language": "en", "duration": 3.2 }
```

### 2. speak(text, voice = 'af_sarah')

Convert text to speech.

```python
# Input: "Your gold alert: $1950 (+1.2%)"
# Output: /output/tts/xyz789.mp3

result = await voice.speak("Your gold alert: $1950 (+1.2%)")
# Returns: { "audio_path": "...", "duration": 2.5 }
```

### 3. voices()

List available TTS voices.

```python
voices = await voice.voices()
# Returns: ["af_sarah", "af_allison", "am_michael", ...]
```

---

## Skill Registration

```json
// /skills/registry.json
{
  "voice": {
    "name": "Voice (STT/TTS)",
    "version": "1.0.0",
    "description": "Convert voice to text (STT) and text to voice (TTS) using MLX-Audio",
    "file": "/skills/builtin/voice/index.py",
    "parameters": {
      "action": {
        "type": "string",
        "enum": ["transcribe", "speak", "voices"],
        "required": true
      },
      "audio_path": { "type": "string" },
      "text": { "type": "string" },
      "voice": { "type": "string" }
    }
  }
}
```

---

## WhatsApp Voice Message Flow

```
User sends voice note on WhatsApp
         │
         ▼
┌─────────────────┐
│ gateway.js     │
│ receives audio │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ Download audio │ ─── WhatsApp voice is .ogg format
│ to temp folder │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ Call voice      │ ─── skill: voice, action: transcribe
│ skill (STT)    │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ MLX Whisper     │ ─── Uses Mac GPU/NPU
│ transcribes    │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ Return text to  │
│ LLM for reply  │
└────────┬────────┘
         │
         ▼
    ... normal flow ...
```

---

## WhatsApp TTS Response Flow

```
LLM returns text response
         │
         ▼
┌─────────────────┐
│ LLM decides to  │ ─── "Send as voice" or user requests voice
│ use TTS        │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ Call voice      │ ─── skill: voice, action: speak
│ skill (TTS)    │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ MLX TTS        │ ─── Uses Mac GPU/NPU
│ generates MP3  │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ Write to queue │
│ for gateway    │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ Gateway sends  │ ─── Send audio via WhatsApp
│ audio message  │
```

---

## Audio Format Handling

| Input                 | Output            | Notes               |
| --------------------- | ----------------- | ------------------- |
| WhatsApp voice (.ogg) | .wav for Whisper  | Convert first       |
| TTS output (.wav)     | .mp3 for WhatsApp | Convert with ffmpeg |

### Conversion Script

```python
import subprocess

def convert_ogg_to_wav(input_path, output_path):
    subprocess.run([
        'ffmpeg', '-i', input_path,
        '-acodec', 'pcm_s16le', '-ar', '16000',
        output_path
    ])

def convert_wav_to_mp3(input_path, output_path):
    subprocess.run([
        'ffmpeg', '-i', input_path,
        '-codec:a', 'libmp3lame', '-q:a', '2',
        output_path
    ])
```

---

## Error Handling

| Scenario                    | Handling                             |
| --------------------------- | ------------------------------------ |
| No MLX installed            | Return error: "Voice not available"  |
| Audio file corrupted        | Return error: "Cannot read audio"    |
| Model load failure          | Return error: "Model failed to load" |
| Transcription timeout (30s) | Return partial result or error       |
| No Metal acceleration       | Fallback to CPU (slower)             |

---

## Performance Notes

- **First run:** Model loads to GPU (2-5 seconds)
- **Subsequent runs:** Instant (model stays in memory)
- **Memory:** ~2GB VRAM for Whisper-small + TTS
- **Speed:** Real-time or faster on M-series

---

## Configuration (.env)

```env
# Voice
STT_MODEL=mlx-whisper-small
TTS_MODEL=qwen2.5-tts
TTS_VOICE=af_sarah
TEMP_VOICE_PATH=/temp/voice
OUTPUT_TTS_PATH=/output/tts
```
