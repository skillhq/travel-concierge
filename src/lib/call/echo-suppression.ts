export type EchoSuppressionDecision = 'overlap' | 'speaking' | 'suppressed' | null;

export interface EchoSuppressionParams {
  isSpeaking: boolean;
  suppressSttUntilMs: number;
  transcriptEndMs?: number;
  nowMs: number;
}

export function getEchoSuppressionDecision({
  isSpeaking,
  suppressSttUntilMs,
  transcriptEndMs,
  nowMs,
}: EchoSuppressionParams): EchoSuppressionDecision {
  if (transcriptEndMs !== undefined && transcriptEndMs <= suppressSttUntilMs) {
    return 'overlap';
  }

  if (isSpeaking) {
    return 'speaking';
  }

  if (nowMs < suppressSttUntilMs) {
    return 'suppressed';
  }

  return null;
}
