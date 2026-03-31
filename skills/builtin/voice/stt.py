#!/usr/bin/env python3
"""
Speech-to-Text (STT) Module for Voice Skill

Handles audio transcription using MLX Whisper, optimized for Apple Silicon.
Supports multiple audio formats with automatic conversion.

Based on: plan/ref/app.py
"""

import os
import sys
import subprocess
import tempfile
from typing import Optional, Dict, Any, Tuple
from pathlib import Path

# Environment configuration
STT_MODEL = os.environ.get("STT_MODEL", "mlx-community/whisper-small-mlx")
TEMP_VOICE_PATH = os.environ.get("TEMP_VOICE_PATH", "/tmp/friday/voice")
STT_TIMEOUT_MS = int(os.environ.get("STT_TIMEOUT_MS", "30000"))

# Ensure temp directory exists
os.makedirs(TEMP_VOICE_PATH, exist_ok=True)


class AudioConverter:
    """Handles audio format conversion using ffmpeg."""
    
    SUPPORTED_FORMATS = ['.ogg', '.mp3', '.wav', '.m4a', '.aac', '.flac', '.webm']
    
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
    def convert_to_wav(input_path: str, output_path: Optional[str] = None) -> Tuple[bool, str]:
        """
        Convert audio file to WAV format suitable for Whisper.
        
        Args:
            input_path: Path to input audio file
            output_path: Optional output path (defaults to temp file)
            
        Returns:
            Tuple of (success, output_path or error_message)
        """
        if not os.path.exists(input_path):
            return False, f"Input file not found: {input_path}"
        
        if output_path is None:
            base_name = os.path.basename(input_path)
            output_path = os.path.join(TEMP_VOICE_PATH, f"converted_{base_name}.wav")
        
        try:
            # Convert to 16kHz mono WAV (optimal for Whisper)
            result = subprocess.run([
                'ffmpeg', '-y', '-i', input_path,
                '-acodec', 'pcm_s16le',
                '-ar', '16000',
                '-ac', '1',  # Mono
                output_path
            ], capture_output=True, text=True, timeout=60)
            
            if result.returncode != 0:
                return False, f"ffmpeg error: {result.stderr}"
            
            return True, output_path
            
        except subprocess.TimeoutExpired:
            return False, "Audio conversion timed out"
        except FileNotFoundError:
            return False, "ffmpeg not found. Please install ffmpeg."
        except Exception as e:
            return False, f"Conversion error: {str(e)}"
    
    @staticmethod
    def get_audio_info(file_path: str) -> Dict[str, Any]:
        """Get audio file information using ffprobe."""
        try:
            result = subprocess.run([
                'ffprobe', '-v', 'quiet',
                '-print_format', 'json',
                '-show_format', '-show_streams',
                file_path
            ], capture_output=True, text=True, timeout=10)
            
            if result.returncode == 0:
                import json
                return json.loads(result.stdout)
            return {}
        except Exception:
            return {}
    
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


