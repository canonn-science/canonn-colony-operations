export interface Point3 {
  x: number;
  y: number;
  z: number;
}

/** Straight-line distance between two galactic coordinates, in light-years. */
export function distanceLy(a: Point3, b: Point3): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dz = a.z - b.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}
