export class RepoLockRegistry {
  private readonly activeKeys = new Set<string>();
  private readonly listeners = new Set<(key: string) => void>();

  acquire(key: string): string | null {
    if (this.activeKeys.has(key)) {
      return 'Another job is already active for this repository';
    }
    this.activeKeys.add(key);
    return null;
  }

  release(key: string): void {
    if (!this.activeKeys.delete(key)) return;
    for (const listener of this.listeners) listener(key);
  }

  has(key: string): boolean {
    return this.activeKeys.has(key);
  }

  onReleased(listener: (key: string) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}
