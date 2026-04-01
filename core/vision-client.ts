/**
 * Vision Client for Project Friday
 * 
 * Handles image analysis using a separate vision model.
 * This allows using a dedicated vision model (like llava) when the main
 * chat model doesn't support vision capabilities.
 */

import * as fs from 'fs';
import * as path from 'path';

// Configuration from environment
const VISION_MODEL = process.env.VISION_MODEL || '';
const VISION_BASE_URL = process.env.VISION_BASE_URL || process.env.OLLAMA_BASE_URL || 'http://localhost:11434';
const VISION_ENABLED = VISION_MODEL.length > 0;
// API type: "ollama" or "openai" (OpenAI-compatible, e.g. LM Studio)
const VISION_API_TYPE = (process.env.VISION_API_TYPE || 'ollama').toLowerCase().trim();
const IS_OPENAI = VISION_API_TYPE === 'openai';

/**
 * Build the full API URL based on VISION_API_TYPE.
 * @param endpoint One of "generate", "models", "tags"
 */
function getApiUrl(endpoint: string): string {
    if (IS_OPENAI) {
        let base = VISION_BASE_URL.replace(/\/+$/, '');
        // Strip trailing /v1 if present so we don't double-up
        if (base.endsWith('/v1')) base = base.slice(0, -3);
        if (endpoint === 'generate') return `${base}/v1/chat/completions`;
        if (endpoint === 'models') return `${base}/v1/models`;
    } else {
        // Ollama
        if (endpoint === 'generate') return `${VISION_BASE_URL}/api/generate`;
        if (endpoint === 'tags') return `${VISION_BASE_URL}/api/tags`;
    }
    return `${VISION_BASE_URL}/${endpoint}`;
}

/**
 * Check if vision capabilities are available
 */
export function isVisionAvailable(): boolean {
    return VISION_ENABLED;
}

/**
 * Get the configured vision model name
 */
export function getVisionModel(): string {
    return VISION_MODEL;
}

/**
 * Encode an image file to base64
 * @param imagePath Path to the image file
 * @returns Base64 encoded image data (without data URI prefix)
 */
export function encodeImageToBase64(imagePath: string): string {
    if (!fs.existsSync(imagePath)) {
        throw new Error(`Image file not found: ${imagePath}`);
    }
    
    const imageBuffer = fs.readFileSync(imagePath);
    return imageBuffer.toString('base64');
}

/**
 * Get the MIME type for an image based on file extension
 * @param imagePath Path to the image file
 * @returns MIME type string
 */
export function getImageMimeType(imagePath: string): string {
    const ext = path.extname(imagePath).toLowerCase();
    switch (ext) {
        case '.jpg':
        case '.jpeg':
            return 'image/jpeg';
        case '.png':
            return 'image/png';
        case '.gif':
            return 'image/gif';
        case '.webp':
            return 'image/webp';
        case '.bmp':
            return 'image/bmp';
        default:
            return 'image/jpeg'; // Default fallback
    }
}

/**
 * Vision analysis result
 */
export interface VisionAnalysisResult {
    success: boolean;
    description?: string;
    error?: string;
}

/**
 * Analyze an image using the vision model
 * @param imagePath Path to the image file
 * @param query Optional query/question about the image
 * @param timeoutMs Timeout in milliseconds (default 60000)
 * @returns Vision analysis result
 */
