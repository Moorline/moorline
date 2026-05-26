export class ProviderRecoveryService {
  shouldRecover(input: { sessionId: string; lifecycleStatus: string; providerAutoStartEnabled?: boolean }): boolean {
    return input.lifecycleStatus !== 'archived' && !input.sessionId.startsWith('chat-') && input.providerAutoStartEnabled !== false;
  }
}
