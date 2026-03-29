"""
Image handler for static page generator.
Downloads and stores images locally alongside generated pages.
"""

import os
import hashlib
import urllib.request
import urllib.error
import mimetypes
from typing import Dict, Any, Optional, Tuple
from datetime import datetime, timezone

# Supported image extensions
IMAGE_EXTENSIONS = {
    'image/jpeg': '.jpg',
    'image/png': '.png',
    'image/gif': '.gif',
    'image/webp': '.webp',
    'image/svg+xml': '.svg'
}

MAX_IMAGE_SIZE_BYTES = 10 * 1024 * 1024  # 10MB max image size
DOWNLOAD_TIMEOUT = 30  # seconds


class ImageHandler:
    """Handles image downloading and storage for static pages."""
    
    def __init__(self, output_dir: str):
        """
        Initialize image handler.
        
        Args:
            output_dir: Base directory for storing images (e.g., web_portal/user_id/hash/)
        """
        self.output_dir = output_dir
        self.assets_dir = os.path.join(output_dir, 'assets')
    
    def ensure_assets_dir(self) -> str:
        """Create assets directory if it doesn't exist."""
        os.makedirs(self.assets_dir, exist_ok=True)
        return self.assets_dir
    
    def get_image_filename(self, url: str, content_type: Optional[str] = None) -> str:
        """
        Generate a unique filename for an image.
        
        Args:
            url: Source URL of the image
            content_type: MIME type of the image
            
        Returns:
            Filename string (e.g., 'abc123.jpg')
        """
        # Generate hash from URL
        url_hash = hashlib.md5(url.encode()).hexdigest()[:12]
        
        # Determine extension
        if content_type and content_type in IMAGE_EXTENSIONS:
            ext = IMAGE_EXTENSIONS[content_type]
        else:
            # Try to guess from URL
            ext = os.path.splitext(url.split('?')[0])[-1].lower()
            if ext not in IMAGE_EXTENSIONS.values():
                ext = '.jpg'  # Default fallback
        
        return f"{url_hash}{ext}"
    
    def download_image(self, url: str) -> Tuple[bool, str, Optional[str]]:
        """
        Download an image from URL and save locally.
        
        Args:
            url: URL of the image to download
            
        Returns:
            Tuple of (success, local_path_or_error, content_type)
        """
        try:
            # Create request with headers
            request = urllib.request.Request(url, headers={
                'User-Agent': 'Mozilla/5.0 (compatible; FridayAI/1.0)'
            })
            
            # Download with timeout
            with urllib.request.urlopen(request, timeout=DOWNLOAD_TIMEOUT) as response:
                # Check content type
                content_type = response.headers.get('Content-Type', '').split(';')[0].strip()
                
                # Check size
                content_length = response.headers.get('Content-Length')
                if content_length and int(content_length) > MAX_IMAGE_SIZE_BYTES:
                    return False, f"Image too large: {content_length} bytes", None
                
                # Read data
                data = response.read()
                if len(data) > MAX_IMAGE_SIZE_BYTES:
                    return False, f"Image too large: {len(data)} bytes", None
                
                # Validate image type
                if content_type and content_type not in IMAGE_EXTENSIONS:
                    # Try to detect from magic bytes
                    if data[:8] == b'\x89PNG\r\n\x1a\n':
                        content_type = 'image/png'
                    elif data[:2] == b'\xff\xd8':
                        content_type = 'image/jpeg'
                    elif data[:4] == b'GIF8':
                        content_type = 'image/gif'
                    elif data[:4] == b'RIFF' and data[8:12] == b'WEBP':
                        content_type = 'image/webp'
                
                # Ensure assets directory exists
                self.ensure_assets_dir()
                
                # Generate filename
                filename = self.get_image_filename(url, content_type)
                local_path = os.path.join(self.assets_dir, filename)
                
                # Save image
                with open(local_path, 'wb') as f:
                    f.write(data)
                
                # Return relative path for HTML
                relative_path = f"assets/{filename}"
                return True, relative_path, content_type
                
        except urllib.error.URLError as e:
            return False, f"URL error: {str(e)}", None
        except urllib.error.HTTPError as e:
            return False, f"HTTP error: {e.code}", None
        except Exception as e:
            return False, f"Download failed: {str(e)}", None
    
    def process_image_field(self, image_field: Any) -> Tuple[str, Optional[str]]:
        """
        Process an image field from content data.
        
        Args:
            image_field: Can be:
                - string URL: "https://example.com/image.jpg"
                - dict with url: {"url": "https://...", "alt": "Description"}
                
        Returns:
            Tuple of (image_html_or_path, error_message)
        """
        if isinstance(image_field, str):
            # Simple URL string
            success, result, _ = self.download_image(image_field)
            if success:
                return f'<img src="{result}" alt="" loading="lazy">', None
            return "", result
            
        elif isinstance(image_field, dict):
            url = image_field.get('url', '')
            alt = image_field.get('alt', '')
            
            if not url:
                return "", "No URL provided"
            
            success, result, _ = self.download_image(url)
            if success:
                return f'<img src="{result}" alt="{alt}" loading="lazy">', None
            return "", result
        
        return "", "Invalid image field format"
    
    def process_images_in_content(self, content_items: list) -> list:
        """
        Process all images in content items.
        
        Args:
            content_items: List of content dictionaries
            
        Returns:
            Updated content items with local image paths
        """
        processed = []
        for item in content_items:
            if isinstance(item, dict) and 'image' in item:
                image_html, error = self.process_image_field(item['image'])
                if image_html:
                    # Add image HTML to content
                    item = dict(item)  # Copy to avoid modifying original
                    item['image_html'] = image_html
                if error:
                    # Log error but continue
                    item = dict(item)
                    item['image_error'] = error
            processed.append(item)
        return processed