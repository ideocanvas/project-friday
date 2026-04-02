#!/usr/bin/env python3
"""
Models Module for Voice Skill

Handles MLX model loading, caching, and management for both STT and TTS.
Optimized for Apple Silicon with Metal acceleration.
"""

import os
import sys
import time
import threading
from typing import Optional, Dict, Any, Tuple
from pathlib import Path

# Environment configuration
STT_MODEL = os.environ.get("STT_MODEL", "mlx-community/whisper-small-mlx")
TTS_MODEL = os.environ.get("TTS_MODEL", "mlx-community/Qwen3-TTS-12Hz-0.6B-Base-bf16")
MODEL_CACHE_DIR = os.environ.get(
    "MODEL_CACHE_DIR", os.path.expanduser("~/.cache/huggingface")
)

# Ensure cache directory exists
os.makedirs(MODEL_CACHE_DIR, exist_ok=True)


class ModelCache:
    """
    Thread-safe model cache for MLX models.

    Keeps models in memory for faster subsequent calls.
    """

    _instance = None
    _lock = threading.Lock()

    def __new__(cls):
        if cls._instance is None:
            with cls._lock:
                if cls._instance is None:
                    cls._instance = super().__new__(cls)
                    cls._instance._models = {}
                    cls._instance._model_timestamps = {}
                    cls._instance._model_sizes = {}
        return cls._instance

    def get(self, model_name: str) -> Optional[Any]:
        """
        Get cached model.

        Args:
            model_name: Model identifier

        Returns:
            Cached model or None
        """
        return self._models.get(model_name)

    def set(self, model_name: str, model: Any, size_mb: float = 0) -> None:
        """
        Cache a model.

        Args:
            model_name: Model identifier
            model: Model instance
            size_mb: Model size in MB (for tracking)
        """
        self._models[model_name] = model
        self._model_timestamps[model_name] = time.time()
        self._model_sizes[model_name] = size_mb

    def remove(self, model_name: str) -> bool:
        """
        Remove model from cache.

        Args:
            model_name: Model identifier

        Returns:
            True if model was removed
        """
        if model_name in self._models:
            del self._models[model_name]
            del self._model_timestamps[model_name]
            del self._model_sizes[model_name]
            return True
        return False

    def clear(self) -> None:
        """Clear all cached models."""
        self._models.clear()
        self._model_timestamps.clear()
        self._model_sizes.clear()

    def get_stats(self) -> Dict[str, Any]:
        """Get cache statistics."""
        total_size = sum(self._model_sizes.values())
        return {
            "model_count": len(self._models),
            "total_size_mb": total_size,
            "models": {
                name: {
                    "loaded_at": self._model_timestamps.get(name, 0),
                    "size_mb": self._model_sizes.get(name, 0),
                }
                for name in self._models.keys()
            },
        }


class MLXModelLoader:
    """
    MLX model loader with caching and error handling.

    Handles both STT (Whisper) and TTS models.
    """

    @staticmethod
    def check_mlx() -> Tuple[bool, str]:
        """
        Check if MLX is available.

        Returns:
            Tuple of (available, status_message)
        """
        try:
            import mlx.core as mlx

            if mlx.metal.is_available():
                return True, "MLX available with Metal acceleration"
            return True, "MLX available (CPU mode)"
        except ImportError:
            return False, "MLX not installed. Install with: pip install mlx"

    @staticmethod
    def check_mlx_audio() -> Tuple[bool, str]:
        """
        Check if MLX-Audio is available.

        Returns:
            Tuple of (available, status_message)
        """
        try:
            import mlx_audio

            return True, "MLX-Audio installed"
        except ImportError:
            return False, "MLX-Audio not installed. Install with: pip install mlx-audio"

    @staticmethod
    def get_system_info() -> Dict[str, Any]:
        """Get system information for MLX."""
        info = {
            "mlx_available": False,
            "mlx_audio_available": False,
            "metal_available": False,
            "device": "cpu",
        }

        try:
            import mlx.core as mlx

            info["mlx_available"] = True
            info["metal_available"] = mlx.metal.is_available()
            if info["metal_available"]:
                info["device"] = "gpu"
                # Get GPU info
                try:
                    info["gpu_memory"] = mlx.metal.get_gpu_memory()
                except AttributeError:
                    pass
        except ImportError:
            pass

        try:
            import mlx_audio

            info["mlx_audio_available"] = True
        except ImportError:
            pass

        return info


