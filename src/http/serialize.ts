/** Shared response serialization helpers. */

/** Milliseconds since epoch → ISO 8601 string for the v1 contract. */
export function iso(ms: number): string {
  return new Date(ms).toISOString();
}
