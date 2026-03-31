#!/usr/bin/env python3
"""
Text-to-Speech (TTS) Module for Voice Skill

Handles text to audio conversion using MLX TTS, optimized for Apple Silicon.
Supports multiple TTS engines:
- Kokoro: Uses predefined voices (af_heart, af_sarah, etc.)
- Qwen3-TTS: Voice cloning model using reference audio

Based on: plan/ref/app.py and plan/ref/mlx.ipynb
"""

import os
import sys
import subprocess
import uuid
import tempfile
import shutil
from typing import Optional, Dict, Any, List, Tuple
from pathlib import Path

# Get the directory where this script is located
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))

# Environment configuration
# Qwen3-TTS model (voice cloning) - recommended for best quality
TTS_MODEL = os.environ.get("TTS_MODEL", "mlx-community/Qwen3-TTS-12Hz-0.6B-Base-bf16")
TTS_VOICE = os.environ.get("TTS_VOICE", "default")
TTS_LANG_CODE = os.environ.get("TTS_LANG_CODE", "zh")  # 'en' for English, 'zh' for Chinese
OUTPUT_TTS_PATH = os.environ.get("OUTPUT_TTS_PATH", "/tmp/friday/tts")
TTS_SAMPLE_RATE = int(os.environ.get("TTS_SAMPLE_RATE", "24000"))

# Reference audio for Qwen3-TTS voice cloning
# Default to the included speaker01 reference
DEFAULT_REF_AUDIO = os.path.join(SCRIPT_DIR, "references", "speaker01.wav")
DEFAULT_REF_TEXT = "是呀，他还想换个地球仪哈哈哈，看来给你积累了一些快乐值了，你还想不想再听一个其他的笑话呀？"

TTS_REF_AUDIO = os.environ.get("TTS_REF_AUDIO", DEFAULT_REF_AUDIO)
TTS_REF_TEXT = os.environ.get("TTS_REF_TEXT", DEFAULT_REF_TEXT)

# Ensure output directory exists
os.makedirs(OUTPUT_TTS_PATH, exist_ok=True)


# Default available voices for Kokoro TTS (not used for Qwen3)
KOKORO_VOICES = [
    "af_heart",    # American female (recommended)
    "af_sarah",
    "af_allison",
    "af_bella",
    "af_nicole",
    "af_sky",
    "am_michael",
    "am_adam",
    "am_gorge"
]

# Qwen3-TTS is a voice cloning model - it uses reference audio instead of predefined voices
QWEN3_MODELS = [
    "mlx-community/Qwen3-TTS-12Hz-0.6B-Base-bf16",
    "Qwen/Qwen3-4B",
    "Qwen/Qwen3-TTS",
]


def is_qwen3_model(model: str) -> bool:
    """Check if the model is a Qwen3-TTS model."""
    model_lower = model.lower()
    return "qwen3" in model_lower or "qwen" in model_lower and "tts" in model_lower


class AudioEncoder:
    """Handles audio encoding and format conversion."""
    
    @staticmethod
    def is_ffmpeg_available() -> bool:
        """Check if ffmpeg is installed."""
        try:
            subprocess.run(
                ['ffmpeg', '-version'],
                capture_output=True,
                timeout=5
            )
            return True
        except (FileNotFoundError, subprocess.TimeoutExpired):
            return False
    
    @staticmethod
    def wav_to_mp3(wav_path: str, mp3_path: str, quality: int = 2) -> Tuple[bool, str]:
        """
        Convert WAV to MP3 format.
        
        Args:
            wav_path: Path to WAV file
            mp3_path: Output MP3 path
            quality: MP3 quality (0-9, lower is better)
            
        Returns:
            Tuple of (success, output_path or error_message)
        """
        try:
            result = subprocess.run([
                'ffmpeg', '-y', '-i', wav_path,
                '-codec:a', 'libmp3lame',
                '-q:a', str(quality),
                mp3_path
            ], capture_output=True, text=True, timeout=60)
            
            if result.returncode != 0:
                return False, f"ffmpeg error: {result.stderr}"
            
            return True, mp3_path
            
        except subprocess.TimeoutExpired:
            return False, "MP3 conversion timed out"
        except FileNotFoundError:
            return False, "ffmpeg not found"
        except Exception as e:
            return False, f"Conversion error: {str(e)}"
    
    @staticmethod
    def get_duration(file_path: str) -> float:
        """Get audio duration in seconds."""
        try:
            result = subprocess.run([
                'ffprobe', '-v', 'error',
                '-show_entries', 'format=duration',
                '-of', 'default=noprint_wrappers=1:nokey=1',
                file_path
            ], capture_output=True, text=True, timeout=10)
            
            return float(result.stdout.strip())
        except Exception:
            return 0.0