export async function analyzeImage(
    imagePath: string,
    query: string = 'Describe this image in detail.',
    timeoutMs: number = 60000
): Promise<VisionAnalysisResult> {
    if (!VISION_ENABLED) {
        return {
            success: false,
            error: 'Vision model not configured. Set VISION_MODEL environment variable.'
        };
    }
    
    try {
        // Check if file exists
        if (!fs.existsSync(imagePath)) {
            return {
                success: false,
                error: `Image file not found: ${imagePath}`
            };
        }
        
        // Encode image to base64
        const base64Image = encodeImageToBase64(imagePath);
        const mimeType = getImageMimeType(imagePath);
        
        console.log(`[Vision] Analyzing image: ${imagePath}`);
        console.log(`[Vision] Model: ${VISION_MODEL}`);
        console.log(`[Vision] Query: ${query}`);
        
        // Call vision API
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
        
        let payload: object;
        if (IS_OPENAI) {
            // OpenAI-compatible (LM Studio) — chat completions with vision content
            payload = {
                model: VISION_MODEL,
                messages: [
                    {
                        role: 'user',
                        content: [
                            { type: 'text', text: query },
                            {
                                type: 'image_url',
                                image_url: {
                                    url: `data:${mimeType};base64,${base64Image}`
                                }
                            }
                        ]
                    }
                ],
                max_tokens: 2048,
                temperature: 0.3
            };
        } else {
            // Ollama — /api/generate
            payload = {
                model: VISION_MODEL,
                prompt: query,
                images: [base64Image],
                stream: false
            };
        }
        
        const response = await fetch(getApiUrl('generate'), {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(payload),
            signal: controller.signal
        });
        
        clearTimeout(timeoutId);
        
        if (!response.ok) {
            const errorText = await response.text();
            return {
                success: false,
                error: `Vision API error: ${response.status} - ${errorText}`
            };
        }
        
        const data = await response.json() as Record<string, unknown>;
        
        // Check for error in response body
        if (data.error) {
            return {
                success: false,
                error: String(data.error)
            };
        }
        
        // Extract description based on API type
        let description = '';
        if (IS_OPENAI) {
            const choices = (data.choices as Array<{ message?: { content?: string } }>) ?? [];
            if (choices.length > 0 && choices[0]!.message) {
                description = choices[0]!.message!.content || '';
            }
        } else {
            description = (data as { response?: string }).response || '';
        }
        
        console.log(`[Vision] Analysis complete`);
        
        return {
            success: true,
            description: description || 'No description generated'
        };
        
    } catch (error) {
        if (error instanceof Error) {
            if (error.name === 'AbortError') {
                return {
                    success: false,
                    error: `Vision analysis timed out after ${timeoutMs}ms`
                };
            }
            return {
                success: false,
                error: error.message
            };
        }
        return {
            success: false,
            error: 'Unknown error during vision analysis'
        };
    }
}

/**
 * Analyze multiple images using the vision model
 * @param imagePaths Array of paths to image files
 * @param query Optional query/question about the images
 * @param timeoutMs Timeout in milliseconds (default 120000)
 * @returns Vision analysis result
 */