class WhisperTranscriber:
    """
    MLX Whisper-based transcriber with model caching.
    
    Uses mlx_whisper package for transcription.
    Optimized for Apple Silicon with Metal acceleration.
    """
    
    _model = None
    _model_name = None
    
    @classmethod
    def is_available(cls) -> Tuple[bool, str]:
        """
        Check if MLX Whisper is available.
        
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
    def is_mlx_whisper_available(cls) -> Tuple[bool, str]:
        """Check if mlx_whisper is installed."""
        try:
            import mlx_whisper
            return True, "mlx_whisper installed"
        except ImportError:
            return False, "mlx_whisper not installed. Install with: pip install mlx-whisper"
    
    @classmethod
    def transcribe(
        cls,
        audio_path: str,
        model_name: str = STT_MODEL,
        language: Optional[str] = None
    ) -> Dict[str, Any]:
        """
        Transcribe audio file to text using mlx_whisper.
        
        Args:
            audio_path: Path to audio file
            model_name: Whisper model to use (HuggingFace repo)
            language: Language code (e.g., 'en', 'zh')
            
        Returns:
            dict with text, language, duration
        """
        # Check file exists
        if not os.path.exists(audio_path):
            return {
                "success": False,
                "error": "file_not_found",
                "message": f"Audio file not found: {audio_path}"
            }
        
        # Convert to WAV if needed
        file_ext = os.path.splitext(audio_path)[1].lower()
        wav_path = audio_path
        temp_file = False
        
        if file_ext != '.wav':
            success, result = AudioConverter.convert_to_wav(audio_path)
            if not success:
                return {
                    "success": False,
                    "error": "conversion_failed",
                    "message": result
                }
            wav_path = result
            temp_file = True
        
        try:
            # Get audio duration
            duration = AudioConverter.get_duration(audio_path)
            
            # Import mlx_whisper
            import mlx_whisper
            
            # Build kwargs for transcription
            kwargs = {"path_or_hf_repo": model_name}
            if language:
                kwargs["language"] = language
            
            # Transcribe using mlx_whisper
            result = mlx_whisper.transcribe(wav_path, **kwargs)
            
            # Extract text
            text = result.get("text", "") if isinstance(result, dict) else str(result)
            detected_language = result.get("language", language or "en") if isinstance(result, dict) else (language or "en")
            
            return {
                "success": True,
                "text": text.strip(),
                "language": detected_language,
                "duration": duration,
                "model": model_name
            }
            
        except ImportError as e:
            return {
                "success": False,
                "error": "mlx_whisper_not_installed",
                "message": f"mlx_whisper not installed: {str(e)}. Install with: pip install mlx-whisper"
            }
        except Exception as e:
            return {
                "success": False,
                "error": "transcription_failed",
                "message": f"Transcription error: {str(e)}"
            }
        finally:
            # Clean up temp file
            if temp_file and os.path.exists(wav_path):
                try:
                    os.remove(wav_path)
                except Exception:
                    pass
    
    @classmethod
    def transcribe_smart(
        cls,
        audio_path: str,
        model_name: str = STT_MODEL,
        min_silence_len: int = 500,
        silence_thresh: int = -40
    ) -> Dict[str, Any]:
        """
        Smart transcription with silence-based chunking.
        
        Splits audio on silence and transcribes each chunk separately,
        useful for long audio files with pauses.
        
        Args:
            audio_path: Path to audio file
            model_name: Whisper model to use
            min_silence_len: Minimum silence length in ms
            silence_thresh: Silence threshold in dB
            
        Returns:
            dict with text, language, duration
        """
        try:
            from pydub import AudioSegment
            from pydub.silence import split_on_silence
        except ImportError:
            # Fall back to regular transcription
            return cls.transcribe(audio_path, model_name)
        
        if not os.path.exists(audio_path):
            return {
                "success": False,
                "error": "file_not_found",
                "message": f"Audio file not found: {audio_path}"
            }
        
        try:
            # Load audio
            sound = AudioSegment.from_file(audio_path)
            
            # Split on silence
            chunks = split_on_silence(
                sound,
                min_silence_len=min_silence_len,
                silence_thresh=silence_thresh,
                keep_silence=200
            )
            
            full_text = []
            
            for chunk in chunks:
                # Skip very short chunks
                if len(chunk) < 200:
                    continue
                
                # Export chunk to temp file
                with tempfile.NamedTemporaryFile(delete=False, suffix=".wav") as t:
                    chunk.export(t.name, format="wav")
                    chunk_path = t.name
                
                try:
                    # Transcribe chunk
                    result = cls.transcribe(chunk_path, model_name)
                    if result.get("success") and result.get("text", "").strip():
                        full_text.append(result["text"].strip())
                finally:
                    if os.path.exists(chunk_path):
                        os.unlink(chunk_path)
            
            duration = AudioConverter.get_duration(audio_path)
            
            return {
                "success": True,
                "text": " ".join(full_text),
                "language": "en",  # Default for smart transcription
                "duration": duration,
                "model": model_name,
                "chunks_processed": len([c for c in chunks if len(c) >= 200])
            }
            
        except Exception as e:
            return {
                "success": False,
                "error": "smart_transcription_failed",
                "message": f"Smart transcription error: {str(e)}"
            }


def transcribe(audio_path: str, **kwargs) -> Dict[str, Any]:
    """
    Convenience function to transcribe audio.
    
    Args:
        audio_path: Path to audio file
        **kwargs: Additional arguments for WhisperTranscriber.transcribe
        
    Returns:
        dict with transcription result
    """
    return WhisperTranscriber.transcribe(audio_path, **kwargs)


def get_status() -> Dict[str, Any]:
    """Get STT module status."""
    mlx_available, mlx_status = WhisperTranscriber.is_available()
    mlx_whisper_available, mlx_whisper_status = WhisperTranscriber.is_mlx_whisper_available()
    ffmpeg_available = AudioConverter.is_ffmpeg_available()
    
    return {
        "mlx_available": mlx_available,
        "mlx_status": mlx_status,
        "mlx_whisper_available": mlx_whisper_available,
        "mlx_whisper_status": mlx_whisper_status,
        "ffmpeg_available": ffmpeg_available,
        "stt_model": STT_MODEL,
        "ready": mlx_available and mlx_whisper_available
    }


if __name__ == "__main__":
    # Test the module
    import json
    
    if len(sys.argv) < 2:
        print(json.dumps(get_status(), indent=2))
    else:
        audio_file = sys.argv[1]
        result = transcribe(audio_file)
        print(json.dumps(result, indent=2))