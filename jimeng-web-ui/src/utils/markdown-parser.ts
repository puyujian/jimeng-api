/**
 * Markdown parser utility for rendering images and videos from markdown syntax
 */

// Regex patterns for markdown parsing
const IMAGE_MARKDOWN_REGEX = /!\[([^\]]*)\]\(([^)]+)\)/g
const VIDEO_MARKDOWN_REGEX = /!\[video\]\(([^)]+)\)/gi

/**
 * Parsed media item from markdown
 */
export interface ParsedMedia {
  type: 'image' | 'video'
  url: string
  alt?: string
}

/**
 * Parses markdown content and extracts media items
 * @param content - Markdown content string
 * @returns Array of parsed media items
 */
export function parseMediaFromMarkdown(content: string): ParsedMedia[] {
  const media: ParsedMedia[] = []
  
  // First, find all video markdown (more specific pattern)
  const videoMatches = content.matchAll(VIDEO_MARKDOWN_REGEX)
  const videoUrls = new Set<string>()
  
  for (const match of videoMatches) {
    const url = match[1]
    if (url && !videoUrls.has(url)) {
      videoUrls.add(url)
      media.push({ type: 'video', url })
    }
  }
  
  // Then find all image markdown (excluding videos)
  const imageMatches = content.matchAll(IMAGE_MARKDOWN_REGEX)
  
  for (const match of imageMatches) {
    const alt = match[1] ?? ''
    const url = match[2]
    
    // Skip if this is a video (alt text is "video") or no URL
    if (!url || alt.toLowerCase() === 'video') {
      continue
    }
    
    media.push({ type: 'image', url, alt })
  }
  
  return media
}

/**
 * Converts markdown image syntax to HTML img element
 * @param markdown - Markdown string with image syntax
 * @returns HTML string with img elements
 */
export function renderMarkdownImages(markdown: string): string {
  return markdown.replace(IMAGE_MARKDOWN_REGEX, (match, alt, url) => {
    // Skip video markdown
    if (alt.toLowerCase() === 'video') {
      return match
    }
    const escapedUrl = escapeHtml(url)
    const escapedAlt = escapeHtml(alt)
    return `<img src="${escapedUrl}" alt="${escapedAlt}" class="markdown-image" />`
  })
}

/**
 * Converts markdown video syntax to HTML video element
 * @param markdown - Markdown string with video syntax
 * @returns HTML string with video elements
 */
export function renderMarkdownVideos(markdown: string): string {
  return markdown.replace(VIDEO_MARKDOWN_REGEX, (_match, url) => {
    const escapedUrl = escapeHtml(url)
    return `<video src="${escapedUrl}" controls class="markdown-video"></video>`
  })
}

/**
 * Renders all markdown media (images and videos) to HTML
 * @param markdown - Markdown content string
 * @returns HTML string with rendered media
 */
export function renderMarkdownMedia(markdown: string): string {
  let result = markdown
  // Render videos first (more specific pattern)
  result = renderMarkdownVideos(result)
  // Then render images
  result = renderMarkdownImages(result)
  return result
}

/**
 * Escapes HTML special characters to prevent XSS
 * @param str - String to escape
 * @returns Escaped string
 */
function escapeHtml(str: string): string {
  const htmlEscapes: Record<string, string> = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }
  return str.replace(/[&<>"']/g, (char) => htmlEscapes[char] ?? char)
}
