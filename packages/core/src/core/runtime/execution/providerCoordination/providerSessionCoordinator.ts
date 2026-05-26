export class ProviderSessionCoordinator {
  providerStoppedReply(input: { sessionId: string }): string {
    if (input.sessionId.startsWith('chat-')) {
      return 'The LLM provider is currently stopped by an Moorline admin. Ask an admin to run /admin provider-start all before sending new work.';
    }
    return 'This session provider is currently stopped by an Moorline admin. Ask an admin to run /admin provider-start current before sending new work.';
  }
}
