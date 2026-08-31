export function decodeDeploymentRouteSegment(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch (error) {
    if (error instanceof URIError) return value;
    throw error;
  }
}

export function encodeDeploymentRouteSegment(value: string): string {
  return encodeURIComponent(decodeDeploymentRouteSegment(value));
}
