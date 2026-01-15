/**
 * Download utilities for Jimeng Web UI
 * Provides functions for downloading files and copying URLs to clipboard
 * Requirements: 8.1, 8.2, 8.3, 8.4
 */

import JSZip from 'jszip'

export interface DownloadOptions {
  filename?: string
  mimeType?: string
}

export interface DownloadResult {
  success: boolean
  error?: string
}

/**
 * Generate a filename based on URL and type
 */
export function generateFilename(url: string, type: 'image' | 'video' = 'image'): string {
  const timestamp = Date.now()
  const extension = type === 'video' ? 'mp4' : 'png'
  
  // Try to extract filename from URL
  try {
    const urlObj = new URL(url)
    const pathname = urlObj.pathname
    const urlFilename = pathname.split('/').pop()
    
    if (urlFilename && urlFilename.includes('.')) {
      return urlFilename
    }
  } catch {
    // URL parsing failed, use default
  }
  
  return `${type}-${timestamp}.${extension}`
}

/**
 * Download a single file from URL
 * Requirements: 8.1, 8.2
 */
export async function downloadFile(
  url: string,
  options: DownloadOptions = {}
): Promise<DownloadResult> {
  try {
    const response = await fetch(url)
    
    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`)
    }
    
    const blob = await response.blob()
    const blobUrl = URL.createObjectURL(blob)
    
    const filename = options.filename || generateFilename(url, 
      blob.type.startsWith('video/') ? 'video' : 'image'
    )
    
    const link = document.createElement('a')
    link.href = blobUrl
    link.download = filename
    link.style.display = 'none'
    
    document.body.appendChild(link)
    link.click()
    document.body.removeChild(link)
    
    // Clean up blob URL after a short delay
    setTimeout(() => {
      URL.revokeObjectURL(blobUrl)
    }, 100)
    
    return { success: true }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Download failed'
    console.error('Download failed:', error)
    return { success: false, error: errorMessage }
  }
}

/**
 * Download an image file
 * Requirements: 8.1
 */
export async function downloadImage(
  url: string,
  filename?: string
): Promise<DownloadResult> {
  return downloadFile(url, {
    filename: filename || generateFilename(url, 'image')
  })
}

/**
 * Download a video file
 * Requirements: 8.2
 */
export async function downloadVideo(
  url: string,
  filename?: string
): Promise<DownloadResult> {
  return downloadFile(url, {
    filename: filename || generateFilename(url, 'video')
  })
}

/**
 * Copy URL to clipboard
 * Requirements: 8.3
 */
export async function copyToClipboard(text: string): Promise<DownloadResult> {
  try {
    await navigator.clipboard.writeText(text)
    return { success: true }
  } catch (error) {
    // Fallback for older browsers or when clipboard API is not available
    try {
      const textArea = document.createElement('textarea')
      textArea.value = text
      textArea.style.position = 'fixed'
      textArea.style.left = '-9999px'
      textArea.style.top = '-9999px'
      document.body.appendChild(textArea)
      textArea.focus()
      textArea.select()
      
      const successful = document.execCommand('copy')
      document.body.removeChild(textArea)
      
      if (successful) {
        return { success: true }
      }
      throw new Error('execCommand copy failed')
    } catch (fallbackError) {
      const errorMessage = fallbackError instanceof Error 
        ? fallbackError.message 
        : 'Copy to clipboard failed'
      console.error('Copy to clipboard failed:', fallbackError)
      return { success: false, error: errorMessage }
    }
  }
}

/**
 * Copy image URL to clipboard with confirmation
 * Requirements: 8.3
 */
export async function copyImageUrl(url: string): Promise<DownloadResult> {
  return copyToClipboard(url)
}

/**
 * Copy video URL to clipboard with confirmation
 * Requirements: 8.3
 */
export async function copyVideoUrl(url: string): Promise<DownloadResult> {
  return copyToClipboard(url)
}


export interface BatchDownloadOptions {
  zipFilename?: string
  onProgress?: (current: number, total: number) => void
}

export interface BatchDownloadResult {
  success: boolean
  downloadedCount: number
  failedCount: number
  errors?: string[]
}

/**
 * Download multiple files as a ZIP archive
 * Requirements: 8.4
 */
export async function downloadAsZip(
  urls: string[],
  options: BatchDownloadOptions = {}
): Promise<BatchDownloadResult> {
  const {
    zipFilename = `images-${Date.now()}.zip`,
    onProgress
  } = options

  const zip = new JSZip()
  const errors: string[] = []
  let downloadedCount = 0
  let failedCount = 0

  // Download all files and add to ZIP
  for (let i = 0; i < urls.length; i++) {
    const url = urls[i]
    
    if (!url) {
      failedCount++
      errors.push(`Invalid URL at index ${i}`)
      continue
    }
    
    try {
      const response = await fetch(url)
      
      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`)
      }
      
      const blob = await response.blob()
      const filename = generateFilename(url, 
        blob.type.startsWith('video/') ? 'video' : 'image'
      )
      
      // Ensure unique filenames in ZIP
      const uniqueFilename = `${i + 1}_${filename}`
      zip.file(uniqueFilename, blob)
      
      downloadedCount++
    } catch (error) {
      failedCount++
      const errorMessage = error instanceof Error ? error.message : 'Unknown error'
      errors.push(`Failed to download ${url}: ${errorMessage}`)
      console.error(`Failed to download ${url}:`, error)
    }
    
    // Report progress
    if (onProgress) {
      onProgress(i + 1, urls.length)
    }
  }

  // If no files were downloaded, return failure
  if (downloadedCount === 0) {
    return {
      success: false,
      downloadedCount: 0,
      failedCount,
      errors
    }
  }

  // Generate and download ZIP file
  try {
    const zipBlob = await zip.generateAsync({ type: 'blob' })
    const blobUrl = URL.createObjectURL(zipBlob)
    
    const link = document.createElement('a')
    link.href = blobUrl
    link.download = zipFilename
    link.style.display = 'none'
    
    document.body.appendChild(link)
    link.click()
    document.body.removeChild(link)
    
    // Clean up blob URL after a short delay
    setTimeout(() => {
      URL.revokeObjectURL(blobUrl)
    }, 100)
    
    return {
      success: true,
      downloadedCount,
      failedCount,
      errors: errors.length > 0 ? errors : undefined
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'ZIP generation failed'
    console.error('ZIP generation failed:', error)
    return {
      success: false,
      downloadedCount,
      failedCount,
      errors: [...errors, errorMessage]
    }
  }
}

/**
 * Download multiple images as a ZIP archive
 * Requirements: 8.4
 */
export async function downloadImagesAsZip(
  urls: string[],
  options: BatchDownloadOptions = {}
): Promise<BatchDownloadResult> {
  return downloadAsZip(urls, {
    zipFilename: options.zipFilename || `images-${Date.now()}.zip`,
    onProgress: options.onProgress
  })
}