export async function analyzeMultipleImages(
    imagePaths: string[],
    query: string = 'Describe these images.',
    timeoutMs: number = 120000
): Promise<VisionAnalysisResult> {
    if (!VISION_ENABLED) {
        return {
            success: false,
            error: 'Vision model not configured. Set VISION_MODEL environment variable.'
        };
    }
    
    if (imagePaths.length === 0) {
        return {
            success: false,
            error: 'No image paths provided'
        };
    }
    
    // For single image, use the simpler function
    if (imagePaths.length === 1) {
        return analyzeImage(imagePaths[0]!, query, timeoutMs);
    }
    
    try {
        // Encode all images
        const images: string[] = [];
        for (const imagePath of imagePaths) {
            if (!fs.existsSync(imagePath)) {
                return {
                    success: false,
                    error: `Image file not found: ${imagePath}`
                };
            }
            images.push(encodeImageToBase64(imagePath));
        }
        
        console.log(`[Vision] Analyzing ${imagePaths.length} images`);
        console.log(`[Vision] Model: ${VISION_MODEL}`);
        console.log(`[Vision] Query: ${query}`);
        
        // Call vision API
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
        
        let payload: object;
        if (IS_OPENAI) {
            // OpenAI-compatible — multi-image content
            const imageContents: Array<{ type: string; text?: string; image_url?: { url: string } }> = [
                { type: 'text', text: query }
            ];
            for (let i = 0; i < imagePaths.length; i++) {
                const mime = getImageMimeType(imagePaths[i]!);
                imageContents.push({
                    type: 'image_url',
                    image_url: { url: `data:${mime};base64,${images[i]}` }
                });
            }
            payload = {
                model: VISION_MODEL,
                messages: [
                    { role: 'user', content: imageContents }
                ],
                max_tokens: 2048,
                temperature: 0.3
            };
        } else {
            // Ollama
            payload = {
                model: VISION_MODEL,
                prompt: query,
                images: images,
                stream: false
            };
        }
        
        const response = await fetch(getApiUrl('generate'), {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(payload),
            signal: controller.signal
        });
        
        clearTimeout(timeoutId);
        
        if (!response.ok) {
            const errorText = await response.text();
            return {
                success: false,
                error: `Vision API error: ${response.status} - ${errorText}`
            };
        }
        
        const data = await response.json() as Record<string, unknown>;
        
        if (data.error) {
            return {
                success: false,
                error: String(data.error)
            };
        }
        
        // Extract description based on API type
        let description = '';
        if (IS_OPENAI) {
            const choices = (data.choices as Array<{ message?: { content?: string } }>) ?? [];
            if (choices.length > 0 && choices[0]!.message) {
                description = choices[0]!.message!.content || '';
            }
        } else {
            description = (data as { response?: string }).response || '';
        }
        
        console.log(`[Vision] Multi-image analysis complete`);
        
        return {
            success: true,
            description: description || 'No description generated'
        };
        
    } catch (error) {
        if (error instanceof Error) {
            if (error.name === 'AbortError') {
                return {
                    success: false,
                    error: `Vision analysis timed out after ${timeoutMs}ms`
                };
            }
            return {
                success: false,
                error: error.message
            };
        }
        return {
            success: false,
            error: 'Unknown error during vision analysis'
        };
    }
}

/**
 * Check if the vision model is available and responding
 * @returns True if the vision model is available
 */
export async function checkVisionModelAvailable(): Promise<boolean> {
    if (!VISION_ENABLED) {
        return false;
    }
    
    try {
        const endpoint = IS_OPENAI ? 'models' : 'tags';
        const response = await fetch(getApiUrl(endpoint), {
            method: 'GET',
            headers: {
                'Content-Type': 'application/json'
            }
        });
        
        if (!response.ok) {
            console.log(`[Vision] Model check failed: ${response.status}`);
            return false;
        }
        
        const data = await response.json() as Record<string, unknown>;
        
        if (IS_OPENAI) {
            // OpenAI /v1/models returns { data: [{ id: "model-name" }] }
            const models = (data.data as Array<{ id: string }>) ?? [];
            const modelExists = models.some(m => m.id === VISION_MODEL || m.id.startsWith(VISION_MODEL + ':'));
            if (!modelExists) {
                console.log(`[Vision] Model ${VISION_MODEL} not found in available models`);
                return false;
            }
        } else {
            // Ollama /api/tags returns { models: [{ name: "model-name" }] }
            const models = (data.models as Array<{ name: string }>) ?? [];
            const modelExists = models.some(m =>
                m.name === VISION_MODEL || m.name.startsWith(VISION_MODEL + ':')
            );
            if (!modelExists) {
                console.log(`[Vision] Model ${VISION_MODEL} not found in available models`);
                return false;
            }
        }
        
        console.log(`[Vision] Model ${VISION_MODEL} is available`);
        return true;
        
    } catch (error) {
        console.log(`[Vision] Model check error:`, error);
        return false;
    }
}

// Export default object with all functions
export default {
    isVisionAvailable,
    getVisionModel,
    encodeImageToBase64,
    getImageMimeType,
    analyzeImage,
    analyzeMultipleImages,
    checkVisionModelAvailable
};