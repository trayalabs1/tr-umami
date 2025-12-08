/**
 * Security utilities for input validation and sanitization
 */

// Maximum sizes to prevent DoS attacks
export const MAX_DATA_SIZE = 10000; // 10KB for data field
export const MAX_STRING_LENGTH = 500;
export const MAX_OBJECT_KEYS = 50;
export const MAX_NESTING_DEPTH = 3;

/**
 * Patterns that indicate potential security threats
 */
const MALICIOUS_PATTERNS = [
  // Command injection patterns
  /(\||;|&|`|\$\(|\$\{|>|<|\\|\n|\r)/g,

  // Common attack vectors
  /bash|sh|curl|wget|nc|netcat|eval|exec|spawn|chmod|chown/gi,

  // Script tags and HTML injection
  /<script|<iframe|javascript:|onerror=|onload=/gi,

  // SQL injection patterns
  /union\s+select|insert\s+into|drop\s+table|delete\s+from|update\s+set/gi,

  // Path traversal
  /\.\.\//g,

  // Encoded attack patterns
  /%0a|%0d|%00|%2e%2e|%252e/gi,
];

/**
 * Check if a string contains malicious patterns
 */
export function containsMaliciousPattern(value: string): boolean {
  if (typeof value !== 'string') return false;

  return MALICIOUS_PATTERNS.some(pattern => pattern.test(value));
}

/**
 * Recursively check object for malicious content
 */
export function validateObjectSafety(
  obj: any,
  depth = 0,
  keyCount = 0,
): { safe: boolean; reason?: string } {
  // Check depth
  if (depth > MAX_NESTING_DEPTH) {
    return { safe: false, reason: 'Object nesting too deep' };
  }

  // Check if it's an object
  if (obj === null || typeof obj !== 'object') {
    // For primitive values, check if string contains malicious patterns
    if (typeof obj === 'string') {
      if (obj.length > MAX_STRING_LENGTH) {
        return { safe: false, reason: 'String value too long' };
      }
      if (containsMaliciousPattern(obj)) {
        return { safe: false, reason: 'Malicious pattern detected in string' };
      }
    }
    return { safe: true };
  }

  // Check for arrays
  if (Array.isArray(obj)) {
    if (obj.length > MAX_OBJECT_KEYS) {
      return { safe: false, reason: 'Array too large' };
    }
    for (const item of obj) {
      const result = validateObjectSafety(item, depth + 1, keyCount);
      if (!result.safe) return result;
    }
    return { safe: true };
  }

  // Check object keys count
  const keys = Object.keys(obj);
  if (keys.length + keyCount > MAX_OBJECT_KEYS) {
    return { safe: false, reason: 'Too many object keys' };
  }

  // Check each key and value
  for (const key of keys) {
    // Check key itself for malicious patterns
    if (containsMaliciousPattern(key)) {
      return { safe: false, reason: 'Malicious pattern detected in object key' };
    }

    // Check key length
    if (key.length > MAX_STRING_LENGTH) {
      return { safe: false, reason: 'Object key too long' };
    }

    // Recursively check value
    const result = validateObjectSafety(obj[key], depth + 1, keyCount + keys.length);
    if (!result.safe) {
      return result;
    }
  }

  return { safe: true };
}

/**
 * Calculate approximate size of JSON object in bytes
 */
export function calculateDataSize(data: any): number {
  try {
    return JSON.stringify(data).length;
  } catch {
    return 0;
  }
}

/**
 * Validate that data object is safe to process
 */
export function isDataSafe(data: any): { safe: boolean; reason?: string } {
  // Check data size
  const size = calculateDataSize(data);
  if (size > MAX_DATA_SIZE) {
    return { safe: false, reason: `Data size exceeds limit (${size} > ${MAX_DATA_SIZE} bytes)` };
  }

  // Check for malicious patterns
  return validateObjectSafety(data);
}

/**
 * Sanitize string by removing potentially dangerous characters
 */
export function sanitizeString(value: string, maxLength = MAX_STRING_LENGTH): string {
  if (typeof value !== 'string') {
    return '';
  }

  // Truncate to max length
  let sanitized = value.slice(0, maxLength);

  // Remove control characters
  // eslint-disable-next-line no-control-regex
  sanitized = sanitized.replace(/[\x00-\x1F\x7F]/g, '');

  // Trim whitespace
  sanitized = sanitized.trim();

  return sanitized;
}
