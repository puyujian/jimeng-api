import type { Region } from '../types'

/**
 * Region prefix mapping
 * cn (China) has no prefix, other regions use their code as prefix
 */
const REGION_PREFIXES: Record<Region, string> = {
  cn: '',
  us: 'us-',
  hk: 'hk-',
  jp: 'jp-',
  sg: 'sg-',
}

/**
 * Formats the authorization header with the appropriate region prefix
 * @param sessionId - The user's session ID
 * @param region - The selected region
 * @returns Formatted authorization header value
 */
export function formatAuthHeader(sessionId: string, region: Region): string {
  const prefix = REGION_PREFIXES[region]
  return `Bearer ${prefix}${sessionId}`
}

/**
 * Gets the region prefix for a given region
 * @param region - The selected region
 * @returns The prefix string (empty for cn)
 */
export function getRegionPrefix(region: Region): string {
  return REGION_PREFIXES[region]
}
