export function describeTransportAuthor(input: {
  authorId: string;
  authorUsername: string;
  authorGlobalName: string | null;
  authorDisplayName: string | null;
  authorLabel: string;
}): string {
  const details: string[] = [];
  if (input.authorDisplayName && input.authorDisplayName !== input.authorLabel) {
    details.push(`display name: ${input.authorDisplayName}`);
  }
  if (input.authorGlobalName && input.authorGlobalName !== input.authorLabel && input.authorGlobalName !== input.authorDisplayName) {
    details.push(`global name: ${input.authorGlobalName}`);
  }
  if (input.authorUsername !== input.authorLabel) {
    details.push(`username: ${input.authorUsername}`);
  }
  details.push(`id: ${input.authorId}`);
  return `${input.authorLabel} (${details.join(', ')})`;
}
