#!/usr/bin/env python3
"""
Voice Skill - Built-in Skill for Friday

Provides Speech-to-Text (STT) and Text-to-Speech (TTS) capabilities using MLX-Audio.
Optimized for Apple Silicon (M-series chips) with Metal acceleration.

Based on: plan/design-voice.md and plan/ref/app.py
"""

import sys
import os
import json
from typing import Optional, Dict, Any

# Add parent directory to path for imports
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

# === CONFIGURATION ===
SKILL_NAME = "voice"
VERSION = "1.0.0"

# Environment variables
STT_MODEL = os.environ.get("STT_MODEL", "mlx-community/whisper-small-mlx")
TTS_MODEL = os.environ.get("TTS_MODEL", "mlx-community/Qwen3-TTS-12Hz-0.6B-Base-bf16")
TTS_VOICE = os.environ.get("TTS_VOICE", "af_heart")
TTS_LANG_CODE = os.environ.get(
    "TTS_LANG_CODE", "en"
)  # 'en' for English, 'zh' for Chinese
TEMP_VOICE_PATH = os.environ.get("TEMP_VOICE_PATH", "/tmp/friday/voice")
OUTPUT_TTS_PATH = os.environ.get("OUTPUT_TTS_PATH", "/tmp/friday/tts")

# Ensure directories exist
os.makedirs(TEMP_VOICE_PATH, exist_ok=True)
os.makedirs(OUTPUT_TTS_PATH, exist_ok=True)


# === SKILL PARAMETERS ===
PARAMETERS = {
    "action": {
        "type": "string",
        "enum": ["transcribe", "speak", "voices", "status"],
        "required": True,
        "description": "Action to perform",
    },
    "audio_path": {
        "type": "string",
        "required": False,
        "description": "Path to audio file (required for transcribe action)",
    },
    "text": {
        "type": "string",
        "required": False,
        "description": "Text to convert to speech (required for speak action)",
    },
    "voice": {
        "type": "string",
        "required": False,
        "default": TTS_VOICE,
        "description": "Voice to use for TTS",
    },
    "lang_code": {
        "type": "string",
        "required": False,
        "default": TTS_LANG_CODE,
        "description": "Language code: 'a' for American English, 'z' for Chinese",
    },
    "model": {
        "type": "string",
        "required": False,
        "default": None,
        "description": "Override model (STT or TTS depending on action)",
    },
    "smart_split": {
        "type": "boolean",
        "required": False,
        "default": False,
        "description": "Use smart splitting for long audio (STT only)",
    },
}


def check_dependencies() -> Dict[str, Any]:
    """Check if all required dependencies are available."""
    result = {
        "mlx_available": False,
        "mlx_whisper_available": False,
        "mlx_audio_available": False,
        "metal_available": False,
        "ffmpeg_available": False,
        "stt_model": STT_MODEL,
        "tts_model": TTS_MODEL,
        "default_voice": TTS_VOICE,
        "lang_code": TTS_LANG_CODE,
    }

    # Check MLX
    try:
        import mlx.core as mlx

        result["mlx_available"] = True
        result["metal_available"] = mlx.metal.is_available()
    except ImportError:
        pass

    # Check mlx_whisper (for STT)
    try:
        import mlx_whisper

        result["mlx_whisper_available"] = True
    except ImportError:
        pass

    # Check mlx_audio (for TTS)
    try:
        from mlx_audio.tts.generate import generate_audio

        result["mlx_audio_available"] = True
    except ImportError:
        pass

    # Check ffmpeg
    try:
        import subprocess

        subprocess.run(["ffmpeg", "-version"], capture_output=True, timeout=5)
        result["ffmpeg_available"] = True
    except Exception:
        pass

    return result


def transcribe_audio(
    audio_path: str, model: str = None, smart_split: bool = False
) -> Dict[str, Any]:
    """
    Transcribe audio file to text using mlx_whisper.

    Args:
        audio_path: Path to audio file (supports .ogg, .wav, .mp3, .m4a)
        model: Optional model override
        smart_split: Use smart splitting for long audio

    Returns:
        dict with success, message, and data
    """
    from stt import WhisperTranscriber, AudioConverter

    model_name = model or STT_MODEL

    # Check if file exists
    if not os.path.exists(audio_path):
        return {
            "success": False,
            "message": f"❌ Audio file not found: {audio_path}",
            "data": {"error": "file_not_found", "path": audio_path},
        }

    # Check dependencies
    deps = check_dependencies()
    if not deps["mlx_whisper_available"]:
        return {
            "success": False,
            "message": "❌ mlx_whisper is not installed. Install with: pip install mlx-whisper",
            "data": {"error": "mlx_whisper_not_installed", "status": deps},
        }

    # Use smart split if requested
    if smart_split:
        result = WhisperTranscriber.transcribe_smart(audio_path, model_name)
    else:
        result = WhisperTranscriber.transcribe(audio_path, model_name)

    if result.get("success"):
        return {
            "success": True,
            "message": f'✅ Transcribed: "{result["text"]}"',
            "data": result,
        }
    else:
        return {
            "success": False,
            "message": f"❌ Transcription failed: {result.get('message', 'Unknown error')}",
            "data": result,
        }


