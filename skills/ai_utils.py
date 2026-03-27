"""
Friday AI Utilities - Shared Python functions for all skills

This module provides:
- call_local_ai(): Call local LLM (LM Studio)
- call_cloud_glm5(): Call GLM-5 Cloud API
- wait_for_gpu(): GPU Resource Arbiter
- get_user_profile(): Load user profile
- get_user_memory(): Load user memory (JSONL)
"""

import os
import time
import json
import requests
from dotenv import load_dotenv

load_dotenv()

# Configuration
AI_PROVIDER = os.getenv('AI_PROVIDER', 'LM_STUDIO')
AI_BASE_URL = os.getenv('AI_BASE_URL', 'http://localhost:1234/v1')
CHAT_MODEL = os.getenv('CHAT_MODEL', 'qwen/qwen3.5-35b-a3b')
CLOUD_AI_KEY = os.getenv('CLOUD_AI_KEY', '')
CLOUD_AI_URL = os.getenv('CLOUD_AI_URL', 'https://api.z.ai/v1')
EVOLUTION_MODEL = os.getenv('EVOLUTION_MODEL', 'glm-5')
USER_DATA_ROOT = os.getenv('USER_DATA_ROOT', './users')
ARBITER_LOCK_PATH = os.getenv('ARBITER_LOCK_PATH', './temp/gpu_active.lock')


def wait_for_gpu():
    """
    GPU Resource Arbiter: Prevents conflicts between Local LLM, MLX-Audio, and Cloud Evolution.
    Call this before any GPU-intensive operation.
    """
    while os.path.exists(ARBITER_LOCK_PATH):
        print(f"GPU busy, waiting... ({ARBITER_LOCK_PATH} exists)")
        time.sleep(2)


def acquire_gpu_lock():
    """Acquire GPU lock for exclusive access."""
    lock_dir = os.path.dirname(ARBITER_LOCK_PATH)
    if lock_dir and not os.path.exists(lock_dir):
        os.makedirs(lock_dir, exist_ok=True)
    with open(ARBITER_LOCK_PATH, 'w') as f:
        f.write(time.strftime('%Y-%m-%dT%H:%M:%SZ'))


def release_gpu_lock():
    """Release GPU lock."""
    if os.path.exists(ARBITER_LOCK_PATH):
        os.unlink(ARBITER_LOCK_PATH)


def call_local_ai(prompt, system_msg="You are Friday, a helpful AI assistant."):
    """
    Call local LLM (LM Studio) for fast responses.
    
    Args:
        prompt: User message/prompt
        system_msg: System message for context
    
    Returns:
        str: AI response text
    """
    headers = {
        'Content-Type': 'application/json'
    }
    
    payload = {
        'model': CHAT_MODEL,
        'messages': [
            {'role': 'system', 'content': system_msg},
            {'role': 'user', 'content': prompt}
        ],
        'temperature': 0.7
    }
    
    try:
        response = requests.post(
            f'{AI_BASE_URL}/chat/completions',
            headers=headers,
            json=payload,
            timeout=60
        )
        response.raise_for_status()
        data = response.json()
        return data['choices'][0]['message']['content']
    except Exception as e:
        return f"Error calling local AI: {str(e)}"


def call_cloud_glm5(prompt, system_msg="You are Friday's Evolution Engine, an expert Python programmer."):
    """
    Call GLM-5 Cloud API (Ollama) for high-reasoning coding tasks.
    
    Args:
        prompt: User message/prompt
        system_msg: System message for context
    
    Returns:
        str: AI response text
    """
    # Wait for GPU to be available
    wait_for_gpu()
    
    # Ollama API format
    payload = {
        'model': EVOLUTION_MODEL,
        'messages': [
            {'role': 'system', 'content': system_msg},
            {'role': 'user', 'content': prompt}
        ],
        'stream': False
    }
    
    try:
        response = requests.post(
            f'{CLOUD_AI_URL}/api/chat',
            json=payload,
            timeout=120
        )
        response.raise_for_status()
        data = response.json()
        # Ollama returns message.content or response
        return data.get('message', {}).get('content', '') or data.get('response', '')
    except Exception as e:
        return f"Error calling cloud AI: {str(e)}"


def get_user_profile(user_id):
    """
    Load user profile from JSON file.
    
    Args:
        user_id: User's phone number (e.g., '+1234567890')
    
    Returns:
        dict: User profile data
    """
    profile_path = os.path.join(USER_DATA_ROOT, user_id, 'profile.json')
    
    if not os.path.exists(profile_path):
        return {
            'user_id': user_id,
            'agent': 'friday',
            'created': time.strftime('%Y-%m-%dT%H:%M:%SZ')
        }
    
    with open(profile_path, 'r') as f:
        return json.load(f)


def get_user_memory(user_id, limit=10):
    """
    Load recent user memory from JSONL file.
    
    Args:
        user_id: User's phone number
        limit: Maximum number of messages to return
    
    Returns:
        list: Recent memory entries
    """
    memory_path = os.path.join(USER_DATA_ROOT, user_id, 'memory.log')
    
    if not os.path.exists(memory_path):
        return []
    
    with open(memory_path, 'r') as f:
        lines = f.readlines()
    
    # Get last N lines
    recent = lines[-limit:] if len(lines) > limit else lines
    
    # Parse JSONL
    memory = []
    for line in recent:
        try:
            memory.append(json.loads(line.strip()))
        except:
            pass
    
    return memory


def save_user_memory(user_id, role, content):
    """
    Append to user memory (JSONL).
    
    Args:
        user_id: User's phone number
        role: 'user' or 'assistant'
        content: Message content
    """
    user_dir = os.path.join(USER_DATA_ROOT, user_id)
    
    if not os.path.exists(user_dir):
        os.makedirs(user_dir, exist_ok=True)
    
    memory_path = os.path.join(user_dir, 'memory.log')
    
    entry = {
        'timestamp': time.strftime('%Y-%m-%dT%H:%M:%SZ'),
        'role': role,
        'content': content
    }
    
    with open(memory_path, 'a') as f:
        f.write(json.dumps(entry) + '\n')


def get_user_reminders(user_id):
    """
    Load user reminders from JSON file.
    
    Args:
        user_id: User's phone number
    
    Returns:
        list: User reminders
    """
    reminders_path = os.path.join(USER_DATA_ROOT, user_id, 'reminders.json')
    
    if not os.path.exists(reminders_path):
        return []
    
    with open(reminders_path, 'r') as f:
        return json.load(f)


def save_user_reminders(user_id, reminders):
    """
    Save user reminders to JSON file.
    
    Args:
        user_id: User's phone number
        reminders: List of reminder objects
    """
    user_dir = os.path.join(USER_DATA_ROOT, user_id)
    
    if not os.path.exists(user_dir):
        os.makedirs(user_dir, exist_ok=True)
    
    reminders_path = os.path.join(user_dir, 'reminders.json')
    
    with open(reminders_path, 'w') as f:
        json.dump(reminders, f, indent=2)


# Example usage
if __name__ == '__main__':
    # Test local AI
    print("Testing local AI...")
    response = call_local_ai("Hello, how are you?")
    print(f"Response: {response}")
    
    # Test memory
    print("\nTesting memory...")
    save_user_memory('+1234567890', 'user', 'Hello!')
    memory = get_user_memory('+1234567890')
    print(f"Memory: {memory}")