class TTSEngine:
    """
    MLX TTS engine supporting both Kokoro and Qwen3-TTS.
    
    Optimized for Apple Silicon with Metal acceleration.
    """
    
    @classmethod
    def is_available(cls) -> Tuple[bool, str]:
        """
        Check if MLX is available.
        
        Returns:
            Tuple of (available, status_message)
        """
        try:
            import mlx.core as mlx
            if mlx.metal.is_available():
                return True, "MLX available (Metal acceleration)"
            return True, "MLX available (CPU mode)"
        except ImportError:
            return False, "MLX not installed"
    
    @classmethod
    def is_mlx_audio_available(cls) -> Tuple[bool, str]:
        """Check if MLX-Audio TTS is installed."""
        try:
            from mlx_audio.tts.generate import generate_audio
            return True, "MLX-Audio TTS installed"
        except ImportError:
            return False, "MLX-Audio TTS not installed. Install with: pip install mlx-audio"
    
    @classmethod
    def get_available_voices(cls, model: str = TTS_MODEL) -> List[str]:
        """
        Get list of available voices for a model.
        
        Args:
            model: TTS model name
            
        Returns:
            List of voice names (or reference audio paths for Qwen3)
        """
        if is_qwen3_model(model):
            # Qwen3 uses reference audio for voice cloning
            # Return available reference files
            ref_dir = os.path.join(SCRIPT_DIR, "references")
            if os.path.exists(ref_dir):
                wav_files = [f for f in os.listdir(ref_dir) if f.endswith('.wav')]
                return wav_files
            return ["speaker01.wav"]  # Default reference
        else:
            # Kokoro uses predefined voices
            return KOKORO_VOICES
    
    @classmethod
    def generate(
        cls,
        text: str,
        voice: str = TTS_VOICE,
        model: str = TTS_MODEL,
        lang_code: str = TTS_LANG_CODE,
        speed: float = 1.0,
        output_path: Optional[str] = None,
        ref_audio: Optional[str] = None,
        ref_text: Optional[str] = None
    ) -> Dict[str, Any]:
        """
        Generate speech from text using MLX TTS.
        
        For Qwen3-TTS: Uses reference audio for voice cloning
        For Kokoro: Uses predefined voice names
        
        Args:
            text: Text to convert to speech
            voice: Voice to use (Kokoro) or "default" (Qwen3)
            model: TTS model name (HuggingFace repo)
            lang_code: Language code ('en' for English, 'zh' for Chinese)
            speed: Speech speed multiplier
            output_path: Output file path (auto-generated if None)
            ref_audio: Reference audio path for Qwen3-TTS voice cloning
            ref_text: Reference text corresponding to the reference audio
            
        Returns:
            dict with audio_path, duration, model, etc.
        """
        if not text or not text.strip():
            return {
                "success": False,
                "error": "empty_text",
                "message": "No text provided for TTS"
            }
        
        # Create temp directory for output
        tmp_dir = tempfile.mkdtemp()
        file_prefix = os.path.join(tmp_dir, "audio")
        expected_output = file_prefix + ".wav"
        
        try:
            # Import MLX-Audio TTS
            from mlx_audio.tts.generate import generate_audio
            
            # Check if this is a Qwen3 model
            use_qwen3 = is_qwen3_model(model)
            
            if use_qwen3:
                # Qwen3-TTS: Use reference audio for voice cloning
                actual_ref_audio = ref_audio or TTS_REF_AUDIO
                actual_ref_text = ref_text or TTS_REF_TEXT
                
                # Validate reference audio exists
                if not os.path.exists(actual_ref_audio):
                    # Try to find in references directory
                    ref_in_dir = os.path.join(SCRIPT_DIR, "references", os.path.basename(actual_ref_audio))
                    if os.path.exists(ref_in_dir):
                        actual_ref_audio = ref_in_dir
                    else:
                        # Fall back to default reference
                        actual_ref_audio = DEFAULT_REF_AUDIO
                        actual_ref_text = DEFAULT_REF_TEXT
                
                # Read reference text from file if needed
                if actual_ref_text.endswith('.txt'):
                    txt_path = os.path.join(SCRIPT_DIR, "references", actual_ref_text) if not os.path.isabs(actual_ref_text) else actual_ref_text
                    if os.path.exists(txt_path):
                        with open(txt_path, 'r', encoding='utf-8') as f:
                            actual_ref_text = f.read().strip()
                
                print(f"Text: {text}")
                print(f"Reference audio: {actual_ref_audio}")
                print(f"Reference text: {actual_ref_text}")
                
                # Generate audio with Qwen3-TTS
                generate_audio(
                    model=model,
                    text=text,
                    ref_audio=actual_ref_audio,
                    ref_text=actual_ref_text,
                    file_prefix=file_prefix,
                    speed=speed,
                    verbose=False
                )
            else:
                # Kokoro TTS: Use predefined voices
                text_proc = text
                if lang_code == 'z' or lang_code == 'zh':
                    # Add comma prefix for Chinese to prevent skipped words
                    text_proc = "，" + text_proc
                
                generate_audio(
                    text=text_proc,
                    model=model,
                    voice=voice,
                    lang_code=lang_code,
                    speed=speed,
                    file_prefix=file_prefix,
                    audio_format="wav",
                    join_audio=True,
                    append_datetime=False,
                    verbose=False
                )
            
            # Find the output file
            final_path = None
            if os.path.exists(expected_output):
                final_path = expected_output
            elif os.path.exists(file_prefix + "_000.wav"):
                final_path = file_prefix + "_000.wav"
            
            if not final_path:
                # List files in temp dir for debugging
                files = os.listdir(tmp_dir)
                return {
                    "success": False,
                    "error": "no_output_file",
                    "message": f"Generation finished but no output file found. Files in temp: {files}"
                }
            
            # Check file size
            file_size = os.path.getsize(final_path)
            
            # Determine final output path
            if output_path is None:
                output_filename = f"tts_{uuid.uuid4().hex[:8]}"
                output_path = os.path.join(OUTPUT_TTS_PATH, output_filename)
            
            mp3_path = f"{output_path}.mp3"
            wav_path = f"{output_path}.wav"
            
            # Convert to MP3 for WhatsApp if ffmpeg available
            if AudioEncoder.is_ffmpeg_available():
                success, result = AudioEncoder.wav_to_mp3(final_path, mp3_path)
                if success:
                    # Copy to output path
                    shutil.copy(final_path, wav_path)
                    # Remove WAV, keep MP3
                    os.remove(wav_path)
                    final_output = mp3_path
                else:
                    # Keep WAV file
                    shutil.copy(final_path, wav_path)
                    final_output = wav_path
            else:
                # No ffmpeg, keep WAV
                shutil.copy(final_path, wav_path)
                final_output = wav_path
            
            # Get duration
            duration = AudioEncoder.get_duration(final_output)
            
            return {
                "success": True,
                "audio_path": final_output,
                "duration": duration,
                "voice": voice if not use_qwen3 else "cloned",
                "model": model,
                "lang_code": lang_code,
                "text_length": len(text),
                "file_size": file_size,
                "ref_audio": actual_ref_audio if use_qwen3 else None
            }
            
        except ImportError as e:
            return {
                "success": False,
                "error": "mlx_audio_not_installed",
                "message": f"MLX-Audio TTS not installed: {str(e)}. Install with: pip install mlx-audio"
            }
        except Exception as e:
            import traceback
            return {
                "success": False,
                "error": "generation_failed",
                "message": f"TTS generation error: {str(e)}",
                "traceback": traceback.format_exc()
            }
        finally:
            # Clean up temp directory
            if os.path.exists(tmp_dir):
                try:
                    shutil.rmtree(tmp_dir)
                except Exception:
                    pass