def speak_text(
    text: str, voice: str = None, lang_code: str = None, model: str = None
) -> Dict[str, Any]:
    """
    Convert text to speech using mlx_audio TTS.

    Args:
        text: Text to convert to speech
        voice: Voice to use for TTS
        lang_code: Language code ('a' for English, 'z' for Chinese)
        model: Optional model override

    Returns:
        dict with success, message, and data (including audio_path)
    """
    from tts import TTSEngine

    voice_name = voice or TTS_VOICE
    lang = lang_code or TTS_LANG_CODE
    model_name = model or TTS_MODEL

    if not text:
        return {
            "success": False,
            "message": "❌ No text provided for TTS",
            "data": {"error": "no_text"},
        }

    # Check dependencies
    deps = check_dependencies()
    if not deps["mlx_audio_available"]:
        return {
            "success": False,
            "message": "❌ mlx_audio is not installed. Install with: pip install mlx-audio",
            "data": {"error": "mlx_audio_not_installed", "status": deps},
        }

    # Generate speech
    result = TTSEngine.generate(
        text=text, voice=voice_name, model=model_name, lang_code=lang
    )

    if result.get("success"):
        return {
            "success": True,
            "message": f"✅ Generated speech: {len(text)} characters ({result.get('duration', 0):.1f}s)",
            "data": result,
        }
    else:
        return {
            "success": False,
            "message": f"❌ TTS failed: {result.get('message', 'Unknown error')}",
            "data": result,
        }


def list_voices(model: str = None) -> Dict[str, Any]:
    """
    List available TTS voices.

    Args:
        model: Optional model name

    Returns:
        dict with success, message, and data (including voices list)
    """
    from tts import TTSEngine

    model_name = model or TTS_MODEL
    voices = TTSEngine.get_available_voices(model_name)

    return {
        "success": True,
        "message": f"✅ Available voices: {', '.join(voices)}",
        "data": {"voices": voices, "default": TTS_VOICE, "model": model_name},
    }


def validate_params(params: dict) -> tuple:
    """Validate input parameters."""
    action = params.get("action")

    if not action:
        return False, "Missing required parameter: action"

    valid_actions = ["transcribe", "speak", "voices", "status"]
    if action not in valid_actions:
        return (
            False,
            f"Invalid action: {action}. Must be one of: {', '.join(valid_actions)}",
        )

    # transcribe requires audio_path
    if action == "transcribe" and not params.get("audio_path"):
        return False, "Missing required parameter: audio_path (required for transcribe)"

    # speak requires text
    if action == "speak" and not params.get("text"):
        return False, "Missing required parameter: text (required for speak)"

    return True, None


def logic(params: dict, user_id: str) -> dict:
    """
    Main skill logic - handle voice operations.

    Args:
        params: Dictionary of parameters from user
        user_id: User's phone number

    Returns:
        dict with keys:
        - success: bool
        - message: str (for WhatsApp)
        - data: dict (optional)
    """
    action = params.get("action", "status")

    if action == "status":
        status = check_dependencies()

        if (
            status["mlx_available"]
            and status["mlx_whisper_available"]
            and status["mlx_audio_available"]
        ):
            metal_status = (
                "✅ Metal acceleration enabled"
                if status["metal_available"]
                else "⚠️ Using CPU (slower)"
            )
            return {
                "success": True,
                "message": f"✅ Voice skill is available.\n🎤 STT Model: {STT_MODEL}\n🔊 TTS Model: {TTS_MODEL}\n🎵 Default Voice: {TTS_VOICE}\n🌐 Language: {TTS_LANG_CODE}\n{metal_status}",
                "data": status,
            }
        else:
            missing = []
            if not status["mlx_available"]:
                missing.append("MLX")
            if not status["mlx_whisper_available"]:
                missing.append("mlx-whisper")
            if not status["mlx_audio_available"]:
                missing.append("mlx-audio")

            return {
                "success": False,
                "message": f"❌ Voice skill not fully available.\n⚠️ Missing: {', '.join(missing)}\n💡 Install with: pip install mlx mlx-whisper mlx-audio",
                "data": status,
            }

    elif action == "transcribe":
        audio_path = params.get("audio_path")
        model = params.get("model")
        smart_split = params.get("smart_split", False)
        return transcribe_audio(audio_path, model=model, smart_split=smart_split)

    elif action == "speak":
        text = params.get("text")
        voice = params.get("voice", TTS_VOICE)
        lang_code = params.get("lang_code", TTS_LANG_CODE)
        model = params.get("model")
        return speak_text(text, voice=voice, lang_code=lang_code, model=model)

    elif action == "voices":
        model = params.get("model")
        return list_voices(model)

    else:
        return {
            "success": False,
            "message": f"❌ Unknown action: {action}",
            "data": {"error": "unknown_action"},
        }


def main():
    """Entry point - called by Node.js"""
    try:
        input_data = json.loads(sys.stdin.read())
    except json.JSONDecodeError as e:
        print(json.dumps({"success": False, "error": f"Invalid JSON input: {str(e)}"}))
        sys.exit(1)

    params = input_data.get("params", {})
    user_id = input_data.get("user_id", "default")

    # Validate
    valid, error = validate_params(params)
    if not valid:
        print(json.dumps({"success": False, "error": error}))
        sys.exit(1)

    # Execute
    try:
        result = logic(params, user_id)
        print(json.dumps(result))
        sys.exit(0)
    except Exception as e:
        print(json.dumps({"success": False, "error": str(e)}))
        sys.exit(1)


if __name__ == "__main__":
    main()
