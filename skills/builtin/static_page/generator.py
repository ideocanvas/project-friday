"""
Static Page Generator - HTML generation logic

Uses Jinja2 templates for professional HTML generation.
"""

import os
import json
import hashlib
from datetime import datetime, timezone
from pathlib import Path
from typing import Dict, Any, Optional, List

# Try to import Jinja2, fall back to basic templating if not available
try:
    from jinja2 import Environment, FileSystemLoader, Template
    JINJA2_AVAILABLE = True
except ImportError:
    JINJA2_AVAILABLE = False

# Configuration
WEB_PORTAL_PATH = os.getenv('WEB_PORTAL_PATH', './web_portal')
CLOUDFLARE_TUNNEL_URL = os.getenv('CLOUDFLARE_TUNNEL_URL', '')
PAGE_EXPIRY_HOURS = int(os.getenv('PAGE_EXPIRY_HOURS', '24'))
MAX_DATA_SIZE_BYTES = int(os.getenv('MAX_DATA_SIZE_BYTES', '1048576'))  # 1MB

# Template directory
TEMPLATE_DIR = Path(__file__).parent / 'templates'


class StaticPageGenerator:
    """Generate static HTML pages from data."""
    
    def __init__(self):
        self.web_portal_path = Path(WEB_PORTAL_PATH)
        self.template_dir = TEMPLATE_DIR
        
        if JINJA2_AVAILABLE and self.template_dir.exists():
            self.env = Environment(loader=FileSystemLoader(str(self.template_dir)))
        else:
            self.env = None
    
    def detect_template(self, data: Any) -> str:
        """
        Auto-detect template based on data structure.
        
        | Data Pattern                            | Template                |
        | Array of objects with date + value      | chart.html (line chart) |
        | Array of objects with label + value      | chart.html (bar chart)  |
        | Array with headers + rows                | table.html              |
        | Simple array                             | list.html               |
        | Multiple sections                        | dashboard.html          |
        """
        if not data:
            return 'default'
        
        if isinstance(data, dict):
            # Check for dashboard pattern
            if 'widgets' in data or 'sections' in data:
                return 'dashboard'
            
            # Check for table pattern
            if 'headers' in data and 'rows' in data:
                return 'table'
            
            # Check for chart pattern
            if 'type' in data:
                return data.get('type', 'chart')
            
            # Check for chart data
            chart_data = data.get('data', data)
            if isinstance(chart_data, list) and chart_data:
                first_item = chart_data[0]
                if isinstance(first_item, dict):
                    if 'date' in first_item or 'time' in first_item:
                        return 'chart'
                    if 'label' in first_item or 'name' in first_item:
                        return 'chart'
        
        if isinstance(data, list) and data:
            first_item = data[0]
            if isinstance(first_item, dict):
                # Check for time-series data
                if 'date' in first_item or 'time' in first_item or 'timestamp' in first_item:
                    return 'chart'
                # Check for labeled data
                if 'label' in first_item or 'name' in first_item:
                    return 'chart'
                # Default to table for object arrays
                return 'table'
        
        return 'list'
    
    def validate_data_size(self, data: Any) -> bool:
        """Check if data is within size limits."""
        try:
            data_str = json.dumps(data)
            return len(data_str.encode('utf-8')) <= MAX_DATA_SIZE_BYTES
        except:
            return False
    
    def generate_hash(self, data: Any, user_id: str) -> str:
        """Generate unique hash for page."""
        content = f"{user_id}:{json.dumps(data, sort_keys=True)}:{datetime.now(timezone.utc).isoformat()}"
        return hashlib.md5(content.encode()).hexdigest()[:8]
    
    def render_template(self, template_name: str, context: Dict[str, Any]) -> str:
        """Render a template with context."""
        if self.env and JINJA2_AVAILABLE:
            try:
                template = self.env.get_template(f"{template_name}.html")
                return template.render(**context)
            except Exception as e:
                # Fall back to inline template
                pass
        
        # Inline fallback templates
        return self._render_inline(template_name, context)
    
    def _render_inline(self, template_name: str, context: Dict[str, Any]) -> str:
        """Render inline template (fallback when Jinja2 unavailable)."""
        templates = {
            'chart': self._get_chart_template(),
            'table': self._get_table_template(),
            'list': self._get_list_template(),
            'dashboard': self._get_dashboard_template(),
            'default': self._get_default_template()
        }
        
        template = templates.get(template_name, templates['default'])
        
        # Simple placeholder replacement
        result = template
        for key, value in context.items():
            if isinstance(value, str):
                result = result.replace('{{ ' + key + ' }}', value)
                result = result.replace('{{' + key + '}}', value)
            elif isinstance(value, (dict, list)):
                result = result.replace('{{ ' + key + ' }}', json.dumps(value))
                result = result.replace('{{' + key + '}}', json.dumps(value))
        
        # Replace timestamp
        result = result.replace('{{ timestamp }}', 
                               datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M UTC'))
        
        return result
    
    def _get_chart_template(self) -> str:
        return '''<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>{{ title }}</title>
    <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { 
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            min-height: 100vh;
            padding: 20px;
        }
        .container {
            max-width: 900px;
            margin: 0 auto;
            background: white;
            border-radius: 16px;
            box-shadow: 0 20px 60px rgba(0,0,0,0.3);
            padding: 30px;
        }
        h1 { color: #333; margin-bottom: 10px; }
        .timestamp { color: #666; margin-bottom: 30px; font-size: 0.9em; }
        .chart-container { position: relative; height: 400px; }
    </style>
</head>
<body>
    <div class="container">
        <h1>{{ title }}</h1>
        <p class="timestamp">Generated: {{ timestamp }}</p>
        <div class="chart-container">
            <canvas id="myChart"></canvas>
        </div>
    </div>
    <script>
        const ctx = document.getElementById('myChart').getContext('2d');
        const chartConfig = {{ chart_config }};
        new Chart(ctx, chartConfig);
    </script>
</body>
</html>'''
    
    def _get_table_template(self) -> str:
        return '''<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>{{ title }}</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { 
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            min-height: 100vh;
            padding: 20px;
        }
        .container {
            max-width: 800px;
            margin: 0 auto;
            background: white;
            border-radius: 16px;
            box-shadow: 0 20px 60px rgba(0,0,0,0.3);
            overflow: hidden;
        }
        .header {
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: white;
            padding: 30px;
            text-align: center;
        }
        .header h1 { font-size: 1.8em; }
        .timestamp { opacity: 0.8; font-size: 0.9em; margin-top: 10px; }
        .content { padding: 20px; }
        table { width: 100%; border-collapse: collapse; }
        th, td { padding: 12px 15px; text-align: left; border-bottom: 1px solid #eee; }
        th { background: #f8f9fa; font-weight: 600; }
        tr:hover { background: #f5f5f5; }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>{{ title }}</h1>
            <div class="timestamp">Generated: {{ timestamp }}</div>
        </div>
        <div class="content">
            <table>
                <thead><tr>{{ headers }}</tr></thead>
                <tbody>{{ rows }}</tbody>
            </table>
        </div>
    </div>
</body>
</html>'''
    
    def _get_list_template(self) -> str:
        return '''<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>{{ title }}</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { 
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            background: linear-gradient(135deg, #11998e 0%, #38ef7d 100%);
            min-height: 100vh;
            padding: 20px;
        }
        .container {
            max-width: 600px;
            margin: 0 auto;
            background: white;
            border-radius: 16px;
            box-shadow: 0 20px 60px rgba(0,0,0,0.2);
        }
        .header {
            background: linear-gradient(135deg, #11998e 0%, #38ef7d 100%);
            color: white;
            padding: 30px;
            text-align: center;
        }
        .header h1 { font-size: 1.8em; }
        .content { padding: 20px; }
        .list-item {
            padding: 15px 20px;
            border-bottom: 1px solid #eee;
            display: flex;
            align-items: center;
        }
        .list-item:last-child { border-bottom: none; }
        .bullet {
            width: 8px;
            height: 8px;
            background: #38ef7d;
            border-radius: 50%;
            margin-right: 15px;
        }
        .list-item.done .bullet { background: #999; }
        .list-item.done .text { text-decoration: line-through; color: #999; }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>{{ title }}</h1>
        </div>
        <div class="content">
            {{ items }}
        </div>
    </div>
</body>
</html>'''
    
    def _get_dashboard_template(self) -> str:
        return '''<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>{{ title }}</title>
    <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { 
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            background: #f5f7fa;
            min-height: 100vh;
            padding: 20px;
        }
        .container { max-width: 1200px; margin: 0 auto; }
        .header { text-align: center; margin-bottom: 30px; }
        .header h1 { color: #333; font-size: 2em; }
        .timestamp { color: #666; }
        .widgets { display: grid; grid-template-columns: repeat(auto-fit, minmax(350px, 1fr)); gap: 20px; }
        .widget {
            background: white;
            border-radius: 12px;
            box-shadow: 0 4px 20px rgba(0,0,0,0.1);
            padding: 20px;
        }
        .widget h2 { color: #333; margin-bottom: 15px; font-size: 1.2em; }
        .chart-container { position: relative; height: 250px; }
        table { width: 100%; border-collapse: collapse; }
        th, td { padding: 10px; text-align: left; border-bottom: 1px solid #eee; }
        th { background: #f8f9fa; font-weight: 600; }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>{{ title }}</h1>
            <p class="timestamp">Generated: {{ timestamp }}</p>
        </div>
        <div class="widgets">
            {{ widgets }}
        </div>
        <div class="footer">
            Generated by Friday AI Assistant
        </div>
    </div>
    <script>
        {{ widget_scripts }}
    </script>
</body>
</html>'''
    
    def _get_default_template(self) -> str:
        return '''<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>{{ title }}</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { 
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            min-height: 100vh;
            padding: 20px;
        }
        .container {
            max-width: 800px;
            margin: 0 auto;
            background: white;
            border-radius: 16px;
            box-shadow: 0 20px 60px rgba(0,0,0,0.3);
            overflow: hidden;
        }
        .header {
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: white;
            padding: 30px;
            text-align: center;
        }
        .header h1 { font-size: 2em; margin-bottom: 10px; }
        .timestamp { opacity: 0.8; font-size: 0.9em; }
        .content { padding: 30px; }
        .data-table { width: 100%; border-collapse: collapse; margin: 20px 0; }
        .data-table th, .data-table td { padding: 12px 15px; text-align: left; border-bottom: 1px solid #eee; }
        .data-table th { background: #f8f9fa; font-weight: 600; }
        .data-table tr:hover { background: #f5f5f5; }
        .message { padding: 20px; background: #f8f9fa; border-radius: 8px; margin: 20px 0; white-space: pre-wrap; }
        .footer { text-align: center; padding: 20px; color: #666; font-size: 0.85em; }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>{{ title }}</h1>
            <div class="timestamp">Generated: {{ timestamp }}</div>
        </div>
        <div class="content">
            {{ content }}
        </div>
        <div class="footer">Generated by Friday AI Assistant</div>
    </div>
</body>
</html>'''
    
    def prepare_chart_config(self, data: Any, title: str) -> Dict[str, Any]:
        """Prepare Chart.js configuration from data."""
        if isinstance(data, dict):
            chart_data = data.get('data', data)
            chart_type = data.get('chart_type', 'line')
        else:
            chart_data = data
            chart_type = 'line'
        
        if not isinstance(chart_data, list) or not chart_data:
            return {}
        
        first_item = chart_data[0]
        
        # Detect labels and values
        if 'date' in first_item or 'time' in first_item or 'timestamp' in first_item:
            # Time series
            label_key = next(k for k in ['date', 'time', 'timestamp'] if k in first_item)
            labels = [item.get(label_key, item.get('date', '')) for item in chart_data]
            values = [item.get('value', item.get('price', item.get('count', 0))) for item in chart_data]
        elif 'label' in first_item or 'name' in first_item:
            # Categorical
            label_key = 'label' if 'label' in first_item else 'name'
            labels = [item.get(label_key, '') for item in chart_data]
            values = [item.get('value', item.get('count', 0)) for item in chart_data]
        else:
            # Fallback
            labels = [str(i) for i in range(len(chart_data))]
            values = list(chart_data)
        
        return {
            'type': chart_type,
            'data': {
                'labels': labels,
                'datasets': [{
                    'label': title,
                    'data': values,
                    'borderColor': '#667eea',
                    'backgroundColor': 'rgba(102, 126, 234, 0.1)',
                    'fill': True
                }]
            },
            'options': {
                'responsive': True,
                'maintainAspectRatio': False,
                'plugins': {
                    'legend': {'display': True}
                }
            }
        }
    
    def _render_widgets(self, widgets: List[Dict]) -> str:
        """Render dashboard widgets as HTML."""
        html_parts = []
        for i, widget in enumerate(widgets):
            widget_type = widget.get('type', 'table')
            widget_title = widget.get('title', f'Widget {i+1}')
            
            if widget_type == 'chart':
                html_parts.append(f'''
            <div class="widget">
                <h2>{widget_title}</h2>
                <div class="chart-container">
                    <canvas id="chart-{i}"></canvas>
                </div>
            </div>''')
            elif widget_type == 'table':
                headers = widget.get('headers', [])
                rows = widget.get('rows', [])
                table_html = f'''
            <div class="widget">
                <h2>{widget_title}</h2>
                <table>
                    <thead><tr>{"".join(f"<th>{h}</th>" for h in headers)}</tr></thead>
                    <tbody>{"".join("<tr>" + "".join(f"<td>{cell}</td>" for cell in row) + "</tr>" for row in rows)}</tbody>
                </table>
            </div>'''
                html_parts.append(table_html)
            elif widget_type == 'list':
                items = widget.get('items', [])
                list_html = f'''
            <div class="widget">
                <h2>{widget_title}</h2>
                <ul class="list">{"".join(f"<li>{item}</li>" for item in items)}</ul>
            </div>'''
                html_parts.append(list_html)
            else:
                html_parts.append(f'''
            <div class="widget">
                <h2>{widget_title}</h2>
                <div class="content">{json.dumps(widget.get('data', widget))}</div>
            </div>''')
        
        return '\n'.join(html_parts)
    
    def _render_widget_scripts(self, widgets: List[Dict]) -> str:
        """Render Chart.js scripts for chart widgets."""
        scripts = []
        for i, widget in enumerate(widgets):
            if widget.get('type') == 'chart':
                chart_config = widget.get('chart_config', self.prepare_chart_config(widget.get('data', {}), widget.get('title', '')))
                scripts.append(f'''
        (function() {{
            const ctx = document.getElementById('chart-{i}').getContext('2d');
            const config = {json.dumps(chart_config)};
            new Chart(ctx, config);
        }})();''')
        return '\n'.join(scripts)
    
    def generate(self, data: Any, user_id: str, template: str = 'auto',
                 title: str = 'Friday Page') -> Dict[str, Any]:
        """
        Generate a static HTML page.
        
        Args:
            data: Data to render
            user_id: User's phone number
            template: Template name ('auto', 'chart', 'table', 'list', 'dashboard')
            title: Page title
            
        Returns:
            dict with success, path, url, expires
        """
        # Validate data size
        if not self.validate_data_size(data):
            return {
                'success': False,
                'error': 'Data too large (max 1MB)'
            }
        
        # Auto-detect template
        if template == 'auto':
            template = self.detect_template(data)
        
        # Generate hash
        page_hash = self.generate_hash(data, user_id)
        
        # Create page directory
        user_dir = self.web_portal_path / user_id.replace('+', '')
        page_dir = user_dir / page_hash
        page_dir.mkdir(parents=True, exist_ok=True)
        
        # Prepare context
        context = {
            'title': title,
            'timestamp': datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M UTC')
        }
        
        # Render based on template
        if template == 'chart':
            context['chart_config'] = json.dumps(self.prepare_chart_config(data, title))
            context['data'] = data
        elif template == 'table':
            if isinstance(data, dict) and 'headers' in data and 'rows' in data:
                context['headers'] = ''.join(f'<th>{h}</th>' for h in data['headers'])
                context['rows'] = ''.join(
                    '<tr>' + ''.join(f'<td>{cell}</td>' for cell in row) + '</tr>'
                    for row in data['rows']
                )
            else:
                # Auto-generate table from list of objects
                if isinstance(data, list) and data and isinstance(data[0], dict):
                    headers = list(data[0].keys())
                    context['headers'] = ''.join(f'<th>{h}</th>' for h in headers)
                    context['rows'] = ''.join(
                        '<tr>' + ''.join(f'<td>{row.get(h, "")}</td>' for h in headers) + '</tr>'
                        for row in data
                    )
        elif template == 'list':
            items = data if isinstance(data, list) else data.get('items', [])
            context['items'] = ''.join(
                f'<div class="list-item"><div class="bullet"></div><div class="text">{item}</div></div>'
                for item in items
            )
        elif template == 'dashboard':
            widgets = data.get('widgets', [])
            context['widgets'] = self._render_widgets(widgets)
            context['widget_scripts'] = self._render_widget_scripts(widgets)
        else:
            # Default - render as table or message
            if isinstance(data, list) and data and isinstance(data[0], dict):
                headers = list(data[0].keys())
                context['content'] = (
                    '<table class="data-table"><thead><tr>' +
                    ''.join(f'<th>{h}</th>' for h in headers) +
                    '</tr></thead><tbody>' +
                    ''.join('<tr>' + ''.join(f'<td>{row.get(h, "")}</td>' for h in headers) + '</tr>' for row in data) +
                    '</tbody></table>'
                )
            else:
                context['content'] = f'<div class="message">{json.dumps(data, indent=2)}</div>'
        
        # Render HTML
        html = self.render_template(template, context)
        
        # Save files
        index_path = page_dir / 'index.html'
        index_path.write_text(html)
        
        # Save data.json for reference
        data_path = page_dir / 'data.json'
        data_path.write_text(json.dumps(data, indent=2))
        
        # Calculate expiry
        expires = datetime.now(timezone.utc).isoformat()
        
        # Build URL
        user_id_clean = user_id.replace('+', '')
        if CLOUDFLARE_TUNNEL_URL:
            url = f"{CLOUDFLARE_TUNNEL_URL}/{user_id_clean}/{page_hash}/"
        else:
            url = f"/portal/{user_id}/{page_hash}/"
        
        return {
            'success': True,
            'path': str(page_dir / 'index.html'),
            'url': url,
            'expires': expires
        }
    
    def list_pages(self, user_id: str) -> Dict[str, Any]:
        """List all pages for a user."""
        user_dir = self.web_portal_path / user_id.replace('+', '')
        
        if not user_dir.exists():
            return {
                'success': True,
                'pages': []
            }
        
        pages = []
        for page_dir in user_dir.iterdir():
            if page_dir.is_dir():
                index_file = page_dir / 'index.html'
                if index_file.exists():
                    stat = index_file.stat()
                    pages.append({
                        'id': page_dir.name,
                        'path': str(index_file),
                        'url': f"/portal/{user_id}/{page_dir.name}/",
                        'created': datetime.fromtimestamp(stat.st_ctime, tz=timezone.utc).isoformat(),
                        'expires': datetime.fromtimestamp(stat.st_mtime + PAGE_EXPIRY_HOURS * 3600, tz=timezone.utc).isoformat()
                    })
        
        return {
            'success': True,
            'pages': pages
        }