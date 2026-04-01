import requests

VISION_BASE_URL = "http://localhost:1234/v1"
VISION_MODEL = "qwen/qwen3.5-35b-a3b"

payload = {
    "model": VISION_MODEL,
    "prompt": "Hello",
    "stream": False
}

try:
    print("Testing /api/generate ...")
    response = requests.post(f"{VISION_BASE_URL}/api/generate", json=payload)
    print("Status:", response.status_code)
    print("Content:", response.text)
except Exception as e:
    print("Error:", e)