def speak(text: str, voice: str = TTS_VOICE, **kwargs) -> Dict[str, Any]:
    """
    Convenience function to generate speech.
    
    Args:
        text: Text to convert to speech
        voice: Voice to use (for Kokoro) or "default" (for Qwen3)
        **kwargs: Additional arguments for TTSEngine.generate
        
    Returns:
        dict with audio generation result
    """
    return TTSEngine.generate(text, voice=voice, **kwargs)


def list_voices(model: str = TTS_MODEL) -> List[str]:
    """
    Get available voices.
    
    Args:
        model: TTS model name
        
    Returns:
        List of voice names (or reference audio files for Qwen3)
    """
    return TTSEngine.get_available_voices(model)


def get_status() -> Dict[str, Any]:
    """Get TTS module status."""
    mlx_available, mlx_status = TTSEngine.is_available()
    mlx_audio_available, mlx_audio_status = TTSEngine.is_mlx_audio_available()
    ffmpeg_available = AudioEncoder.is_ffmpeg_available()
    
    voices = TTSEngine.get_available_voices()
    is_qwen3 = is_qwen3_model(TTS_MODEL)
    
    return {
        "mlx_available": mlx_available,
        "mlx_status": mlx_status,
        "mlx_audio_available": mlx_audio_available,
        "mlx_audio_status": mlx_audio_status,
        "ffmpeg_available": ffmpeg_available,
        "tts_model": TTS_MODEL,
        "tts_model_type": "qwen3" if is_qwen3 else "kokoro",
        "default_voice": TTS_VOICE,
        "lang_code": TTS_LANG_CODE,
        "available_voices": voices,
        "ref_audio": TTS_REF_AUDIO if is_qwen3 else None,
        "ref_text": TTS_REF_TEXT if is_qwen3 else None,
        "ready": mlx_available and mlx_audio_available
    }


if __name__ == "__main__":
    # Test the module
    import json
    
    if len(sys.argv) < 2:
        print(json.dumps(get_status(), indent=2))
    else:
        text = " ".join(sys.argv[1:])
        result = speak(text)
        print(json.dumps(result, indent=2))