class WhisperModelLoader(MLXModelLoader):
    """Loader for MLX Whisper models."""

    @staticmethod
    def load(
        model_name: str = STT_MODEL, use_cache: bool = True
    ) -> Tuple[Any, Dict[str, Any]]:
        """
        Load Whisper model for STT.

        Args:
            model_name: HuggingFace model name or path
            use_cache: Whether to use cached model

        Returns:
            Tuple of (model, metadata)
        """
        cache = ModelCache()
        metadata = {
            "model_name": model_name,
            "source": "cache" if use_cache else "fresh",
            "load_time_ms": 0,
        }

        # Check cache first
        if use_cache:
            cached = cache.get(model_name)
            if cached is not None:
                metadata["source"] = "cache"
                return cached, metadata

        # Load fresh model
        start_time = time.time()

        try:
            # Try mlx_audio first
            from mlx_audio.whisper import load_model

            model = load_model(model_name)

            # Estimate model size based on name
            size_mb = {
                "tiny": 40,
                "base": 74,
                "small": 244,
                "medium": 769,
                "large": 1550,
            }.get(model_name.split("-")[-1] if "-" in model_name else "small", 244)

            # Cache the model
            if use_cache:
                cache.set(model_name, model, size_mb)

            metadata["load_time_ms"] = (time.time() - start_time) * 1000
            metadata["size_mb"] = size_mb

            return model, metadata

        except ImportError:
            # Fallback to mlx_whisper
            try:
                import mlx_whisper

                # mlx_whisper uses lazy loading, just return the model name
                metadata["load_time_ms"] = (time.time() - start_time) * 1000
                metadata["note"] = "Using mlx_whisper package"

                return model_name, metadata

            except ImportError:
                raise ImportError(
                    "Neither mlx_audio nor mlx_whisper is installed. "
                    "Install with: pip install mlx-audio"
                )

    @staticmethod
    def get_available_models() -> Dict[str, Dict[str, Any]]:
        """Get list of available Whisper models."""
        return {
            "mlx-community/whisper-tiny-mlx": {
                "size_mb": 40,
                "speed": "Fastest",
                "accuracy": "Basic",
            },
            "mlx-community/whisper-base-mlx": {
                "size_mb": 74,
                "speed": "Very Fast",
                "accuracy": "Good",
            },
            "mlx-community/whisper-small-mlx": {
                "size_mb": 244,
                "speed": "Fast",
                "accuracy": "Better",
                "recommended": True,
            },
            "mlx-community/whisper-medium-mlx": {
                "size_mb": 769,
                "speed": "Medium",
                "accuracy": "Best",
            },
            "mlx-community/whisper-large-mlx": {
                "size_mb": 1550,
                "speed": "Slow",
                "accuracy": "Best",
            },
        }


class TTSModelLoader(MLXModelLoader):
    """Loader for MLX TTS models."""

    @staticmethod
    def load(
        model_name: str = TTS_MODEL, use_cache: bool = True
    ) -> Tuple[Any, Dict[str, Any]]:
        """
        Load TTS model.

        Args:
            model_name: TTS model name
            use_cache: Whether to use cached model

        Returns:
            Tuple of (model, metadata)
        """
        cache = ModelCache()
        metadata = {
            "model_name": model_name,
            "source": "cache" if use_cache else "fresh",
            "load_time_ms": 0,
        }

        # Check cache first
        if use_cache:
            cached = cache.get(f"tts_{model_name}")
            if cached is not None:
                metadata["source"] = "cache"
                return cached, metadata

        # Load fresh model
        start_time = time.time()

        try:
            from mlx_audio.tts import load_model as load_tts_model

            model = load_tts_model(model_name)

            # Cache the model
            if use_cache:
                cache.set(f"tts_{model_name}", model, 500)  # Estimate 500MB

            metadata["load_time_ms"] = (time.time() - start_time) * 1000

            return model, metadata

        except ImportError:
            # TTS might not need explicit model loading
            metadata["load_time_ms"] = (time.time() - start_time) * 1000
            metadata["note"] = "TTS model loaded on demand"

            return model_name, metadata

    @staticmethod
    def get_available_models() -> Dict[str, Dict[str, Any]]:
        """Get list of available TTS models."""
        return {
            "qwen2.5-tts": {
                "quality": "Good",
                "languages": ["en", "zh"],
                "recommended": True,
            },
            "ming-omni": {
                "quality": "Better",
                "languages": ["en", "zh", "ja", "ko"],
                "recommended": False,
            },
        }


def preload_models(
    stt_model: str = STT_MODEL, tts_model: str = TTS_MODEL
) -> Dict[str, Any]:
    """
    Preload models for faster first call.

    Args:
        stt_model: STT model to preload
        tts_model: TTS model to preload

    Returns:
        dict with preload results
    """
    results = {"stt": None, "tts": None, "errors": []}

    # Preload STT model
    try:
        _, stt_meta = WhisperModelLoader.load(stt_model)
        results["stt"] = stt_meta
    except Exception as e:
        results["errors"].append(f"STT preload failed: {str(e)}")

    # Preload TTS model
    try:
        _, tts_meta = TTSModelLoader.load(tts_model)
        results["tts"] = tts_meta
    except Exception as e:
        results["errors"].append(f"TTS preload failed: {str(e)}")

    return results


def get_status() -> Dict[str, Any]:
    """Get models module status."""
    mlx_available, mlx_status = MLXModelLoader.check_mlx()
    mlx_audio_available, mlx_audio_status = MLXModelLoader.check_mlx_audio()
    system_info = MLXModelLoader.get_system_info()
    cache_stats = ModelCache().get_stats()

    return {
        "mlx_available": mlx_available,
        "mlx_status": mlx_status,
        "mlx_audio_available": mlx_audio_available,
        "mlx_audio_status": mlx_audio_status,
        "system": system_info,
        "cache": cache_stats,
        "stt_model": STT_MODEL,
        "tts_model": TTS_MODEL,
        "ready": mlx_available and mlx_audio_available,
    }


if __name__ == "__main__":
    import json

    # Print status
    print(json.dumps(get_status(), indent=2))
