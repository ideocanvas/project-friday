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
        
        // Call Ollama API for vision
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
        
        const response = await fetch(`${VISION_BASE_URL}/api/generate`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                model: VISION_MODEL,
                prompt: query,
                images: [base64Image],
                stream: false
            }),
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
        
        const data = await response.json() as { response?: string; error?: string };
        
        if (data.error) {
            return {
                success: false,
                error: data.error
            };
        }
        
        console.log(`[Vision] Analysis complete`);
        
        return {
            success: true,
            description: data.response || 'No description generated'
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
        
        // Call Ollama API for vision
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
        
        const response = await fetch(`${VISION_BASE_URL}/api/generate`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                model: VISION_MODEL,
                prompt: query,
                images: images,
                stream: false
            }),
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
        
        const data = await response.json() as { response?: string; error?: string };
        
        if (data.error) {
            return {
                success: false,
                error: data.error
            };
        }
        
        console.log(`[Vision] Multi-image analysis complete`);
        
        return {
            success: true,
            description: data.response || 'No description generated'
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
        // Try to get model info from Ollama
        const response = await fetch(`${VISION_BASE_URL}/api/tags`, {
            method: 'GET',
            headers: {
                'Content-Type': 'application/json'
            }
        });
        
        if (!response.ok) {
            console.log(`[Vision] Model check failed: ${response.status}`);
            return false;
        }
        
        const data = await response.json() as { models?: Array<{ name: string }> };
        
        if (data.models && Array.isArray(data.models)) {
            const modelExists = data.models.some(m => 
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