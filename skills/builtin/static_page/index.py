#!/usr/bin/env python3
"""
Static Page Generator - Built-in Skill for Friday

Generates shareable HTML pages for data, charts, and tables.
Creates unique hashed folders in web_portal directory.

Based on: plan/design-static-page.md
"""

import sys
import os
import json

# Add current directory to path for local imports
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

# Import the generator module
from generator import StaticPageGenerator

# === CONFIGURATION ===
SKILL_NAME = "static_page"
VERSION = "1.0.0"

# === SKILL PARAMETERS ===
PARAMETERS = {
    "action": {
        "type": "string",
        "enum": ["generate", "generate_from_template", "list_pages"],
        "required": True,
        "description": "Action to perform"
    },
    "data": {
        "type": "object",
        "required": False,
        "description": "Data to render (for generate action)"
    },
    "template": {
        "type": "string",
        "required": False,
        "default": "auto",
        "description": "Template name: auto, chart, table, list, dashboard"
    },
    "title": {
        "type": "string",
        "required": False,
        "default": "Friday Page",
        "description": "Page title"
    },
    "template_name": {
        "type": "string",
        "required": False,
        "description": "Specific template name (for generate_from_template)"
    },
    "template_content": {
        "type": "string",
        "required": False,
        "description": "Custom template content (for generate_from_template)"
    }
}

def validate_params(params):
    """Validate input parameters."""
    action = params.get("action")
    
    if not action:
        return False, "Missing required parameter: action"
    
    if action not in ["generate", "generate_from_template", "list_pages"]:
        return False, f"Invalid action: {action}. Must be one of: generate, generate_from_template, list_pages"
    
    if action in ["generate", "generate_from_template"] and not params.get("data"):
        return False, f"Missing required parameter: data (required for {action} action)"
    
    return True, None

def logic(params: dict, user_id: str) -> dict:
    """
    Main skill logic - generate static HTML pages.

    Args:
        params: Dictionary of parameters from user
        user_id: User's phone number

    Returns:
        dict with keys:
        - success: bool
        - message: str (for WhatsApp)
        - data: dict (optional)
    """
    action = params.get("action", "generate")
    generator = StaticPageGenerator()
    
    if action == "list_pages":
        result = generator.list_pages(user_id)
        
        if result['success']:
            pages = result.get('pages', [])
            if not pages:
                return {
                    "success": True,
                    "message": "📋 You have no pages yet.\n\nUse 'static_page generate' to create one!",
                    "data": {"pages": []}
                }
            
            lines = ["📋 Your Pages:\n"]
            for page in pages:
                lines.append(f"🔗 {page['url']}")
                lines.append(f"   Created: {page['created']}")
                lines.append(f"   Expires: {page['expires']}\n")
            
            return {
                "success": True,
                "message": "\n".join(lines),
                "data": result
            }
        else:
            return {
                "success": False,
                "message": f"❌ Failed to list pages: {result.get('error', 'Unknown error')}",
                "data": result
            }
    
    elif action == "generate":
        data = params.get("data", {})
        template = params.get("template", "auto")
        title = params.get("title", "Friday Page")
        
        result = generator.generate(data, user_id, template, title)
        
        if result['success']:
            return {
                "success": True,
                "message": f"✅ Page generated!\n\n🔗 URL: {result['url']}\n📄 Title: {title}",
                "data": {
                    "path": result['path'],
                    "url": result['url'],
                    "expires": result['expires']
                }
            }
        else:
            return {
                "success": False,
                "message": f"❌ Failed to generate page: {result.get('error', 'Unknown error')}",
                "data": result
            }
    
    elif action == "generate_from_template":
        data = params.get("data", {})
        template_name = params.get("template_name", "default")
        title = params.get("title", "Friday Page")
        
        result = generator.generate(data, user_id, template_name, title)
        
        if result['success']:
            return {
                "success": True,
                "message": f"✅ Page generated from template!\n\n🔗 URL: {result['url']}\n📄 Template: {template_name}",
                "data": {
                    "path": result['path'],
                    "url": result['url'],
                    "expires": result['expires']
                }
            }
        else:
            return {
                "success": False,
                "message": f"❌ Failed to generate page: {result.get('error', 'Unknown error')}",
                "data": result
            }
    
    return {
        "success": False,
        "message": f"Unknown action: {action}"
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