#!/usr/bin/env python3
"""
Vision Skill - Built-in Skill for Friday

Provides image analysis capabilities using a vision model (e.g., LLaVA).
Used when Friday needs to understand image content, such as screenshots,
photos, or other visual data.

Based on: plan/design-tool-calling-and-vision.md
"""

import sys
import os
import json
import base64
import requests
from typing import Optional, Dict, Any, List

# === CONFIGURATION ===
SKILL_NAME = "vision"
VERSION = "1.0.0"

# Environment variables
VISION_MODEL = os.environ.get("VISION_MODEL", "llava:13b")
VISION_BASE_URL = os.environ.get("VISION_BASE_URL", "http://localhost:11434")
VISION_TIMEOUT_MS = int(os.environ.get("VISION_TIMEOUT_MS", "60000"))

# === SKILL PARAMETERS ===
PARAMETERS = {
    "action": {
        "type": "string",
        "enum": ["analyze", "describe", "ocr", "status"],
        "required": True,
        "description": "Action to perform"
    },
    "image_path": {
        "type": "string",
        "required": False,
        "description": "Path to image file (required for analyze/describe/ocr actions)"
    },
    "image_paths": {
        "type": "array",
        "items": {"type": "string"},
        "required": False,
        "description": "Paths to multiple image files (alternative to image_path)"
    },
    "query": {
        "type": "string",
        "required": False,
        "default": "Describe this image in detail.",
        "description": "Question or prompt for the vision model"
    }
}


def get_image_mime_type(file_path: str) -> str:
    """Get MIME type based on file extension."""
    ext = os.path.splitext(file_path)[1].lower()
    mime_types = {
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.png': 'image/png',
        '.gif': 'image/gif',
        '.webp': 'image/webp',
        '.bmp': 'image/bmp'
    }
    return mime_types.get(ext, 'image/jpeg')


def encode_image_to_base64(file_path: str) -> Optional[str]:
    """Encode an image file to base64 string."""
    try:
        with open(file_path, 'rb') as f:
            return base64.b64encode(f.read()).decode('utf-8')
    except FileNotFoundError:
        return None
    except Exception as e:
        print(f"Error encoding image: {e}", file=sys.stderr)
        return None


def check_vision_available() -> Dict[str, Any]:
    """Check if the vision model is available."""
    try:
        # Try to get model info from Ollama
        response = requests.get(
            f"{VISION_BASE_URL}/api/tags",
            timeout=10
        )
        
        if response.status_code == 200:
            models = response.json().get('models', [])
            model_names = [m.get('name', '') for m in models]
            
            # Check if vision model is in the list
            vision_available = any(VISION_MODEL in name for name in model_names)
            
            return {
                "available": vision_available,
                "model": VISION_MODEL,
                "base_url": VISION_BASE_URL,
                "installed_models": model_names
            }
        else:
            return {
                "available": False,
                "model": VISION_MODEL,
                "base_url": VISION_BASE_URL,
                "error": f"API returned status {response.status_code}"
            }
    except requests.exceptions.RequestException as e:
        return {
            "available": False,
            "model": VISION_MODEL,
            "base_url": VISION_BASE_URL,
            "error": str(e)
        }


def analyze_image(image_path: str, query: str, timeout_ms: int = VISION_TIMEOUT_MS) -> Dict[str, Any]:
    """
    Analyze a single image using the vision model.
    
    Args:
        image_path: Path to the image file
        query: Question or prompt for the vision model
        timeout_ms: Timeout in milliseconds
        
    Returns:
        dict with success, message, and data
    """
    # Check if file exists
    if not os.path.exists(image_path):
        return {
            "success": False,
            "message": f"❌ Image file not found: {image_path}",
            "data": {"error": "file_not_found", "path": image_path}
        }
    
    # Encode image
    base64_image = encode_image_to_base64(image_path)
    if not base64_image:
        return {
            "success": False,
            "message": f"❌ Failed to encode image: {image_path}",
            "data": {"error": "encoding_failed", "path": image_path}
        }
    
    mime_type = get_image_mime_type(image_path)
    
    # Call Ollama API for vision
    try:
        payload = {
            "model": VISION_MODEL,
            "prompt": query,
            "images": [base64_image],
            "stream": False
        }
        
        response = requests.post(
            f"{VISION_BASE_URL}/api/generate",
            json=payload,
            timeout=timeout_ms / 1000  # Convert to seconds
        )
        
        if response.status_code == 200:
            result = response.json()
            analysis = result.get('response', '')
            
            return {
                "success": True,
                "message": f"✅ Image analyzed successfully.\n\n{analysis}",
                "data": {
                    "image_path": image_path,
                    "query": query,
                    "analysis": analysis,
                    "model": VISION_MODEL
                }
            }
        else:
            return {
                "success": False,
                "message": f"❌ Vision model returned error {response.status_code}: {response.text}",
                "data": {
                    "error": "api_error",
                    "status_code": response.status_code,
                    "response": response.text
                }
            }
            
    except requests.exceptions.Timeout:
        return {
            "success": False,
            "message": f"❌ Vision model request timed out after {timeout_ms}ms",
            "data": {"error": "timeout", "timeout_ms": timeout_ms}
        }
    except requests.exceptions.RequestException as e:
        return {
            "success": False,
            "message": f"❌ Vision model request failed: {str(e)}",
            "data": {"error": "request_failed", "details": str(e)}
        }


