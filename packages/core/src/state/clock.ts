import type { Clock } from "@harness/contracts";

export class SystemClock implements Clock {
  now(): string { return new Date().toISOString(); }
}

export class FixedClock implements Clock {
  private t: number;
  constructor(iso: string) { this.t = Date.parse(iso); }
  now(): string { return new Date(this.t).toISOString(); }
  advance(seconds: number): void { this.t += seconds * 1000; }
  set(iso: string): void { this.t = Date.parse(iso); }
}

export function addSeconds(iso: string, seconds: number): string {
  return new Date(Date.parse(iso) + seconds * 1000).toISOString();
}
