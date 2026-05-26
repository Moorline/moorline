export class ProviderTurnCoordinator {
  turnKey(threadId: string, turnId: string): string {
    return `${threadId}:${turnId}`;
  }
}