def analyze_multiple_images(image_paths: List[str], query: str, timeout_ms: int = VISION_TIMEOUT_MS) -> Dict[str, Any]:
    """
    Analyze multiple images using the vision model.
    
    Args:
        image_paths: List of paths to image files
        query: Question or prompt for the vision model
        timeout_ms: Timeout in milliseconds
        
    Returns:
        dict with success, message, and data
    """
    # Encode all images
    encoded_images = []
    failed_paths = []
    
    for path in image_paths:
        if not os.path.exists(path):
            failed_paths.append(path)
            continue
            
        base64_image = encode_image_to_base64(path)
        if base64_image:
            encoded_images.append(base64_image)
        else:
            failed_paths.append(path)
    
    if failed_paths:
        return {
            "success": False,
            "message": f"❌ Failed to process images: {', '.join(failed_paths)}",
            "data": {"error": "encoding_failed", "failed_paths": failed_paths}
        }
    
    if not encoded_images:
        return {
            "success": False,
            "message": "❌ No valid images to analyze",
            "data": {"error": "no_valid_images"}
        }
    
    # Call Ollama API for vision
    try:
        payload = {
            "model": VISION_MODEL,
            "prompt": query,
            "images": encoded_images,
            "stream": False
        }
        
        response = requests.post(
            f"{VISION_BASE_URL}/api/generate",
            json=payload,
            timeout=timeout_ms / 1000
        )
        
        if response.status_code == 200:
            result = response.json()
            analysis = result.get('response', '')
            
            return {
                "success": True,
                "message": f"✅ {len(encoded_images)} images analyzed successfully.\n\n{analysis}",
                "data": {
                    "image_paths": image_paths,
                    "query": query,
                    "analysis": analysis,
                    "model": VISION_MODEL,
                    "image_count": len(encoded_images)
                }
            }
        else:
            return {
                "success": False,
                "message": f"❌ Vision model returned error {response.status_code}: {response.text}",
                "data": {
                    "error": "api_error",
                    "status_code": response.status_code,
                    "response": response.text
                }
            }
            
    except requests.exceptions.Timeout:
        return {
            "success": False,
            "message": f"❌ Vision model request timed out after {timeout_ms}ms",
            "data": {"error": "timeout", "timeout_ms": timeout_ms}
        }
    except requests.exceptions.RequestException as e:
        return {
            "success": False,
            "message": f"❌ Vision model request failed: {str(e)}",
            "data": {"error": "request_failed", "details": str(e)}
        }
    except Exception as e:
        return {
            "success": False,
            "message": f"❌ Unexpected error: {str(e)}",
            "data": {"error": "unexpected_error", "details": str(e)}
        }


def validate_params(params: dict) -> tuple:
    """Validate input parameters."""
    action = params.get("action")
    
    if not action:
        return False, "Missing required parameter: action"
    
    valid_actions = ["analyze", "describe", "ocr", "status"]
    if action not in valid_actions:
        return False, f"Invalid action: {action}. Must be one of: {', '.join(valid_actions)}"
    
    # analyze, describe, ocr require an image
    if action in ["analyze", "describe", "ocr"]:
        if not params.get("image_path") and not params.get("image_paths"):
            return False, f"Missing required parameter: image_path or image_paths (required for {action})"
    
    return True, None


def logic(params: dict, user_id: str) -> dict:
    """
    Main skill logic - analyze images using vision model.
    
    Args:
        params: Dictionary of parameters from user
        user_id: User's phone number
        
    Returns:
        dict with keys:
        - success: bool
        - message: str (for WhatsApp)
        - data: dict (optional)
    """
    action = params.get("action", "analyze")
    
    if action == "status":
        status = check_vision_available()
        
        if status["available"]:
            return {
                "success": True,
                "message": f"✅ Vision model '{VISION_MODEL}' is available.\n📍 Base URL: {VISION_BASE_URL}",
                "data": status
            }
        else:
            return {
                "success": False,
                "message": f"❌ Vision model '{VISION_MODEL}' is not available.\n📍 Base URL: {VISION_BASE_URL}\n⚠️ Error: {status.get('error', 'Unknown error')}",
                "data": status
            }
    
    # Get image path(s)
    image_path = params.get("image_path")
    image_paths = params.get("image_paths", [])
    
    # Normalize to list
    if image_path:
        image_paths = [image_path]
    
    # Get query based on action
    default_queries = {
        "analyze": "Analyze this image in detail. Describe what you see, including objects, people, text, colors, and any notable features.",
        "describe": "Describe this image in detail.",
        "ocr": "Extract and transcribe all text visible in this image. List each piece of text you find."
    }
    
    query = params.get("query", default_queries.get(action, "Describe this image."))
    
    # Analyze single or multiple images
    if len(image_paths) == 1:
        return analyze_image(image_paths[0], query)
    else:
        return analyze_multiple_images(image_paths, query)


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